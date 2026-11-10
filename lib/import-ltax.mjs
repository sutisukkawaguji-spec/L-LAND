// Import the Excel workbook exported from LTAX ONLINE (sheets owner, land, land_detail, building,
// building_detail, sign). Columns are found by header text, so column order does not matter.
// Every imported record gets `synced` = the values LTAX held, which is what change tracking compares to.
const randomUUID = () => globalThis.crypto.randomUUID();
import { DOC_TYPES, UTM_SHEETS, STRUCTURES, BUILDING_TYPES, PERSON_TYPES, LAND_USE_TYPES } from '../public/shared/schema.mjs';
import { syncFields, pendingState } from '../public/shared/diff.mjs';
import { repairThai } from '../public/shared/thai-text.mjs';

const clean = v => {
  const s = repairThai(String(v ?? '').trim());
  return s === '-' ? '' : s;
};
const numStr = v => {
  const s = clean(v).replace(/,/g, '');
  if (s === '') return '';
  const n = Number(s);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : s;
};
const nameKey = s => clean(s).replace(/\s+/g, ' ').replace(/^(นางสาว)\s*/, 'น.ส. ').toLowerCase();

// Sheet rows → array of objects keyed by header text.
function table(sheet) {
  if (!sheet || !sheet.rows.length) return [];
  const head = sheet.rows[0].map(h => clean(h));
  return sheet.rows.slice(1).filter(r => r.some(c => clean(c) !== '')).map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { if (h) o[h] = r[j] ?? ''; });
    return o;
  });
}
const pick = (row, ...names) => {
  for (const n of names) if (n in row && clean(row[n]) !== '') return clean(row[n]);
  return '';
};
const codeByLabel = (list, text) => {
  const t = clean(text).replace(/\s+/g, '');
  return (list.find(([, l]) => l.replace(/\s+/g, '') === t) || [''])[0];
};

// LTAX export writes use types in several spellings ("2 -(2) ที่อยู่อาศัย - หลังหลัก ...", "2-(2) ที่อยู่อาศัย หลังหลัก(...)").
export function useTypeCode(text) {
  const t = clean(text).replace(/\s+/g, '');
  if (!t) return '';
  const exact = codeByLabel(LAND_USE_TYPES, t);
  if (exact) return exact;
  const m = t.match(/^(\d)(?:-?\((\d)\))?/);
  if (!m) return '';
  if (m[1] === '1') return '1';
  if (m[1] === '2') return { 1: '2', 2: '3', 3: '4' }[m[2]] || '';
  if (m[1] === '3') return '5';
  if (m[1] === '4') return /6ปี/.test(t) ? '9' : /3ปี/.test(t) ? '8' : '6';
  if (m[1] === '5') return '7';
  return '';
}

export function parseRNW(text) {
  const m = clean(text).match(/^(\d+)\s*-\s*(\d+)\s*-\s*([\d.]+)$/);
  return m ? { rai: m[1], ngan: m[2], wah: numStr(m[3]) } : { rai: '', ngan: '', wah: '' };
}

const buildingCode = text => {
  const m = clean(text).match(/^(\d{3}(?:\/\d)?)/);
  return m && BUILDING_TYPES.some(([c]) => c === m[1]) ? m[1] : '';
};

