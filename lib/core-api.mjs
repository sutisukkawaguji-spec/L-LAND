// The L-LAN data API, shared by the office server (local JSON store) and the web page (a store kept in
// Supabase, running in the browser). Only data work lives here; LTAX, settings and Supabase sync are
// office-only routes in server.mjs. Browser-safe: no Node modules.
import { importShapefile, joinReport, overlayReport, exportLayer } from './layers.mjs';
import { readLtaxWorkbook, mergeImport } from './import-ltax.mjs';
import { readXlsx, writeXlsx, zipStore } from './xlsx.mjs';
import { buildWorkbook } from './export-xlsx.mjs';
import { ownerRelated, deleteOwner, deleteRecords, fillPrices } from './registry-ops.mjs';
import { validateAll } from '../public/shared/validate.mjs';
import { pendingState } from '../public/shared/diff.mjs';
import { ENTITIES } from '../public/shared/schema.mjs';
import { areaM2, bboxOf } from '../public/shared/proj.mjs';
import { parcelStatuses, statusSummary, surveyList, surveySig, withLiveSurvey, SURVEY_MARKS } from './parcel-status.mjs';
import { normCode } from './layers.mjs';

export const RECORDS = ['owners', 'lands', 'buildings', 'signboards'];

export function dataIssues(store) {
  return validateAll({ ...store.data, parcels: store.list('features').filter(f => f.kind === 'parcel').map(f => ({ ...f, parcelCode: f.code })) },
    { areaTolerance: (store.settings.areaTolerance ?? 10) / 100 });
}
// Status of every parcel (link to the register and to LTAX, what to fix in the survey).
export function computeStatuses(store) {
  return parcelStatuses(store.data, { issues: dataIssues(store), checks: store.list('checks'), pushes: store.list('pushes') });
}

const fail = (code, message) => Object.assign(new Error(message), { code });
const b64 = s => (s ? Uint8Array.from(atob(s), ch => ch.charCodeAt(0)) : undefined);
const b64text = s => (s ? new TextDecoder().decode(b64(s)) : undefined);
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

// Records with their pending state for the UI and exports.
export function annotate(store) {
  const out = {};
  for (const c of RECORDS) out[c] = store.list(c).map(r => {
    const p = pendingState(c, r);
    return { ...r, pending: p.action, pendingCount: p.changes.length };
  });
  return out;
}

