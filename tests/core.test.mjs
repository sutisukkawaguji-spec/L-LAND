import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateAll, validateRecord } from '../public/shared/validate.mjs';
import { validThaiId, toWah, fromWah } from '../public/shared/calc.mjs';
import { syncFields, pendingState, diffRecord } from '../public/shared/diff.mjs';
import { useTypeCode, parseRNW, readLtaxWorkbook, mergeImport } from '../lib/import-ltax.mjs';
import { toWgs84, fromWgs84, crsFromPrj, areaM2, centroid } from '../public/shared/proj.mjs';
import { Store } from '../lib/store.mjs';

const land = (over = {}) => ({ id: 'L1', parcelCode: '60A002', docType: '6', amphur: 'น้ำโสม', district: 'น้ำโสม', rai: '1', ngan: '0', wah: '0', ownerIds: ['O1'],
  uses: [{ usedType: '1', rai: '1', ngan: '0', wah: '0', usedFor: '1', agriType: '1' }], ...over });
const owner = (over = {}) => ({ id: 'O1', personType: 'บุคคลธรรมดา', prefixName: 'นาย', firstName: 'ก', lastName: 'ข', psnId: '1100000000016', ...over });
const dbOf = (o = {}) => ({ owners: [owner()], lands: [land()], buildings: [], signboards: [], parcels: [], ...o });

test('area units and Thai id checksum', () => {
  assert.equal(toWah(15, 3, 12), 6312);
  assert.deepEqual(fromWah(6312), { rai: 15, ngan: 3, wah: 12 });
  assert.ok(validThaiId('1100000000016'));
  assert.ok(!validThaiId('1100000000017'));
});

test('a clean record passes', () => {
  assert.deepEqual(validateAll(dbOf()).filter(i => i.level === 'error'), []);
});

test('land checks: required, area overflow, duplicate code, ngan range', () => {
  const issues = validateAll(dbOf({ lands: [land({ docType: '', uses: [{ usedType: '1', rai: '2', ngan: '0', wah: '0', usedFor: '1', agriType: '1' }] }), land({ id: 'L2', ngan: '5' })] }));
  const msgs = issues.filter(i => i.level === 'error').map(i => i.message).join('\n');
  assert.match(msgs, /ไม่ได้กรอกประเภทเอกสารสิทธิ์/);
  assert.match(msgs, /เกินเนื้อที่แปลง/);
  assert.match(msgs, /ซ้ำกับแปลงอื่น/);
  assert.match(msgs, /งานต้องเป็นจำนวนเต็ม/);
});

test('owner checks: bad id, missing last name, duplicate id', () => {
  const issues = validateAll(dbOf({ owners: [owner({ psnId: '1234567890123', lastName: '' }), owner({ id: 'O2', psnId: '1234567890123' })] }));
  const msgs = issues.filter(i => i.level === 'error').map(i => i.message).join('\n');
  assert.match(msgs, /ไม่ถูกต้อง/);
  assert.match(msgs, /ต้องมีนามสกุล/);
  assert.match(msgs, /ซ้ำกับเจ้าของรายอื่น/);
});

test('errors on values LTAX already holds become warnings', () => {
  const l = land({ scale: '(5000)' });
  l.synced = syncFields('lands', l);
  const [i] = validateRecord('lands', l, dbOf({ lands: [l] })).filter(x => x.field === 'scale');
  assert.equal(i.level, 'warn');
  l.scale = '9999';
  assert.equal(validateRecord('lands', l, dbOf({ lands: [l] })).find(x => x.field === 'scale').level, 'error');
});

test('building checks: structure vs type, area, year', () => {
  const b = { id: 'B1', buildingType: '103', structure: '1', noFloor: '1', width: '9', length: '9', totalArea: '100', since: '3000', landIds: ['L1'], ownerIds: ['O1'], uses: [{ usedType: '3', area: '81' }] };
  const issues = validateRecord('buildings', b, dbOf({ buildings: [b] }));
  const text = issues.map(i => `${i.level}:${i.message}`).join('\n');
  assert.match(text, /warn:ลักษณะ "ไม้" ไม่ตรงกับประเภท/);
  assert.match(text, /ไม่เท่ากับ กว้าง×ยาว×ชั้น/);
  assert.match(text, /error:ปีที่สร้างเสร็จ 3000/);
});

