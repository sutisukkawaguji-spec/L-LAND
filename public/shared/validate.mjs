// Data checks before anything is sent to LTAX. level 'error' blocks sending; 'warn' is shown only.
import { ENTITIES, BUILDING_TYPES, LAND_USE_TYPES } from './schema.mjs';
import { num, landWah, usesWah, toWah, polygonArea, validThaiId, buddhistYearNow, formatNumber } from './calc.mjs';

const issue = (level, entity, id, field, message) => ({ level, entity, id, field, message });
const blank = v => v === null || v === undefined || String(v).trim() === '';

function requiredFields(entity, rec, out, defs = ENTITIES[entity].fields, prefix = '', id = rec.id) {
  for (const d of defs) if (d.required && blank(rec[d.key])) out.push(issue('error', entity, id, prefix + d.key, `ไม่ได้กรอก${d.th}`));
}

function inList(entity, rec, out, defs, prefix = '', id = rec.id) {
  for (const d of defs) {
    if (d.type !== 'select' || blank(rec[d.key])) continue;
    if (!d.list.some(([v]) => v === String(rec[d.key]))) out.push(issue('error', entity, id, prefix + d.key, `${d.th} "${rec[d.key]}" ไม่ตรงกับรายการของ LTAX`));
  }
}

// A field still holding the value LTAX gave us is never written back, so its problem can't block sending.
const normV = v => (v === null || v === undefined ? '' : String(v).trim());
function softenUnchanged(rec, out) {
  if (!rec.synced) return out;
  for (const x of out) {
    if (x.level !== 'error' || !x.field) continue;
    const m = x.field.match(/^uses\.(\d+)\.(\w+)$/);
    const was = m ? rec.synced.uses?.[m[1]]?.[m[2]] : rec.synced[x.field];
    const now = m ? rec.uses?.[m[1]]?.[m[2]] : rec[x.field];
    if (was !== undefined && normV(was) === normV(now)) { x.level = 'warn'; x.message += ' (ค่าเดิมจาก LTAX)'; }
  }
  return out;
}
// Use rows that came from LTAX unchanged (the LTAX export lacks some columns, e.g. การเกษตรที่ทำ).
const useFromLtax = (rec, i) => {
  const s = rec.synced?.uses?.[i], u = rec.uses?.[i];
  return !!s && !!u && Object.keys(s).every(k => normV(s[k]) === normV(u[k]));
};

