// ตารางแบบฟอร์ม LTAX: the register out to Excel laid out like the LTAX entry forms, and back in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildLtaxTable, planTableImport, TABLE_SHEETS } from '../lib/ltax-table.mjs';
import { writeXlsx, readXlsx, unzip } from '../lib/xlsx.mjs';
import { syncFields, pendingState } from '../public/shared/diff.mjs';
import { Store } from '../lib/store.mjs';
import { coreRoutes, router } from '../lib/core-api.mjs';

const synced = (entity, r) => ({ ...r, synced: syncFields(entity, r) });
function sampleDb() {
  const O1 = synced('owners', { id: 'O1', ltaxId: '9001', personType: 'บุคคลธรรมดา', prefixName: 'นาย', firstName: 'สมชาย', lastName: 'ใจดี', psnId: '1101700203451',
    addrNo: '12', addrVillage: '3', currVillage: '5', tel: '0812345678', addrProvince: 'หนองคาย' });
  const O2 = { id: 'O2', personType: 'นิติบุคคล', prefixName: 'บริษัท', firstName: 'ทดสอบ จำกัด', psnId: '' };
  const L1 = synced('lands', { id: 'L1', ltaxId: '7001', parcelCode: '11E001', docType: '1', docNo: '123', scale: '(5000)', amphur: 'เมือง', district: 'ในเมือง',
    rai: '1', ngan: '2', wah: '30.5', ownerIds: ['O1', 'O2'], uses: [{ usedType: '1', rai: '1', ngan: '2', wah: '30.5', usedFor: '1', agriType: '1' }] });
  const B1 = synced('buildings', { id: 'B1', buildingCode: '11E001-B001', buildingType: '101', structure: '2', noFloor: '1', width: '6', length: '8', landIds: ['L1'], ownerIds: ['O1'],
    uses: [{ usedType: '2', fullArea: true, area: '48', usedFor: '1' }] });
  const S1 = { id: 'S1', signboardCode: 'SG01', signboardName: 'ร้านค้า', landId: 'L1', ownerIds: ['O2'], width: '100', height: '50' };
  return { owners: [O1, O2], lands: [L1], buildings: [B1], signboards: [S1], features: [] };
}
const roundTrip = async (db, opts) => readXlsx(writeXlsx(buildLtaxTable(db, opts)));
const sheetOf = (sheets, key) => sheets.find(s => s.name === TABLE_SHEETS[key]);
const col = (sheet, header) => { const i = sheet.rows[0].indexOf(header); assert.ok(i >= 0, `no column ${header} in ${sheet.name}`); return i; };

test('the table round-trips without changing anything', async () => {
  const db = sampleDb();
  const sheets = await roundTrip(db);
  assert.deepEqual(sheets.map(s => s.name), [...Object.values(TABLE_SHEETS), 'รายการให้เลือก', 'วิธีใช้']);
  const owners = sheetOf(sheets, 'owners');
  // Labels as on the LTAX form; repeated labels carry their group.
  assert.ok(owners.rows[0].includes('ที่อยู่ตามบัตรประชาชน: หมู่ที่/ชุมชน'));
  assert.ok(owners.rows[0].includes('ที่อยู่ปัจจุบัน: หมู่ที่/ชุมชน'));
  assert.equal(owners.rows[1][col(owners, 'เลขประจำตัวประชาชน')], '1101700203451');
  const lands = sheetOf(sheets, 'lands');
  assert.equal(lands.rows[1][col(lands, 'ประเภทเอกสารสิทธิ์')], 'โฉนด');
  assert.equal(lands.rows[1][col(lands, 'เจ้าของ (เลขประจำตัวประชาชน)')], '1101700203451, O2');
  const plan = planTableImport(db, sheets);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.changes.length, 0);
  assert.deepEqual(plan.counts.owners, { create: 0, update: 0, same: 2 });
  assert.equal(plan.counts.lands.same, 1);
});

