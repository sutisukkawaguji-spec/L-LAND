// Status of every parcel as the central (office) system sees it: does the shape link to the register,
// does the register link to LTAX, and what the field survey still has to fix. The office computes it and
// stores it in Supabase (llan_parcel_status) for the survey web page. Browser-safe.
import { overlayReport, normCode } from './layers.mjs';
import { pendingState, syncFields } from '../public/shared/diff.mjs';
import { toWah } from '../public/shared/calc.mjs';

export const STATUS_TH = { ok: 'ข้อมูลตรง', fix: 'ต้องปรับแก้ (สำรวจ)', send: 'รอดำเนินการใน LTAX' };
export const LINK_TH = { ok: 'รูปแปลงตรงกับทะเบียน', 'no-record': 'มีรูป ไม่มีทะเบียน', 'no-shape': 'มีทะเบียน ไม่มีรูป', 'dup-shape': 'รหัสซ้ำบนแผนที่', 'dup-record': 'รหัสซ้ำในทะเบียน', 'no-code': 'รูปไม่มีรหัส' };
export const SURVEY_TH = { draft: 'กำลังสำรวจ', revisit: 'ต้องกลับไปสำรวจซ้ำ', ready: 'สำรวจเสร็จ รอลง LTAX', done: 'สำรวจเสร็จ ตรงกับ LTAX แล้ว', changed: 'แก้ไขหลังกดสำรวจเสร็จ' };
export const SURVEY_MARKS = ['draft', 'revisit', 'done'];
export const LTAX_TH = { found: 'พบใน LTAX', 'not-found': 'ไม่พบใน LTAX', dup: 'รหัสซ้ำใน LTAX', new: 'ยังไม่มีใน LTAX', none: '-' };
// Warnings about what is on the ground (area, use, owner, building's land) are survey work; others are only notes.
const SURVEY_WARN = new Set(['rai', 'uses', 'ownerIds', 'landIds', 'parcelCode']);
const PARCEL_OF = /^([0-9]{2}[A-Z][0-9]{3})-/;

const add = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };

// Buildings of each parcel: by the parcel part of the building code, and by the lands they stand on.
function buildingsByParcel(db) {
  const landCode = new Map(db.lands.map(l => [l.id, normCode(l.parcelCode)]));
  const out = new Map();
  for (const b of db.buildings) {
    const codes = new Set([(normCode(b.buildingCode).match(PARCEL_OF) || [])[1], ...(b.landIds || []).map(id => landCode.get(id))].filter(Boolean));
    for (const c of codes) add(out, c, b);
  }
  for (const [c, list] of out) out.set(c, [...new Set(list)]);
  return out;
}

