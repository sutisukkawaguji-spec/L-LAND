// End-to-end: L-LAN engine → headless Chrome → simulated LTAX (mock-ltax). Never the real system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockLtax } from '../mock-ltax/server.mjs';
import { Store } from '../lib/store.mjs';
import { LtaxEngine } from '../lib/ltax-engine.mjs';
import { launchChrome, findChrome, listTargets, Page } from '../lib/cdp.mjs';
import { syncFields, pendingState } from '../public/shared/diff.mjs';

const chrome = findChrome();

test('push and pull against the simulated LTAX', { skip: !chrome && 'ไม่พบ Chrome', timeout: 240000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'llan-e2e-'));
  const { server, DB } = createMockLtax({
    notCurrentYear: '2570', // exercises the "ยืนยันการแก้ไขข้อมูลปีภาษี" prompt
    db: {
      owners: [{ id: '200001', personType: 'บุคคลธรรมดา', psnId: '1100000000016', prefixName: 'นาง', firstName: 'ทดสอบ', lastName: 'ตัวอย่าง', addrProvince: 'อุดรธานี', addrAmphur: 'น้ำโสม', addrDistrict: 'น้ำโสม' }],
      lands: [{ id: '100001', parcelCode: '60A002', docType: '6', docNo: '1234', amphur: 'น้ำโสม', district: 'น้ำโสม', rai: '15', ngan: '3', wah: '12', ownerIds: ['200001'],
        uses: [{ usedType: '1', rai: '15', ngan: '3', wah: '12', usedFor: '1', agriType: '1' }] }],
    },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = 9600 + Math.floor(Math.random() * 300);
  const child = await launchChrome({ port, profileDir: path.join(dir, 'chrome'), url: `${base}/sso/login.do`, headless: true });
  const store = await new Store(path.join(dir, 'data')).open();
  await store.saveSettings({ ltax: { ssoUrl: `${base}/sso/login.do`, baseUrl: base, port, delayMs: 20, realModeEnabled: true } });
  const engine = new LtaxEngine(store, path.join(dir, 'data'));
  const run = job => new Promise((resolve, reject) => {
    const on = e => { if (e.jobId !== job.id || e.type !== 'done') return; engine.off('event', on); resolve(store.get('jobs', job.id)); };
    engine.on('event', on);
    setTimeout(() => reject(new Error('job timeout')), 120000);
  });
  try {
    // The user's login, done here by filling the simulated SSO form.
    const target = (await listTargets(port)).find(x => x.url.startsWith(base));
    const page = await Page.attach(target);
    await page.waitReady();
    await page.navigateBy(() => page.eval(`document.forms[0].login.value = 'tester'; document.forms[0].submit()`));
    page.close();
    assert.equal(await engine.enterLtax(), true);

    // Local copies as if imported from an LTAX export.
    const owner = await store.upsert('owners', { personType: 'บุคคลธรรมดา', psnId: '1100000000016', prefixName: 'นาง', firstName: 'ทดสอบ', lastName: 'ตัวอย่าง', addrProvince: 'อุดรธานี', addrAmphur: 'น้ำโสม', addrDistrict: 'น้ำโสม' });
    await store.upsert('owners', { ...owner, ltaxId: '200001', synced: syncFields('owners', owner) });
    const base0 = { parcelCode: '60A002', docType: '6', docNo: '1234', amphur: 'น้ำโสม', district: 'น้ำโสม', rai: '15', ngan: '3', wah: '12', ownerIds: [owner.id],
      uses: [{ usedType: '1', rai: '15', ngan: '3', wah: '12', usedFor: '1', agriType: '1' }] };
    let land = await store.upsert('lands', { ...base0, ltaxId: '100001', synced: syncFields('lands', base0) });
    // Survey result: new document number, other sub-district, part of the land left empty.
    land = await store.upsert('lands', { ...land, docNo: '9999', district: 'ศรีสำราญ',
      uses: [{ usedType: '1', rai: '15', ngan: '3', wah: '10', usedFor: '1', agriType: '1' }, { usedType: '6', rai: '0', ngan: '0', wah: '2', usedFor: '1' }] });
    assert.equal(pendingState('lands', land).action, 'update');

    await t.test('dry run fills and compares but saves nothing', async () => {
      const job = await run(await engine.startJob({ type: 'push', mode: 'dry', items: [{ entity: 'lands', recordId: land.id }] }));
      const [it] = job.items;
      assert.equal(it.status, 'done', it.message);
      assert.match(it.message, /ทดลองกรอกได้ครบ/);
      assert.ok(it.changes.some(c => c.field === 'docNo' && c.ltax === '1234' && c.local === '9999'));
      assert.ok(it.changes.some(c => c.field === 'district' && c.local === 'ศรีสำราญ'));
      assert.ok(it.changes.some(c => /การใช้ประโยชน์ลำดับ 2/.test(c.th)));
      assert.equal(DB.saves.length, 0);
      assert.equal(DB.lands[0].docNo, '1234');
    });

    await t.test('real run saves, answers the confirm prompt and reads back', async () => {
      const job = await run(await engine.startJob({ type: 'push', mode: 'real', items: [{ entity: 'lands', recordId: land.id }] }));
      const [it] = job.items;
      assert.equal(it.status, 'done', it.message);
      assert.match(it.message, /ตรวจซ้ำตรงกัน/);
      const l = DB.lands.find(x => x.id === '100001');
      assert.equal(l.docNo, '9999');
      assert.equal(l.district, 'ศรีสำราญ');
      assert.equal(l.uses.length, 2);
      assert.equal(l.uses[1].usedType, '6');
      assert.equal(pendingState('lands', store.get('lands', land.id)).action, null);
    });

    await t.test('new land is created from its owner page', async () => {
      const fresh = await store.upsert('lands', { parcelCode: '61B001', docType: '1', docNo: '555', amphur: 'น้ำโสม', district: 'นางัว', rai: '0', ngan: '1', wah: '0', ownerIds: [owner.id],
        uses: [{ usedType: '2', rai: '0', ngan: '1', wah: '0', usedFor: '1' }] });
      const job = await run(await engine.startJob({ type: 'push', mode: 'real', items: [{ entity: 'lands', recordId: fresh.id }] }));
      assert.equal(job.items[0].status, 'done', job.items[0].message);
      const l = DB.lands.find(x => x.parcelCode === '61B001');
      assert.deepEqual(l.ownerIds, ['200001']);
      assert.equal(l.uses[0].usedType, '2');
      assert.equal(store.get('lands', fresh.id).ltaxId, l.id);
    });

    await t.test('new owner with chained address selects and a title outside the captured list', async () => {
      const o = await store.upsert('owners', { personType: 'บุคคลธรรมดา', psnId: '1100000000024', prefixName: 'พระ', firstName: 'ใหม่', lastName: 'ทดสอบ', addrProvince: 'อุดรธานี', addrAmphur: 'บ้านผือ', addrDistrict: 'หายโศก', postalCode: '41160' });
      const job = await run(await engine.startJob({ type: 'push', mode: 'real', items: [{ entity: 'owners', recordId: o.id }] }));
      assert.equal(job.items[0].status, 'done', job.items[0].message);
      const m = DB.owners.find(x => x.psnId === '1100000000024');
      assert.equal(m.prefixName, 'พระ');
      assert.equal(m.addrAmphur, 'บ้านผือ');
      assert.equal(m.addrDistrict, 'หายโศก');
    });

    await t.test('records with errors are skipped', async () => {
      const bad = await store.upsert('lands', { parcelCode: '62C001', docType: '', amphur: 'น้ำโสม', district: 'น้ำโสม', rai: '1', ownerIds: [owner.id], uses: [] });
      const job = await run(await engine.startJob({ type: 'push', mode: 'real', items: [{ entity: 'lands', recordId: bad.id }] }));
      assert.equal(job.items[0].status, 'skipped');
      assert.ok(!DB.lands.some(x => x.parcelCode === '62C001'));
    });

    await t.test('pull brings LTAX changes in', async () => {
      DB.lands.find(x => x.id === '100001').docNo = '7777';
      const job = await run(await engine.startJob({ type: 'pull', items: [{ entity: 'lands', recordId: land.id }] }));
      assert.equal(job.items[0].status, 'done', job.items[0].message);
      const l = store.get('lands', land.id);
      assert.equal(l.docNo, '7777');
      assert.equal(l.uses.length, 2);
      assert.equal(pendingState('lands', l).action, null);
    });

    await t.test('check records whether codes exist in LTAX without changing anything', async () => {
      const saves = DB.saves.length;
      const job = await run(await engine.startJob({ type: 'check', items: [{ kind: 'parcel', code: '60a002' }, { kind: 'parcel', code: '99Z999' }] }));
      assert.deepEqual(job.items.map(i => i.message), ['พบใน LTAX', 'ไม่พบใน LTAX']);
      assert.equal(store.get('checks', 'parcel:60A002').found, true);
      assert.equal(store.get('checks', 'parcel:99Z999').found, false);
      assert.equal(DB.saves.length, saves);
      const st = await engine.status();
      assert.equal(st.user.name, 'ผู้ทดสอบ');
      assert.equal(st.user.org, 'อบต.ทดสอบ');
    });

    await t.test('push results are remembered per record and a stopped job can be resumed', async () => {
      assert.equal(store.get('pushes', `lands:${land.id}`).mode, 'real');
      assert.equal(store.get('pushes', `lands:${land.id}`).status, 'done');
      const a = await store.upsert('lands', { ...store.get('lands', land.id), docNo: '8888' });
      const b = await store.upsert('lands', { parcelCode: '63D001', docType: '1', amphur: 'น้ำโสม', district: 'นางัว', rai: '0', ngan: '1', wah: '0', ownerIds: [owner.id], uses: [{ usedType: '1', rai: '0', ngan: '1', wah: '0', usedFor: '1', agriType: '1' }] });
      // Stop right after the first item has started.
      const started = await engine.startJob({ type: 'push', mode: 'dry', items: [{ entity: 'lands', recordId: a.id }, { entity: 'lands', recordId: b.id }] });
      engine.stop(started.id);
      const first = await run(started);
      assert.equal(first.status, 'stopped');
      assert.ok(first.items.some(i => i.status === 'cancelled'));
      const resumed = await run(await engine.startJob({ resumeOf: first.id }));
      assert.equal(resumed.resumeOf, first.id);
      assert.deepEqual(resumed.items.map(i => i.recordId), first.items.filter(i => i.status !== 'done').map(i => i.recordId));
      assert.ok(resumed.items.every(i => i.status === 'done'), JSON.stringify(resumed.items.map(i => i.message)));
      await assert.rejects(engine.startJob({ resumeOf: resumed.id }), /ทำครบทุกรายการแล้ว/);
    });
  } finally {
    engine.page?.close();
    child.kill();
    server.close();
    await store.flush();
    await new Promise(r => setTimeout(r, 500));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
