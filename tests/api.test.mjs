// Starts the real server on a temporary data folder and exercises the shape API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromWgs84, toWgs84 } from '../public/shared/proj.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('draw, reshape and delete shapes through the API', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'llan-api-'));
  const port = 4700 + Math.floor(Math.random() * 200);
  const proc = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, LLAN_DATA_DIR: dir, LLAN_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
    return j;
  };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
    // 40 m × 25 m square near Nam Som (UTM 48N metres → WGS84)
    const [x, y] = fromWgs84(102.13, 17.79, 'EPSG:32648');
    const sq = (w, h) => ({ type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map(([a, b]) => toWgs84(a, b, 'EPSG:32648'))] });

    const parcel = await call('POST', '/api/features', { kind: 'parcel', code: '99a001', geometry: sq(40, 25) });
    assert.equal(parcel.code, '99A001');
    assert.ok(Math.abs(parcel.areaM2 - 1000) < 1);
    const layers = await call('GET', '/api/layers');
    assert.equal(layers.length, 1);
    assert.equal(layers[0].kind, 'parcel');
    assert.equal(layers[0].count, 1);

    const bld = await call('POST', '/api/features', { kind: 'building', code: '99A001-B001', geometry: sq(10, 8) });
    assert.equal((await call('GET', '/api/layers')).length, 2);
    const overlay = await call('GET', '/api/reports/overlay');
    assert.equal(overlay.rows.find(r => r.featureId === bld.id).result, 'ตรงแปลง');

    const reshaped = await call('PUT', `/api/features/${parcel.id}`, { geometry: sq(50, 25) });
    assert.ok(Math.abs(reshaped.areaM2 - 1250) < 1);
    const log = await call('GET', '/api/log');
    assert.match(log[0].reason, /แก้รูป 99A001 พื้นที่ 1000/);

    await assert.rejects(call('PUT', `/api/features/${parcel.id}`, { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } }), e => e.status === 400);

    await call('DELETE', `/api/features/${bld.id}`);
    assert.equal((await call('GET', '/api/features')).length, 1);
  } finally {
    proc.kill();
    await new Promise(r => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
