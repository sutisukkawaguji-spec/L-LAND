// Parcel status from the central system: what links, what the survey must fix, what waits for LTAX.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parcelStatuses, statusSummary, surveyList, surveySig, withLiveSurvey } from '../lib/parcel-status.mjs';
import { validateAll } from '../public/shared/validate.mjs';
import { syncFields } from '../public/shared/diff.mjs';

const sq = (x, y, d = 0.0002) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const box = g => { const xs = g.coordinates[0].map(p => p[0]), ys = g.coordinates[0].map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
const shape = (id, kind, code, geometry, areaM2 = 400) => ({ id, kind, code, geometry, bbox: box(geometry), areaM2, layerId: kind });
// A land exactly as LTAX has it (synced snapshot equal to the record), 100 ตร.ว. = 400 m²
const land = (id, parcelCode, extra = {}) => {
  const l = { id, parcelCode, ltaxId: `L${id}`, docType: '1', rai: '0', ngan: '1', wah: '0', ownerIds: ['O1'], pricePerWah: '100',
    uses: [{ usedType: '1', usedFor: '1', rai: '0', ngan: '1', wah: '0', agriType: '1' }], ...extra };
  return { ...l, synced: syncFields('lands', l) };
};

test('every parcel gets a status the survey can act on', () => {
  const db = {
    owners: [{ id: 'O1', personType: '1', prefixName: 'นาย', firstName: 'ก', lastName: 'ข', psnId: '1101700203451' }],
    lands: [land('1', '11E001'), land('2', '11E003'), land('3', '11E004'), land('4', '11E005')],
    buildings: [{ id: 'B1', buildingCode: '11E001-B001', landIds: ['1'] }, { id: 'B2', buildingCode: '11E004-B001', landIds: ['3'] }],
    signboards: [],
    features: [
      shape('f1', 'parcel', '11E001', sq(102, 17)),
      shape('f2', 'parcel', '11E002', sq(102.01, 17)),                 // shape without a register record
      shape('f4a', 'parcel', '11E004', sq(102.02, 17)), shape('f4b', 'parcel', '11E004', sq(102.03, 17)), // duplicate code
      shape('f5', 'parcel', '11E005', sq(102.04, 17)),
      shape('fx', 'parcel', '', sq(102.05, 17)),                       // no code
      shape('b1', 'building', '11E001-B001', sq(102.00005, 17.00005, 0.00005), 25),
      shape('b9', 'building', '11E005-B009', sq(102.5, 17.5, 0.00005), 25), // outside its parcel, no record
    ],
  };
  // 11E005 was changed here after the last LTAX snapshot → waits for LTAX
  db.lands[3].docNo = '999';
  const issues = validateAll({ ...db, parcels: db.features.filter(f => f.kind === 'parcel').map(f => ({ ...f, parcelCode: f.code })) }, { areaTolerance: 0.1 });
  // Building record details are not part of this test.
  const landIssues = issues.filter(i => i.entity !== 'buildings');
  const rows = parcelStatuses(db, { issues: landIssues, checks: [{ id: 'parcel:11E001', found: true, count: 1 }], pushes: [] });
  const by = Object.fromEntries(rows.map(r => [r.id, r]));

  assert.equal(by['11E001'].status, 'ok', JSON.stringify(by['11E001'].reasons));
  assert.equal(by['11E001'].ltax, 'found');
  assert.equal(by['11E001'].info.buildings.records, 1);
  assert.equal(by['11E002'].status, 'fix');
  assert.equal(by['11E002'].link, 'no-record');
  assert.equal(by['11E003'].link, 'no-shape');
  assert.equal(by['11E003'].status, 'fix');
  assert.equal(by['11E004'].link, 'dup-shape');
  assert.match(by['11E004'].reasons.map(r => r.text).join(' '), /อาคารในทะเบียนยังไม่มีรูป: 11E004-B001/);
  assert.equal(by['11E005'].status, 'fix'); // its building shape sits outside it
  assert.match(by['11E005'].reasons.map(r => r.text).join(' '), /อยู่นอกแปลง.*11E005-B009/);
  assert.ok(by['11E005'].reasons.some(r => r.level === 'send' && /รอส่งเข้า LTAX/.test(r.text)));
  assert.equal(by[`#fx`].link, 'no-code');

  // Fix the survey problems of 11E005 and only the LTAX step is left.
  db.features = db.features.filter(f => f.id !== 'b9');
  const again = parcelStatuses(db, { issues: landIssues, checks: [], pushes: [] }).find(r => r.id === '11E005');
  assert.equal(again.status, 'send');
  assert.equal(again.pending, 'update');

  const sm = statusSummary(rows);
  assert.equal(sm.total, 6);
  assert.equal(sm.ok + sm.fix + sm.send, 6);
  assert.ok(sm.reasons['มีรูปแปลง แต่ไม่มีข้อมูลที่ดินในทะเบียน'] >= 1);
});

test('survey sign-off: "สำรวจเสร็จ" puts the parcel in the LTAX queue until it is edited again', () => {
  const db = {
    owners: [{ id: 'O1', personType: '1', prefixName: 'นาย', firstName: 'ก', lastName: 'ข', psnId: '1101700203451' }],
    lands: [land('1', '11E001'), land('2', '11E002')],
    buildings: [{ id: 'B1', buildingCode: '11E001-B001', landIds: ['1'], ownerIds: ['O1'] }],
    signboards: [],
    features: [shape('f1', 'parcel', '11E001', sq(102, 17)), shape('f2', 'parcel', '11E002', sq(102.01, 17)), shape('b1', 'building', '11E001-B001', sq(102.00005, 17.00005, 0.00005), 25)],
  };
  db.owners[0] = { ...db.owners[0], synced: syncFields('owners', db.owners[0]) };
  db.buildings[0] = { ...db.buildings[0], synced: syncFields('buildings', db.buildings[0]) };
  // The survey changes the land and the owner's phone, then signs the parcel off.
  db.lands[0] = { ...db.lands[0], docNo: '555' };
  db.owners[0] = { ...db.owners[0], tel: '0811111111' };
  assert.deepEqual(surveyList(db), []);
  db.lands[0].survey = { state: 'done', at: '2026-11-10T10:00:00Z', by: 'editor@test.local', sig: surveySig(db, '11E001') };
  let [s] = surveyList(db);
  assert.equal(s.code, '11E001');
  assert.equal(s.state, 'ready');
  assert.deepEqual(s.items.map(i => `${i.entity}:${i.recordId}`).sort(), ['lands:1', 'owners:O1']);
  let row = parcelStatuses(db).find(r => r.id === '11E001');
  assert.equal(row.survey, 'ready');
  assert.equal(row.info.survey.state, 'ready');
  assert.equal(row.status, 'send');
  assert.match(row.reasons.map(r => r.text).join(' '), /สำรวจเสร็จแล้ว \(editor@test\.local\) รอลง LTAX 2 รายการ/);

  // Editing the building after the sign-off: the parcel has to be signed off again.
  db.buildings[0] = { ...db.buildings[0], noFloor: '2' };
  [s] = surveyList(db);
  assert.equal(s.state, 'changed');
  row = parcelStatuses(db).find(r => r.id === '11E001');
  assert.equal(row.status, 'fix');
  db.lands[0].survey = { ...db.lands[0].survey, sig: surveySig(db, '11E001') };
  assert.equal(surveyList(db)[0].state, 'ready');
  assert.equal(surveyList(db)[0].items.length, 3);

  // Once the office has put everything into LTAX nothing is left to send.
  for (const [c, i] of [['lands', 0], ['owners', 0], ['buildings', 0]]) db[c][i] = { ...db[c][i], synced: syncFields(c, db[c][i]) };
  assert.equal(surveyList(db)[0].state, 'done');
  assert.equal(parcelStatuses(db).find(r => r.id === '11E001').survey, 'done');

  // Rows kept in Supabase pick up a newer mark made on the web.
  const stored = parcelStatuses({ ...db, lands: db.lands.map(({ survey, ...l }) => l) });
  assert.equal(stored.find(r => r.id === '11E001').survey, null);
  const live = withLiveSurvey(stored, db);
  assert.equal(live.find(r => r.id === '11E001').survey, 'done');
  assert.equal(live.find(r => r.id === '11E002'), stored.find(r => r.id === '11E002'));
  assert.equal(statusSummary(live).survey.done, 1);
});

test('survey states: กำลังสำรวจ and ต้องกลับไปซ้ำ', () => {
  const db = { owners: [], lands: [land('1', '11E001'), land('2', '11E002')], buildings: [], signboards: [],
    features: [shape('f1', 'parcel', '11E001', sq(102, 17)), shape('f2', 'parcel', '11E002', sq(102.01, 17))] };
  db.lands[0].survey = { state: 'draft', at: '2026-11-10T09:00:00Z', by: 'a@test.local' };
  db.lands[1].survey = { state: 'revisit', at: '2026-11-10T09:00:00Z', by: 'a@test.local', note: 'เจ้าของไม่อยู่' };
  const by = Object.fromEntries(parcelStatuses(db).map(r => [r.id, r]));
  assert.equal(by['11E001'].survey, 'draft');
  assert.equal(by['11E001'].status, 'ok');
  assert.equal(by['11E002'].survey, 'revisit');
  assert.equal(by['11E002'].status, 'fix');
  assert.match(by['11E002'].reasons.map(r => r.text).join(' '), /ต้องกลับไปสำรวจซ้ำ: เจ้าของไม่อยู่/);
  assert.equal(by['11E002'].info.survey.note, 'เจ้าของไม่อยู่');
  const sm = statusSummary(Object.values(by));
  assert.deepEqual([sm.survey.draft, sm.survey.revisit, sm.survey.parcels], [1, 1, 2]);
});

test('web rows stored before a survey mark show the same as the office would', () => {
  const db = { owners: [], lands: [land('1', '11E001'), land('2', '11E002', { rai: '5' })], buildings: [], signboards: [],
    features: [shape('f1', 'parcel', '11E001', sq(102, 17)), shape('f2', 'parcel', '11E002', sq(102.01, 17))] };
  const opts = db2 => ({ issues: validateAll({ ...db2, parcels: db2.features.map(f => ({ ...f, parcelCode: f.code })) }, { areaTolerance: 0.1 }) });
  const stored = parcelStatuses(db, opts(db));
  assert.equal(stored.find(r => r.id === '11E002').status, 'fix'); // area on the map differs from the deed
  db.lands[0].survey = { state: 'revisit', at: '2026-11-10T09:00:00Z', by: 'a', note: 'ฝนตก' };
  db.lands[1].survey = { state: 'done', at: '2026-11-10T09:00:00Z', by: 'a', sig: surveySig(db, '11E002') };
  const office = Object.fromEntries(parcelStatuses(db, opts(db)).map(r => [r.id, r]));
  const web = Object.fromEntries(withLiveSurvey(stored, db).map(r => [r.id, r]));
  assert.equal(office['11E002'].status, 'ok'); // signed off: the area warning is settled, nothing differs from LTAX
  assert.match(office['11E002'].reasons.map(r => r.text).join(' '), /ผู้สำรวจยืนยันแล้ว/);
  assert.equal(office['11E001'].status, 'fix');
  assert.deepEqual(web, office);
  // Clearing the marks gives the stored rows back.
  delete db.lands[0].survey; delete db.lands[1].survey;
  assert.deepEqual(withLiveSurvey(Object.values(office), db), stored);
});
