// L-LAN local server (office machine): static UI, JSON API over the local data folder, imports/exports,
// LTAX jobs, and the two-way sync with Supabase that the web page works on.
// Listens on 127.0.0.1 only. Run: node server.mjs   (data folder: LLAN_DATA_DIR or ./data)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { LtaxEngine, DEFAULT_LTAX } from './lib/ltax-engine.mjs';
import { writeXlsx } from './lib/xlsx.mjs';
import { ENTITIES } from './public/shared/schema.mjs';
import { repairObject } from './public/shared/thai-text.mjs';
import { Cloud } from './lib/cloud.mjs';
import { CloudSync } from './lib/cloud-sync.mjs';
import { coreRoutes, router, computeStatuses } from './lib/core-api.mjs';
import { StatusPublisher } from './lib/status-publisher.mjs';

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body));
};
const fail = (res, code, message) => send(res, code, { error: message });
const httpError = (code, message) => Object.assign(new Error(message), { code });

async function bodyJson(req, limit = 300 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, 'ไฟล์ใหญ่เกินไป'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
const fileName = s => encodeURIComponent(s).replace(/['()]/g, escape);
const download = (res, name, bytes, type) => send(res, 200, bytes, type, { 'Content-Disposition': `attachment; filename*=UTF-8''${fileName(name)}` });
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

// Sign-in to L-LAN goes through the DLA SSO (user name, password, OTP) in L-LAN's Chrome window.
// "offline" works on local data only; nothing can be sent to LTAX until signed in.
let session = { mode: 'none' };
const who = () => session.user?.name || 'สำนักงาน';

// ---------- Supabase: the shared copy the web page works on ----------
const cloudCfg = () => store.settings.cloud || {};
const sync = new CloudSync(store, DATA, { cloud: () => (cloudCfg().enabled && cloudCfg().key && cloudCfg().url && isWriteKey(cloudCfg().key) ? new Cloud(cloudCfg()) : null), who });
await sync.load();
sync.attach();
// Parcel statuses for the survey web page: recomputed after any change, sent up a few seconds later.
const STATUS_INPUTS = new Set(['owners', 'lands', 'buildings', 'features', 'layers', 'checks', 'pushes']);
let statusCache = null, statusAt = null;
const currentStatuses = () => {
  if (!statusCache) { statusCache = computeStatuses(store); statusAt = new Date().toISOString(); }
  return statusCache;
};
const publisher = new StatusPublisher(DATA, { cloud: () => (sync.enabled ? new Cloud(cloudCfg()) : null), compute: currentStatuses });
await publisher.load();
const statusChanged = () => { statusCache = null; publisher.later(); };
store.onChange(ev => { if (STATUS_INPUTS.has(ev.c)) statusChanged(); });
// What the web page may know about this office (no keys, no LTAX settings).
async function publishSettings() {
  if (!sync.enabled) return;
  const { org, amphur, districts, areaTolerance } = store.settings;
  await new Cloud(cloudCfg()).setConfig('settings', JSON.stringify({ org, amphur, districts, areaTolerance })).catch(err => console.error('ส่งการตั้งค่าขึ้น Supabase ไม่ได้:', err.message));
}

const publicSettings = () => {
  const { cloud = {}, ...rest } = store.settings;
  return { ...rest, ltax: { ...DEFAULT_LTAX, ...(rest.ltax || {}) }, cloud: { url: cloud.url || '', enabled: !!cloud.enabled, hasKey: !!cloud.key && isWriteKey(cloud.key), sync: sync.status(), status: publisher.status() } };
};

// The office needs a key that can write: sb_secret_… or a legacy service_role JWT (not the publishable/anon key).
function isWriteKey(k) {
  if (k.startsWith('sb_secret_')) return true;
  if (k.startsWith('eyJ')) { try { return JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString()).role === 'service_role'; } catch { return false; } }
  return !k.startsWith('sb_publishable_');
}
const routes = coreRoutes(store, { settings: publicSettings, state: () => ({ dataDir: DATA }), who,
  statuses: () => ({ rows: currentStatuses(), checkedAt: statusAt, published: publisher.status() }) });
const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

route('PUT', '/api/settings', async (_, body) => {
  const patch = { ...body };
  if (body.ltax) patch.ltax = { ...(store.settings.ltax || {}), ...body.ltax };
  if (body.cloud) {
    const old = store.settings.cloud || {};
    const newKey = body.cloud.key ? String(body.cloud.key).trim() : '';
    if (newKey && !isWriteKey(newKey)) throw httpError(400, 'key นี้เป็น publishable key (ใช้ได้แค่อ่าน) ต้องใช้ secret key: Supabase → Project Settings → API Keys → Secret keys (ขึ้นต้นด้วย sb_secret_)');
    // A read-only key saved earlier is dropped, so the settings page asks for the secret key again.
    const keep = old.key && isWriteKey(old.key) ? old.key : '';
    patch.cloud = { url: String(body.cloud.url ?? old.url ?? '').trim(), enabled: !!body.cloud.enabled, key: newKey || keep };
  }
  await store.saveSettings(patch);
  statusChanged();
  publishSettings();
  return publicSettings();
});

const NEED_SECRET = 'ยังไม่มี secret key: วาง key จาก Supabase → Project Settings → API Keys → Secret keys (ขึ้นต้นด้วย sb_secret_) แล้วกดบันทึก';
const needSecret = () => { if (!cloudCfg().key || !isWriteKey(cloudCfg().key)) throw httpError(400, NEED_SECRET); };
route('GET', '/api/cloud/status', async () => {
  const c = new Cloud(cloudCfg());
  if (!c.configured || !isWriteKey(c.key)) return { ok: false, message: c.url ? NEED_SECRET : 'ยังไม่ได้ใส่ Project URL', sync: sync.status() };
  try { return { ...(await c.status()), local: store.list('features').length, sync: sync.status() }; }
  catch (err) { return { ok: false, message: err.message, sync: sync.status() }; }
});
// Field photos live in Supabase Storage; the office reads and adds them with its secret key.
const photoCloud = () => { needSecret(); return new Cloud(cloudCfg()); };
const okPhotoPath = p => typeof p === 'string' && /^[a-z]+\/[^/]+\/[\w.-]+\.(jpe?g|png|webp)$/i.test(p) && !p.includes('..');
route('GET', '/api/photos/file', async (_, __, url) => {
  const p = url.searchParams.get('path');
  if (!okPhotoPath(p)) throw httpError(400, 'ชื่อไฟล์รูปไม่ถูกต้อง');
  const r = await photoCloud().photo(p);
  return { raw: r.bytes, type: r.type };
});
route('POST', '/api/photos/file', async (_, body) => {
  if (!okPhotoPath(body?.path) || !body.data) throw httpError(400, 'ข้อมูลรูปไม่ถูกต้อง');
  await photoCloud().uploadPhoto(body.path, Buffer.from(body.data, 'base64'), body.type || 'image/jpeg');
  return { ok: true, path: body.path };
});
route('DELETE', '/api/photos/file', async (_, __, url) => {
  const p = url.searchParams.get('path');
  if (!okPhotoPath(p)) throw httpError(400, 'ชื่อไฟล์รูปไม่ถูกต้อง');
  await photoCloud().removePhotos([p]);
  return { ok: true };
});
// Everything on this machine up to Supabase (first time). Web edits are pulled in first.
route('POST', '/api/cloud/push', async () => {
  needSecret();
  const r = await sync.uploadAll();
  await publishSettings();
  return { ...r, statuses: await publisher.publish({ all: true }).catch(err => ({ error: err.message })) };
});
route('POST', '/api/parcel-status/publish', () => publisher.publish({ all: true }));
// Send what is waiting and take in what was changed on the web.
route('POST', '/api/cloud/sync', () => { needSecret(); return sync.sync(); });
route('GET', '/api/cloud/schema', async () => ({
  sql: (await Promise.all(['schema.sql', 'web-access.sql', 'records.sql'].map(f => readFile(path.join(ROOT, 'supabase', f), 'utf8')))).join('\n\n'),
}));

route('GET', '/api/jobs/:id/report', ({ id }) => {
  const job = store.get('jobs', id);
  if (!job) throw httpError(404, 'ไม่พบงาน');
  const STATUS = { done: 'สำเร็จ', error: 'ผิดพลาด', skipped: 'ข้าม', cancelled: 'ยกเลิก', waiting: 'รอ', running: 'กำลังทำ' };
  const rows = job.items.map((it, i) => ({ no: i + 1, entity: ENTITIES[it.entity].th, label: it.label, status: STATUS[it.status] || it.status, message: it.message,
    changes: (it.changes || []).map(c => `${c.th}: ${c.ltax || '-'} → ${c.local || '-'}`).join('\n'), manual: (it.manual || []).join('\n'), startedAt: it.startedAt || '', finishedAt: it.finishedAt || '' }));
  const bytes = writeXlsx([{ name: 'รายงานงาน', columns: [
    { header: 'ลำดับ', key: 'no', width: 7 }, { header: 'ประเภท', key: 'entity', width: 14 }, { header: 'รายการ', key: 'label', width: 22 },
    { header: 'ผล', key: 'status', width: 10 }, { header: 'ข้อความ', key: 'message', width: 60 }, { header: 'ช่องที่ต่างจาก LTAX (LTAX → ในเครื่อง)', key: 'changes', width: 70 },
    { header: 'ต้องทำเองใน LTAX', key: 'manual', width: 50 }, { header: 'เริ่ม', key: 'startedAt', width: 20 }, { header: 'เสร็จ', key: 'finishedAt', width: 20 }], rows }]);
  return { download: `L-LAN_งาน_${job.type}_${job.mode}_${stamp()}.xlsx`, bytes, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
});

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

// LTAX
route('GET', '/api/ltax/status', () => engine.status());
route('POST', '/api/ltax/browser', () => engine.openBrowser());
route('POST', '/api/ltax/lookup', async (_, body) => engine.lookup(body));
route('POST', '/api/ltax/enter', async () => ({ ok: await engine.enterLtax() }));
route('GET', '/api/ltax/jobs', () => engine.listJobs());
route('GET', '/api/ltax/jobs/:id', ({ id }) => store.get('jobs', id));
route('POST', '/api/ltax/jobs', async (_, body) => {
  // Work on the latest survey data: take in what was changed on the web first.
  let cloudWarning = null;
  if (sync.enabled) {
    try { await sync.sync(); } catch (err) { cloudWarning = `ดึงข้อมูลล่าสุดจาก Supabase ไม่ได้ งานนี้ใช้ข้อมูลในเครื่อง (${err.message})`; }
  }
  const job = await engine.startJob(body);
  return { ...job, items: job.items, cloudWarning };
});
route('POST', '/api/ltax/jobs/:id/stop', ({ id }) => { engine.stop(id); return { ok: true }; });

const sseClients = new Set();
const broadcast = e => { for (const res of sseClients) res.write(`data: ${JSON.stringify(e)}\n\n`); };
engine.on('event', broadcast);
sync.on('change', s => broadcast({ type: 'cloud', ...s }));

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  // The browser also needs the pure-JS file-format readers.
  const base = rel.startsWith('lib/') && ['lib/shapefile.mjs', 'lib/cp874.mjs'].includes(rel) ? ROOT : path.join(ROOT, 'public');
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base) || !existsSync(file) || !(await stat(file)).isFile()) return fail(res, 404, 'ไม่พบไฟล์');
  send(res, 200, await readFile(file), MIME[path.extname(file)] || 'application/octet-stream');
}

const dispatch = router(routes);
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
    const hit = dispatch(req.method, url);
    if (!hit.found) return fail(res, 404, 'ไม่พบคำสั่ง');
    const body = ['POST', 'PUT'].includes(req.method) ? await bodyJson(req) : null;
    const out = await hit.run(body);
    if (out && out.download) return download(res, out.download, out.bytes, out.type);
    if (out && out.raw) return send(res, 200, out.raw, out.type, { 'Cache-Control': 'private, max-age=86400' });
    send(res, 200, out ?? null);
  } catch (err) {
    if (!res.headersSent) fail(res, err.code && Number.isInteger(err.code) ? err.code : 500, err.message);
    if (!err.code || !Number.isInteger(err.code)) console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`L-LAN พร้อมใช้งานที่ http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}  (ข้อมูล: ${DATA})`);
  sync.start();
  publisher.later(3000);
  publishSettings();
});
export { server, store, engine, sync };