test('the file has drop-down lists, red required headers and text columns', async () => {
  const files = await unzip(writeXlsx(buildLtaxTable(sampleDb(), { scope: 'blank' })));
  const text = name => new TextDecoder().decode(files.find(f => f.name === name).data);
  const lands = text('xl/worksheets/sheet2.xml');
  assert.match(lands, /<dataValidation type="list"[^>]*sqref="[A-Z]+2:[A-Z]+\d+"><formula1>'รายการให้เลือก'!\$[A-Z]+\$2:\$[A-Z]+\$\d+<\/formula1>/);
  assert.match(text('xl/styles.xml'), /numFmtId="49"/);
  assert.match(lands, /<col [^>]*style="3"/);
  assert.match(text('xl/worksheets/sheet5.xml'), /<formula1>&quot;ใช่&quot;<\/formula1>/); // building use: เต็มพื้นที่ทุกชั้น
});

test('edits, new rows and links come back as changes waiting for LTAX', async () => {
  const db = sampleDb();
  const sheets = await roundTrip(db);
  const owners = sheetOf(sheets, 'owners'), lands = sheetOf(sheets, 'lands'), landUses = sheetOf(sheets, 'landUses'), buildings = sheetOf(sheets, 'buildings');
  const blankRow = s => s.rows[0].map(() => '');
  // An owner's phone changes; a new owner is added (no L-LAN id).
  owners.rows[1][col(owners, 'โทรศัพท์')] = '0899999999';
  const nr = blankRow(owners);
  nr[col(owners, 'ประเภทบุคคล')] = 'บุคคลธรรมดา'; nr[col(owners, 'คำนำหน้าชื่อ/หน่วยงาน')] = 'นาง'; nr[col(owners, 'ชื่อ')] = 'สมหญิง'; nr[col(owners, 'นามสกุล')] = 'ใจงาม';
  nr[col(owners, 'เลขประจำตัวประชาชน')] = '3-1006-01234-56-0';
  owners.rows.push(nr);
  // A new land owned by the new owner, document type given by its code; its use in the uses sheet.
  const nl = blankRow(lands);
  nl[col(lands, 'รหัสแปลงที่ดิน')] = '11e002'; nl[col(lands, 'ประเภทเอกสารสิทธิ์')] = '3'; nl[col(lands, 'อำเภอ')] = 'เมือง'; nl[col(lands, 'ตำบล')] = 'ในเมือง';
  nl[col(lands, 'ไร่')] = '2'; nl[col(lands, 'เจ้าของ (เลขประจำตัวประชาชน)')] = '3100601234560';
  lands.rows.push(nl);
  const nu = blankRow(landUses);
  nu[col(landUses, 'รหัสแปลงที่ดิน')] = '11E002'; nu[col(landUses, 'ลำดับ')] = '1'; nu[col(landUses, 'ประเภทการใช้ประโยชน์')] = '1-เกษตรกรรม'; nu[col(landUses, 'ไร่')] = '2';
  landUses.rows.push(nu);
  // The existing building moves to the new land; a bad choice and an unknown owner are reported.
  buildings.rows[1][col(buildings, 'รหัสแปลงที่ดินที่ตั้ง')] = '11E002';
  buildings.rows[1][col(buildings, 'ลักษณะสิ่งปลูกสร้าง')] = 'ไม้ไผ่';
  buildings.rows[1][col(buildings, 'เจ้าของ (เลขประจำตัวประชาชน)')] = '1101700203451, 9999999999999';
  // The same land twice: the second row is skipped.
  lands.rows.push([...lands.rows[1]]);

  const plan = planTableImport(db, sheets);
  const by = Object.fromEntries(plan.changes.map(c => [`${c.entity}:${c.title}`, c]));
  assert.deepEqual(plan.counts.owners, { create: 1, update: 1, same: 1 });
  assert.deepEqual(by['owners:นาย สมชาย ใจดี'].changes, [{ th: 'โทรศัพท์', from: '0812345678', to: '0899999999' }]);
  const newOwner = plan.records.owners.find(o => o.firstName === 'สมหญิง');
  assert.equal(newOwner.psnId, '3100601234560');
  const newLand = plan.records.lands.find(l => l.parcelCode === '11e002' || l.parcelCode === '11E002');
  assert.equal(newLand.docType, '3');
  assert.deepEqual(newLand.ownerIds, [newOwner.id]);
  assert.equal(newLand.uses.length, 1);
  assert.equal(newLand.uses[0].usedType, '1');
  const b = plan.records.buildings[0];
  assert.deepEqual(b.landIds, [newLand.id]);
  assert.equal(b.structure, '2', 'a bad choice leaves the field as it was');
  assert.deepEqual(b.ownerIds, ['O1']);
  const msgs = plan.problems.map(p => `${p.sheet}:${p.row}:${p.message}`).join('\n');
  assert.match(msgs, /สิ่งปลูกสร้าง:2:"ไม้ไผ่" ไม่อยู่ในรายการของช่อง "ลักษณะสิ่งปลูกสร้าง"/);
  assert.match(msgs, /ไม่พบเจ้าของ "9999999999999"/);
  assert.match(msgs, /ที่ดิน:4:ซ้ำกับแถว 2/);
  // Unchanged values that LTAX itself gave (scale "(5000)") pass quietly.
  assert.doesNotMatch(msgs, /5000/);
  // New records are new for LTAX; edited ones differ from what LTAX holds.
  assert.equal(pendingState('lands', newLand).action, 'create');
  assert.equal(pendingState('owners', plan.records.owners.find(o => o.id === 'O1')).action, 'update');
});

