// The office L-LAN (127.0.0.1) as the monitoring centre of the survey teams: it sees every team and every
// surveyor through its secret key, adds people by their personal code, makes teams. Fake Supabase only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeSupabase, listen, SECRET, PUBLISHABLE } from './fake-supabase.mjs';
import { Cloud } from '../lib/cloud.mjs';
import { launchChrome, findChrome, listTargets, Page } from '../lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('office monitoring centre: teams, people by code, positions', { timeout: 180000 }, async () => {
  const fake = fakeSupabase({ 'admin@test.local': 'admin', 'm1@test.local': 'editor' });
  const sb = await listen(fake.server);
  const at = new Date().toISOString();
  fake.t.llan_teams.set('T1', { id: 'T1', name: 'ทีมเหนือ', color: '#2f80ed', join_key: 'NORT-0001', created_at: at });
  fake.info.set('m1@test.local', { team_id: 'T1', team_role: 'member', display_name: 'สมาชิกหนึ่ง' });
  fake.t.llan_locations.set('m1@test.local', { email: 'm1@test.local', name: 'สมาชิกหนึ่ง', team_id: 'T1', lat: 17.7, lon: 102.1, accuracy: 5, at });
  fake.t.llan_work_log.set('1', { id: 1, at, by_user: 'm1@test.local', team_id: 'T1', code: '11E001', action: 'survey', state: 'done' });
  const dir = mkdtempSync(path.join(tmpdir(), 'llan-office-team-'));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ org: 'อบต.ทดสอบ', cloud: { url: sb, key: SECRET, enabled: true } }));
  const port = 5600 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, LLAN_DATA_DIR: dir, LLAN_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (op, ...args) => {
    const res = await fetch(`${base}/api/team/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, args }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.result;
  };
  let child, profile;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/state`); break; } catch { await sleep(200); } }
    // Everything is visible to the office: keys, everyone's position, the work log.
    assert.deepEqual((await call('rpc', 'llan_team_keys')).map(t => t.join_key), ['NORT-0001']);
    assert.equal((await call('get', 'llan_locations?select=*')).length, 1);
    assert.equal((await call('getAll', 'llan_work_log', 'at,by_user,code,action,state', '', 'at.asc')).length, 1);
    await assert.rejects(call('get', 'llan_records?select=*'), /ไม่อนุญาต/);
    await assert.rejects(call('upsertOn', 'llan_members', [{ email: 'x' }], 'email'), /ไม่อนุญาต/);
    // A team made at the office gets a key.
    const [t2] = await call('rpc', 'llan_team_save', { p_id: null, p_name: 'ทีมใต้', p_color: '#eb5757' });
    assert.match(t2.join_key, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    assert.ok(fake.t.llan_teams.has(t2.id));
    // Someone signs up on the web page and reads out their code; the office adds them to a team.
    const code = await new Cloud({ url: sb, key: PUBLISHABLE, token: 'tok:new@test.local' }).rpc('llan_my_code', { p_name: 'ช่างใหม่' });
    assert.deepEqual((await call('rpc', 'llan_pending_users')).map(u => u.code), [code]);
    await assert.rejects(call('rpc', 'llan_add_by_code', { p_code: 'ZZZZ-0000', p_team_id: t2.id }), /ไม่พบรหัสผู้ใช้นี้/);
    const [added] = await call('rpc', 'llan_add_by_code', { p_code: code.toLowerCase(), p_team_id: t2.id, p_team_role: 'lead', p_role: 'editor' });
    assert.equal(added.email, 'new@test.local');
    assert.deepEqual([fake.info.get('new@test.local').team_id, fake.info.get('new@test.local').team_role, fake.info.get('new@test.local').display_name], [t2.id, 'lead', 'ช่างใหม่']);
    assert.deepEqual(await call('rpc', 'llan_pending_users'), []);
    await call('rpc', 'llan_member_set', { p_email: 'new@test.local', p_team_id: 'T1', p_team_role: 'member', p_role: 'editor', p_name: '' });
    assert.equal(fake.info.get('new@test.local').team_id, 'T1');
    const k = await call('rpc', 'llan_team_new_key', { p_id: 'T1' });
    assert.equal(fake.t.llan_teams.get('T1').join_key, k);

    // The office page shows the monitoring centre.
    if (!findChrome()) return;
    const cport = 9200 + Math.floor(Math.random() * 90);
    profile = path.join(dir, '..', `llan-office-chrome-${cport}`);
    child = await launchChrome({ port: cport, profileDir: profile, url: `${base}/`, headless: true });
    const p = await Page.attach((await listTargets(cport)).find(t => t.url.startsWith(base)));
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
    await p.waitReady();
    const ev = js => p.eval(js);
    const waitFor = async (js, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await ev(js)) return true; return false; };
    await ev(`document.querySelector('#loginOffline')?.click()`);
    assert.ok(await waitFor(`document.body.classList.contains('teams') && document.querySelector('#tabs button[data-tab=team]').offsetParent !== null`), 'team pages on the office');
    assert.equal(await ev(`document.querySelector('#tabs button[data-tab=mywork]').offsetParent`), null, 'no "my work" at the office');
    assert.ok(await waitFor(`/ออนไลน์\\s*1\\s*\\/\\s*2/.test(document.querySelector('#surveyChips').innerText)`), await ev(`document.querySelector('#surveyChips').innerText`));
    await ev(`document.querySelector('#tabs button[data-tab=team]').click()`);
    assert.ok(await waitFor(`/ศูนย์ติดตามทีมสำรวจ/.test(document.querySelector('#tab-team').innerText) && !!document.querySelector('#tab-team [data-locate="m1@test.local"]')`));
    assert.match(await ev(`document.querySelector('#tab-team .kpis').innerText`), /สำรวจเสร็จวันนี้\s*1/);
    assert.equal(await ev(`document.querySelector('#tab-team [data-chip=share]')`), null, 'the office shares no position');
  } finally {
    child?.kill(); proc.kill(); fake.server.close(); await sleep(400);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
