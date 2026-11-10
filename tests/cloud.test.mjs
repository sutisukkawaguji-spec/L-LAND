// Supabase sync against a small fake PostgREST (never the real project).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cloud } from '../lib/cloud.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sb_secret_test';

function fakeSupabase({ schema = true } = {}) {
  const tables = { llan_layers: new Map(), llan_features: new Map(), llan_feature_log: new Map() };
  const state = { schema, requests: 0 };
  const server = http.createServer(async (req, res) => {
    state.requests++;
    const url = new URL(req.url, 'http://x');
    const name = url.pathname.replace('/rest/v1/', '');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.headers.apikey !== KEY) return send(401, { message: 'Invalid API key' });
    if (!state.schema || !tables[name]) return send(404, { code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache` });
    const t = tables[name];
    let body = '';
    for await (const c of req) body += c;
    const filter = [...url.searchParams].find(([k, v]) => v.startsWith('eq.'));
    const match = r => !filter || String(r[filter[0]]) === filter[1].slice(3);
    if (req.method === 'GET') {
      const [from, to] = (req.headers.range || '0-999').split('-').map(Number);
      return send(200, [...t.values()].filter(match).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(from, to + 1));
    }
    if (req.method === 'POST') {
      for (const row of JSON.parse(body)) { const id = row.id ?? t.size + 1; t.set(String(id), { ...t.get(String(id)), ...row, id }); }
      return send(201);
    }
    if (req.method === 'DELETE') { for (const [k, r] of t) if (match(r)) t.delete(k); return send(204); }
    send(405, { message: 'method' });
  });
  return { server, tables, state };
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const square = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]] });

test('push and pull through the fake Supabase', async () => {
  const fake = fakeSupabase({ schema: false });
  const url = await listen(fake.server);
  try {
    const c = new Cloud({ url, key: KEY });
    await assert.rejects(c.status(), /ยังไม่ได้สร้างตาราง/);
    fake.state.schema = true;
    const layer = { id: 'L1', name: 'parcel', kind: 'parcel', crs: 'EPSG:4326', codeField: 'parcel_cod', fields: [{ name: 'parcel_cod' }, { name: 'own_fname' }] };
    const features = Array.from({ length: 1500 }, (_, i) => ({ id: `f${String(i).padStart(4, '0')}`, layerId: 'L1', kind: 'parcel', fid: i, code: `11E${String(i).padStart(3, '0')}`,
      geometry: square(102 + i / 1e4, 17.7), areaM2: 100, attrs: { parcel_cod: `11E${i}`, own_fname: 'นาย ก' } }));
    await c.pushAll([layer], features, 'ทดสอบ');
    assert.equal(fake.tables.llan_features.size, 1500);
    const sent = fake.tables.llan_features.get('f0001');
    // All .shp columns go up (members-only tables, the user's choice of 11-10).
    assert.equal(sent.attrs.own_fname, 'นาย ก');
    assert.equal(sent.updated_by, 'ทดสอบ');
    assert.deepEqual(fake.tables.llan_layers.get('L1').fields, [{ name: 'parcel_cod' }, { name: 'own_fname' }]);
    const back = await c.pullAll();
    assert.equal(back.features.length, 1500); // two pages of 1000
    assert.deepEqual(back.features.find(f => f.id === 'f0001').geometry, features[1].geometry);
    assert.equal((await c.status()).features, 1500);
  } finally { fake.server.close(); }
});

test('server sends shape edits to Supabase and warns when it cannot', { timeout: 60000 }, async () => {
  const fake = fakeSupabase();
  const url = await listen(fake.server);
  const dir = mkdtempSync(path.join(tmpdir(), 'llan-cloud-'));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ cloud: { url, key: KEY, enabled: true } }));
  const port = 4900 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, LLAN_DATA_DIR: dir, LLAN_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, u, body) => (await fetch(base + u, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
    const st = await call('GET', '/api/state');
    assert.equal(st.settings.cloud.hasKey, true);
    assert.equal(JSON.stringify(st).includes(KEY), false); // the key never reaches the browser
    const f = await call('POST', '/api/features', { kind: 'parcel', code: '99A001', geometry: square(102.13, 17.79), attrs: { own_fname: 'นาย ก' } });
    // Shapes go up through the sync queue a moment later, with all their columns.
    for (let i = 0; i < 40 && !fake.tables.llan_features.has(f.id); i++) await new Promise(r => setTimeout(r, 200));
    assert.equal(fake.tables.llan_features.get(f.id).code, '99A001');
    assert.equal(fake.tables.llan_features.get(f.id).attrs.own_fname, 'นาย ก');
    await call('DELETE', '/api/features/' + f.id);
    for (let i = 0; i < 40 && fake.tables.llan_features.has(f.id); i++) await new Promise(r => setTimeout(r, 200));
    assert.equal(fake.tables.llan_features.has(f.id), false);
  } finally {
    proc.kill(); fake.server.close();
    await new Promise(r => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