// ---------- survey state of a parcel ----------
// The survey marks a parcel on its land record: land.survey = { state, at, by, note, sig }, state being
// draft (กำลังสำรวจ) / revisit (ต้องกลับไปซ้ำ) / done (สำรวจเสร็จ). For done, sig is a fingerprint of the
// LTAX fields of the parcel's land(s) and buildings at that moment, so an edit made afterwards shows up.
const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
function sigOf(lands, buildings) {
  const part = (e, list) => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(r => [r.id, syncFields(e, r)]);
  return hash(JSON.stringify([part('lands', lands), part('buildings', buildings)]));
}
// Marked done: ready = unchanged since and something waits for LTAX; done = nothing left to send;
// changed = edited again after the sign-off. items: what to send (its lands, buildings and their owners).
function surveyOf(db, lands, buildings) {
  const mark = lands.map(l => l.survey).filter(m => SURVEY_MARKS.includes(m?.state)).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (!mark) return null;
  const ownerIds = new Set([...lands, ...buildings].flatMap(r => r.ownerIds || []));
  const items = [['owners', db.owners.filter(o => ownerIds.has(o.id))], ['lands', lands], ['buildings', buildings]]
    .flatMap(([e, list]) => list.filter(r => pendingState(e, r).action).map(r => ({ entity: e, recordId: r.id })));
  const state = mark.state !== 'done' ? mark.state : !items.length ? 'done' : mark.sig === sigOf(lands, buildings) ? 'ready' : 'changed';
  return { state, at: mark.at, by: mark.by || '', note: mark.note || '', items };
}
const groupOf = (db, code, byParcel) => ({ lands: db.lands.filter(l => normCode(l.parcelCode) === code), buildings: byParcel.get(code) || [] });
export function surveySig(db, code) {
  const g = groupOf(db, normCode(code), buildingsByParcel(db));
  return sigOf(g.lands, g.buildings);
}
// Every parcel the survey has marked, with its state.
export function surveyList(db) {
  const byParcel = buildingsByParcel(db);
  const codes = [...new Set(db.lands.filter(l => SURVEY_MARKS.includes(l.survey?.state)).map(l => normCode(l.parcelCode)).filter(Boolean))].sort();
  return codes.map(code => { const g = groupOf(db, code, byParcel); return { code, ...surveyOf(db, g.lands, g.buildings) }; });
}
// Puts a parcel's survey state into its status row: the survey's own reasons (flag survey), the
// on-the-ground warnings (flag soft) settled or not, and the status worked out again. Used by the office
// and, on the web, on rows the office stored earlier (the survey marks are read live).
export function applySurvey(row, sv) {
  const signed = sv && (sv.state === 'ready' || sv.state === 'done');
  const CONFIRMED = ' (ผู้สำรวจยืนยันแล้ว)';
  const reasons = (row.reasons || []).filter(r => !r.survey).map(r => (!r.soft ? r
    : { ...r, level: signed ? 'note' : 'fix', text: r.text.replace(CONFIRMED, '') + (signed ? CONFIRMED : '') }));
  const add = (level, text) => reasons.push({ level, text, survey: true });
  if (sv?.state === 'ready') add('send', `สำรวจเสร็จแล้ว${sv.by ? ` (${sv.by})` : ''} รอลง LTAX ${sv.items.length ?? sv.items} รายการ`);
  if (sv?.state === 'changed') add('fix', 'มีการแก้ไขหลังกด "สำรวจเสร็จ" กดสำรวจเสร็จอีกครั้งเมื่อแก้ครบ');
  if (sv?.state === 'revisit') add('fix', `ต้องกลับไปสำรวจซ้ำ${sv.note ? `: ${sv.note}` : ''}`);
  if (sv?.state === 'draft') add('note', `กำลังสำรวจ${sv.by ? ` (${sv.by})` : ''}${sv.note ? `: ${sv.note}` : ''}`);
  const status = reasons.some(r => r.level === 'fix') ? 'fix' : reasons.some(r => r.level === 'send') ? 'send' : 'ok';
  const survey = sv ? { state: sv.state, at: sv.at, by: sv.by, note: sv.note, items: Array.isArray(sv.items) ? sv.items.length : sv.items } : null;
  return { ...row, status, survey: sv?.state || null, reasons, info: { ...(row.info || {}), survey } };
}
// (In Supabase the survey state lives in info.survey; row.survey is the same value for convenience.)
export function withLiveSurvey(rows, db) {
  const live = new Map(surveyList(db).map(s => [s.code, s]));
  return rows.map(r => {
    if (!r.code) return r;
    const s = live.get(r.code) || null;
    const want = s ? { state: s.state, at: s.at, by: s.by, note: s.note, items: s.items.length } : null;
    if ((r.survey || null) === (s?.state || null) && JSON.stringify(r.info?.survey || null) === JSON.stringify(want)) return r;
    return applySurvey(r, s);
  });
}