export function checkOwner(o, ctx) {
  const out = [];
  requiredFields('owners', o, out);
  inList('owners', o, out, ENTITIES.owners.fields);
  const person = o.personType === 'บุคคลธรรมดา';
  if (person && blank(o.lastName)) out.push(issue('error', 'owners', o.id, 'lastName', 'บุคคลธรรมดาต้องมีนามสกุล'));
  if (blank(o.psnId)) out.push(issue('warn', 'owners', o.id, 'psnId', 'ยังไม่มีเลขประจำตัวประชาชน'));
  else if (!validThaiId(String(o.psnId))) out.push(issue('error', 'owners', o.id, 'psnId', `เลขประจำตัว ${o.psnId} ไม่ถูกต้อง (ต้องเป็นเลข 13 หลักที่ตรวจหลักสุดท้ายผ่าน)`));
  for (const k of ['postalCode', 'currPostalCode'])
    if (!blank(o[k]) && !/^\d{5}$/.test(o[k])) out.push(issue('error', 'owners', o.id, k, 'รหัสไปรษณีย์ต้องเป็นตัวเลข 5 หลัก'));
  if (!blank(o.email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) out.push(issue('warn', 'owners', o.id, 'email', 'รูปแบบอีเมลไม่ถูกต้อง'));
  if (!blank(o.psnId) && ctx.ownersByPsn.get(String(o.psnId)) > 1)
    out.push(issue('error', 'owners', o.id, 'psnId', `เลขประจำตัว ${o.psnId} ซ้ำกับเจ้าของรายอื่น`));
  return out;
}

export function checkLand(l, ctx) {
  const out = [];
  requiredFields('lands', l, out);
  inList('lands', l, out, ENTITIES.lands.fields);
  if (!blank(l.parcelCode) && !/^\d{2}[A-Z]\d{3}$/.test(l.parcelCode))
    out.push(issue('warn', 'lands', l.id, 'parcelCode', `รหัสแปลง ${l.parcelCode} ไม่อยู่ในรูปแบบ เช่น 60A002`));
  if (!blank(l.parcelCode) && ctx.landsByCode.get(l.parcelCode) > 1)
    out.push(issue('error', 'lands', l.id, 'parcelCode', `รหัสแปลง ${l.parcelCode} ซ้ำกับแปลงอื่น`));
  const docKey = `${l.docType}|${l.docNo}`;
  if (!blank(l.docNo) && ctx.landsByDoc.get(docKey) > 1)
    out.push(issue('warn', 'lands', l.id, 'docNo', `เอกสารสิทธิ์เลขที่ ${l.docNo} ซ้ำกับแปลงอื่น`));
  const ngan = num(l.ngan), wah = num(l.wah);
  if (ngan !== null && (ngan < 0 || ngan > 3 || !Number.isInteger(ngan))) out.push(issue('error', 'lands', l.id, 'ngan', 'งานต้องเป็นจำนวนเต็ม 0–3'));
  if (wah !== null && (wah < 0 || wah >= 100)) out.push(issue('error', 'lands', l.id, 'wah', 'ตร.ว. ต้องอยู่ระหว่าง 0–99.99'));
  const total = landWah(l);
  if (blank(l.pricePerWah)) out.push(issue('warn', 'lands', l.id, 'pricePerWah', 'ยังไม่มีราคาประเมินที่ดินต่อ ตร.ว.'));
  if (total <= 0) out.push(issue('error', 'lands', l.id, 'rai', 'ยังไม่มีเนื้อที่'));
  if (!(l.ownerIds || []).length) out.push(issue('warn', 'lands', l.id, 'ownerIds', 'ยังไม่กำหนดเจ้าของแปลงที่ดิน'));
  for (const oid of l.ownerIds || []) if (!ctx.owners.has(oid)) out.push(issue('error', 'lands', l.id, 'ownerIds', 'เจ้าของที่ผูกไว้ไม่มีในทะเบียน'));

  const uses = l.uses || [];
  if (!uses.length) out.push(issue('warn', 'lands', l.id, 'uses', 'ยังไม่ได้บันทึกการใช้ประโยชน์'));
  uses.forEach((u, i) => {
    const p = `uses.${i}.`;
    requiredFields('lands', u, out, ENTITIES.lands.uses, p, l.id);
    inList('lands', u, out, ENTITIES.lands.uses, p, l.id);
    if (toWah(u.rai, u.ngan, u.wah) <= 0) out.push(issue('error', 'lands', l.id, p + 'rai', `การใช้ประโยชน์ลำดับ ${i + 1} ไม่มีเนื้อที่`));
    if (!useFromLtax(l, i)) {
      if (u.usedType === '1' && blank(u.agriType)) out.push(issue('warn', 'lands', l.id, p + 'agriType', `การใช้ประโยชน์ลำดับ ${i + 1} เป็นเกษตรกรรมแต่ยังไม่ระบุการเกษตรที่ทำ`));
      if (['2', '3'].includes(u.usedFor) && blank(u.usedBy)) out.push(issue('warn', 'lands', l.id, p + 'usedBy', `การใช้ประโยชน์ลำดับ ${i + 1} ยังไม่ระบุชื่อผู้ทำประโยชน์`));
    }
  });
  const used = usesWah(uses);
  if (total > 0 && used - total > 0.005)
    out.push(issue('error', 'lands', l.id, 'uses', `เนื้อที่ใช้ประโยชน์รวม ${formatNumber(used)} ตร.ว. เกินเนื้อที่แปลง ${formatNumber(total)} ตร.ว.`));
  else if (uses.length && total - used > 0.005)
    out.push(issue('warn', 'lands', l.id, 'uses', `ยังใช้ประโยชน์ไม่เต็มแปลง เหลือ ${formatNumber(total - used)} ตร.ว.`));

  const parcel = ctx.parcelsByCode.get(l.parcelCode);
  if (parcel && total > 0) {
    const mapWah = (parcel.areaM2 ?? polygonArea(parcel.geometry)) / 4;
    const diff = Math.abs(mapWah - total) / total;
    if (diff > ctx.areaTolerance) out.push(issue('warn', 'lands', l.id, 'rai',
      `เนื้อที่ตามเอกสาร ${formatNumber(total)} ตร.ว. ต่างจากรูปแปลงในแผนที่ ${formatNumber(mapWah)} ตร.ว. (${Math.round(diff * 100)}%)`));
  }
  return out;
}

export function checkBuilding(b, ctx) {
  const out = [];
  requiredFields('buildings', b, out);
  inList('buildings', b, out, ENTITIES.buildings.fields);
  const type = BUILDING_TYPES.find(([c]) => c === b.buildingType);
  const structureWord = { 1: 'ไม้', 2: 'ตึก', 3: 'ครึ่งตึกครึ่งไม้' }[b.structure];
  if (type && structureWord && /ไม้|ตึก/.test(type[1])) {
    const half = type[1].includes('ครึ่งตึกครึ่งไม้');
    const fits = half ? structureWord === 'ครึ่งตึกครึ่งไม้' : type[1].includes(structureWord) && structureWord !== 'ครึ่งตึกครึ่งไม้';
    if (!fits) out.push(issue('warn', 'buildings', b.id, 'structure', `ลักษณะ "${structureWord}" ไม่ตรงกับประเภท "${type[1]}"`));
  }
  const floors = num(b.noFloor), w = num(b.width), len = num(b.length), area = num(b.totalArea);
  if (floors !== null && floors <= 0) out.push(issue('error', 'buildings', b.id, 'noFloor', 'จำนวนชั้นต้องมากกว่า 0'));
  if (w && len && floors && area) {
    const expect = w * len * floors;
    if (Math.abs(expect - area) > Math.max(1, expect * 0.01))
      out.push(issue('warn', 'buildings', b.id, 'totalArea', `พื้นที่ทั้งอาคาร ${formatNumber(area)} ตร.ม. ไม่เท่ากับ กว้าง×ยาว×ชั้น = ${formatNumber(expect)} ตร.ม.`));
  }
  if (blank(b.pricePerMeter)) out.push(issue('warn', 'buildings', b.id, 'pricePerMeter', 'ยังไม่มีราคาประเมินสิ่งปลูกสร้างต่อ ตร.ม.'));
  if (!area && !(w && len)) out.push(issue('error', 'buildings', b.id, 'totalArea', 'ยังไม่มีขนาดพื้นที่'));
  const since = num(b.since), now = buddhistYearNow();
  if (since !== null && (since < 2400 || since > now)) out.push(issue('error', 'buildings', b.id, 'since', `ปีที่สร้างเสร็จ ${since} ไม่ใช่ปี พ.ศ. ที่เป็นไปได้`));
  if (since !== null && num(b.age) !== null && Math.abs(now - since - num(b.age)) > 1)
    out.push(issue('warn', 'buildings', b.id, 'age', `อายุ ${b.age} ปี ไม่ตรงกับปีที่สร้างเสร็จ ${since}`));
  if (!(b.landIds || []).length) out.push(issue('warn', 'buildings', b.id, 'landIds', 'ยังไม่ได้กำหนดแปลงที่ดิน'));
  for (const lid of b.landIds || []) if (!ctx.lands.has(lid)) out.push(issue('error', 'buildings', b.id, 'landIds', 'แปลงที่ดินที่ผูกไว้ไม่มีในทะเบียน'));
  if (!(b.ownerIds || []).length) out.push(issue('warn', 'buildings', b.id, 'ownerIds', 'ยังไม่กำหนดเจ้าของสิ่งปลูกสร้าง'));
  const uses = b.uses || [];
  if (!uses.length) out.push(issue('warn', 'buildings', b.id, 'uses', 'ยังไม่ได้บันทึกการใช้ประโยชน์'));
  const landUseTypes = new Set((b.landIds || []).flatMap(lid => (ctx.lands.get(lid)?.uses || []).map(u => u.usedType)));
  uses.forEach((u, i) => {
    const p = `uses.${i}.`;
    requiredFields('buildings', u, out, ENTITIES.buildings.uses, p, b.id);
    inList('buildings', u, out, ENTITIES.buildings.uses, p, b.id);
    if (u.usedType && landUseTypes.size && !landUseTypes.has(u.usedType)) {
      const t = LAND_USE_TYPES.find(([v]) => v === u.usedType)?.[1] || u.usedType;
      out.push(issue('warn', 'buildings', b.id, p + 'usedType', `การใช้ประโยชน์ "${t}" ไม่มีในการใช้ประโยชน์ของแปลงที่ดินที่ตั้ง LTAX อาจไม่ให้เลือก`));
    }
  });
  const usedArea = uses.reduce((s, u) => s + (u.fullArea ? (area || 0) : num(u.area) || 0), 0);
  if (area && usedArea - area > 0.005) out.push(issue('error', 'buildings', b.id, 'uses', `พื้นที่ใช้ประโยชน์รวม ${formatNumber(usedArea)} ตร.ม. เกินพื้นที่อาคาร ${formatNumber(area)} ตร.ม.`));
  return out;
}

export function checkSignboard(s, ctx) {
  const out = [];
  requiredFields('signboards', s, out);
  inList('signboards', s, out, ENTITIES.signboards.fields);
  if (!(num(s.width) > 0 && num(s.height) > 0)) out.push(issue('error', 'signboards', s.id, 'width', 'ยังไม่มีขนาดป้าย'));
  if (!(s.ownerIds || []).length) out.push(issue('warn', 'signboards', s.id, 'ownerIds', 'ยังไม่กำหนดเจ้าของป้าย'));
  return out;
}

export function checkParcel(p, ctx) {
  const out = [];
  if (!p.parcelCode) out.push(issue('warn', 'parcels', p.id, 'parcelCode', 'รูปแปลงยังไม่มีรหัสแปลงที่ดิน'));
  else if (!ctx.landsByCodeRec.has(p.parcelCode)) out.push(issue('warn', 'parcels', p.id, 'parcelCode', `รูปแปลง ${p.parcelCode} ยังไม่มีข้อมูลที่ดินในทะเบียน`));
  if (p.geometry && (p.areaM2 ?? polygonArea(p.geometry)) <= 0) out.push(issue('error', 'parcels', p.id, 'geometry', 'รูปแปลงไม่มีพื้นที่'));
  return out;
}

const countBy = (items, key) => {
  const m = new Map();
  for (const it of items) { const k = key(it); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return m;
};

export function buildContext(db, opts = {}) {
  return {
    owners: new Map(db.owners.map(o => [o.id, o])),
    lands: new Map(db.lands.map(l => [l.id, l])),
    ownersByPsn: countBy(db.owners, o => (o.psnId ? String(o.psnId) : '')),
    landsByCode: countBy(db.lands, l => l.parcelCode),
    landsByCodeRec: new Map(db.lands.filter(l => l.parcelCode).map(l => [l.parcelCode, l])),
    landsByDoc: countBy(db.lands, l => (l.docNo ? `${l.docType}|${l.docNo}` : '')),
    parcelsByCode: new Map((db.parcels || []).filter(p => p.parcelCode).map(p => [p.parcelCode, p])),
    areaTolerance: opts.areaTolerance ?? 0.1,
  };
}

const CHECKS = { owners: checkOwner, lands: checkLand, buildings: checkBuilding, signboards: checkSignboard, parcels: checkParcel };

export function validateAll(db, opts) {
  const ctx = buildContext(db, opts);
  const out = [];
  for (const [entity, check] of Object.entries(CHECKS)) for (const rec of db[entity] || []) out.push(...softenUnchanged(rec, check(rec, ctx)));
  return out;
}

export function validateRecord(entity, rec, db, opts) {
  const ctx = buildContext(db, opts);
  return softenUnchanged(rec, CHECKS[entity](rec, ctx));
}
