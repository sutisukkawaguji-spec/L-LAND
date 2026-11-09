// L-LAN Web end to end: built site + headless Chrome + a fake Supabase (Auth + PostgREST). Never the real project.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, findChrome, listTargets, Page } from '../lib/cdp.mjs';
import { fromWgs84, toWgs84 } from '../public/shared/proj.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sb_publishable_test';

function fakeSupabase() {
  const users = { 'editor@test.local': 'pass1234', 'viewer@test.local': 'pass1234', 'stranger@test.local': 'pass1234' };
  const t = { llan_members: new Map([['editor@test.local', { email: 'editor@test.local', role: 'editor' }], ['viewer@test.local', { email: 'viewer@test.local', role: 'viewer' }]]),
    llan_layers: new Map(), llan_features: new Map(), llan_feature_log: new Map() };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.method === 'OPTIONS') return send(204);
    if (req.headers.apikey !== KEY) return send(401, { message: 'Invalid API key' });
    let body = ''; for await (const c of req) body += c;
    if (url.pathname === '/auth/v1/token') {
      const b = JSON.parse(body);
      if (users[b.email] !== b.password) return send(400, { error_description: 'Invalid login credentials' });
      return send(200, { access_token: `tok:${b.email}`, refresh_token: 'r', expires_in: 3600, user: { email: b.email } });
    }
    const email = (req.headers.authorization || '').replace('Bearer tok:', '');
    if (!users[email]) return send(401, { message: 'JWT invalid' });
    const role = t.llan_members.get(email)?.role;
    const name = url.pathname.replace('/rest/v1/', ''), table = t[name];
    if (!table) return send(404, { message: 'no table' });
    const filters = [...url.searchParams].filter(([, v]) => v.startsWith('eq.'));
    const match = r => filters.every(([k, v]) => String(r[k]) === decodeURIComponent(v.slice(3)));
    if (req.method === 'GET') {
      if (!role) return send(200, []); // RLS: non-members see nothing
      const off = Number(url.searchParams.get('offset') || 0), lim = Number(url.searchParams.get('limit') || 1000);
      return send(200, [...table.values()].filter(match).slice(off, off + lim));
    }
    if (role !== 'editor' && role !== 'admin') return send(403, { message: 'new row violates row-level security policy' });
    if (req.method === 'POST') {
      const rows = JSON.parse(body).map(r => ({ ...r, id: r.id ?? table.size + 1, updated_at: new Date().toISOString() }));
      for (const r of rows) table.set(String(r.id), r);
      return send(201, /representation/.test(req.headers.prefer || '') ? rows : undefined);
    }
    if (req.method === 'PATCH') { for (const [k, r] of table) if (match(r)) table.set(k, { ...r, ...JSON.parse(body) }); return send(204); }
    if (req.method === 'DELETE') { for (const [k, r] of table) if (match(r)) table.delete(k); return send(204); }
    send(405, {});
  });
  return { server, t };
}

