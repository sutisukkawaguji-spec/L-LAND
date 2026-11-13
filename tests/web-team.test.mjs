// Survey teams on the github.io page: a lead makes a work plan, members see their work and share where they
// are, the lead sees them, a member of another team cannot change those parcels, admins make teams.
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
import { Cloud } from '../lib/cloud.mjs';
import { todayTh, addDays } from '../lib/team.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('survey teams: plan, my work, positions, locks, team admin', { skip: !findChrome() && 'ไม่พบ Chrome', timeout: 240000 }, async () => {
  const fake = fakeSupabase({ 'admin@test.local': 'admin', 'lead@test.local': 'editor', 'm1@test.local': 'editor', 'm2@test.local': 'editor', 'other@test.local': 'editor' });
  const sb = await listen(fake.server);
  const at = new Date().toISOString();
  fake.t.llan_teams.set('T1', { id: 'T1', name: 'ทีมเหนือ', color: '#2f80ed', join_key: 'NORT-0001', created_at: at });
  fake.t.llan_teams.set('T2', { id: 'T2', name: 'ทีมใต้', color: '#eb5757', join_key: 'SOUT-0002', created_at: at });
  fake.info.set('lead@test.local', { team_id: 'T1', team_role: 'lead', display_name: 'หัวหน้าเหนือ' });
  fake.info.set('m1@test.local', { team_id: 'T1', team_role: 'member', display_name: 'สมาชิกหนึ่ง' });
  fake.info.set('m2@test.local', { team_id: 'T1', team_role: 'member', display_name: 'สมาชิกสอง' });
  fake.info.set('other@test.local', { team_id: 'T2', team_role: 'member', display_name: 'คนทีมใต้' });
  // 12 parcels in a 4 x 3 grid, each with its land record
  const sq = (x, y, d = 0.0005) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
  fake.t.llan_layers.set('LP', Cloud.layerRow({ id: 'LP', name: 'แปลงที่ดิน', kind: 'parcel', crs: 'EPSG:4326', codeField: 'parcel_cod', fields: [], count: 12 }));
  for (let i = 0; i < 12; i++) {
    const code = `P${String(i + 1).padStart(2, '0')}`;
    fake.t.llan_features.set(`F${i}`, { ...Cloud.featureRow({ id: `F${i}`, layerId: 'LP', kind: 'parcel', fid: i, code, geometry: sq(102.1 + (i % 4) * 0.0006, 17.7 + Math.floor(i / 4) * 0.0006), areaM2: 3000, attrs: {} }, 'office'), rev: 1 });
    fake.t.llan_records.set(`L${i}`, { id: `L${i}`, entity: 'lands', data: { id: `L${i}`, parcelCode: code, ownerIds: [] }, rev: 1, updated_at: at });
  }
  fake.t.llan_config.set('settings', { key: 'settings', value: JSON.stringify({ org: 'อบต.ทดสอบ' }) });

  const dist = mkdtempSync(path.join(tmpdir(), 'llan-team-'));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-web.mjs'), dist], { cwd: ROOT, env: { ...process.env, LLAN_SUPABASE_URL: sb, LLAN_SUPABASE_KEY: PUBLISHABLE }, stdio: 'ignore' });
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const site = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname), file = path.join(dist, p === '/' ? 'index.html' : p);
    if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  });
  const web = await listen(site, '127.0.0.3');
  const port = 9300 + Math.floor(Math.random() * 150);
  const profile = path.join(dist, '..', `llan-team-chrome-${port}`);
  const child = await launchChrome({ port, profileDir: profile, url: `${web}/`, headless: true });
  try {
    const p = await Page.attach((await listTargets(port)).find(t => t.url.startsWith(web)));
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 860, deviceScaleFactor: 1, mobile: false });
    await p.waitReady(); await sleep(600);
    const ev = (js, o) => p.eval(js, o);
    const waitFor = async (js, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await ev(js)) return true; return false; };
    const signIn = async email => {
      await ev(`localStorage.removeItem('llan.full.session')`);
      await p.goto(`${web}/`); await sleep(500);
      await ev(`document.querySelector('#wEmail').value = ${JSON.stringify(email)}; document.querySelector('#wPass').value = ${JSON.stringify(PASSWORD)}; document.querySelector('#webLogin').requestSubmit()`);
      assert.ok(await waitFor(`document.querySelector('#login').hidden && !document.querySelector('.join-screen')`), `${email} signed in`);
      await sleep(500);
    };
    const tab = async name => { await ev(`document.querySelector('#tabs button[data-tab=${name}]').click()`); await sleep(400); };
    const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`);
    const confirmYes = async () => { assert.ok(await waitFor(`document.querySelector('#confirmBox').open`)); await ev(`document.querySelector('#confirmBox button[value=yes]').click()`); await sleep(300); };

    // 1. The lead plans 8 parcels for 4 days; the two members get 4 each, one a day.
    await signIn('lead@test.local');
    assert.equal(await ev(`document.querySelector('#tabs button[data-tab=plan]').offsetParent !== null`), true, 'leads see แผนงาน');
    await tab('plan');
    const start = todayTh(), end = addDays(start, 3);
    await ev(`{ const set = (k, v) => { const el = document.querySelector('[data-plan="' + k + '"]'); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
      set('source', 'all'); }`);
    await sleep(200);
    await ev(`{ const set = (k, v) => { const el = document.querySelector('[data-plan="' + k + '"]'); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
      set('name', 'สัปดาห์แรก'); set('count', '8'); set('start', ${JSON.stringify(start)}); set('end', ${JSON.stringify(end)});
      for (const d of [0, 1, 2, 3, 4, 5, 6]) { const c = document.querySelector('[data-day="' + d + '"]'); if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } } }`);
    await sleep(300);
    assert.match(await text('#tab-plan .avail'), /12/);
    assert.match(await text('#tab-plan .calc'), /8 แปลง ÷ 2 คน/);
    await ev(`document.querySelector('[data-act="plan-calc"]').click()`);
    assert.ok(await waitFor(`!!document.querySelector('#tab-plan .preview')`));
    assert.match(await text('#tab-plan .preview'), /สมาชิกหนึ่ง\s+4\s+1/);
    await ev(`document.querySelector('[data-act="plan-save"]').click()`);
    await confirmYes();
    assert.ok(await waitFor(`/สัปดาห์แรก/.test(document.querySelector('#tab-plan').innerText)`));
    const rows = [...fake.t.llan_assignments.values()];
    assert.equal(rows.length, 8);
    assert.deepEqual([...new Set(rows.map(r => r.team_id))], ['T1']);
    assert.equal(rows.filter(r => r.email === 'm1@test.local').length, 4);
    assert.equal(rows.filter(r => r.email === 'm1@test.local' && r.due === start).length, 1);
    assert.equal(fake.t.llan_plans.size, 1);

    // 2. A member sees today's work and shares where they are.
    await p.send('Browser.grantPermissions', { origin: web, permissions: ['geolocation'] }).catch(() => {});
    await p.send('Emulation.setGeolocationOverride', { latitude: 17.7003, longitude: 102.1003, accuracy: 8 });
    await signIn('m1@test.local');
    assert.ok(await waitFor(`/วันนี้\\s*0\\/1/.test(document.querySelector('#surveyChips').innerText)`), await text('#surveyChips'));
    await tab('mywork');
    assert.ok(await waitFor(`document.querySelectorAll('#tab-mywork .work-item').length === 1`), 'one parcel due today');
    await ev(`document.querySelector('#tab-mywork [data-seg=my] button[data-v=all]').click()`); await sleep(300);
    assert.equal(await ev(`document.querySelectorAll('#tab-mywork .work-item').length`), 4);
    for (let i = 0; i < 60 && !fake.t.llan_locations.has('m1@test.local'); i++) await sleep(200);
    const pos = fake.t.llan_locations.get('m1@test.local');
    assert.ok(pos, 'position shared');
    assert.equal(pos.team_id, 'T1');
    assert.equal(Math.round(pos.lat * 1e4), 177003);
    // The member's own parcel can be signed off from the map panel.
    const myCode = rows.find(r => r.email === 'm1@test.local' && r.due === start).code;

    // 3. Someone of another team: the parcel is locked.
    await signIn('other@test.local');
    await tab('map');
    await ev(`{ const q = document.querySelector('#mapSearch'); q.value = ${JSON.stringify(myCode)}; q.dispatchEvent(new Event('change')); }`);
    assert.ok(await waitFor(`document.querySelector('#mapSide').classList.contains('locked')`), 'panel locked');
    assert.match(await text('#mapSide .lock-box'), /มอบหมายให้ทีมเหนือแล้ว/);
    assert.equal(await ev(`document.querySelector('#mapSide .survey-box .row')?.offsetParent ?? null`), null, 'no survey buttons');
    assert.equal(await ev(`document.querySelector('#tabs button[data-tab=plan]').offsetParent === null`), true, 'members do not see แผนงาน');

    // 4. The lead sees where the team is.
    await signIn('lead@test.local');
    await tab('team');
    assert.ok(await waitFor(`/สมาชิกหนึ่ง/.test(document.querySelector('#tab-team').innerText) && !!document.querySelector('#tab-team [data-locate="m1@test.local"]')`), 'm1 position listed');
    assert.match(await text('#tab-team .key-box'), /NORT-0001/);

    // 5. Admin: a new team gets a key; the summary page has the day's figures.
    await signIn('admin@test.local');
    await tab('team');
    await ev(`{ const f = document.querySelector('#teamNew'); f.name.value = 'ทีมกลาง'; f.requestSubmit(); }`);
    assert.ok(await waitFor(`/ทีมกลาง/.test(document.querySelector('#tab-team').innerText)`));
    const t3 = [...fake.t.llan_teams.values()].find(t => t.name === 'ทีมกลาง');
    assert.match(await text('#tab-team'), new RegExp(t3.join_key));
    await tab('summary');
    assert.ok(await waitFor(`!!document.querySelector('#tab-summary .kpis')`));
    assert.match(await text('#tab-summary .kpis'), /ตามแผนงาน\s*0\/8/);

    // 6. A newcomer gets a personal code; the admin adds them with it and their page opens by itself.
    await ev(`localStorage.removeItem('llan.full.session')`); await p.goto(`${web}/`); await sleep(500);
    await ev(`document.querySelector('#wEmail').value = 'newbie@test.local'; document.querySelector('#wPass').value = ${JSON.stringify(PASSWORD)}; document.querySelector('#webLogin').requestSubmit()`);
    assert.ok(await waitFor(`/^U\\d{3}-/.test(document.querySelector('#myCode')?.textContent || '')`), 'personal code shown');
    assert.equal(await ev(`!!document.querySelector('.join-screen [data-skip]')`), false, 'no skipping without membership');
    await ev(`{ const n = document.querySelector('#myName'); n.value = 'น้องใหม่'; n.dispatchEvent(new Event('change')); }`);
    await sleep(500);
    const code = await ev(`document.querySelector('#myCode').textContent`);
    assert.equal(fake.codes.get('newbie@test.local').name, 'น้องใหม่');
    const admin = new Cloud({ url: sb, key: PUBLISHABLE, token: 'tok:admin@test.local' });
    await admin.rpc('llan_add_by_code', { p_code: code.toLowerCase(), p_team_id: 'T2', p_team_role: 'member', p_role: 'editor' });
    assert.ok(await waitFor(`document.querySelector('#login').hidden && !document.querySelector('.join-screen')`, 15000), 'page opened once added');
    assert.ok(await waitFor(`/ทีมใต้/.test(document.querySelector('#surveyChips').innerText)`));
    assert.equal(fake.info.get('newbie@test.local').display_name, 'น้องใหม่');
    // A lead may add only to their own team; the admin adds from the pending list on the team page.
    const lead = new Cloud({ url: sb, key: PUBLISHABLE, token: 'tok:lead@test.local' });
    const code2 = await new Cloud({ url: sb, key: PUBLISHABLE, token: 'tok:newbie2@test.local' }).rpc('llan_my_code', { p_name: 'น้องใหม่สอง' });
    await assert.rejects(lead.rpc('llan_add_by_code', { p_code: code2, p_team_id: 'T2' }), /เฉพาะผู้ดูแล หรือหัวหน้าของทีมนั้น/);
    await assert.rejects(lead.rpc('llan_add_by_code', { p_code: 'NOPE-0000', p_team_id: 'T1' }), /ไม่พบรหัสผู้ใช้นี้/);
    await signIn('admin@test.local');
    await tab('team');
    assert.ok(await waitFor(`!!document.querySelector('#tab-team [data-fill-code="${code2}"]')`), 'pending list shows the code');
    await ev(`document.querySelector('#tab-team [data-fill-code="${code2}"]').click()`);
    await ev(`{ const f = document.querySelector('#addByCode'); f.team.value = 'T1'; f.trole.value = 'lead'; f.requestSubmit(); }`);
    for (let i = 0; i < 40 && fake.info.get('newbie2@test.local')?.team_id !== 'T1'; i++) await sleep(150);
    assert.deepEqual([fake.info.get('newbie2@test.local')?.team_id, fake.info.get('newbie2@test.local')?.team_role, fake.members['newbie2@test.local']], ['T1', 'lead', 'editor']);
  } finally {
    child.kill(); site.close(); fake.server.close(); await sleep(400);
    rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('before the team SQL is run the page works as before', { skip: !findChrome() && 'ไม่พบ Chrome', timeout: 120000 }, async () => {
  const fake = fakeSupabase(undefined, { teams: false });
  const sb = await listen(fake.server);
  const at = new Date().toISOString();
  fake.t.llan_records.set('L1', { id: 'L1', entity: 'lands', data: { id: 'L1', parcelCode: '11E001' }, rev: 1, updated_at: at });
  const dist = mkdtempSync(path.join(tmpdir(), 'llan-noteam-'));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-web.mjs'), dist], { cwd: ROOT, env: { ...process.env, LLAN_SUPABASE_URL: sb, LLAN_SUPABASE_KEY: PUBLISHABLE }, stdio: 'ignore' });
  const site = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname), file = path.join(dist, p === '/' ? 'index.html' : p);
    if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  });
  const web = await listen(site, '127.0.0.3');
  const port = 9460 + Math.floor(Math.random() * 30);
  const profile = path.join(dist, '..', `llan-noteam-chrome-${port}`);
  const child = await launchChrome({ port, profileDir: profile, url: `${web}/`, headless: true });
  try {
    const p = await Page.attach((await listTargets(port)).find(t => t.url.startsWith(web)));
    await p.waitReady(); await sleep(500);
    const ev = js => p.eval(js);
    await ev(`document.querySelector('#wEmail').value = 'editor@test.local'; document.querySelector('#wPass').value = ${JSON.stringify(PASSWORD)}; document.querySelector('#webLogin').requestSubmit()`);
    for (let i = 0; i < 40 && !(await ev(`document.querySelector('#login').hidden`)); i++) await sleep(200);
    assert.equal(await ev(`document.querySelector('#login').hidden`), true, await ev(`document.querySelector('#loginState').textContent`));
    assert.equal(await ev(`!!document.querySelector('.join-screen')`), false, 'no team key asked');
    assert.equal(await ev(`document.body.classList.contains('teams')`), false);
    assert.equal(await ev(`document.querySelector('#tabs button[data-tab=mywork]').offsetParent`), null, 'team pages hidden');
    await ev(`document.querySelector('#tabs button[data-tab=registry]').click()`);
    await sleep(400);
    assert.match(await ev(`document.querySelector('#tab-registry').textContent`), /11E001/);
  } finally {
    child.kill(); site.close(); fake.server.close(); await sleep(400);
    rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
