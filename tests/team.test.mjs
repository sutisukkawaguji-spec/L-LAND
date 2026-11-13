// Survey teams: plans split among members, locks, daily summaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workdays, planAssignments, spatialOrder, lockOf, summarize, progress, dayOf } from '../lib/team.mjs';

test('working days skip the days off', () => {
  // 2026-11-16 is a Monday
  assert.deepEqual(workdays('2026-11-14', '2026-11-17'), ['2026-11-14', '2026-11-16', '2026-11-17']); // Sat, (Sun off), Mon, Tue
  assert.deepEqual(workdays('2026-11-14', '2026-11-17', [1, 2, 3, 4, 5]), ['2026-11-16', '2026-11-17']);
  assert.deepEqual(workdays('2026-11-17', '2026-11-16'), []);
  assert.equal(dayOf('2026-11-13T18:30:00Z'), '2026-11-14', 'after 17:00 UTC it is the next day in Thailand');
});

test('a plan gives every member one compact area, worked day by day', () => {
  // A 10 x 6 grid of parcels; 3 members; 4 working days.
  const parcels = [];
  for (let x = 0; x < 10; x++) for (let y = 0; y < 6; y++) parcels.push({ code: `P${x}-${y}`, x, y });
  const plan = planAssignments({ parcels, count: 50, members: ['a', 'b', 'c'], start: '2026-11-16', end: '2026-11-19' });
  assert.equal(plan.total, 50);
  assert.deepEqual(plan.members.map(m => m.codes.length), [17, 17, 16]);
  assert.deepEqual(plan.members.map(m => m.perDay), [5, 5, 4]);
  assert.equal(plan.rows.length, 50);
  assert.equal(new Set(plan.rows.map(r => r.code)).size, 50, 'no parcel twice');
  assert.deepEqual(plan.dates, ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
  const a = plan.rows.filter(r => r.email === 'a');
  assert.equal(a.filter(r => r.due === '2026-11-16').length, 5);
  assert.equal(a.at(-1).due, '2026-11-19');
  // Compact: each member's parcels stay close together (small bounding box compared with the whole grid).
  for (const m of plan.members) {
    const pts = m.codes.map(c => parcels.find(p => p.code === c));
    const w = Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)) + 1, h = Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)) + 1;
    assert.ok(w * h <= 36, `${m.email}: ${w}x${h}`);
  }
  assert.throws(() => planAssignments({ parcels, members: [], start: '2026-11-16', end: '2026-11-19' }), /ลูกทีม/);
  assert.throws(() => planAssignments({ parcels, members: ['a'], start: '2026-11-22', end: '2026-11-22' }), /ไม่มีวันทำงาน/); // a Sunday
  assert.equal(spatialOrder([{ code: 'x', x: 1, y: 1 }]).length, 1);
});

test('parcels of another team are locked', () => {
  const assignments = new Map([['A1', { code: 'A1', team_id: 'T1', email: 'm1' }], ['B1', { code: 'B1', team_id: 'T2', email: 'm2' }]]);
  const surveys = new Map([['C1', { team: 'T2', state: 'done' }]]);
  const teamName = t => ({ T1: 'ทีมเหนือ', T2: 'ทีมใต้' })[t];
  const me = { email: 'm1', role: 'editor', team_id: 'T1' };
  assert.equal(lockOf('A1', { me, assignments, surveys, teamName }), null);
  assert.match(lockOf('B1', { me, assignments, surveys, teamName }).reason, /มอบหมายให้ทีมใต้แล้ว/);
  assert.match(lockOf('C1', { me, assignments, surveys, teamName }).reason, /ทีมใต้สำรวจแปลงนี้แล้ว/);
  assert.equal(lockOf('D1', { me, assignments, surveys, teamName }), null, 'nobody has it yet');
  assert.equal(lockOf('B1', { me: { ...me, role: 'admin' }, assignments, surveys }), null, 'admins may change everything');
  assert.ok(lockOf('A1', { me: { email: 'x', role: 'editor', team_id: null }, assignments, surveys }), 'without a team, team parcels are locked');
});

