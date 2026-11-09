// L-LAN local server: static UI, JSON API over the local data folder, imports/exports and LTAX jobs.
// Listens on 127.0.0.1 only. Run: node server.mjs   (data folder: LLAN_DATA_DIR or ./data)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { LtaxEngine, DEFAULT_LTAX } from './lib/ltax-engine.mjs';
import { readLtaxWorkbook, mergeImport } from './lib/import-ltax.mjs';
import { importShapefile, joinReport, overlayReport, exportLayer } from './lib/layers.mjs';
import { readXlsx, writeXlsx, zipStore } from './lib/xlsx.mjs';
import { buildWorkbook } from './lib/export-xlsx.mjs';
import { validateAll } from './public/shared/validate.mjs';
import { pendingState } from './public/shared/diff.mjs';
import { ENTITIES } from './public/shared/schema.mjs';
import { repairObject } from './public/shared/thai-text.mjs';
import { areaM2, bboxOf } from './public/shared/proj.mjs';
import { ownerRelated, deleteOwner, deleteRecords, fillPrices } from './lib/registry-ops.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.LLAN_DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.LLAN_PORT || 4380);
const HOST = process.env.LLAN_HOST || '127.0.0.1';

const store = await new Store(DATA).open();
const engine = new LtaxEngine(store, DATA);

// Map attributes imported before the Thai-text repair existed are fixed once at start-up.
{
  let fixed = 0;
  for (const f of store.list('features')) fixed += repairObject(f.attrs || {}).length;
  if (fixed) {
    await store.replaceAll('features', store.list('features'), { action: 'repair-thai', after: { values: fixed } });
    console.log(`ซ่อมข้อความภาษาไทยในข้อมูลแผนที่ ${fixed} ค่า`);
  }
}
const RECORDS = ['owners', 'lands', 'buildings', 'signboards'];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body));
};
const fail = (res, code, message) => send(res, code, { error: message });