function staticServer(dir) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  return http.createServer((req, res) => {
    const file = path.join(dir, new URL(req.url, 'http://x').pathname === '/' ? 'index.html' : decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
}
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

test('L-LAN Web: sign in, see shapes, draw and delete a building', { skip: !findChrome() && 'ไม่พบ Chrome', timeout: 180000 }, async () => {
  const fake = fakeSupabase();
  const api = await listen(fake.server);
  // One 40 m × 25 m parcel to draw in
  const [x, y] = fromWgs84(102.13, 17.79, 'EPSG:32648');
  const ring = [[x, y], [x + 40, y], [x + 40, y + 25], [x, y + 25], [x, y]].map(([a, b]) => toWgs84(a, b, 'EPSG:32648'));
  fake.t.llan_layers.set('L1', { id: 'L1', name: 'parcel', kind: 'parcel', code_field: 'parcel_cod', fields: [] });
  fake.t.llan_features.set('P1', { id: 'P1', layer_id: 'L1', kind: 'parcel', code: '99A001', geojson: { type: 'Polygon', coordinates: [ring] }, area_m2: 1000, attrs: { parcel_cod: '99A001' } });

  const dist = mkdtempSync(path.join(tmpdir(), 'llan-web-'));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-web.mjs'), dist], { cwd: ROOT, env: { ...process.env, LLAN_SUPABASE_URL: api, LLAN_SUPABASE_KEY: KEY }, stdio: 'ignore' });
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-web.mjs'), dist + '-x'], { cwd: ROOT, env: { ...process.env, LLAN_SUPABASE_URL: api, LLAN_SUPABASE_KEY: 'sb_secret_nope' }, stdio: 'ignore' }));
  const site = staticServer(dist);
  const web = await listen(site);
  const port = 9700 + Math.floor(Math.random() * 200);
  const child = await launchChrome({ port, profileDir: path.join(dist, '..', `llan-web-chrome-${port}`), url: `${web}/`, headless: true });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const p = await Page.attach((await listTargets(port)).find(t => t.url.startsWith(web)));
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
    await p.waitReady(); await sleep(800);
    const ev = js => p.eval(js);
    const login = async (email, pass) => { await ev(`document.querySelector('#loginEmail').value = ${JSON.stringify(email)}; document.querySelector('#loginPass').value = ${JSON.stringify(pass)}; document.querySelector('#loginForm').requestSubmit()`); await sleep(1500); };

    await login('stranger@test.local', 'pass1234');
    assert.match(await ev(`document.querySelector('#loginState').textContent`), /ยังไม่ได้รับสิทธิ์/);
    await login('editor@test.local', 'wrong');
    assert.match(await ev(`document.querySelector('#loginState').textContent`), /ไม่ถูกต้อง/);
    await login('editor@test.local', 'pass1234');
    assert.equal(await ev(`document.querySelector('#login').hidden`), true);
    assert.match(await ev(`document.querySelector('#mapLegend').textContent`), /แปลง 1/);

    // Draw a 3-point building in the middle of the parcel
    const [cx, cy] = await ev(`(() => { const r = document.querySelector('#map').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    // Taps go straight to the map canvas as pointer events (CDP mouse input is unreliable in headless Chrome).
    const click = async (px, py) => { await ev(`(() => { const c = document.querySelector('#map'); for (const type of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(type, { clientX: ${px}, clientY: ${py}, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerdown' ? 1 : 0, bubbles: true })); })()`); await sleep(200); };
    await ev(`document.querySelector('#mapBar [data-tool="building-rect"]').click()`); await sleep(300);
    await ev(`window.__pe = []; for (const t of ['pointerdown', 'pointerup']) document.querySelector('#map').addEventListener(t, e => __pe.push(t[7] + e.pointerId))`);
    const hitEl = await ev(`(() => { const el = document.elementFromPoint(${cx}, ${cy}); return el.id || el.className || el.tagName; })()`);
    await click(cx - 60, cy + 40); await click(cx + 60, cy + 40); await click(cx, cy - 30); await sleep(500);
    for (let i = 0; i < 25 && !(await ev(`!!document.querySelector('#shapeForm [name=code]')`)); i++) await sleep(200);
    const diag = await ev(`JSON.stringify({ toast: document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent, bar: document.querySelector('#drawStatus').textContent, legend: document.querySelector('#mapLegend').textContent, pe: window.__pe, dlg: [...document.querySelectorAll('dialog[open]')].map(d => d.id), focus: document.hasFocus(), vis: document.visibilityState })`) + ' hit=' + hitEl;
    assert.equal(await ev(`document.querySelector('#shapeForm [name=code]')?.value`), '99A001-B001', diag);
    await ev(`document.querySelector('#shapeForm button[value=save]').click()`); await sleep(300);
    await ev(`document.querySelector('#confirmBox button[value=yes]').click()`); await sleep(1500);
    const built = [...fake.t.llan_features.values()].find(f => f.code === '99A001-B001');
    assert.ok(built, 'building saved to Supabase');
    assert.equal(built.drawn, true);
    assert.equal(built.updated_by, 'editor@test.local');
    assert.equal(fake.t.llan_feature_log.size, 1);

    // Delete it from the side panel (it is selected after saving)
    await ev(`document.querySelector('#shapeDelete').click()`); await sleep(300);
    await ev(`document.querySelector('#confirmBox button[value=yes]').click()`); await sleep(1200);
    assert.ok(![...fake.t.llan_features.values()].some(f => f.code === '99A001-B001'));

    // A viewer cannot edit
    await ev(`localStorage.clear(); location.reload()`); await sleep(1500); await p.waitReady();
    await login('viewer@test.local', 'pass1234');
    assert.equal(await ev(`getComputedStyle(document.querySelector('#mapBar [data-tool="parcel"]')).display`), 'none');
  } finally {
    child.kill(); site.close(); fake.server.close();
    await sleep(500);
    rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(path.join(dist, '..', `llan-web-chrome-${port}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
