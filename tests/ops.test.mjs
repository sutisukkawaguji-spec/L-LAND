import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { ownerRelated, deleteOwner, deleteRecords, fillPrices } from '../lib/registry-ops.mjs';
import { landTotal, buildingValue, deprTable, estimateDepr, suggestLandPrice, suggestBuildingPrice } from '../public/shared/valuation.mjs';

const withStore = async fn => {
  const dir = mkdtempSync(path.join(tmpdir(), 'llan-ops-'));
  try { await fn(await new Store(dir).open()); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('valuation: totals, depreciation learned from LTAX, suggestions', () => {
  assert.equal(landTotal({ rai: '1', ngan: '0', wah: '0', pricePerWah: '150' }), 60000);
  const bs = [
    { id: 'a', structure: '2', age: '19', ltaxValues: { deprPct: '28' }, buildingType: '103', pricePerMeter: '7850' },
    { id: 'b', structure: '2', age: '32', ltaxValues: { deprPct: '52' }, buildingType: '103', pricePerMeter: '7850' },
    { id: 'c', structure: '2', age: '36', ltaxValues: { deprPct: '60' }, buildingType: '105', pricePerMeter: '7750' },
  ];
  const t = deprTable(bs);
  assert.equal(t['2|32'], 52);
  assert.equal(estimateDepr('2', 34, t), 56); // between 32 → 52 and 36 → 60
  const v = buildingValue({ totalArea: '100', pricePerMeter: '7850', structure: '2', age: '34' }, t);
  assert.deepEqual([v.gross, v.deprPct, v.deprSource, v.net], [785000, 56, 'estimate', 345400]);
  assert.equal(suggestBuildingPrice({ id: 'x', buildingType: '103' }, bs).value, 7850);
  const lands = ['11E001', '11E002', '11E003', '11F001'].map((c, i) => ({ id: c, parcelCode: c, docType: '7', pricePerWah: i < 3 ? '150' : '440' }));
  const s = suggestLandPrice({ id: 'n', parcelCode: '11E099', docType: '7' }, lands);
  assert.equal(s.value, 150);
  assert.match(s.basis, /บล็อก 11E/);
});

test('deleting an owner: alone, or with the assets only they own', async () => {
  await withStore(async store => {
    const o1 = await store.upsert('owners', { firstName: 'หนึ่ง', ltaxId: '9001' });
    const o2 = await store.upsert('owners', { firstName: 'สอง' });
    const solo = await store.upsert('lands', { parcelCode: '11E001', ownerIds: [o1.id], ltaxId: '7001' });
    const shared = await store.upsert('lands', { parcelCode: '11E002', ownerIds: [o1.id, o2.id] });
    const b1 = await store.upsert('buildings', { buildingCode: '11E001-B001', ownerIds: [o1.id], landIds: [solo.id] });
    const b2 = await store.upsert('buildings', { buildingCode: '11E001-B002', ownerIds: [o2.id], landIds: [solo.id] }); // someone else's on the sole land
    await store.upsert('features', { kind: 'parcel', code: '11E001', layerId: 'L' });

    const rel = ownerRelated(store, o1.id);
    assert.deepEqual(rel.lands.map(l => [l.title, l.shared]), [['11E001', false], ['11E002', true]]);
    assert.deepEqual(rel.buildingsOnLand.map(b => b.id), [b2.id]);

    const r = await deleteOwner(store, o1.id, { withAssets: true, withShapes: true });
    assert.equal(r.owners, 1); assert.equal(r.lands, 1); assert.equal(r.buildings, 2); assert.equal(r.shapes, 1);
    assert.equal(store.get('lands', shared.id).ownerIds.join(), o2.id); // shared land kept, link cut
    assert.equal(store.get('buildings', b1.id), null);
    // Records that exist in LTAX are listed for deletion there
    assert.deepEqual(store.list('deletions').map(d => d.id).sort(), ['lands:7001', 'owners:9001']);
  });
});

test('deleting a land unlinks buildings on it', async () => {
  await withStore(async store => {
    const l = await store.upsert('lands', { parcelCode: '11E001' });
    const b = await store.upsert('buildings', { buildingCode: '11E001-B001', landIds: [l.id] });
    const r = await deleteRecords(store, 'lands', [l.id]);
    assert.equal(r.unlinked, 1);
    assert.deepEqual(store.get('buildings', b.id).landIds, []);
  });
});

test('fill missing prices: preview, then apply', async () => {
  await withStore(async store => {
    for (const c of ['11E001', '11E002', '11E003']) await store.upsert('lands', { parcelCode: c, docType: '7', pricePerWah: '150' });
    const empty = await store.upsert('lands', { parcelCode: '11E004', docType: '7' });
    const p = await fillPrices(store, 'lands', null);
    assert.deepEqual(p.rows.map(r => [r.id, r.suggested]), [[empty.id, 150]]);
    assert.equal(store.get('lands', empty.id).pricePerWah, undefined);
    const a = await fillPrices(store, 'lands', [empty.id], { apply: true });
    assert.equal(a.applied, 1);
    assert.equal(store.get('lands', empty.id).pricePerWah, '150');
  });
});
