// "ตารางแบบฟอร์ม LTAX": the register as an Excel workbook laid out like the LTAX ONLINE entry forms
// (AST001). One sheet per form, one column per form field, the same labels and the same choices as LTAX.
// Filled in or corrected in Excel, the file comes back through planTableImport (check first) and
// applyTableImport; what changed then waits in "รอส่ง LTAX" for the office to put into LTAX.
// Browser-safe (also runs on the web page).
import { ENTITIES, label } from '../public/shared/schema.mjs';
import { pendingState } from '../public/shared/diff.mjs';
import { validateAll } from '../public/shared/validate.mjs';
import { XLSX_STYLE } from './xlsx.mjs';

const RECORDS = ['owners', 'lands', 'buildings', 'signboards'];
export const TABLE_SHEETS = { owners: 'เจ้าของ', lands: 'ที่ดิน', landUses: 'การใช้ประโยชน์ที่ดิน', buildings: 'สิ่งปลูกสร้าง', buildingUses: 'การใช้ประโยชน์อาคาร', signboards: 'ป้าย' };
const LISTS_SHEET = 'รายการให้เลือก';
const HELP_SHEET = 'วิธีใช้';
// Columns that are not form fields
const COL = {
  id: 'รหัส L-LAN (ห้ามแก้)',
  ltaxId: 'รหัสใน LTAX (ดูอย่างเดียว)',
  state: 'สถานะกับ LTAX (ดูอย่างเดียว)',
  owners: 'เจ้าของ (เลขประจำตัวประชาชน)',
  ownerNames: 'ชื่อเจ้าของ (ดูอย่างเดียว)',
  lands: 'รหัสแปลงที่ดินที่ตั้ง',
  parentId: 'รหัส L-LAN ของรายการหลัก (ห้ามแก้)',
  landCode: 'รหัสแปลงที่ดิน',
  buildingCode: 'รหัสสิ่งปลูกสร้าง',
  order: 'ลำดับ',
};
const STATE_TH = { create: 'ยังไม่มีใน LTAX', update: 'แก้ไขแล้ว รอส่ง', '': 'ตรงกับ LTAX' };
const YES = new Set(['ใช่', 'y', 'yes', '1', 'true', '✓', '/', 'x', 'มี']);

const squash = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const sheetKey = s => squash(s).toLowerCase();
const codeOf = v => squash(v).toUpperCase();
const digits = v => String(v ?? '').replace(/[\s-]/g, '');

// Field columns of one form; labels that repeat inside a form (owner addresses) get their group in front.
function fieldColumns(fields) {
  const seen = new Map();
  for (const f of fields) seen.set(f.th, (seen.get(f.th) || 0) + 1);
  return fields.map(f => ({ header: seen.get(f.th) > 1 && f.group ? `${f.group}: ${f.th}` : f.th, field: f }));
}
const FORM = {
  owners: { cols: fieldColumns(ENTITIES.owners.fields), links: [] },
  lands: { cols: fieldColumns(ENTITIES.lands.fields), links: ['owners'] },
  buildings: { cols: fieldColumns(ENTITIES.buildings.fields), links: ['lands', 'owners'] },
  signboards: { cols: fieldColumns(ENTITIES.signboards.fields), links: ['land', 'owners'] },
  landUses: { cols: fieldColumns(ENTITIES.lands.uses), parent: 'lands' },
  buildingUses: { cols: fieldColumns(ENTITIES.buildings.uses), parent: 'buildings' },
};

// ---------- values: record → cell, cell → record ----------
function toCell(f, v) {
  if (f.type === 'checkbox') return v ? 'ใช่' : '';
  if (v === null || v === undefined || v === '') return '';
  if (f.type === 'select') return label(f.list, v) || String(v);
  if (f.type === 'number') { const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) && String(v).trim() !== '' ? n : String(v); }
  return String(v);
}
// → { value } or { error }
function fromCell(f, raw) {
  const v = squash(raw);
  if (f.type === 'checkbox') return { value: YES.has(v.toLowerCase()) };
  if (!v) return { value: '' };
  if (f.type === 'select') {
    const hit = f.list.find(([, l]) => squash(l) === v) || f.list.find(([c]) => c === v)
      || f.list.find(([c]) => v.startsWith(`${c} -`) || v.startsWith(`${c}-`) || v.startsWith(`${c} `));
    return hit ? { value: hit[0] } : { error: `"${v}" ไม่อยู่ในรายการของช่อง "${f.th}" (ดูชีต ${LISTS_SHEET})` };
  }
  if (f.type === 'number') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? { value: String(Math.round(n * 1e6) / 1e6) } : { error: `ช่อง "${f.th}" ต้องเป็นตัวเลข (พบ "${v}")` };
  }
  if (f.key === 'psnId' && /^\d{13}$/.test(digits(v))) return { value: digits(v) };
  return { value: v };
}