export function readLtaxWorkbook(sheets) {
  const byName = Object.fromEntries(sheets.map(s => [s.name.trim().toLowerCase(), s]));
  const report = { counts: {}, problems: [] };
  const problem = (sheet, row, message) => report.problems.push({ sheet, row, message });

  // Owners
  const owners = [];
  const ownerByLtax = new Map(), ownerByName = new Map();
  for (const r of table(byName.owner)) {
    const typeCode = pick(r, 'ประเภทบุคคล(รหัส)', 'ประเภทบุคคล');
    const o = {
      ltaxId: pick(r, 'รหัสเจ้าของ'),
      personType: /^\d+$/.test(typeCode) ? (PERSON_TYPES[Number(typeCode) - 1] || [''])[0] : typeCode,
      prefixName: pick(r, 'คำนำหน้าชื่อ'), firstName: pick(r, 'ชื่อ'), lastName: pick(r, 'นามสกุล'),
      assetReg4: pick(r, 'ถอดรหัสชื่อ ผ.ท.4'), psnId: pick(r, 'เลขบัตรปชช.', 'เลขประจำตัวประชาชน'),
      addrNo: pick(r, 'บ้านเลขที่'), addrVillage: pick(r, 'หมู่'), addrAlley: pick(r, 'ซอย'), addrRoad: pick(r, 'ถนน'),
      addrDistrict: pick(r, 'ตำบล'), addrAmphur: pick(r, 'อำเภอ'), addrProvince: pick(r, 'จังหวัด'), postalCode: pick(r, 'รหัสไปรษณีย์'),
    };
    if (!o.ltaxId) { problem('owner', r._row, 'ไม่มีรหัสเจ้าของ'); continue; }
    owners.push(o);
    ownerByLtax.set(o.ltaxId, o);
    const key = nameKey([o.prefixName, o.firstName, o.lastName].filter(Boolean).join(' '));
    if (!ownerByName.has(key)) ownerByName.set(key, []);
    ownerByName.get(key).push(o);
  }

  // Lands: one row per land and owner, grouped by รหัสที่ดิน
  const lands = [], landByLtax = new Map();
  for (const r of table(byName.land)) {
    const ltaxId = pick(r, 'รหัสที่ดิน');
    if (!ltaxId) { problem('land', r._row, 'ไม่มีรหัสที่ดิน'); continue; }
    let l = landByLtax.get(ltaxId);
    if (!l) {
      l = {
        ltaxId, landGroup: pick(r, 'รหัสกลุ่มที่ดิน'), parcelCode: pick(r, 'รหัสแปลงที่ดิน').toUpperCase(),
        docType: codeByLabel(DOC_TYPES, pick(r, 'ประเภทเอกสารสิทธิ์')), docNo: pick(r, 'เลขที่เอกสารสิทธิ์'),
        utm1: pick(r, 'ระวาง'), utm2: codeByLabel(UTM_SHEETS, pick(r, 'แผนที่ระวางภูมิประเทศ')), utm3: pick(r, 'ระวางUTM'),
        utm4: pick(r, 'แผ่นที่ระวางUTM'), scale: pick(r, 'มาตราส่วน'), parcelNo: pick(r, 'เลขที่ดิน'),
        dealingFileNo: pick(r, 'หน้าสำรวจ'), volume: pick(r, 'เล่มที่'), page: pick(r, 'หน้าที่'),
        road: pick(r, 'ถนน'), alley: pick(r, 'ซอย'), villageNo: pick(r, 'หมู่ที่'), amphur: pick(r, 'อำเภอ'), district: pick(r, 'ตำบล'),
        rai: numStr(pick(r, 'เนื้อที่ (ไร่)')), ngan: numStr(pick(r, 'เนื้อที่ (งาน)')), wah: numStr(pick(r, 'เนื้อที่ (ตร.ว.)')),
        pricePerWah: numStr(pick(r, 'ราคาประเมินที่ดินต่อ ตร.ว.')), ownerIds: [], uses: [], _ownerNames: [],
        ltaxValues: { totalPrice: numStr(pick(r, 'รวมราคาประเมินที่ดิน (บาท)')) },
      };
      if (pick(r, 'ประเภทเอกสารสิทธิ์') && !l.docType) problem('land', r._row, `ประเภทเอกสารสิทธิ์ "${pick(r, 'ประเภทเอกสารสิทธิ์')}" ไม่ตรงกับรายการของ LTAX`);
      landByLtax.set(ltaxId, l);
      lands.push(l);
    }
    const owner = pick(r, 'เจ้าของ');
    if (owner && !l._ownerNames.includes(owner)) l._ownerNames.push(owner);
  }
  for (const l of lands) {
    for (const name of l._ownerNames) {
      const hits = ownerByName.get(nameKey(name)) || [];
      if (hits.length === 1) l.ownerIds.push(hits[0].ltaxId);
      else problem('land', l.parcelCode, hits.length ? `ชื่อเจ้าของ "${name}" ตรงกับเจ้าของหลายราย ผูกอัตโนมัติไม่ได้` : `ไม่พบเจ้าของชื่อ "${name}" ในชีต owner`);
    }
    delete l._ownerNames;
  }

  // Land uses
  for (const r of table(byName.land_detail)) {
    const l = landByLtax.get(pick(r, 'รหัสที่ดิน'));
    if (!l) { problem('land_detail', r._row, `ไม่พบที่ดินรหัส ${pick(r, 'รหัสที่ดิน')}`); continue; }
    const usedText = pick(r, 'การใช้ประโยชน์');
    if (!usedText) continue;
    const u = { order: Number(pick(r, 'ลำดับการใช้')) || l.uses.length + 1, usedType: useTypeCode(usedText), ...parseRNW(pick(r, 'เนื้อที่ใช้(ร-ง-ว)')), usedBy: pick(r, 'ผู้ใช้ประโยชน์'),
      // What LTAX computed for this use: values, tax rate (%) and net tax
      ltax: { landValue: numStr(pick(r, 'ราคาประเมินที่ดิน')), buildingValue: numStr(pick(r, 'ราคาประเมินสิ่งปลูกสร้าง')), taxRate: numStr(pick(r, 'อัตราภาษี')), tax: numStr(pick(r, 'ภาษีสุทธิ')) } };
    if (!u.usedType) problem('land_detail', r._row, `การใช้ประโยชน์ "${usedText}" ไม่ตรงกับรายการของ LTAX`);
    l.uses.push(u);
  }
  for (const l of lands) {
    l.uses.sort((a, b) => a.order - b.order); l.uses.forEach(u => delete u.order);
    const taxes = l.uses.map(u => Number(u.ltax?.tax)).filter(Number.isFinite);
    if (taxes.length) l.ltaxValues.tax = String(Math.round(taxes.reduce((a, b) => a + b, 0) * 100) / 100);
  }

  // Buildings
  const buildings = [], buildingByLtax = new Map();
  for (const r of table(byName.building)) {
    const ltaxId = pick(r, 'รหัสอาคาร');
    if (!ltaxId) { problem('building', r._row, 'ไม่มีรหัสอาคาร'); continue; }
    if (buildingByLtax.has(ltaxId)) continue;
    const typeText = pick(r, 'ประเภทสิ่งปลูกสร้าง');
    const b = {
      ltaxId, buildingCode: pick(r, 'รหัสสิ่งปลูกสร้าง').toUpperCase(), addrNo: pick(r, 'เลขที่'), villageNo: pick(r, 'หมู่ที่'),
      villageName: pick(r, 'หมู่บ้าน/ชุนชน', 'หมู่บ้าน/ชุมชน'), road: pick(r, 'ถนน'), alley: pick(r, 'ซอย'),
      buildingType: buildingCode(typeText) || buildingCode(pick(r, 'รหัสประเภทอาคาร')),
      structure: codeByLabel(STRUCTURES, pick(r, 'ลักษณะสิ่งปลูกสร้าง')), noFloor: numStr(pick(r, 'จำนวนชั้น')),
      width: numStr(pick(r, 'ขนาดพื้นที่ กว้าง (เมตร)')), length: numStr(pick(r, 'ขนาดพื้นที่ ยาว (เมตร)')),
      age: numStr(pick(r, 'อายุสิ่งปลูกสร้าง (ปี)')), since: numStr(pick(r, 'ก่อสร้างแล้วเสร็จ ปี พ.ศ.')),
      totalArea: numStr(pick(r, 'ขนาดพื้นที่ทั้งอาคาร (ตร.ม.)')), pricePerMeter: numStr(pick(r, 'ราคาประเมินสิ่งปลูกสร้าง (บาท ต่อ ตร.ม.)')),
      note: pick(r, 'หมายเหตุ'), ownerIds: [], landIds: [], uses: [],
      ltaxValues: { totalPrice: numStr(pick(r, 'ราคาประเมินทุนทรัพย์สิ่งปลูกสร้าง (บาท)')), deprPct: numStr(pick(r, 'หักค่าเสื่อม (%)')),
        deprAmount: numStr(pick(r, 'หักค่าเสื่อม (บาท)')), netPrice: numStr(pick(r, 'คงเหลือราคาประเมินทุนทรัพย์สิ่งปลูกสร้าง (บาท)')) },
      _land: pick(r, 'รหัสที่ดิน'), _owner: pick(r, 'รหัสเจ้าของ'),
    };
    if (typeText && !b.buildingType) problem('building', r._row, `ประเภทสิ่งปลูกสร้าง "${typeText}" ไม่ตรงกับรายการของ LTAX`);
    buildingByLtax.set(ltaxId, b);
    buildings.push(b);
  }
  for (const b of buildings) {
    if (b._land) { if (landByLtax.has(b._land)) b.landIds.push(b._land); else problem('building', b.buildingCode, `ไม่พบที่ดินรหัส ${b._land}`); }
    if (b._owner) { if (ownerByLtax.has(b._owner)) b.ownerIds.push(b._owner); else problem('building', b.buildingCode, `ไม่พบเจ้าของรหัส ${b._owner}`); }
    delete b._land; delete b._owner;
  }
  for (const r of table(byName.building_detail)) {
    const b = buildingByLtax.get(pick(r, 'รหัสอาคาร'));
    if (!b) { problem('building_detail', r._row, `ไม่พบอาคารรหัส ${pick(r, 'รหัสอาคาร')}`); continue; }
    const usedText = pick(r, 'การใช้ประโยชน์');
    if (!usedText) continue;
    const u = { order: Number(pick(r, 'ลำดับการใช้')) || b.uses.length + 1, usedType: useTypeCode(usedText), useFloor: pick(r, 'ชั้นที่ใช้'), area: numStr(pick(r, 'พื้นที่ใช้')), note: pick(r, 'หมายเหตุการใช้') };
    if (!u.usedType) problem('building_detail', r._row, `การใช้ประโยชน์ "${usedText}" ไม่ตรงกับรายการของ LTAX`);
    b.uses.push(u);
  }
  for (const b of buildings) { b.uses.sort((a, c) => a.order - c.order); b.uses.forEach(u => delete u.order); }

  // Signboards (main fields only)
  const signboards = [];
  for (const r of table(byName.sign)) {
    const ltaxId = pick(r, 'รหัสป้าย');
    if (!ltaxId) continue;
    const owner = pick(r, 'รหัสเจ้าของ');
    signboards.push({
      ltaxId, signboardCode: pick(r, 'รหัสป้าย(เต็ม)'), signboardName: pick(r, 'ข้อความในป้าย', 'ชื่อสถานประกอบการ'),
      setupDate: pick(r, 'วันที่ติดตั้งป้าย'), addrNo: pick(r, 'บ้านเลขที่'), villageNo: pick(r, 'หมู่'), alley: pick(r, 'ซอย'), road: pick(r, 'ถนน'),
      villageName: pick(r, 'ชุมชน'), width: numStr(pick(r, 'ความกว้างป้าย (ซม.)')), height: numStr(pick(r, 'ความยาวป้าย (ซม.)')),
      noSide: numStr(pick(r, 'จำนวนด้าน')), unit: numStr(pick(r, 'จำนวนหน่วย')), landCode: pick(r, 'รหัสแปลง').toUpperCase(),
      ownerIds: owner && ownerByLtax.has(owner) ? [owner] : [],
    });
  }

  report.counts = { owners: owners.length, lands: lands.length, buildings: buildings.length, signboards: signboards.length,
    landUses: lands.reduce((s, l) => s + l.uses.length, 0), buildingUses: buildings.reduce((s, b) => s + b.uses.length, 0) };
  return { owners, lands, buildings, signboards, report };
}

