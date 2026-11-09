// Field-level differences between a record and what LTAX holds (record.synced).
import { ENTITIES, LINK_KEYS } from './schema.mjs';

const norm = v => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(',') : String(v).trim());

export function syncFields(entity, rec) {
  const def = ENTITIES[entity];
  const out = {};
  for (const f of def.fields) out[f.key] = norm(rec[f.key]);
  for (const k of LINK_KEYS) if (k in rec) out[k] = norm(rec[k]);
  if (def.uses) out.uses = (rec.uses || []).map(u => Object.fromEntries(def.uses.map(f => [f.key, norm(u[f.key])])));
  return out;
}

// Returns [{ field, th, before, after }]; uses are compared row by row.
export function diffRecord(entity, rec) {
  const def = ENTITIES[entity];
  const now = syncFields(entity, rec);
  const was = rec.synced || null;
  if (!was) return null; // never pulled from or pushed to LTAX: the whole record is new
  const out = [];
  for (const f of def.fields) if (norm(was[f.key]) !== now[f.key]) out.push({ field: f.key, th: f.th, before: norm(was[f.key]), after: now[f.key] });
  for (const k of LINK_KEYS) if (k in now && norm(was[k]) !== now[k]) out.push({ field: k, th: k === 'ownerIds' ? 'เจ้าของ' : 'แปลงที่ดิน', before: norm(was[k]), after: now[k] });
  if (def.uses) {
    const a = was.uses || [], b = now.uses || [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (!a[i]) { out.push({ field: `uses.${i}`, th: `การใช้ประโยชน์ลำดับ ${i + 1}`, before: '', after: 'เพิ่มใหม่' }); continue; }
      if (!b[i]) { out.push({ field: `uses.${i}`, th: `การใช้ประโยชน์ลำดับ ${i + 1}`, before: 'มีอยู่', after: 'ลบออก' }); continue; }
      for (const f of def.uses) if (norm(a[i][f.key]) !== norm(b[i][f.key]))
        out.push({ field: `uses.${i}.${f.key}`, th: `การใช้ประโยชน์ ${i + 1}: ${f.th}`, before: norm(a[i][f.key]), after: norm(b[i][f.key]) });
    }
  }
  return out;
}

// pending: what has to go to LTAX. 'create' = not in LTAX yet, 'update' = differs from LTAX.
export function pendingState(entity, rec) {
  if (!rec.ltaxId && !rec.synced) return { action: 'create', changes: [] };
  const changes = diffRecord(entity, rec) || [];
  return changes.length ? { action: 'update', changes } : { action: null, changes };
}