// ---------- export ----------
const ownerName = o => (o ? [o.prefixName, o.firstName, o.lastName].filter(Boolean).join(' ') : '');
const ownerRef = o => (o ? (o.psnId ? digits(o.psnId) : o.id) : '');

// scope: 'all' | 'pending' (only what still has to go to LTAX) | 'blank' (headers and choices only)
export function buildLtaxTable(db, { scope = 'all' } = {}) {
  const owners = new Map(db.owners.map(o => [o.id, o]));
  const lands = new Map(db.lands.map(l => [l.id, l]));
  const codeCount = new Map();
  for (const l of db.lands) { const c = codeOf(l.parcelCode); if (c) codeCount.set(c, (codeCount.get(c) || 0) + 1); }
  const landRef = l => (l ? (l.parcelCode && codeCount.get(codeOf(l.parcelCode)) === 1 ? codeOf(l.parcelCode) : l.id) : '');
  const pick = entity => (scope === 'blank' ? [] : scope === 'pending' ? db[entity].filter(r => pendingState(entity, r).action) : db[entity]);

  // Choices sheet: one column per list, referenced by the drop-downs.
  const lists = [];
  const listOf = f => {
    let l = lists.find(x => x.list === f.list);
    if (!l) { l = { list: f.list, header: f.th, key: `L${lists.length}`, col: lists.length }; lists.push(l); }
    return l;
  };
  const letter = i => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

  const sheet = (name, form, rows, extra) => {
    const columns = [...extra.before, ...form.cols.map(c => ({ header: c.header, key: c.field.key,
      headerStyle: c.field.required ? XLSX_STYLE.required : XLSX_STYLE.header, style: c.field.type === 'number' ? undefined : XLSX_STYLE.text })), ...(extra.after || [])];
    const validations = form.cols.filter(c => c.field.type === 'select' || c.field.type === 'checkbox').map(c => {
      if (c.field.type === 'checkbox') return { key: c.field.key, formula: '"ใช่"' };
      const l = listOf(c.field);
      return { key: c.field.key, formula: `'${LISTS_SHEET}'!$${letter(l.col)}$2:$${letter(l.col)}$${l.list.length + 1}` };
    });
    return { name, columns, rows, validations };
  };
  const ro = (header, key, width) => ({ header, key, width, headerStyle: XLSX_STYLE.readOnlyHeader, style: XLSX_STYLE.readOnly });
  const tx = (header, key, width) => ({ header, key, width, style: XLSX_STYLE.text });
  const base = (entity, r) => ({ __id: r.id, __ltax: r.ltaxId || '', __state: STATE_TH[pendingState(entity, r).action || ''] });
  const fields = (form, r) => Object.fromEntries(form.cols.map(c => [c.field.key, toCell(c.field, r[c.field.key])]));
  const head = [ro(COL.id, '__id', 12), ro(COL.ltaxId, '__ltax', 12), ro(COL.state, '__state', 16)];
  const ownerCols = [tx(COL.owners, '__owners', 30), ro(COL.ownerNames, '__ownerNames', 30)];
  const linkOwners = ids => ({ __owners: (ids || []).map(id => ownerRef(owners.get(id))).filter(Boolean).join(', '), __ownerNames: (ids || []).map(id => ownerName(owners.get(id))).filter(Boolean).join(', ') });

  const ownerRows = pick('owners').map(o => ({ ...base('owners', o), ...fields(FORM.owners, o) }));
  const landList = pick('lands');
  const landRows = landList.map(l => ({ ...base('lands', l), ...fields(FORM.lands, l), ...linkOwners(l.ownerIds) }));
  const landUseRows = landList.flatMap(l => (l.uses || []).map((u, i) => ({ __parent: l.id, __code: landRef(l), __order: i + 1, ...fields(FORM.landUses, u) })));
  const buildingList = pick('buildings');
  const buildingRows = buildingList.map(b => ({ ...base('buildings', b), ...fields(FORM.buildings, b),
    __lands: (b.landIds || []).map(id => landRef(lands.get(id))).filter(Boolean).join(', '), ...linkOwners(b.ownerIds) }));
  const buildingUseRows = buildingList.flatMap(b => (b.uses || []).map((u, i) => ({ __parent: b.id, __code: b.buildingCode || '', __order: i + 1, ...fields(FORM.buildingUses, u) })));
  const signRows = pick('signboards').map(s => ({ ...base('signboards', s), ...fields(FORM.signboards, s), __lands: landRef(lands.get(s.landId)), ...linkOwners(s.ownerIds) }));

  const sheets = [
    sheet(TABLE_SHEETS.owners, FORM.owners, ownerRows, { before: head }),
    sheet(TABLE_SHEETS.lands, FORM.lands, landRows, { before: head, after: ownerCols }),
    sheet(TABLE_SHEETS.landUses, FORM.landUses, landUseRows, { before: [ro(COL.parentId, '__parent', 12), tx(COL.landCode, '__code', 14), { header: COL.order, key: '__order', width: 7 }] }),
    sheet(TABLE_SHEETS.buildings, FORM.buildings, buildingRows, { before: head, after: [tx(COL.lands, '__lands', 18), ...ownerCols] }),
    sheet(TABLE_SHEETS.buildingUses, FORM.buildingUses, buildingUseRows, { before: [ro(COL.parentId, '__parent', 12), tx(COL.buildingCode, '__code', 16), { header: COL.order, key: '__order', width: 7 }] }),
    sheet(TABLE_SHEETS.signboards, FORM.signboards, signRows, { before: head, after: [tx(COL.lands, '__lands', 18), ...ownerCols] }),
  ];
  const height = Math.max(0, ...lists.map(l => l.list.length));
  sheets.push({ name: LISTS_SHEET, columns: lists.map(l => ({ header: l.header, key: l.key, width: 30 })),
    rows: Array.from({ length: height }, (_, i) => Object.fromEntries(lists.map(l => [l.key, l.list[i]?.[1] ?? '']))) });
  sheets.push({ name: HELP_SHEET, columns: [{ header: 'วิธีใช้ตารางแบบฟอร์ม LTAX', key: 't', width: 120 }], rows: HELP.map(t => ({ t })) });
  return sheets;
}

