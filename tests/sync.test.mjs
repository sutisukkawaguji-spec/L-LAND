// Office L-LAN ↔ Supabase ↔ web page, against the fake Supabase (never the real project):
// first upload, office edits going up, web edits coming down (merged field by field), deletions, roles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeSupabase, listen, SECRET, PUBLISHABLE } from './fake-supabase.mjs';
import { Cloud, changedKeys, patchOf, sameRecord } from '../lib/cloud.mjs';
import { CloudStore } from '../lib/cloud-store.mjs';
import { coreRoutes, router } from '../lib/core-api.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await fn()) return true; return false; };
const square = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]] });

test('record patches', () => {
  assert.deepEqual(changedKeys({ a: 1, b: [1] }, { a: 1, b: [1, 2], c: 'x' }).sort(), ['b', 'c']);
  assert.deepEqual(patchOf({ a: 1, pending: 'x' }, ['a', 'gone', 'pending']), { patch: { a: 1 }, unset: ['gone'] });
  assert.equal(sameRecord({ a: 1, updatedAt: 'x' }, { a: 1, updatedAt: 'y' }), true);
});

// The web page's side, as the browser runs it: CloudStore + the shared API.
async function webSession(sb, email) {
  const store = await new CloudStore(new Cloud({ url: sb, key: PUBLISHABLE, token: `tok:${email}` }), { email }).open();
  const dispatch = router(coreRoutes(store));
  const call = async (method, p, body) => { const hit = dispatch(method, new URL(p, 'http://web')); assert.ok(hit.found, p); return hit.run(body ?? null); };
  return { store, call };
}

