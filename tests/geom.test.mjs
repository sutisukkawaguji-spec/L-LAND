import test from 'node:test';
import assert from 'node:assert/strict';
import { rectFrom3, minRect, ringArea, selfIntersects, nearestOnSegment, nextBuildingCode, nextParcelCode, convexHull } from '../public/shared/geom.mjs';

test('rectangle from two corners and the opposite side', () => {
  const r = rectFrom3([0, 0], [10, 0], [3, 6]);
  assert.deepEqual(r.map(p => p.map(v => Math.round(v * 1e9) / 1e9)), [[0, 0], [10, 0], [10, 6], [0, 6]]);
  assert.equal(ringArea(r), 60);
  // Rotated side, point on the other side of the line
  const q = rectFrom3([0, 0], [3, 4], [8, 0]);
  assert.ok(Math.abs(ringArea(q) - 5 * 6.4) < 1e-9); // |AB| = 5, distance of (8,0) from line AB = 6.4
});

test('minimum rectangle of a rotated building', () => {
  const a = Math.PI / 7, rot = ([x, y]) => [x * Math.cos(a) - y * Math.sin(a) + 100, x * Math.sin(a) + y * Math.cos(a) + 50];
  const { width, length } = minRect([[0, 0], [12, 0], [12, 9], [0, 9]].map(rot));
  assert.ok(Math.abs(width - 9) < 1e-6 && Math.abs(length - 12) < 1e-6);
  assert.equal(convexHull([[0, 0], [1, 1], [2, 0], [1, 0.2], [1, -1]]).length, 4);
});

test('self-intersection and snapping helpers', () => {
  assert.equal(selfIntersects([[0, 0], [10, 0], [10, 10], [0, 10]]), false);
  assert.equal(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]]), true);
  assert.deepEqual(nearestOnSegment([5, 5], [0, 0], [10, 0]), [5, 0]);
  assert.deepEqual(nearestOnSegment([-5, 5], [0, 0], [10, 0]), [0, 0]);
});

test('next codes', () => {
  assert.equal(nextBuildingCode('11E015', ['11E015-B001', '11E015-B002', '11E016-B009']), '11E015-B003');
  assert.equal(nextBuildingCode('11E099', []), '11E099-B001');
  assert.equal(nextParcelCode('58D146', ['58D146', '58D150', '58C999', '11E015']), '58D151');
  assert.equal(nextParcelCode('bad', ['58D146']), '');
});