const HELP = [
  'แต่ละชีตคือหน้าบันทึกข้อมูลหนึ่งหน้าของ LTAX ONLINE (ทะเบียนทรัพย์สิน AST001) หนึ่งแถวคือหนึ่งรายการ หัวคอลัมน์คือช่องในหน้าบันทึกของ LTAX',
  'หัวคอลัมน์สีแดง = ช่องที่ LTAX บังคับกรอก · คอลัมน์สีเทา = ดูอย่างเดียว แก้ไปก็ไม่มีผล',
  `"${COL.id}": อย่าแก้หรือลบ ใช้จับคู่กับรายการเดิมใน L-LAN · แถวใหม่ให้เว้นว่างไว้`,
  'ถ้าไม่มีรหัส L-LAN ระบบจับคู่จาก เลขประจำตัวประชาชน (เจ้าของ) / รหัสแปลงที่ดิน (ที่ดิน) / รหัสสิ่งปลูกสร้าง / รหัสป้าย ไม่พบจึงเพิ่มเป็นรายการใหม่',
  'ช่องที่มีตัวเลือก: เลือกจากลูกศรในช่อง (รายการทั้งหมดอยู่ในชีต "รายการให้เลือก") จะพิมพ์รหัสแทนก็ได้ เช่น 1 = โฉนด',
  `"${COL.owners}": ใส่เลขประจำตัวประชาชนของเจ้าของ คั่นด้วยจุลภาคถ้ามีหลายคน (เจ้าของที่ไม่มีเลขใช้รหัส L-LAN หรือชื่อเต็มแทนได้)`,
  `"${COL.lands}": ใส่รหัสแปลงที่ดิน คั่นด้วยจุลภาคถ้ามีหลายแปลง`,
  'ชีตการใช้ประโยชน์: หนึ่งแถวต่อการใช้ประโยชน์หนึ่งรายการ อ้างแปลง/อาคารด้วยรหัส ถ้ามีแถวของแปลงไหน รายการการใช้ประโยชน์ของแปลงนั้นจะถูกแทนด้วยแถวในตารางทั้งหมด',
  'ช่องที่เว้นว่างในแถวของรายการเดิม = ลบค่านั้นออก · ลบทั้งคอลัมน์ออก = ไม่แตะช่องนั้น',
  'นำเข้า: L-LAN → นำเข้า / ส่งออก → "ตารางแบบฟอร์ม LTAX" → เลือกไฟล์ → "ตรวจไฟล์ก่อน" ดูสิ่งที่จะเปลี่ยน แล้วกด "นำเข้า"',
  'รายการที่นำเข้าจะไปอยู่ในรายการรอส่ง LTAX เครื่องสำนักงานส่งเข้า LTAX ตามขั้นตอนปกติ (ทดลองก่อน แล้วจึงบันทึกจริง)',
  'ไฟล์นี้มีชื่อและเลขประจำตัวประชาชนของผู้เสียภาษี เก็บรักษาเหมือนเอกสารราชการ',
];