test('daily summary counts each parcel once per person and day', () => {
  const at = (day, h) => new Date(Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00+07:00`)).toISOString();
  const log = [
    { at: at('2026-11-16', 9), by_user: 'a', team_id: 'T1', code: 'P1', action: 'survey', state: 'done' },
    { at: at('2026-11-16', 10), by_user: 'a', team_id: 'T1', code: 'P1', action: 'survey', state: 'done' }, // signed again
    { at: at('2026-11-16', 11), by_user: 'a', team_id: 'T1', code: 'P2', action: 'survey', state: 'revisit' },
    { at: at('2026-11-16', 11), by_user: 'a', team_id: 'T1', code: 'P2', action: 'edit' },
    { at: at('2026-11-16', 12), by_user: 'b', team_id: 'T1', code: 'P3', action: 'survey', state: 'done' },
    { at: at('2026-11-17', 9), by_user: 'a', team_id: 'T1', code: 'P2', action: 'survey', state: 'done' },
    { at: at('2026-11-17', 9), by_user: 'a', team_id: 'T1', code: 'P2', action: 'photo' },
    { at: at('2026-11-17', 23), by_user: 'c', team_id: 'T2', code: 'Q1', action: 'survey', state: 'done' },
  ];
  const s = summarize(log);
  assert.deepEqual(s.days.map(d => [d.day, d.done, d.revisit, d.edit, d.photo, d.people]), [['2026-11-17', 2, 0, 0, 1, 2], ['2026-11-16', 2, 1, 1, 0, 2]]);
  assert.deepEqual(s.people.map(p => [p.email, p.done, p.days]), [['a', 2, 2], ['b', 1, 1], ['c', 1, 1]]);
  assert.equal(s.total.done, 4, 'P2 ended done, so it is not counted as revisit');
  assert.equal(s.total.revisit, 0);
  assert.equal(summarize(log, { person: 'a', from: '2026-11-17' }).total.done, 1);
  assert.equal(summarize(log, { team: 'T2' }).people.length, 1);
});

test('plan progress: done, due today, overdue', () => {
  const rows = [{ code: 'P1', email: 'a', team_id: 'T1', due: '2026-11-16' }, { code: 'P2', email: 'a', team_id: 'T1', due: '2026-11-17' },
    { code: 'P3', email: 'b', team_id: 'T1', due: '2026-11-17' }, { code: 'P4', email: 'b', team_id: 'T1', due: '2026-11-18' }];
  const st = { P1: 'ready', P3: 'revisit' };
  const p = progress(rows, c => st[c] || null, { today: '2026-11-17' });
  assert.deepEqual([p.total, p.done, p.remaining, p.dueToday, p.overdue, p.revisit, p.pct], [4, 1, 3, 2, 0, 1, 25]);
  assert.deepEqual(progress(rows, c => st[c] || null, { today: '2026-11-18', email: 'b' }).overdue, 1);
});

test('the data API refuses changes to parcels of another team and records the work', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { Store } = await import('../lib/store.mjs');
  const { coreRoutes, router } = await import('../lib/core-api.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'llan-guard-'));
  try {
    const store = await new Store(dir).open();
    await store.replaceAll('lands', [{ id: 'L1', parcelCode: '11E001' }, { id: 'L2', parcelCode: '11E002' }]);
    await store.replaceAll('buildings', [{ id: 'B1', buildingCode: '11E002-B001', landIds: ['L2'] }]);
    const work = [];
    const locked = code => (code === '11E002' ? { reason: 'มอบหมายให้ทีมใต้แล้ว' } : null);
    const call = (method, url, body) => router(coreRoutes(store, { team: () => 'T1', locked, onWork: ev => work.push(ev) }))(method, new URL(url, 'http://x')).run(body);
    await call('PUT', '/api/lands/L1', { docNo: '1' });
    await assert.rejects(call('PUT', '/api/lands/L2', { docNo: '2' }), /11E002: มอบหมายให้ทีมใต้แล้ว จึงแก้ไขไม่ได้/);
    await assert.rejects(call('PUT', '/api/buildings/B1', { noFloor: '2' }), /11E002/, 'a building on a locked parcel');
    await assert.rejects(call('POST', '/api/parcels/11E002/survey', { state: 'done' }), /บันทึกการสำรวจไม่ได้/);
    await assert.rejects(call('POST', '/api/features', { kind: 'building', code: '11E002-B009', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }), /แก้รูปไม่ได้/);
    const r = await call('POST', '/api/parcels/11E001/survey', { state: 'done' });
    assert.equal(r.code, '11E001');
    assert.equal(store.get('lands', 'L1').survey.team, 'T1');
    assert.deepEqual(work.map(w => [w.action, w.code, w.state ?? null]), [['edit', '11E001', null], ['survey', '11E001', 'done']]);
    assert.equal(store.get('lands', 'L2').docNo, undefined);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