export function parcelStatuses(db, { issues = [], checks = [], pushes = [] } = {}) {
  const shapes = new Map(), noCode = [], landsBy = new Map(), issuesBy = new Map(), overlayBy = new Map(), bRecs = new Map(), bShapes = new Map();
  for (const f of db.features) {
    if (f.kind === 'parcel') { const c = normCode(f.code); if (c) add(shapes, c, f); else noCode.push(f); }
    if (f.kind === 'building' && f.code) add(bShapes, normCode(f.code), f);
  }
  for (const l of db.lands) { const c = normCode(l.parcelCode); if (c) add(landsBy, c, l); }
  for (const i of issues) add(issuesBy, i.id, i);
  for (const r of overlayReport(db).rows) if (r.expectedParcel) add(overlayBy, r.expectedParcel, r);
  for (const [c, list] of buildingsByParcel(db)) bRecs.set(c, list);
  const allBCodes = new Set(db.buildings.map(b => normCode(b.buildingCode)).filter(Boolean));
  const checkBy = new Map(checks.map(c => [c.id, c]));
  const pushBy = new Map(pushes.map(p => [p.id, p]));

  const rows = [];
  for (const code of new Set([...shapes.keys(), ...landsBy.keys()])) {
    const fs = shapes.get(code) || [], ls = landsBy.get(code) || [], land = ls[0];
    const reasons = [];
    const say = (level, text) => reasons.push({ level, text });
    let link = 'ok';
    if (!ls.length) { link = 'no-record'; say('fix', 'มีรูปแปลง แต่ไม่มีข้อมูลที่ดินในทะเบียน'); }
    else if (!fs.length) { link = 'no-shape'; say('fix', 'มีข้อมูลในทะเบียน แต่ยังไม่มีรูปแปลงบนแผนที่'); }
    if (fs.length > 1) { link = 'dup-shape'; say('fix', `รหัสแปลงซ้ำบนแผนที่ ${fs.length} รูป`); }
    if (ls.length > 1) { link = 'dup-record'; say('fix', `รหัสแปลงซ้ำในทะเบียน ${ls.length} รายการ`); }

    const recs = bRecs.get(code) || [];
    const sv = ls.length ? surveyOf(db, ls, recs) : null;
    let ltax = 'none', pending = null;
    if (land) {
      const chk = checkBy.get(`parcel:${code}`), push = pushBy.get(`lands:${land.id}`), p = pendingState('lands', land);
      pending = p.action;
      if (chk && !chk.found) { ltax = 'not-found'; say('send', 'ตรวจกับ LTAX แล้วไม่พบแปลงนี้'); }
      else if (chk && chk.count > 1) { ltax = 'dup'; say('send', 'LTAX มีรหัสแปลงนี้มากกว่า 1 รายการ'); }
      else if (chk || land.ltaxId) ltax = 'found';
      else ltax = 'new';
      if (push?.status === 'error') say('send', `ส่งเข้า LTAX ครั้งล่าสุดผิดพลาด${push.message ? `: ${push.message}` : ''}`);
      if (p.action === 'create' && ltax !== 'not-found') say('send', 'ยังไม่มีใน LTAX รอส่งเพิ่ม');
      if (p.action === 'update') say('send', `แก้ไขแล้ว ${p.changes.length} ช่อง รอส่งเข้า LTAX`);
      for (const i of issuesBy.get(land.id) || []) {
        if (i.level === 'error') say('fix', i.message);
        // On-the-ground warnings (area, use, owner): settled once the survey signs the parcel off.
        else if (SURVEY_WARN.has(i.field)) reasons.push({ level: 'fix', text: i.message, soft: true });
        else say('note', i.message);
      }
    }

    // Buildings belonging to this parcel: shapes inside it, records with shapes, and their own checks.
    const ov = overlayBy.get(code) || [];
    const misplaced = ov.filter(r => r.result === 'อยู่นอกแปลง' || r.result === 'ไม่ตรงแปลง');
    if (misplaced.length) say('fix', `รูปอาคารอยู่นอกแปลง/ไม่ตรงแปลง: ${misplaced.map(r => r.code).join(', ')}`);
    const noShape = recs.filter(b => b.buildingCode && !bShapes.has(normCode(b.buildingCode)));
    if (noShape.length) say('fix', `อาคารในทะเบียนยังไม่มีรูป: ${noShape.map(b => normCode(b.buildingCode)).join(', ')}`);
    const noRec = ov.filter(r => !allBCodes.has(r.code));
    if (noRec.length) say('fix', `รูปอาคารยังไม่มีข้อมูลในทะเบียน: ${noRec.map(r => r.code).join(', ')}`);
    for (const b of recs) for (const i of issuesBy.get(b.id) || []) if (i.level === 'error') say('fix', `อาคาร ${normCode(b.buildingCode) || ''}: ${i.message}`);

    const areaMap = fs.reduce((s, f) => s + (Number(f.areaM2) || 0), 0);
    rows.push(applySurvey({ id: code, code, status: 'ok', link, ltax, pending, survey: null, reasons, info: {
      survey: null,
      featureIds: fs.map(f => f.id), landIds: ls.map(l => l.id),
      areaMapWah: fs.length ? Math.round(areaMap / 4 * 100) / 100 : null, areaDocWah: land ? toWah(land.rai, land.ngan, land.wah) : null,
      buildings: { records: recs.length, shapes: ov.length, misplaced: misplaced.length, noShape: noShape.length, noRecord: noRec.length },
    } }, sv));
  }
  for (const f of noCode) rows.push({ id: `#${f.id}`, code: '', status: 'fix', link: 'no-code', ltax: 'none', pending: null,
    reasons: [{ level: 'fix', text: 'รูปแปลงไม่มีรหัสแปลง เชื่อมกับทะเบียนไม่ได้' }], info: { featureIds: [f.id], landIds: [], areaMapWah: Math.round((Number(f.areaM2) || 0) / 4 * 100) / 100 } });
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function statusSummary(rows) {
  const out = { total: rows.length, ok: 0, fix: 0, send: 0, link: {}, ltax: {}, reasons: {}, survey: { draft: 0, revisit: 0, ready: 0, done: 0, changed: 0, parcels: 0 } };
  for (const r of rows) {
    out[r.status]++;
    if (r.survey) out.survey[r.survey]++;
    if (r.info?.landIds?.length) out.survey.parcels++;
    out.link[r.link] = (out.link[r.link] || 0) + 1;
    out.ltax[r.ltax] = (out.ltax[r.ltax] || 0) + 1;
    for (const x of r.reasons) if (x.level !== 'note' && !x.survey) {
      const k = x.text.replace(/:.*$/, '').replace(/\d[\d,]*(\.\d+)?/g, '…');
      out.reasons[k] = (out.reasons[k] || 0) + 1;
    }
  }
  return out;
}