test('pending state and diff', () => {
  const l = land();
  assert.equal(pendingState('lands', l).action, 'create');
  l.synced = syncFields('lands', l); l.ltaxId = '1';
  assert.equal(pendingState('lands', l).action, null);
  l.docNo = '99'; l.uses[0].wah = '5';
  const d = diffRecord('lands', l);
  assert.deepEqual(d.map(x => x.field).sort(), ['docNo', 'uses.0.wah']);
});

test('LTAX export spellings of use types and areas', () => {
  assert.equal(useTypeCode('1-เกษตรกรรม'), '1');
  assert.equal(useTypeCode('2 -(2) ที่อยู่อาศัย - หลังหลัก (กรณีไม่ใช่เจ้าของกรรมสิทธิ์ที่ดิน)'), '3');
  assert.equal(useTypeCode('2-(1) ที่อยู่อาศัย หลังหลัก'), '2');
  assert.equal(useTypeCode('2-(3) ที่อยู่อาศัย หลังอื่นๆ'), '4');
  assert.equal(useTypeCode('3-อื่นๆ'), '5');
  assert.equal(useTypeCode('5-ใช้ประโยชน์หลายประเภท'), '7');
  assert.deepEqual(parseRNW('1-3-28'), { rai: '1', ngan: '3', wah: '28' });
});

const sheet = (name, head, ...rows) => ({ name, rows: [head, ...rows] });
const workbook = () => [
  sheet('owner', ['รหัสเจ้าของ', 'ประเภทบุคคล(รหัส)', 'คำนำหน้าชื่อ', 'ชื่อ', 'นามสกุล', 'เลขบัตรปชช.'], ['90000001', '1', 'นาย', 'สมชาย', 'ใจดี', '1100000000016']),
  sheet('land', ['รหัสแปลงที่ดิน', 'ประเภทเอกสารสิทธิ์', 'เลขที่เอกสารสิทธิ์', 'อำเภอ', 'ตำบล', 'เนื้อที่ (ไร่)', 'เนื้อที่ (งาน)', 'เนื้อที่ (ตร.ว.)', 'รหัสที่ดิน', 'เจ้าของ'],
    ['11c004', 'โฉนด', '1891', 'น้ำโสม', 'น้ำโสม', '2', '0', '54', '100000001', 'นาย สมชาย ใจดี']),
  sheet('land_detail', ['รหัสที่ดิน', 'ลำดับการใช้', 'การใช้ประโยชน์', 'เนื้อที่ใช้(ร-ง-ว)'], ['100000001', '1', '1-เกษตรกรรม', '2-0-54']),
  sheet('building', ['รหัสสิ่งปลูกสร้าง', 'ประเภทสิ่งปลูกสร้าง', 'ลักษณะสิ่งปลูกสร้าง', 'รหัสอาคาร', 'รหัสที่ดิน', 'รหัสเจ้าของ'], ['11C004-B001', '105 - บ้านพักอาศัยตึกสองชั้น', 'ตึก', '400000001', '100000001', '90000001']),
  sheet('building_detail', ['รหัสอาคาร', 'ลำดับการใช้', 'ชั้นที่ใช้', 'การใช้ประโยชน์', 'พื้นที่ใช้'], ['400000001', '1', '1-2', '2-(2) ที่อยู่อาศัย หลังหลัก(ไม่ได้เป็นเจ้าของกรรมสิทธิ์ที่ดิน)', '360']),
];

test('read LTAX workbook and link records', () => {
  const r = readLtaxWorkbook(workbook());
  assert.deepEqual(r.report.problems, []);
  const [l] = r.lands, [b] = r.buildings;
  assert.equal(l.parcelCode, '11C004');
  assert.equal(l.docType, '1');
  assert.deepEqual(l.ownerIds, ['90000001']);
  assert.equal(l.uses[0].usedType, '1');
  assert.equal(b.buildingType, '105');
  assert.equal(b.structure, '2');
  assert.equal(b.uses[0].usedType, '3');
});