// Merge imported records into the store collections. Links in the workbook use LTAX ids; they are
// translated to L-LAN ids here. Records with local edits keep them; only their `synced` is refreshed.
export function mergeImport(current, imported) {
  const result = { added: {}, updated: {}, keptLocal: {}, conflicts: [] };
  const idMaps = {};
  const out = {};
  for (const entity of ['owners', 'lands', 'buildings', 'signboards']) {
    const list = current[entity].map(r => ({ ...r }));
    const byLtax = new Map(list.filter(r => r.ltaxId).map(r => [String(r.ltaxId), r]));
    const map = idMaps[entity] = new Map();
    result.added[entity] = result.updated[entity] = result.keptLocal[entity] = 0;
    for (const rec of imported[entity]) {
      const old = byLtax.get(String(rec.ltaxId));
      if (old) map.set(String(rec.ltaxId), old.id); else map.set(String(rec.ltaxId), randomUUID());
    }
    out[entity] = { list, byLtax, incoming: imported[entity] };
  }
  const relink = (rec, key, entity) => { if (rec[key]) rec[key] = rec[key].map(x => idMaps[entity].get(String(x))).filter(Boolean); };
  for (const entity of ['owners', 'lands', 'buildings', 'signboards']) {
    const { list, byLtax, incoming } = out[entity];
    for (const raw of incoming) {
      const rec = { ...raw, id: idMaps[entity].get(String(raw.ltaxId)) };
      relink(rec, 'ownerIds', 'owners');
      relink(rec, 'landIds', 'lands');
      rec.synced = syncFields(entity, rec);
      rec.source = 'ltax-xlsx';
      const old = byLtax.get(String(raw.ltaxId));
      if (!old) { list.push(rec); result.added[entity]++; continue; }
      const local = pendingState(entity, old);
      if (!local.action) { Object.assign(old, rec); result.updated[entity]++; continue; }
      // Local edits win; report fields that LTAX changed too.
      for (const c of local.changes) {
        const ltaxNow = rec.synced[c.field] ?? '';
        if (!c.field.startsWith('uses') && ltaxNow !== c.before) result.conflicts.push({ entity, id: old.id, field: c.th, local: c.after, ltax: ltaxNow });
      }
      old.synced = rec.synced;
      old.ltaxId = rec.ltaxId;
      old.ltaxValues = rec.ltaxValues;
      result.keptLocal[entity]++;
    }
  }
  return { collections: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.list])), result };
}