// ---------- import ----------
// The plan of what a filled-in table would change. Nothing is saved here.
export function planTableImport(db, sheets, { areaTolerance = 0.1 } = {}) {
  const problems = [];
  const say = (sheet, row, message, level = 'error') => problems.push({ sheet, row, message, level });
  const found = [];
  const next = Object.fromEntries(RECORDS.map(e => [e, new Map()])); // id → record as it would be
  const fresh = new Set(); // ids of new records
  const byId = Object.fromEntries(RECORDS.map(e => [e, new Map(db[e].map(r => [r.id, r]))]));
  const current = (entity, id) => next[entity].get(id) || byId[entity].get(id) || null;
  const all = entity => { const m = new Map(byId[entity]); for (const [id, r] of next[entity]) m.set(id, r); return [...m.values()]; };

  const read = key => {
    const s = sheets.find(x => sheetKey(x.name) === sheetKey(TABLE_SHEETS[key]) || sheetKey(x.name) === key.toLowerCase());
    if (!s || !s.rows.length) return null;
    found.push(TABLE_SHEETS[key]);
    const header = s.rows[0].map(squash);
    const at = name => header.indexOf(name);
    const cols = FORM[key].cols.map(c => ({ ...c, i: [c.header, c.field.key, c.field.th].map(at).find(i => i >= 0) ?? -1 })).filter(c => c.i >= 0);
    const rows = s.rows.slice(1).map((cells, n) => ({ row: n + 2, cells, get: name => { const i = at(name); return i >= 0 ? squash(cells[i]) : null; } }))
      .filter(r => r.cells.some(c => squash(c) !== ''));
    return { name: TABLE_SHEETS[key], cols, rows, has: name => at(name) >= 0 };
  };
  // Values that do not fit the form are reported, unless they are what L-LAN already holds (values
  // read from LTAX itself, e.g. a map scale missing from the list): those stay as they are.
  const setFields = (sheet, r, rec, cols) => {
    const bad = [];
    for (const c of cols) {
      const out = fromCell(c.field, r.cells[c.i]);
      if (out.error) bad.push({ c, raw: squash(r.cells[c.i]), error: out.error });
      else rec[c.field.key] = out.value;
    }
    return (keep = () => []) => {
      for (const b of bad) {
        const same = keep(b.c.field).find(v => v !== undefined && v !== '' && squash(toCell(b.c.field, v)) === b.raw);
        if (same !== undefined) rec[b.c.field.key] = same; else say(sheet.name, r.row, b.error);
      }
    };
  };

  // Lookups that also see what this file adds.
  const ownerIndex = () => {
    const byPsn = new Map(), byName = new Map();
    for (const o of all('owners')) {
      if (o.psnId) byPsn.set(digits(o.psnId), o.id);
      const n = squash(ownerName(o)); if (n) byName.set(n, byName.has(n) ? null : o.id);
    }
    return token => byPsn.get(digits(token)) || (current('owners', token) ? token : null) || byName.get(squash(token)) || null;
  };
  const landIndex = () => {
    const byCode = new Map();
    for (const l of all('lands')) { const c = codeOf(l.parcelCode); if (c) byCode.set(c, byCode.has(c) ? null : l.id); }
    return token => (current('lands', token) ? token : byCode.get(codeOf(token)) || null);
  };
  const splitRefs = v => String(v || '').split(/[,;\n]+/).map(squash).filter(Boolean);

  const natural = { owners: r => (r.psnId ? ['psnId', digits(r.psnId)] : null), lands: r => (r.parcelCode ? ['parcelCode', codeOf(r.parcelCode)] : null),
    buildings: r => (r.buildingCode ? ['buildingCode', codeOf(r.buildingCode)] : null), signboards: r => (r.signboardCode ? ['signboardCode', codeOf(r.signboardCode)] : null) };

  for (const entity of RECORDS) {
    const sheet = read(entity);
    if (!sheet) continue;
    const taken = new Map();
    const owners = ownerIndex(), lands = entity === 'buildings' || entity === 'signboards' ? landIndex() : null;
    // The records' own codes (psnId, parcelCode ...), kept up to date as rows are read.
    const nkIndex = new Map();
    const index = rec => { const nk = natural[entity](rec); if (nk) { if (!nkIndex.has(nk[1])) nkIndex.set(nk[1], new Set()); nkIndex.get(nk[1]).add(rec.id); } };
    for (const rec of all(entity)) index(rec);
    for (const r of sheet.rows) {
      const idCell = r.get(COL.id);
      const draft = {};
      const settle = setFields(sheet, r, draft, sheet.cols);
      // Which record this row is: L-LAN id, else the record's own code, else a new one.
      let old = idCell ? current(entity, idCell) : null;
      if (idCell && !old) say(sheet.name, r.row, `ไม่พบรหัส L-LAN ${idCell} (อาจถูกลบไปแล้ว) จะจับคู่ด้วยรหัสของรายการแทน`, 'warn');
      if (!old) {
        const nk = natural[entity](draft);
        if (nk) {
          const hits = [...(nkIndex.get(nk[1]) || [])].map(hid => current(entity, hid)).filter(Boolean);
          if (hits.length === 1) old = hits[0];
          else if (hits.length > 1) { say(sheet.name, r.row, `${ENTITIES[entity].th} รหัส ${nk[1]} มีใน L-LAN ${hits.length} รายการ ใส่รหัส L-LAN เพื่อระบุรายการ`); continue; }
        }
      }
      settle(f => [old?.[f.key]]);
      const id = old?.id || globalThis.crypto.randomUUID();
      if (taken.has(id)) { say(sheet.name, r.row, `ซ้ำกับแถว ${taken.get(id)} (รายการเดียวกัน) ข้ามแถวนี้`); continue; }
      taken.set(id, r.row);
      const rec = { ...(old || {}), ...draft, id };
      if (!old) { fresh.add(id); rec.uses = rec.uses || (ENTITIES[entity].uses ? [] : undefined); if (rec.uses === undefined) delete rec.uses; }
      if (FORM[entity].links.includes('owners') && sheet.has(COL.owners)) {
        const ids = [];
        for (const t of splitRefs(r.get(COL.owners))) { const oid = owners(t); if (oid) ids.push(oid); else say(sheet.name, r.row, `ไม่พบเจ้าของ "${t}" (ใส่เลขประจำตัวประชาชนที่มีในชีตเจ้าของหรือใน L-LAN)`); }
        rec.ownerIds = [...new Set(ids)];
      }
      if ((FORM[entity].links.includes('lands') || FORM[entity].links.includes('land')) && sheet.has(COL.lands)) {
        const ids = [];
        for (const t of splitRefs(r.get(COL.lands))) { const lid = lands(t); if (lid) ids.push(lid); else say(sheet.name, r.row, `ไม่พบแปลงที่ดิน "${t}"`); }
        if (entity === 'signboards') { rec.landId = ids[0] || ''; if (ids.length > 1) say(sheet.name, r.row, 'ป้ายอยู่ได้แปลงเดียว ใช้แปลงแรก', 'warn'); } else rec.landIds = [...new Set(ids)];
      }
      next[entity].set(id, rec);
      index(rec);
    }
  }

  // Uses: rows of one land / building replace its whole list.
  for (const [key, entity, codeCol] of [['landUses', 'lands', COL.landCode], ['buildingUses', 'buildings', COL.buildingCode]]) {
    const sheet = read(key);
    if (!sheet) continue;
    const lands = landIndex();
    const byBuilding = new Map();
    for (const b of all('buildings')) { const c = codeOf(b.buildingCode); if (c) byBuilding.set(c, byBuilding.has(c) ? null : b.id); }
    const groups = new Map();
    for (const r of sheet.rows) {
      const pid = r.get(COL.parentId), code = r.get(codeCol);
      const parent = (pid && current(entity, pid)?.id) || (code && (entity === 'lands' ? lands(code) : byBuilding.get(codeOf(code))));
      if (!parent) { say(sheet.name, r.row, `ไม่พบ${entity === 'lands' ? 'แปลงที่ดิน' : 'สิ่งปลูกสร้าง'} "${code || pid || ''}" ของแถวนี้`); continue; }
      const use = {};
      setFields(sheet, r, use, sheet.cols)(f => (current(entity, parent)?.uses || []).map(u => u[f.key]));
      const order = Number(r.get(COL.order));
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push({ order: Number.isFinite(order) && r.get(COL.order) !== '' ? order : 1e9 + r.row, use });
    }
    for (const [pid, list] of groups) {
      const rec = { ...current(entity, pid) };
      rec.uses = list.sort((a, b) => a.order - b.order).map(x => x.use);
      next[entity].set(pid, rec);
    }
  }
  if (!found.length) throw Object.assign(new Error(`ไม่พบชีตของตารางแบบฟอร์ม LTAX (${Object.values(TABLE_SHEETS).join(', ')})`), { code: 400 });

  // What really changes
  const changes = [], counts = {};
  const merged = Object.fromEntries(RECORDS.map(e => [e, all(e)]));
  const ctxDb = { ...db, ...merged };
  const names = { owners: new Map(merged.owners.map(o => [o.id, ownerName(o)])), lands: new Map(merged.lands.map(l => [l.id, l.parcelCode || l.id])) };
  for (const entity of RECORDS) {
    counts[entity] = { create: 0, update: 0, same: 0 };
    for (const [id, rec] of next[entity]) {
      const before = fresh.has(id) ? null : byId[entity].get(id);
      const diff = before ? diffOf(entity, before, rec, names) : [];
      if (before && !diff.length) { counts[entity].same++; next[entity].delete(id); continue; }
      counts[entity][before ? 'update' : 'create']++;
      changes.push({ entity, id, title: ENTITIES[entity].title(rec), action: before ? 'update' : 'create', changes: diff, errors: [] });
    }
  }
  // Errors that would stop these records going into LTAX (checked once over the data as it would be).
  if (changes.length) {
    const issues = validateAll({ ...ctxDb, parcels: (db.features || []).filter(f => f.kind === 'parcel').map(f => ({ ...f, parcelCode: f.code })) }, { areaTolerance });
    const errs = new Map();
    for (const i of issues) if (i.level === 'error') { if (!errs.has(i.id)) errs.set(i.id, []); errs.get(i.id).push(i.message); }
    for (const c of changes) c.errors = errs.get(c.id) || [];
  }
  return { sheets: found, counts, changes, problems, records: Object.fromEntries(RECORDS.map(e => [e, [...next[e].values()]])) };
}