export function changeSummary(store) {
  const rows = [];
  for (const c of RECORDS) for (const r of store.list(c)) {
    const p = pendingState(c, r);
    if (!p.action) continue;
    rows.push({ entity: c, entityTh: ENTITIES[c].th, id: r.id, title: ENTITIES[c].title(r), action: p.action, changes: p.changes, updatedAt: r.updatedAt });
  }
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// The UI may not overwrite bookkeeping fields (survey state and photos have their own routes, so a form
// left open does not undo them).
function clean(body) {
  const { synced, ltaxId, pending, pendingCount, updatedAt, source, survey, photos, ...rest } = body || {};
  return rest;
}

// Shapes drawn or reshaped in the map. Geometry is WGS84 GeoJSON (Polygon / MultiPolygon).
function checkGeometry(g) {
  const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : null;
  const ok = polys && polys.every(p => Array.isArray(p) && p.every(r => Array.isArray(r) && r.length >= 4
    && r.every(pt => Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && Math.abs(pt[0]) <= 180 && Math.abs(pt[1]) <= 90)));
  if (!ok) throw fail(400, 'รูปไม่ถูกต้อง (ต้องเป็นรูปหลายเหลี่ยมอย่างน้อย 3 จุด)');
  return g;
}
const shapeFields = g => ({ geometry: g, bbox: bboxOf(g), areaM2: Math.round(areaM2(g) * 100) / 100 });
const LAYER_DEFAULTS = {
  parcel: { name: 'แปลงที่วาดใหม่', codeField: 'parcel_cod' },
  building: { name: 'อาคารที่วาดใหม่', codeField: 'building_c' },
};

// ctx.settings(): settings the browser may see; ctx.state(): extra fields for /api/state; ctx.who(): who is working.
export function coreRoutes(store, ctx = {}) {
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, fn });
  const issues = () => dataIssues(store);
  // ctx.statuses(): the office's computed rows, or on the web the rows the office stored in Supabase.
  const statuses = () => (ctx.statuses ? ctx.statuses() : { rows: computeStatuses(store), checkedAt: new Date().toISOString() });

  route('GET', '/api/state', () => ({
    counts: Object.fromEntries([...RECORDS, 'features', 'layers'].map(c => [c, store.list(c).length])),
    pending: changeSummary(store).length + store.list('deletions').length, settings: ctx.settings ? ctx.settings() : store.settings, ...(ctx.state ? ctx.state() : {}),
  }));
  route('GET', '/api/records', () => annotate(store));
  route('GET', '/api/layers', () => store.list('layers'));
  route('GET', '/api/features', () => store.list('features').map(({ attrs, ...f }) => f));
  route('GET', '/api/features/:id', ({ id }) => store.get('features', id) || null);

  for (const c of RECORDS) {
    route('GET', `/api/${c}/:id`, ({ id }) => store.get(c, id));
    route('POST', `/api/${c}`, async (_, body) => store.upsert(c, clean(body)));
    route('PUT', `/api/${c}/:id`, async ({ id }, body) => {
      const old = store.get(c, id);
      if (!old) throw fail(404, 'ไม่พบรายการ');
      return store.upsert(c, { ...old, ...clean(body), id });
    });
    route('DELETE', `/api/${c}/:id`, async ({ id }) => ({ ok: true, removed: await deleteRecords(store, c, [id]) }));
  }

  route('POST', '/api/features', async (_, body) => {
    const kind = body.kind === 'building' ? 'building' : 'parcel';
    const geometry = checkGeometry(body.geometry);
    let layer = body.layerId ? store.get('layers', body.layerId) : store.list('layers').find(l => l.kind === kind);
    if (!layer) {
      const d = LAYER_DEFAULTS[kind];
      layer = await store.upsert('layers', { name: d.name, kind, crs: store.list('layers')[0]?.crs || 'EPSG:32648', codeField: d.codeField, geometryType: 'Polygon',
        encoding: 'utf-8', fields: [{ name: d.codeField, type: 'C', length: 20, decimals: 0 }], prj: '', count: 0, importedAt: new Date().toISOString() }, { reason: 'สร้างชั้นแผนที่สำหรับรูปที่วาด' });
    }
    const code = String(body.code || '').trim().toUpperCase();
    const feats = store.list('features').filter(f => f.layerId === layer.id);
    const fid = feats.reduce((m, f) => Math.max(m, f.fid ?? -1), -1) + 1;
    const attrs = Object.fromEntries(layer.fields.map(f => [f.name, null]));
    if (layer.codeField) attrs[layer.codeField] = code;
    const feature = await store.upsert('features', { layerId: layer.id, kind, fid, code, ...shapeFields(geometry), attrs: { ...attrs, ...(body.attrs || {}) }, drawn: true },
      { reason: `วาดรูป${kind === 'parcel' ? 'แปลง' : 'อาคาร'}ใหม่ ${code}` });
    await store.upsert('layers', { ...layer, count: feats.length + 1 }, { reason: 'เพิ่มรูปในชั้นแผนที่' });
    return feature;
  });

  route('PUT', '/api/features/:id', async ({ id }, body) => {
    const old = store.get('features', id);
    if (!old) throw fail(404, 'ไม่พบรูปแปลง');
    const next = { ...old, attrs: { ...old.attrs, ...(body.attrs || {}) } };
    if (body.code !== undefined) next.code = String(body.code).trim().toUpperCase();
    const layer = store.get('layers', old.layerId);
    if (layer?.codeField && body.code !== undefined) next.attrs[layer.codeField] = next.code;
    let reason = 'แก้ข้อมูลรูปแปลง';
    if (body.geometry) {
      Object.assign(next, shapeFields(checkGeometry(body.geometry)), { reshaped: true });
      reason = `แก้รูป ${next.code || ''} พื้นที่ ${old.areaM2} → ${next.areaM2} ตร.ม.`;
    }
    return store.upsert('features', next, { reason });
  });

  route('DELETE', '/api/features/:id', async ({ id }) => {
    const old = store.get('features', id);
    if (!old) throw fail(404, 'ไม่พบรูปแปลง');
    await store.remove('features', id);
    const layer = store.get('layers', old.layerId);
    if (layer) await store.upsert('layers', { ...layer, count: Math.max(0, (layer.count || 1) - 1) }, { reason: `ลบรูป ${old.code || ''}` });
    return { ok: true };
  });

  route('DELETE', '/api/layers/:id', async ({ id }) => {
    await store.replaceAll('features', store.list('features').filter(f => f.layerId !== id), { action: 'delete-layer', recordId: id });
    await store.remove('layers', id);
    return { ok: true };
  });

  // Registry operations
  route('GET', '/api/owners/:id/related', ({ id }) => ownerRelated(store, id));
  route('POST', '/api/owners/:id/delete', async ({ id }, body) => {
    if (!store.get('owners', id)) throw fail(404, 'ไม่พบเจ้าของ');
    return deleteOwner(store, id, { withAssets: !!body.withAssets, withShapes: !!body.withShapes });
  });
  route('POST', '/api/bulk/delete', async (_, body) => {
    if (!RECORDS.includes(body.entity) || !Array.isArray(body.ids)) throw fail(400, 'คำขอไม่ถูกต้อง');
    if (body.entity === 'owners') {
      const total = {};
      for (const id of body.ids) for (const [k, v] of Object.entries(await deleteOwner(store, id, { withAssets: !!body.withAssets, withShapes: !!body.withShapes }))) total[k] = (total[k] || 0) + v;
      return total;
    }
    return deleteRecords(store, body.entity, body.ids, { withShapes: !!body.withShapes });
  });
  route('POST', '/api/prices/fill', (_, body) => {
    if (!['lands', 'buildings'].includes(body.entity)) throw fail(400, 'เติมราคาได้เฉพาะที่ดินและสิ่งปลูกสร้าง');
    return fillPrices(store, body.entity, body.ids, { apply: !!body.apply });
  });
  route('GET', '/api/pushes', () => store.list('pushes'));
  route('GET', '/api/checks', () => store.list('checks'));
  route('GET', '/api/deletions', () => store.list('deletions'));
  route('DELETE', '/api/deletions/:id', async ({ id }) => ({ ok: await store.remove('deletions', decodeURIComponent(id)) }));

  route('GET', '/api/validate', () => issues());
  route('GET', '/api/parcel-status', () => { const s = statuses(); const rows = withLiveSurvey(s.rows, store.data); return { ...s, rows, summary: statusSummary(rows) }; });

  // Photos taken in the field. The picture itself is in Supabase Storage (sent there first by the page or
  // the office server); the record keeps the list: photos = [{ path, at, by, lat, lon }].
  const PHOTO_ENTITIES = ['lands', 'buildings', 'signboards', 'owners'];
  const photoPath = p => typeof p === 'string' && /^[a-z]+\/[^/]+\/[\w.-]+\.(jpe?g|png|webp)$/i.test(p) && !p.includes('..');
  route('POST', '/api/:entity/:id/photos', async ({ entity, id }, body) => {
    if (!PHOTO_ENTITIES.includes(entity)) throw fail(400, 'เก็บรูปได้เฉพาะเจ้าของ ที่ดิน สิ่งปลูกสร้าง และป้าย');
    const rec = store.get(entity, id);
    if (!rec) throw fail(404, 'ไม่พบรายการ');
    if (!photoPath(body?.path) || !body.path.startsWith(`${entity}/${id}/`)) throw fail(400, 'ชื่อไฟล์รูปไม่ถูกต้อง');
    const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);
    const photo = { path: body.path, at: new Date().toISOString(), by: (ctx.who && ctx.who()) || store.email || 'สำนักงาน', lat: num(body.lat), lon: num(body.lon), note: body.note ? String(body.note).slice(0, 200) : undefined };
    const photos = [...(rec.photos || []).filter(p => p.path !== photo.path), JSON.parse(JSON.stringify(photo))];
    return store.upsert(entity, { ...rec, photos }, { reason: 'เพิ่มรูปถ่าย' });
  });
  route('DELETE', '/api/:entity/:id/photos', async ({ entity, id }, _, url) => {
    const rec = PHOTO_ENTITIES.includes(entity) && store.get(entity, id);
    if (!rec) throw fail(404, 'ไม่พบรายการ');
    const path = url.searchParams.get('path');
    if (!(rec.photos || []).some(p => p.path === path)) throw fail(404, 'ไม่พบรูปนี้');
    await store.upsert(entity, { ...rec, photos: rec.photos.filter(p => p.path !== path) }, { reason: 'ลบรูปถ่าย' });
    return { ok: true, path };
  });

  // Survey state of a parcel: กำลังสำรวจ / ต้องกลับไปซ้ำ / สำรวจเสร็จ. Once done, its edits wait for the
  // office to put them into LTAX. state '' or null clears it.
  route('GET', '/api/survey', () => surveyList(store.data));
  route('POST', '/api/parcels/:code/survey', async ({ code }, body) => {
    code = normCode(decodeURIComponent(code));
    const state = body?.state || null;
    if (state && !SURVEY_MARKS.includes(state)) throw fail(400, 'สถานะการสำรวจไม่ถูกต้อง');
    const lands = store.list('lands').filter(l => normCode(l.parcelCode) === code);
    if (!lands.length) throw fail(404, `แปลง ${code} ยังไม่มีข้อมูลที่ดินในทะเบียน ให้เพิ่มข้อมูลที่ดินก่อน แล้วค่อยบันทึกการสำรวจ`);
    const mark = state && { state, at: new Date().toISOString(), by: (ctx.who && ctx.who()) || store.email || 'สำนักงาน',
      ...(body.note ? { note: String(body.note).trim().slice(0, 500) } : {}), ...(state === 'done' ? { sig: surveySig(store.data, code) } : {}) };
    const TH = { draft: 'กำลังสำรวจ', revisit: 'ต้องกลับไปสำรวจซ้ำ', done: 'สำรวจเสร็จ รอลง LTAX' };
    for (const l of lands) {
      const { survey, ...rest } = store.get('lands', l.id);
      await store.upsert('lands', mark ? { ...rest, survey: mark } : rest, { reason: mark ? `${TH[state]} แปลง ${code}` : `ล้างสถานะการสำรวจ แปลง ${code}` });
    }
    return surveyList(store.data).find(s => s.code === code) || { code, state: null, items: [] };
  });
  route('GET', '/api/changes', () => changeSummary(store));
  route('GET', '/api/log', (_, __, url) => store.readLog({ limit: Number(url.searchParams.get('limit') || 300), recordId: url.searchParams.get('recordId') || undefined }));
  route('GET', '/api/reports/join', () => joinReport(store.data));
  route('GET', '/api/reports/overlay', () => overlayReport(store.data));

  // Imports. Files arrive base64-encoded in JSON from the browser file picker.
  route('POST', '/api/import/shapefile', async (_, body) => {
    const files = { shp: b64(body.shp), dbf: b64(body.dbf), shx: b64(body.shx), prj: b64text(body.prj), cpg: b64text(body.cpg) };
    if (!files.shp || !files.dbf) throw fail(400, 'ต้องมีไฟล์ .shp และ .dbf');
    const existing = store.list('layers').find(l => l.name === body.name);
    const { layer, features } = importShapefile(body.name, files, { crs: body.crs || undefined, kind: body.kind || undefined, codeField: body.codeField, layerId: existing?.id });
    await store.replaceAll('features', [...store.list('features').filter(f => f.layerId !== layer.id), ...features],
      { action: 'import-layer', recordId: layer.id, after: { name: layer.name, kind: layer.kind, count: layer.count, crs: layer.crs } });
    await store.upsert('layers', layer, { reason: 'นำเข้าชั้นแผนที่' });
    return { layer, join: joinReport(store.data)[layer.kind]?.summary || null, status: statusSummary(statuses().rows) };
  });

  route('POST', '/api/import/ltax-xlsx', async (_, body) => {
    const sheets = await readXlsx(b64(body.file));
    const imported = readLtaxWorkbook(sheets);
    if (!imported.owners.length && !imported.lands.length && !imported.buildings.length) throw fail(400, 'ไม่พบชีต owner / land / building ในไฟล์นี้');
    if (body.preview) return { report: imported.report };
    const { collections, result } = mergeImport(store.data, imported);
    for (const [c, list] of Object.entries(collections))
      await store.replaceAll(c, list, { action: 'import-ltax-xlsx', after: { file: body.name, added: result.added[c], updated: result.updated[c], keptLocal: result.keptLocal[c] } });
    return { report: imported.report, result, status: statusSummary(statuses().rows) };
  });

  // Exports
  route('GET', '/api/export/xlsx', () => {
    const db = { ...store.data, ...annotate(store) };
    const bytes = writeXlsx(buildWorkbook(db, { issues: issues(), changes: changeSummary(store), join: joinReport(store.data), overlay: overlayReport(store.data), checks: store.list('checks') }));
    return { download: `L-LAN_${stamp()}.xlsx`, bytes, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  });
  route('GET', '/api/export/shp/:id', ({ id }, _, url) => {
    const layer = store.get('layers', id);
    if (!layer) throw fail(404, 'ไม่พบชั้นแผนที่');
    const crs = url.searchParams.get('crs') || layer.crs;
    const files = exportLayer(layer, { ...store.data, ...annotate(store) }, { crs, encoding: url.searchParams.get('encoding') || 'utf-8' });
    const base = `${layer.name}_LLAN`;
    const entries = [['shp', files.shp], ['shx', files.shx], ['dbf', files.dbf], ['prj', files.prj], ['cpg', files.cpg]].filter(([, d]) => d).map(([ext, data]) => ({ name: `${base}.${ext}`, data }));
    return { download: `${base}_${stamp()}.zip`, bytes: zipStore(entries), type: 'application/zip' };
  });
  return routes;
}

// Pattern routes → a dispatcher: dispatch(method, url) → { found, run(body, extra) }.
export function router(routes) {
  const compiled = routes.map(r => ({ ...r, re: new RegExp(`^${r.pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`) }));
  return (method, url) => {
    for (const r of compiled) {
      if (r.method !== method) continue;
      const m = url.pathname.match(r.re);
      if (m) return { found: true, run: (body, extra) => r.fn(m.groups || {}, body, url, extra) };
    }
    return { found: false };
  };
}