test('re-import keeps local edits and reports conflicts', () => {
  const empty = { owners: [], lands: [], buildings: [], signboards: [] };
  const first = mergeImport(empty, readLtaxWorkbook(workbook())).collections;
  const l = first.lands[0];
  assert.equal(pendingState('lands', l).action, null);
  assert.equal(first.buildings[0].landIds[0], l.id);
  l.docNo = '5555'; // local edit
  const wb = workbook(); wb[1].rows[1][2] = '1900'; wb[1].rows[1][5] = '3'; // LTAX changed doc no and rai
  const second = mergeImport(first, readLtaxWorkbook(wb));
  const l2 = second.collections.lands[0];
  assert.equal(l2.docNo, '5555');
  assert.equal(l2.synced.docNo, '1900');
  assert.equal(second.result.keptLocal.lands, 1);
  assert.equal(second.result.conflicts.length, 1);
});

test('coordinate systems', () => {
  const [x, y] = fromWgs84(102.127923, 17.78883, 'EPSG:24048');
  const [lon, lat] = toWgs84(x, y, 'EPSG:24048');
  // The 3-parameter datum shift runs at height 0 both ways (as QGIS does), so a round trip drifts ~2 mm.
  assert.ok(Math.abs(lon - 102.127923) < 1e-7 && Math.abs(lat - 17.78883) < 1e-7);
  assert.deepEqual(fromWgs84(105, 0, 'EPSG:32648').map(v => Math.round(v)), [500000, 0]);
  assert.equal(crsFromPrj('PROJCS["Indian_1975_UTM_Zone_48N",GEOGCS["GCS_Indian_1975"],PARAMETER["Central_Meridian",105.0]]').id, 'EPSG:24048');
  assert.equal(crsFromPrj('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984"]]').id, 'EPSG:4326');
  // 20 m × 20 m square at Udon Thani measures 400 m² and its centroid is its middle.
  const [cx, cy] = fromWgs84(102.13, 17.79, 'EPSG:32648');
  const sq = [[cx, cy], [cx + 20, cy], [cx + 20, cy + 20], [cx, cy + 20], [cx, cy]].map(([a, b]) => toWgs84(a, b, 'EPSG:32648'));
  assert.ok(Math.abs(areaM2({ type: 'Polygon', coordinates: [sq] }) - 400) < 0.5);
  const c = fromWgs84(...centroid({ type: 'Polygon', coordinates: [sq] }), 'EPSG:32648');
  assert.ok(Math.hypot(c[0] - cx - 10, c[1] - cy - 10) < 0.05);
});

test('double-encoded Thai is repaired, ordinary Thai is left alone', async () => {
  const { repairThai } = await import('../public/shared/thai-text.mjs');
  // Build the damage the way it happened: UTF-8 bytes read as windows-874 (undefined bytes kept as U+0080–U+00FF).
  const special = { 0x80: 0x20ac, 0x85: 0x2026, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014 };
  const garble = t => [...new TextEncoder().encode(t)].map(b => String.fromCodePoint(b < 0x80 ? b : special[b] ?? (b >= 0xa1 && b <= 0xda ? 0x0e01 + b - 0xa1 : b >= 0xdf && b <= 0xfb ? 0x0e3f + b - 0xdf : b))).join('');
  for (const t of ['ส.ป.ก.4-01', 'ที่ครอบครอง', 'โฉนด', 'นางสาวสุภาพร  โยธากุล', 'ส.ป.ก.๔-๐๑ ข']) {
    assert.notEqual(garble(t), t);
    assert.equal(repairThai(garble(t)), t);
  }
  for (const t of ['นาย เนิน จันทร', 'น.ส. สำเนียง หัสโก', 'เนื้อที่ 1-2-30', 'abc', '', null]) assert.equal(repairThai(t), t);
});

test('store writes atomically and logs changes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'llan-store-'));
  try {
    const s = await new Store(dir).open();
    const r = await s.upsert('lands', land({ id: undefined }));
    await s.upsert('lands', { ...r, docNo: '1' });
    await s.flush();
    const again = await new Store(dir).open();
    assert.equal(again.list('lands')[0].docNo, '1');
    const log = await again.readLog();
    assert.equal(log.length, 2);
    assert.equal(log[0].action, 'update');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