async function bodyJson(req, limit = 300 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('ไฟล์ใหญ่เกินไป'), { code: 413 }); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
const b64 = s => (s ? new Uint8Array(Buffer.from(s, 'base64')) : undefined);
const fileName = s => encodeURIComponent(s).replace(/['()]/g, escape);
const download = (res, name, bytes, type) => send(res, 200, bytes, type, { 'Content-Disposition': `attachment; filename*=UTF-8''${fileName(name)}` });
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

// Records with their pending state for the UI and exports.
function annotate() {
  const out = {};
  for (const c of RECORDS) out[c] = store.list(c).map(r => {
    const p = pendingState(c, r);
    return { ...r, pending: p.action, pendingCount: p.changes.length };
  });
  return out;
}

function changeSummary() {
  const rows = [];
  for (const c of RECORDS) for (const r of store.list(c)) {
    const p = pendingState(c, r);
    if (!p.action) continue;
    rows.push({ entity: c, entityTh: ENTITIES[c].th, id: r.id, title: ENTITIES[c].title(r), action: p.action, changes: p.changes, updatedAt: r.updatedAt });
  }
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

route('GET', '/api/state', () => ({
  counts: Object.fromEntries([...RECORDS, 'features', 'layers'].map(c => [c, store.list(c).length])),
  pending: changeSummary().length + store.list('deletions').length, settings: { ...store.settings, ltax: { ...DEFAULT_LTAX, ...(store.settings.ltax || {}) } }, dataDir: DATA,
}));
route('GET', '/api/records', () => annotate());
route('GET', '/api/layers', () => store.list('layers'));
route('GET', '/api/features', () => store.list('features').map(({ attrs, ...f }) => f));
route('GET', '/api/features/:id', ({ id }) => store.get('features', id) || null);

for (const c of RECORDS) {
  route('GET', `/api/${c}/:id`, ({ id }) => store.get(c, id));
  route('POST', `/api/${c}`, async (_, body) => store.upsert(c, clean(body)));
  route('PUT', `/api/${c}/:id`, async ({ id }, body) => {
    const old = store.get(c, id);
    if (!old) throw Object.assign(new Error('ไม่พบรายการ'), { code: 404 });
    return store.upsert(c, { ...old, ...clean(body), id });
  });
  route('DELETE', `/api/${c}/:id`, async ({ id }) => ({ ok: true, removed: await deleteRecords(store, c, [id]) }));
}
// The UI may not overwrite bookkeeping fields.
function clean(body) {
  const { synced, ltaxId, pending, pendingCount, updatedAt, source, ...rest } = body || {};
  return rest;
}

// Shapes drawn or reshaped in the map. Geometry is WGS84 GeoJSON (Polygon / MultiPolygon).
function checkGeometry(g) {
  const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : null;
  const ok = polys && polys.every(p => Array.isArray(p) && p.every(r => Array.isArray(r) && r.length >= 4
    && r.every(pt => Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && Math.abs(pt[0]) <= 180 && Math.abs(pt[1]) <= 90)));
  if (!ok) throw Object.assign(new Error('รูปไม่ถูกต้อง (ต้องเป็นรูปหลายเหลี่ยมอย่างน้อย 3 จุด)'), { code: 400 });
  return g;
}
const shapeFields = g => ({ geometry: g, bbox: bboxOf(g), areaM2: Math.round(areaM2(g) * 100) / 100 });
const LAYER_DEFAULTS = {
  parcel: { name: 'แปลงที่วาดใหม่', codeField: 'parcel_cod' },
  building: { name: 'อาคารที่วาดใหม่', codeField: 'building_c' },
};

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
  if (!old) throw Object.assign(new Error('ไม่พบรูปแปลง'), { code: 404 });
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
  if (!old) throw Object.assign(new Error('ไม่พบรูปแปลง'), { code: 404 });
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
  if (!store.get('owners', id)) throw Object.assign(new Error('ไม่พบเจ้าของ'), { code: 404 });
  return deleteOwner(store, id, { withAssets: !!body.withAssets, withShapes: !!body.withShapes });
});
route('POST', '/api/bulk/delete', async (_, body) => {
  if (!RECORDS.includes(body.entity) || !Array.isArray(body.ids)) throw Object.assign(new Error('คำขอไม่ถูกต้อง'), { code: 400 });
  if (body.entity === 'owners') {
    const total = {};
    for (const id of body.ids) for (const [k, v] of Object.entries(await deleteOwner(store, id, { withAssets: !!body.withAssets, withShapes: !!body.withShapes }))) total[k] = (total[k] || 0) + v;
    return total;
  }
  return deleteRecords(store, body.entity, body.ids, { withShapes: !!body.withShapes });
});
route('POST', '/api/prices/fill', (_, body) => {
  if (!['lands', 'buildings'].includes(body.entity)) throw Object.assign(new Error('เติมราคาได้เฉพาะที่ดินและสิ่งปลูกสร้าง'), { code: 400 });
  return fillPrices(store, body.entity, body.ids, { apply: !!body.apply });
});
route('GET', '/api/pushes', () => store.list('pushes'));
route('GET', '/api/deletions', () => store.list('deletions'));
route('DELETE', '/api/deletions/:id', async ({ id }) => ({ ok: await store.remove('deletions', decodeURIComponent(id)) }));

route('GET', '/api/validate', () => validateAll({ ...store.data, parcels: store.list('features').filter(f => f.kind === 'parcel').map(f => ({ ...f, parcelCode: f.code })) }, { areaTolerance: (store.settings.areaTolerance ?? 10) / 100 }));
route('GET', '/api/changes', () => changeSummary());
route('GET', '/api/log', (_, __, url) => store.readLog({ limit: Number(url.searchParams.get('limit') || 300), recordId: url.searchParams.get('recordId') || undefined }));
route('GET', '/api/reports/join', () => joinReport(store.data));
route('GET', '/api/reports/overlay', () => overlayReport(store.data));

route('PUT', '/api/settings', async (_, body) => {
  const patch = { ...body };
  if (body.ltax) patch.ltax = { ...(store.settings.ltax || {}), ...body.ltax };
  return store.saveSettings(patch);
});

// Imports. Files arrive base64-encoded in JSON from the browser file picker.
route('POST', '/api/import/shapefile', async (_, body) => {
  const files = { shp: b64(body.shp), dbf: b64(body.dbf), shx: b64(body.shx), prj: body.prj ? Buffer.from(body.prj, 'base64').toString('utf8') : undefined, cpg: body.cpg ? Buffer.from(body.cpg, 'base64').toString('utf8') : undefined };
  if (!files.shp || !files.dbf) throw Object.assign(new Error('ต้องมีไฟล์ .shp และ .dbf'), { code: 400 });
  const existing = store.list('layers').find(l => l.name === body.name);
  const { layer, features } = importShapefile(body.name, files, { crs: body.crs || undefined, kind: body.kind || undefined, codeField: body.codeField, layerId: existing?.id });
  await store.replaceAll('features', [...store.list('features').filter(f => f.layerId !== layer.id), ...features],
    { action: 'import-layer', recordId: layer.id, after: { name: layer.name, kind: layer.kind, count: layer.count, crs: layer.crs } });
  await store.upsert('layers', layer, { reason: 'นำเข้าชั้นแผนที่' });
  return { layer, join: joinReport(store.data)[layer.kind]?.summary || null };
});

route('POST', '/api/import/ltax-xlsx', async (_, body) => {
  const sheets = await readXlsx(b64(body.file));
  const imported = readLtaxWorkbook(sheets);
  if (!imported.owners.length && !imported.lands.length && !imported.buildings.length) throw Object.assign(new Error('ไม่พบชีต owner / land / building ในไฟล์นี้'), { code: 400 });
  if (body.preview) return { report: imported.report };
  const { collections, result } = mergeImport(store.data, imported);
  for (const [c, list] of Object.entries(collections))
    await store.replaceAll(c, list, { action: 'import-ltax-xlsx', after: { file: body.name, added: result.added[c], updated: result.updated[c], keptLocal: result.keptLocal[c] } });
  return { report: imported.report, result };
});

// Exports
route('GET', '/api/export/xlsx', () => {
  const db = { ...store.data, ...annotate() };
  const bytes = writeXlsx(buildWorkbook(db, {
    issues: validateAll({ ...store.data, parcels: store.list('features').filter(f => f.kind === 'parcel').map(f => ({ ...f, parcelCode: f.code })) }, { areaTolerance: (store.settings.areaTolerance ?? 10) / 100 }),
    changes: changeSummary(), join: joinReport(store.data), overlay: overlayReport(store.data), checks: store.list('checks'),
  }));
  return { download: `L-LAN_${stamp()}.xlsx`, bytes, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
});
route('GET', '/api/export/shp/:id', ({ id }, _, url) => {
  const layer = store.get('layers', id);
  if (!layer) throw Object.assign(new Error('ไม่พบชั้นแผนที่'), { code: 404 });
  const crs = url.searchParams.get('crs') || layer.crs;
  const files = exportLayer(layer, { ...store.data, ...annotate() }, { crs, encoding: url.searchParams.get('encoding') || 'utf-8' });
  const base = `${layer.name}_LLAN`;
  const entries = [['shp', files.shp], ['shx', files.shx], ['dbf', files.dbf], ['prj', files.prj], ['cpg', files.cpg]].filter(([, d]) => d).map(([ext, data]) => ({ name: `${base}.${ext}`, data }));
  return { download: `${base}_${stamp()}.zip`, bytes: zipStore(entries), type: 'application/zip' };
});
route('GET', '/api/jobs/:id/report', ({ id }) => {
  const job = store.get('jobs', id);
  if (!job) throw Object.assign(new Error('ไม่พบงาน'), { code: 404 });
  const STATUS = { done: 'สำเร็จ', error: 'ผิดพลาด', skipped: 'ข้าม', cancelled: 'ยกเลิก', waiting: 'รอ', running: 'กำลังทำ' };
  const rows = job.items.map((it, i) => ({ no: i + 1, entity: ENTITIES[it.entity].th, label: it.label, status: STATUS[it.status] || it.status, message: it.message,
    changes: (it.changes || []).map(c => `${c.th}: ${c.ltax || '-'} → ${c.local || '-'}`).join('\n'), manual: (it.manual || []).join('\n'), startedAt: it.startedAt || '', finishedAt: it.finishedAt || '' }));
  const bytes = writeXlsx([{ name: 'รายงานงาน', columns: [
    { header: 'ลำดับ', key: 'no', width: 7 }, { header: 'ประเภท', key: 'entity', width: 14 }, { header: 'รายการ', key: 'label', width: 22 },
    { header: 'ผล', key: 'status', width: 10 }, { header: 'ข้อความ', key: 'message', width: 60 }, { header: 'ช่องที่ต่างจาก LTAX (LTAX → ในเครื่อง)', key: 'changes', width: 70 },
    { header: 'ต้องทำเองใน LTAX', key: 'manual', width: 50 }, { header: 'เริ่ม', key: 'startedAt', width: 20 }, { header: 'เสร็จ', key: 'finishedAt', width: 20 }], rows }]);
  return { download: `L-LAN_งาน_${job.type}_${job.mode}_${stamp()}.xlsx`, bytes, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
});

// Sign-in to L-LAN goes through the DLA SSO (user name, password, OTP) in L-LAN's Chrome window.
// "offline" works on local data only; nothing can be sent to LTAX until signed in.
let session = { mode: 'none' };
route('GET', '/api/session', () => session);
route('POST', '/api/session/ltax', async () => {
  let s = await engine.status();
  if (s.browser && !s.loggedIn) { await engine.enterLtax().catch(() => false); s = await engine.status(); }
  if (!s.loggedIn) return { ...session, waiting: true, browser: s.browser };
  session = { mode: 'ltax', user: s.user, since: new Date().toISOString() };
  return session;
});
route('POST', '/api/session/offline', () => (session = { mode: 'offline', since: new Date().toISOString() }));
route('POST', '/api/session/logout', () => (session = { mode: 'none' }));
route('GET', '/api/checks', () => store.list('checks'));

// LTAX
route('GET', '/api/ltax/status', () => engine.status());
route('POST', '/api/ltax/browser', () => engine.openBrowser());
route('POST', '/api/ltax/enter', async () => ({ ok: await engine.enterLtax() }));
route('GET', '/api/ltax/jobs', () => engine.listJobs());
route('GET', '/api/ltax/jobs/:id', ({ id }) => store.get('jobs', id));
route('POST', '/api/ltax/jobs', async (_, body) => {
  const job = await engine.startJob(body);
  return { ...job, items: job.items };
});
route('POST', '/api/ltax/jobs/:id/stop', ({ id }) => { engine.stop(id); return { ok: true }; });

const sseClients = new Set();
engine.on('event', e => { for (const res of sseClients) res.write(`data: ${JSON.stringify(e)}\n\n`); });

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  // The browser also needs the pure-JS file-format readers.
  const base = rel.startsWith('lib/') && ['lib/shapefile.mjs', 'lib/cp874.mjs'].includes(rel) ? ROOT : path.join(ROOT, 'public');
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base) || !existsSync(file) || !(await stat(file)).isFile()) return fail(res, 404, 'ไม่พบไฟล์');
  send(res, 200, await readFile(file), MIME[path.extname(file)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/ltax/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (!url.pathname.startsWith('/api/')) return await serveStatic(res, url.pathname);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const body = ['POST', 'PUT'].includes(req.method) ? await bodyJson(req) : null;
      const out = await r.fn(m.groups || {}, body, url);
      if (out && out.download) return download(res, out.download, out.bytes, out.type);
      return send(res, 200, out ?? null);
    }
    fail(res, 404, 'ไม่พบคำสั่ง');
  } catch (err) {
    if (!res.headersSent) fail(res, err.code && Number.isInteger(err.code) ? err.code : 500, err.message);
    if (!err.code) console.error(err);
  }
});

server.listen(PORT, HOST, () => console.log(`L-LAN พร้อมใช้งานที่ http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}  (ข้อมูล: ${DATA})`));
export { server, store, engine };