test('import through the data API: check first, then save; the changes wait for LTAX', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'llan-table-'));
  try {
    const store = await new Store(dir).open();
    const db = sampleDb();
    for (const c of ['owners', 'lands', 'buildings', 'signboards']) await store.replaceAll(c, db[c]);
    const call = async (method, url, body) => { const hit = router(coreRoutes(store))(method, new URL(url, 'http://x')); assert.ok(hit.found, url); return hit.run(body); };
    const out = await call('GET', '/api/export/ltax-table?scope=pending');
    assert.match(out.download, /^ตารางแบบฟอร์ม_LTAX_รอส่ง_\d+\.xlsx$/);
    const sheets = await readXlsx(out.bytes);
    assert.equal(sheetOf(sheets, 'owners').rows.length, 2, 'only O2 is waiting for LTAX');
    const lands = sheetOf(sheets, 'lands');
    assert.equal(lands.rows.length, 1, 'L1 matches LTAX, so it is not in a "pending" table');
    // Fill a row for an existing land found by its code, using the blank table.
    const blank = await readXlsx((await call('GET', '/api/export/ltax-table?scope=blank')).bytes);
    const bl = sheetOf(blank, 'lands');
    const row = bl.rows[0].map(() => '');
    row[col(bl, 'รหัสแปลงที่ดิน')] = '11E001'; row[col(bl, 'เลขที่เอกสารสิทธิ์')] = '456';
    bl.rows.push(row);
    const file = Buffer.from(writeXlsx(blank.map(s => ({ name: s.name, columns: s.rows[0].map((h, i) => ({ header: h, key: String(i) })),
      rows: s.rows.slice(1).map(r => Object.fromEntries(r.map((v, i) => [String(i), v]))) })))).toString('base64');
    const check = await call('POST', '/api/import/ltax-table', { name: 't.xlsx', file, preview: true });
    assert.equal(check.counts.lands.update, 1);
    assert.equal(store.get('lands', 'L1').docNo, '123', 'checking saves nothing');
    const done = await call('POST', '/api/import/ltax-table', { name: 't.xlsx', file });
    assert.deepEqual(done.items, [{ entity: 'lands', recordId: 'L1' }]);
    assert.equal(store.get('lands', 'L1').docNo, '456');
    assert.equal(store.get('lands', 'L1').uses.length, 1, 'no use rows for this land: its uses stay');
    const changes = await call('GET', '/api/changes');
    assert.ok(changes.some(c => c.id === 'L1' && c.action === 'update' && c.changes.some(x => x.field === 'docNo')));
    await assert.rejects(call('POST', '/api/import/ltax-table', { name: 'x', file: Buffer.from('not excel').toString('base64') }), /อ่านไฟล์ไม่ได้/);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
