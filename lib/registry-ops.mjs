// Bulk registry operations: deleting records with their dependants, and filling missing appraisal prices.
// Records that exist in LTAX leave a "deletion" entry behind, because L-LAN never deletes in LTAX.
import { ENTITIES } from '../public/shared/schema.mjs';
import { suggestLandPrice, suggestBuildingPrice } from '../public/shared/valuation.mjs';

const ASSETS = ['lands', 'buildings', 'signboards'];

// What belongs to an owner: records listing them as owner, split into sole-owned and shared.
export function ownerRelated(store, ownerId) {
  const out = {};
  for (const c of ASSETS) {
    const recs = store.list(c).filter(r => (r.ownerIds || []).includes(ownerId));
    out[c] = recs.map(r => ({ id: r.id, title: ENTITIES[c].title(r), ltaxId: r.ltaxId || '', shared: (r.ownerIds || []).length > 1 }));
  }
  // Buildings and signs standing on lands that would be deleted with the owner
  const soleLands = new Set(out.lands.filter(l => !l.shared).map(l => l.id));
  const onLand = store.list('buildings').filter(b => !(b.ownerIds || []).includes(ownerId) && (b.landIds || []).some(id => soleLands.has(id)));
  out.buildingsOnLand = onLand.map(b => ({ id: b.id, title: ENTITIES.buildings.title(b), ltaxId: b.ltaxId || '' }));
  return out;
}

async function tombstone(store, entity, rec, by) {
  if (!rec.ltaxId) return;
  await store.upsert('deletions', { id: `${entity}:${rec.ltaxId}`, entity, ltaxId: rec.ltaxId, title: ENTITIES[entity].title(rec), deletedAt: new Date().toISOString(), by });
}

// Remove records and every link pointing at them; optionally the matching map shapes too.
export async function deleteRecords(store, entity, ids, { withShapes = false, by = 'user' } = {}) {
  const gone = new Set(ids);
  const removed = { owners: 0, lands: 0, buildings: 0, signboards: 0, shapes: 0, unlinked: 0 };
  const codeKey = { lands: 'parcelCode', buildings: 'buildingCode' }[entity];
  const codes = new Set();
  for (const id of ids) {
    const rec = store.get(entity, id);
    if (!rec) continue;
    if (codeKey && rec[codeKey]) codes.add(String(rec[codeKey]).toUpperCase());
    await tombstone(store, entity, rec, by);
    await store.remove(entity, id, { by });
    removed[entity]++;
  }
  const linkKey = { owners: 'ownerIds', lands: 'landIds' }[entity];
  if (linkKey) for (const c of ASSETS) for (const r of store.list(c)) {
    if (!(r[linkKey] || []).some(x => gone.has(x))) continue;
    await store.upsert(c, { ...r, [linkKey]: r[linkKey].filter(x => !gone.has(x)) }, { by, reason: 'ตัดการเชื่อมโยงกับรายการที่ถูกลบ' });
    removed.unlinked++;
  }
  if (withShapes && codes.size) {
    const kind = entity === 'lands' ? 'parcel' : 'building';
    for (const f of store.list('features').filter(x => x.kind === kind && codes.has(x.code))) {
      await store.remove('features', f.id, { by });
      const layer = store.get('layers', f.layerId);
      if (layer) await store.upsert('layers', { ...layer, count: Math.max(0, (layer.count || 1) - 1) }, { by, reason: 'ลบรูปพร้อมข้อมูลทะเบียน' });
      removed.shapes++;
    }
  }
  return removed;
}

// Delete an owner; with assets also deletes what only they own (and buildings on those lands); shared records just lose the link.
export async function deleteOwner(store, ownerId, { withAssets = false, withShapes = false, by = 'user' } = {}) {
  const rel = ownerRelated(store, ownerId);
  const total = { owners: 0, lands: 0, buildings: 0, signboards: 0, shapes: 0, unlinked: 0 };
  const add = r => { for (const k of Object.keys(total)) total[k] += r[k] || 0; };
  if (withAssets) {
    const solo = c => rel[c].filter(x => !x.shared).map(x => x.id);
    add(await deleteRecords(store, 'buildings', [...new Set([...solo('buildings'), ...rel.buildingsOnLand.map(b => b.id)])], { withShapes, by }));
    add(await deleteRecords(store, 'signboards', solo('signboards'), { by }));
    add(await deleteRecords(store, 'lands', solo('lands'), { withShapes, by }));
  }
  add(await deleteRecords(store, 'owners', [ownerId], { by }));
  return total;
}

// Suggest (preview) or apply prices for records without one.
export async function fillPrices(store, entity, ids, { apply = false } = {}) {
  const key = entity === 'lands' ? 'pricePerWah' : 'pricePerMeter';
  const all = store.list(entity);
  const pick = ids?.length ? new Set(ids) : null;
  const rows = [];
  for (const r of all) {
    if (pick && !pick.has(r.id)) continue;
    if (r[key] !== undefined && r[key] !== null && String(r[key]).trim() !== '') continue;
    const s = entity === 'lands' ? suggestLandPrice(r, all) : suggestBuildingPrice(r, all);
    const why = entity === 'buildings' && !r.buildingType ? 'ยังไม่ได้ระบุประเภทสิ่งปลูกสร้าง (ใส่ประเภทก่อนจึงแนะนำราคาได้)' : 'ไม่มีข้อมูลพอจะแนะนำ';
    rows.push({ id: r.id, title: ENTITIES[entity].title(r), suggested: s?.value ?? null, basis: s ? `${s.basis} (${s.n} รายการ)` : why });
  }
  if (apply) for (const row of rows) {
    if (row.suggested === null) continue;
    await store.upsert(entity, { ...store.get(entity, row.id), [key]: String(row.suggested) }, { reason: `เติมราคาประเมินแนะนำจาก${row.basis}` });
  }
  return { key, rows, applied: apply ? rows.filter(r => r.suggested !== null).length : 0 };
}