test('office and web work on the same data through Supabase', { timeout: 120000 }, async () => {
  const fake = fakeSupabase();
  const sb = await listen(fake.server);
  const dir = mkdtempSync(path.join(tmpdir(), 'llan-sync-'));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ org: 'อบต.ทดสอบ', areaTolerance: 10, cloud: { url: sb, key: SECRET, enabled: true } }));
  writeFileSync(path.join(dir, 'owners.json'), JSON.stringify([{ id: 'O1', personType: '1', prefixName: 'นาย', firstName: 'สมชาย', lastName: 'ดี', psnId: '1234567890123' }]));
  writeFileSync(path.join(dir, 'lands.json'), JSON.stringify([
    { id: 'L1', parcelCode: '11E001', ownerIds: ['O1'], ltaxId: '555', synced: { parcelCode: '11E001' } },
    { id: 'L2', parcelCode: '11E002', ownerIds: ['O1'] }]));
  const port = 5200 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, LLAN_DATA_DIR: dir, LLAN_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const office = async (method, u, body) => {
    const res = await fetch(base + u, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
  };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(200); } }

    // First upload: the register (with personal details) and the shapes.
    await office('POST', '/api/features', { kind: 'parcel', code: '11E001', geometry: square(102.1, 17.7) });
    const up = await office('POST', '/api/cloud/push');
    assert.equal(up.records, 3);
    assert.equal(fake.t.llan_records.get('O1').data.psnId, '1234567890123');
    assert.equal(fake.t.llan_records.get('L1').entity, 'lands');
    assert.equal(fake.t.llan_features.size, 1);
    assert.equal(JSON.parse(fake.t.llan_config.get('settings').value).org, 'อบต.ทดสอบ');
    assert.equal((await office('GET', '/api/state')).settings.cloud.sync.queued, 0);
    // Parcel statuses for the survey: 11E001 has its shape, 11E002 has none yet.
    assert.equal(up.statuses.sent, 2);
    assert.equal(fake.t.llan_parcel_status.get('11E002').link, 'no-shape');
    assert.equal(fake.t.llan_parcel_status.get('11E002').status, 'fix');
    assert.ok(fake.t.llan_config.has('status_checked'));

    // Office edit goes up by itself a moment later, with a history line.
    await office('PUT', '/api/owners/O1', { tel: '0812345678' });
    assert.ok(await until(() => fake.t.llan_records.get('O1').data.tel === '0812345678'), 'office edit reached Supabase');
    assert.ok([...fake.t.llan_change_log.values()].some(l => l.record_id === 'O1' && l.action === 'update'));

    // The web page: sees everything, edits another field of the same owner, adds a building, deletes a land.
    const web = await webSession(sb, 'editor@test.local');
    assert.equal(web.store.settings.org, 'อบต.ทดสอบ');
    const recs = await web.call('GET', '/api/records');
    assert.equal(recs.owners[0].tel, '0812345678');
    assert.equal(recs.lands.length, 2);
    const st = await web.call('GET', '/api/parcel-status');
    assert.equal(st.summary.total, 2);
    assert.ok(st.checkedAt);
    assert.equal(web.store.get('statuses', '11E002').link, 'no-shape');
    await web.call('PUT', '/api/owners/O1', { lastName: 'ดีมาก' });
    const b = await web.call('POST', '/api/buildings', { buildingCode: '11E002-B001', landIds: ['L2'], ownerIds: ['O1'] });
    await web.call('DELETE', '/api/lands/L1');
    assert.equal(fake.t.llan_records.get('O1').updated_by, 'editor@test.local');
    assert.ok(fake.t.llan_records.has('lands:555'), 'deletion note for LTAX');

    // Meanwhile the office changed a different field of the same owner: both changes survive.
    await office('PUT', '/api/owners/O1', { addrNo: '99' });
    const s = await office('POST', '/api/cloud/sync');
    assert.ok(s.changed >= 3, JSON.stringify(s));
    const o1 = await office('GET', '/api/owners/O1');
    assert.equal(o1.lastName, 'ดีมาก');
    assert.equal(o1.addrNo, '99');
    assert.equal(o1.tel, '0812345678');
    assert.equal(fake.t.llan_records.get('O1').data.addrNo, '99');
    assert.ok(await office('GET', `/api/buildings/${b.id}`), 'web building reached the office');
    assert.equal(await office('GET', '/api/lands/L1'), null, 'web deletion reached the office');
    assert.ok((await office('GET', '/api/deletions')).some(d => d.id === 'lands:555'));
    const log = await office('GET', '/api/log?limit=50');
    assert.ok(log.some(l => l.by === 'editor@test.local' && l.recordId === b.id), 'office history names the web user');

    // The web page picks up office changes on its next look.
    await office('PUT', '/api/lands/L2', { docNo: '777' });
    assert.ok(await until(async () => (await web.store.refresh()) > 0 && web.store.get('lands', 'L2').docNo === '777'), 'web saw the office edit');

    // A shape drawn on the web reaches the office map.
    const f = await web.call('POST', '/api/features', { kind: 'building', code: '11E002-B001', geometry: square(102.2, 17.7) });
    await office('POST', '/api/cloud/sync');
    assert.equal((await office('GET', `/api/features/${f.id}`)).code, '11E002-B001');

    // The survey draws the missing parcel: the office re-checks it and the web sees the new status.
    await web.call('POST', '/api/features', { kind: 'parcel', code: '11E002', geometry: square(102.3, 17.7) });
    await office('POST', '/api/cloud/sync');
    assert.ok(await until(() => fake.t.llan_parcel_status.get('11E002')?.link === 'ok', 10000), 'office re-checked 11E002');
    await web.store.refresh();
    assert.equal(web.store.get('statuses', '11E002').link, 'ok');
    assert.equal(fake.t.llan_parcel_status.get('11E001').link, 'no-record'); // its land was deleted on the web

    // The survey signs 11E002 off on the web; the office finds it waiting for LTAX.
    const mark = await web.call('POST', '/api/parcels/11E002/survey', { state: 'done' });
    assert.equal(mark.state, 'ready');
    assert.equal(fake.t.llan_records.get('L2').data.survey.by, 'editor@test.local');
    await office('POST', '/api/cloud/sync');
    const ready = await office('GET', '/api/survey');
    assert.deepEqual(ready.map(s => [s.code, s.state]), [['11E002', 'ready']]);
    assert.ok(ready[0].items.some(i => i.entity === 'buildings' && i.recordId === b.id));
    assert.ok(ready[0].items.some(i => i.entity === 'lands' && i.recordId === 'L2'));
    assert.ok(await until(() => fake.t.llan_parcel_status.get('11E002')?.info?.survey?.state === 'ready', 10000), 'office published the sign-off');
    await web.store.refresh();
    assert.equal((await web.call('GET', '/api/parcel-status')).rows.find(r => r.id === '11E002').survey, 'ready');
    // A form cannot clear the mark; editing after the sign-off asks for a new one.
    await web.call('PUT', '/api/lands/L2', { survey: null, docNo: '778' });
    assert.ok(fake.t.llan_records.get('L2').data.survey);
    assert.equal((await web.call('GET', '/api/survey'))[0].state, 'changed');
    await assert.rejects(web.call('POST', '/api/parcels/99Z999/survey', { state: 'done' }), /ยังไม่มีข้อมูลที่ดิน/);
    await web.call('POST', '/api/parcels/11E002/survey', { state: 'revisit', note: 'เจ้าของไม่อยู่' });
    assert.equal((await web.call('GET', '/api/survey'))[0].note, 'เจ้าของไม่อยู่');

    // A field photo: the page puts the picture in Supabase Storage, the record keeps its path.
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const photo1 = `lands/L2/${Date.now()}-w.jpg`;
    await new Cloud({ url: sb, key: PUBLISHABLE, token: 'tok:editor@test.local' }).uploadPhoto(photo1, jpg);
    const withPhoto = await web.call('POST', '/api/lands/L2/photos', { path: photo1, lat: 17.7, lon: 102.3 });
    assert.equal(withPhoto.photos[0].by, 'editor@test.local');
    assert.equal(withPhoto.photos[0].lat, 17.7);
    await assert.rejects(new Cloud({ url: sb, key: PUBLISHABLE, token: 'tok:viewer@test.local' }).uploadPhoto('lands/L2/v.jpg', jpg), /ไม่มีสิทธิ์/);
    await assert.rejects(web.call('POST', '/api/lands/L2/photos', { path: 'lands/OTHER/x.jpg' }), /ชื่อไฟล์รูปไม่ถูกต้อง/);
    await web.call('PUT', '/api/lands/L2', { photos: [], docNo: '779' }); // a form left open does not drop photos
    assert.equal(fake.t.llan_records.get('L2').data.photos.length, 1);
    await office('POST', '/api/cloud/sync');
    assert.equal((await office('GET', '/api/lands/L2')).photos[0].path, photo1);
    const pic = await fetch(`${base}/api/photos/file?path=${encodeURIComponent(photo1)}`);
    assert.equal(pic.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(new Uint8Array(await pic.arrayBuffer()), jpg);
    // The office adds one and removes the first.
    const photo2 = `lands/L2/${Date.now()}-o.jpg`;
    await office('POST', '/api/photos/file', { path: photo2, data: Buffer.from(jpg).toString('base64') });
    await office('POST', '/api/lands/L2/photos', { path: photo2 });
    await office('DELETE', `/api/lands/L2/photos?path=${encodeURIComponent(photo1)}`);
    await office('DELETE', `/api/photos/file?path=${encodeURIComponent(photo1)}`);
    assert.equal(fake.state.files.has(photo1), false);
    assert.ok(fake.state.files.has(photo2));
    assert.ok(await until(() => JSON.stringify(fake.t.llan_records.get('L2').data.photos?.map(p => p.path)) === JSON.stringify([photo2])), 'office photo list reached Supabase');

    // Viewers can read but not write; non-members see nothing.
    const viewer = await webSession(sb, 'viewer@test.local');
    assert.equal(viewer.store.list('owners').length, 1);
    await assert.rejects(viewer.call('PUT', '/api/owners/O1', { lastName: 'x' }), /ไม่มีสิทธิ์/);
    const stranger = await webSession(sb, 'stranger@test.local');
    assert.equal(stranger.store.list('owners').length, 0);
    assert.equal(await new Cloud({ url: sb, key: PUBLISHABLE, token: 'tok:stranger@test.local' }).myRole('stranger@test.local'), null);

    // Supabase out of reach: the office keeps working and sends later.
    fake.state.offline = true;
    await office('PUT', '/api/owners/O1', { email: 'a@b.c' });
    await sleep(2500);
    assert.ok((await office('GET', '/api/state')).settings.cloud.sync.queued >= 1);
    fake.state.offline = false;
    await office('POST', '/api/cloud/sync');
    assert.equal(fake.t.llan_records.get('O1').data.email, 'a@b.c');
    assert.equal((await office('GET', '/api/state')).settings.cloud.sync.queued, 0);
  } finally {
    proc.kill(); fake.server.close(); await sleep(300);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
