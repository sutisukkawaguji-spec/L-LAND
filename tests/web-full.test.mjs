// The full L-LAN on the web (github.io build): sign in with Supabase, work on the data kept there.
// Built site + headless Chrome + the fake Supabase. Never the real project.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, findChrome, listTargets, Page } from '../lib/cdp.mjs';
import { fakeSupabase, listen, PUBLISHABLE, PASSWORD } from './fake-supabase.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('github.io page: sign in, see the register from Supabase, save an edit', { skip: !findChrome() && 'ไม่พบ Chrome', timeout: 180000 }, async () => {
  const fake = fakeSupabase();
  const sb = await listen(fake.server);
  const at = new Date().toISOString();
  const rec = (id, entity, data) => fake.t.llan_records.set(id, { id, entity, data: { ...data, id }, rev: 1, updated_at: at });
  rec('O1', 'owners', { personType: '1', prefixName: 'นาย', firstName: 'สมชายเว็บ', lastName: 'ดี' });
  rec('L1', 'lands', { parcelCode: '11E001', ownerIds: ['O1'] });
  fake.t.llan_config.set('settings', { key: 'settings', value: JSON.stringify({ org: 'อบต.ทดสอบ' }) });
  // What the office's central system decided about the parcel
  fake.t.llan_parcel_status.set('11E001', { id: '11E001', code: '11E001', status: 'fix', link: 'no-shape', ltax: 'found', pending: null,
    reasons: [{ level: 'fix', text: 'มีข้อมูลในทะเบียน แต่ยังไม่มีรูปแปลงบนแผนที่' }], info: { featureIds: [], landIds: ['L1'], areaDocWah: 100 }, rev: 1, updated_at: at });
  fake.t.llan_config.set('status_checked', { key: 'status_checked', value: at });

  const dist = mkdtempSync(path.join(tmpdir(), 'llan-full-'));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-web.mjs'), dist], { cwd: ROOT, env: { ...process.env, LLAN_SUPABASE_URL: sb, LLAN_SUPABASE_KEY: PUBLISHABLE }, stdio: 'ignore' });
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const site = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname), file = path.join(dist, p === '/' ? 'index.html' : p);
    if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  });
  // Not 127.0.0.1 / localhost, so the page behaves as on github.io.
  const web = await listen(site, '127.0.0.3');
  const port = 9800 + Math.floor(Math.random() * 150);
  const profile = path.join(dist, '..', `llan-full-chrome-${port}`);
  const child = await launchChrome({ port, profileDir: profile, url: `${web}/`, headless: true });
  try {
    const p = await Page.attach((await listTargets(port)).find(t => t.url.startsWith(web)));
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
    await p.waitReady(); await sleep(1000);
    const ev = (js, o) => p.eval(js, o);
    const login = async (email, pass) => {
      await ev(`document.querySelector('#wEmail').value = ${JSON.stringify(email)}; document.querySelector('#wPass').value = ${JSON.stringify(pass)}; document.querySelector('#webLogin').requestSubmit()`);
      for (let i = 0; i < 20; i++) { await sleep(250); if (await ev(`document.querySelector('#login').hidden || /สิทธิ์|ไม่ถูกต้อง/.test(document.querySelector('#loginState').textContent)`)) break; }
    };
    await login('stranger@test.local', PASSWORD);
    assert.match(await ev(`document.querySelector('#loginState').textContent`), /ยังไม่ได้รับสิทธิ์/);
    await login('editor@test.local', PASSWORD);
    assert.equal(await ev(`document.querySelector('#login').hidden`), true, await ev(`document.querySelector('#loginState').textContent`));
    assert.match(await ev(`document.querySelector('#userChip').textContent`), /editor@test\.local/);
    // LTAX and settings are office-only.
    assert.equal(await ev(`document.querySelector('#tabs button[data-tab=ltax]').offsetParent === null`), true);
    assert.equal(await ev(`document.querySelector('#tabs button[data-tab=settings]').offsetParent === null`), true);
    // The survey's work list from the central system
    assert.equal(await ev(`document.querySelector('#badgeFix').textContent`), '1');
    await ev(`document.querySelector('#tabs button[data-tab=status]').click()`);
    await sleep(300);
    assert.match(await ev(`document.querySelector('#stTable').textContent`), /11E001.*ยังไม่มีรูปแปลง/s);
    assert.match(await ev(`document.querySelector('#stWhen').textContent`), /ระบบกลางตรวจล่าสุด/);
    // The survey marks the parcel done from the work list.
    await ev(`document.querySelector('#stTable button[data-survey="11E001"]').click()`);
    for (let i = 0; i < 20 && !(await ev(`document.querySelector('#confirmBox').open`)); i++) await sleep(100);
    await ev(`document.querySelector('#surveyNote').value = 'ตรวจครบ'; document.querySelector('#confirmBox button[value=yes]').click()`);
    for (let i = 0; i < 40 && !fake.t.llan_records.get('L1').data.survey; i++) await sleep(150);
    assert.equal(fake.t.llan_records.get('L1').data.survey?.state, 'done');
    assert.equal(fake.t.llan_records.get('L1').data.survey.note, 'ตรวจครบ');
    for (let i = 0; i < 20 && !/สำรวจเสร็จ รอลง LTAX/.test(await ev(`document.querySelector('#stSummary').textContent + document.querySelector('#stTable').textContent`)); i++) await sleep(150);
    assert.match(await ev(`document.querySelector('#stTable').textContent`), /สำรวจเสร็จ รอลง LTAX/);
    assert.equal(await ev(`document.querySelector('#mapColor').value`), 'status');
    await ev(`document.querySelector('#tabs button[data-tab=registry]').click()`);
    await sleep(500);
    assert.match(await ev(`document.querySelector('#tab-registry').textContent`), /สมชายเว็บ|11E001/);

    // Save through the page's own data API (the same calls the forms make).
    const saved = await ev(`(async () => {
      const { Cloud } = await import('./lib/cloud.mjs');
      const s = JSON.parse(localStorage.getItem('llan.full.session'));
      const c = new Cloud({ url: ${JSON.stringify(sb)}, key: ${JSON.stringify(PUBLISHABLE)}, token: s.access_token });
      const [row] = await c.saveRecords([{ entity: 'owners', id: 'O1', patch: { tel: '0899999999' }, unset: [] }], s.email);
      return row.updated_by;
    })()`, { awaitPromise: true });
    assert.equal(saved, 'editor@test.local');
    assert.equal(fake.t.llan_records.get('O1').data.tel, '0899999999');
    assert.equal(fake.t.llan_records.get('O1').data.firstName, 'สมชายเว็บ');
  } finally {
    child.kill(); site.close(); fake.server.close(); await sleep(400);
    rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