// Field-by-field differences, in words.
function diffOf(entity, a, b, names) {
  const out = [];
  const same = (x, y) => squash(Array.isArray(x) ? x.join(',') : x) === squash(Array.isArray(y) ? y.join(',') : y);
  for (const c of FORM[entity].cols) {
    const f = c.field;
    const x = f.type === 'checkbox' ? !!a[f.key] : a[f.key] ?? '', y = f.type === 'checkbox' ? !!b[f.key] : b[f.key] ?? '';
    if (!same(x, y)) out.push({ th: c.header, from: String(toCell(f, x) || ''), to: String(toCell(f, y) || '') });
  }
  const ownerNames = ids => (ids || []).map(id => names.owners.get(id) || id).join(', ');
  const landCodes = ids => (ids || []).map(id => names.lands.get(id) || id).join(', ');
  if (!same(a.ownerIds || [], b.ownerIds || [])) out.push({ th: 'เจ้าของ', from: ownerNames(a.ownerIds), to: ownerNames(b.ownerIds) });
  if (entity === 'buildings' && !same(a.landIds || [], b.landIds || [])) out.push({ th: 'แปลงที่ดินที่ตั้ง', from: landCodes(a.landIds), to: landCodes(b.landIds) });
  if (entity === 'signboards' && !same(a.landId || '', b.landId || '')) out.push({ th: 'แปลงที่ดินที่ตั้ง', from: landCodes([a.landId].filter(Boolean)), to: landCodes([b.landId].filter(Boolean)) });
  if (ENTITIES[entity].uses) {
    const norm = list => JSON.stringify((list || []).map(u => Object.fromEntries(ENTITIES[entity].uses.map(f => [f.key, f.type === 'checkbox' ? !!u[f.key] : squash(u[f.key])]))));
    if (norm(a.uses) !== norm(b.uses)) out.push({ th: 'การใช้ประโยชน์', from: `${(a.uses || []).length} รายการ`, to: `${(b.uses || []).length} รายการ` });
  }
  return out;
}
