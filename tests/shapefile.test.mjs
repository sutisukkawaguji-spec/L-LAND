import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCp874, encodeCp874 } from '../lib/cp874.mjs';
import { readShapefile, writeShapefile } from '../lib/shapefile.mjs';

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// Signed area, positive = counter-clockwise (y up).
function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

const square = (x0, y0, size) => [[x0, y0], [x0, y0 + size], [x0 + size, y0 + size], [x0 + size, y0], [x0, y0]]; // clockwise
const reversed = (ring) => [...ring].reverse();

function roundTrip(input, readOptions = {}) {
  const files = writeShapefile(input);
  const result = readShapefile({ shp: files.shp, shx: files.shx, dbf: files.dbf, prj: files.prj, cpg: files.cpg, ...readOptions });
  return { files, result };
}

// ---------------------------------------------------------------- cp874

test('cp874 round-trips Thai text one byte per character', () => {
  const text = 'แปลงที่ดิน ส.ป.ก.4-01 ๑๒๓';
  const bytes = encodeCp874(text);
  assert.equal(bytes.length, text.length);
  assert.equal(decodeCp874(bytes), text);
});

test('cp874 mapping table edges, extras and error handling', () => {
  assert.deepEqual([...encodeCp874('ก ฺ ฿ ๛ € … ‘ ’ “ ” • – — ')].filter((b) => b !== 0x20),
    [0xa1, 0xda, 0xdf, 0xfb, 0x80, 0x85, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0xa0]);
  assert.deepEqual([...encodeCp874('é😀A')], [0x3f, 0x3f, 0x41]);
  assert.equal(decodeCp874(new Uint8Array([0x81, 0xdb, 0xde, 0xfc, 0xff])), '�'.repeat(5));

  // Cross-check every defined byte against ICU's windows-874 decoder when available.
  let icu = null;
  try { icu = new TextDecoder('windows-874'); } catch { /* no full ICU */ }
  if (icu) {
    for (let b = 0; b < 256; b++) {
      const ours = decodeCp874(new Uint8Array([b]));
      if (ours !== '�') assert.equal(ours, icu.decode(new Uint8Array([b])), `byte 0x${b.toString(16)}`);
    }
  }
});

// ---------------------------------------------------------------- geometry

test('polygon with a hole round-trips unchanged', () => {
  const outer = square(0, 0, 10);
  const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]; // counter-clockwise
  const { result } = roundTrip({
    geometryType: 'Polygon',
    fields: [{ name: 'name', type: 'C' }],
    features: [{ geometry: { type: 'Polygon', coordinates: [outer, hole] }, properties: { name: 'a' } }],
  });
  assert.equal(result.geometryType, 'Polygon');
  assert.equal(result.shapeType, 5);
  assert.deepEqual(result.features[0].geometry, { type: 'Polygon', coordinates: [outer, hole] });
  assert.deepEqual(result.bbox, [0, 0, 10, 10]);
});

test('ring orientation is fixed on write and rings are closed', () => {
  const ccwOuter = reversed(square(0, 0, 10));
  const cwHoleOpen = [[2, 2], [2, 4], [4, 4], [4, 2]]; // clockwise and not closed
  const { result } = roundTrip({
    geometryType: 'Polygon',
    fields: [],
    features: [{ geometry: { type: 'Polygon', coordinates: [ccwOuter, cwHoleOpen] } }],
  });
  const geometry = result.features[0].geometry;
  assert.equal(geometry.type, 'Polygon');
  const [outer, hole] = geometry.coordinates;
  assert.ok(signedArea(outer) < 0, 'outer ring written clockwise');
  assert.ok(signedArea(hole) > 0, 'hole written counter-clockwise');
  assert.deepEqual(hole[0], hole[hole.length - 1]);
  assert.equal(hole.length, 5);
  assert.deepEqual(outer, square(0, 0, 10));
});

test('MultiPolygon of two squares', () => {
  const coordinates = [[square(0, 0, 1)], [square(5, 5, 2)]];
  const { result } = roundTrip({
    geometryType: 'Polygon',
    fields: [{ name: 'id', type: 'N' }],
    features: [{ geometry: { type: 'MultiPolygon', coordinates }, properties: { id: 7 } }],
  });
  assert.deepEqual(result.features[0].geometry, { type: 'MultiPolygon', coordinates });
  assert.deepEqual(result.bbox, [0, 0, 7, 7]);
});

test('holes go to the smallest containing outer ring', () => {
  const big = square(0, 0, 100);
  const bigHole = reversed(square(10, 10, 80));
  const island = square(20, 20, 60);
  const islandHole = reversed(square(30, 30, 10));
  // islandHole is inside both `big` and `island`; it must attach to `island`.
  const { result } = roundTrip({
    geometryType: 'Polygon',
    fields: [],
    features: [{ geometry: { type: 'MultiPolygon', coordinates: [[big, bigHole], [island, islandHole]] } }],
  });
  assert.deepEqual(result.features[0].geometry.coordinates, [[big, bigHole], [island, islandHole]]);
});

test('a hole without a container becomes its own polygon', () => {
  // A PolyLine record has the Polygon layout, so patch the type codes to fake a bad file.
  const ccwRing = reversed(square(0, 0, 4));
  const files = writeShapefile({
    geometryType: 'LineString',
    fields: [],
    features: [{ geometry: { type: 'LineString', coordinates: ccwRing } }],
  });
  view(files.shp).setInt32(32, 5, true);
  view(files.shp).setInt32(100 + 8, 5, true);
  const result = readShapefile({ shp: files.shp, dbf: files.dbf });
  assert.deepEqual(result.features[0].geometry, { type: 'Polygon', coordinates: [ccwRing] });
});

test('polyline: LineString and MultiLineString', () => {
  const line = [[0, 0], [1, 1], [2, 0]];
  const multi = [[[10, 10], [11, 12]], [[20, 20], [21, 19], [22, 25]]];
  const { result } = roundTrip({
    geometryType: 'LineString',
    fields: [{ name: 'road', type: 'C', length: 20 }],
    features: [
      { geometry: { type: 'LineString', coordinates: line }, properties: { road: 'ถนน 1' } },
      { geometry: { type: 'MultiLineString', coordinates: multi }, properties: { road: 'ถนน 2' } },
    ],
  });
  assert.equal(result.geometryType, 'LineString');
  assert.equal(result.shapeType, 3);
  assert.deepEqual(result.features[0].geometry, { type: 'LineString', coordinates: line });
  assert.deepEqual(result.features[1].geometry, { type: 'MultiLineString', coordinates: multi });
  assert.deepEqual(result.bbox, [0, 0, 22, 25]);
});

test('points, null shapes and multipoints', () => {
  const { files, result } = roundTrip({
    geometryType: 'Point',
    fields: [{ name: 'n', type: 'N' }],
    features: [
      { geometry: { type: 'Point', coordinates: [100.5, 13.75] }, properties: { n: 1 } },
      { geometry: null, properties: { n: 2 } },
      { geometry: { type: 'Point', coordinates: [101.25, 14, 99] }, properties: { n: 3 } }, // Z dropped
    ],
  });
  assert.equal(result.geometryType, 'Point');
  assert.deepEqual(result.features.map((f) => f.geometry), [
    { type: 'Point', coordinates: [100.5, 13.75] },
    null,
    { type: 'Point', coordinates: [101.25, 14] },
  ]);
  assert.deepEqual(result.features.map((f) => f.id), [0, 1, 2]);
  assert.deepEqual(result.features.map((f) => f.properties.N), [1, 2, 3]);
  assert.deepEqual(result.bbox, [100.5, 13.75, 101.25, 14]);
  // The null record: header (8 bytes) + 4 content bytes of shape type 0.
  const shx = view(files.shx);
  assert.equal(shx.getInt32(100 + 8 + 4, false), 2);
  assert.equal(view(files.shp).getInt32(shx.getInt32(108, false) * 2 + 8, true), 0);

  const mp = roundTrip({
    geometryType: 'MultiPoint',
    fields: [],
    features: [
      { geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] } },
      { geometry: { type: 'Point', coordinates: [5, 6] } },
    ],
  }).result;
  assert.equal(mp.geometryType, 'MultiPoint');
  assert.deepEqual(mp.features.map((f) => f.geometry), [
    { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] },
    { type: 'MultiPoint', coordinates: [[5, 6]] },
  ]);
});

test('null shape in a polygon file', () => {
  const { files, result } = roundTrip({
    geometryType: 'Polygon',
    fields: [{ name: 'x', type: 'C', length: 5 }],
    features: [
      { geometry: null, properties: { x: 'none' } },
      { geometry: { type: 'Polygon', coordinates: [square(1, 1, 1)] }, properties: { x: 'sq' } },
    ],
  });
  assert.equal(result.features[0].geometry, null);
  assert.deepEqual(result.features[0].properties, { X: 'none' });
  assert.equal(result.features[1].geometry.type, 'Polygon');
  assert.deepEqual(result.bbox, [1, 1, 2, 2]); // null shapes do not count
  assert.equal(view(files.shp).getInt32(100 + 4, false), 2); // content length in words
});

test('rejects geometries that do not match the file type', () => {
  assert.throws(() => writeShapefile({
    geometryType: 'Polygon',
    fields: [],
    features: [{ geometry: { type: 'Point', coordinates: [0, 0] } }],
  }), /Feature 0: Point geometry cannot be written/);
});

// ---------------------------------------------------------------- headers

test('.shp/.shx headers, file lengths, offsets and record count', () => {
  const features = [
    { geometry: { type: 'Polygon', coordinates: [square(0, 0, 10), reversed(square(2, 2, 2))] }, properties: { a: 1 } },
    { geometry: null, properties: { a: 2 } },
    { geometry: { type: 'MultiPolygon', coordinates: [[square(20, -5, 3)], [square(30, 30, 1)]] }, properties: { a: 3 } },
  ];
  const files = writeShapefile({ geometryType: 'Polygon', fields: [{ name: 'a', type: 'N' }], features });
  const shp = view(files.shp);
  const shx = view(files.shx);

  for (const v of [shp, shx]) {
    assert.equal(v.getInt32(0, false), 9994);
    assert.equal(v.getInt32(28, true), 1000);
    assert.equal(v.getInt32(32, true), 5);
    assert.deepEqual([36, 44, 52, 60].map((p) => v.getFloat64(p, true)), [0, -5, 31, 31]);
  }
  assert.equal(shp.getInt32(24, false), files.shp.length / 2);
  assert.equal(shx.getInt32(24, false), files.shx.length / 2);
  assert.equal(files.shx.length, 100 + 8 * features.length);

  let expectedOffset = 100;
  for (let i = 0; i < features.length; i++) {
    const offset = shx.getInt32(100 + 8 * i, false) * 2;
    const length = shx.getInt32(100 + 8 * i + 4, false) * 2;
    assert.equal(offset, expectedOffset);
    assert.equal(shp.getInt32(offset, false), i + 1, 'record number at the shx offset');
    assert.equal(shp.getInt32(offset + 4, false) * 2, length);
    expectedOffset += 8 + length;
  }
  assert.equal(expectedOffset, files.shp.length);

  const dbf = view(files.dbf);
  assert.equal(dbf.getUint32(4, true), features.length);
  assert.equal(files.dbf[dbf.getUint16(8, true) - 1], 0x0d);
  assert.equal(files.dbf[files.dbf.length - 1], 0x1a);
  assert.equal(files.dbf.length, dbf.getUint16(8, true) + dbf.getUint16(10, true) * features.length + 1);

  const result = readShapefile({ shp: files.shp, dbf: files.dbf }); // without .shx: sequential walk
  assert.equal(result.features.length, 3);
  assert.deepEqual(result.bbox, [0, -5, 31, 31]);
  assert.deepEqual(result.features.map((f) => f.properties.A), [1, 2, 3]);
});

// ---------------------------------------------------------------- attributes

const thaiFeatures = [
  { geometry: { type: 'Point', coordinates: [1, 1] }, properties: { owner: 'นายสมชาย ใจดี', doc: 'โฉนดที่ดิน ส.ป.ก.4-01 ๑๒๓' } },
  { geometry: { type: 'Point', coordinates: [2, 2] }, properties: { owner: 'Ms. Smith', doc: null } },
];
const thaiFields = [{ name: 'owner', type: 'C', length: 60 }, { name: 'doc', type: 'C', length: 80 }];

for (const encoding of ['windows-874', 'utf-8']) {
  test(`Thai attributes in ${encoding}, with and without .cpg`, () => {
    const files = writeShapefile({ geometryType: 'Point', fields: thaiFields, features: thaiFeatures, encoding });
    assert.equal(files.cpg, encoding === 'utf-8' ? 'UTF-8' : '874');
    const expected = [
      { OWNER: 'นายสมชาย ใจดี', DOC: 'โฉนดที่ดิน ส.ป.ก.4-01 ๑๒๓' },
      { OWNER: 'Ms. Smith', DOC: '' },
    ];
    for (const cpg of [files.cpg, undefined]) {
      const result = readShapefile({ shp: files.shp, dbf: files.dbf, cpg });
      assert.equal(result.encoding, encoding, `cpg=${cpg}`);
      assert.deepEqual(result.features.map((f) => f.properties), expected);
    }
  });
}

test('cpg labels are recognised; Uint8Array cpg/prj accepted', () => {
  const files = writeShapefile({ geometryType: 'Point', fields: thaiFields, features: thaiFeatures, encoding: 'utf8' });
  const enc = new TextEncoder();
  for (const cpg of ['UTF-8', 'utf8\r\n', enc.encode('UTF-8')]) {
    assert.equal(readShapefile({ shp: files.shp, dbf: files.dbf, cpg }).encoding, 'utf-8');
  }
  const cp = writeShapefile({ geometryType: 'Point', fields: thaiFields, features: thaiFeatures, encoding: 'TIS-620' });
  for (const cpg of ['874', 'ANSI 874', 'TIS-620', 'windows-874', 'CP874']) {
    assert.equal(readShapefile({ shp: cp.shp, dbf: cp.dbf, cpg }).encoding, 'windows-874');
  }
  const prj = 'GEOGCS["GCS_WGS_1984"]';
  const result = readShapefile({ shp: cp.shp, dbf: cp.dbf, prj: enc.encode(prj) });
  assert.equal(result.prj, prj);
  assert.equal(writeShapefile({ geometryType: 'Point', fields: [], features: [], prj }).prj, prj);
  assert.equal(writeShapefile({ geometryType: 'Point', fields: [], features: [] }).prj, undefined);
});

test('character fields are truncated by bytes without splitting UTF-8 characters', () => {
  const features = [{ geometry: null, properties: { t: 'กขคง', a: 'abcdefghijkl' } }];
  const fields = [{ name: 't', type: 'C', length: 10 }, { name: 'a', type: 'C', length: 10 }];
  const utf8 = roundTrip({ geometryType: 'Point', fields, features, encoding: 'utf-8' }).result;
  assert.deepEqual(utf8.features[0].properties, { T: 'กขค', A: 'abcdefghij' }); // 9 of 12 bytes fit
  const cp = roundTrip({
    geometryType: 'Point',
    fields: [{ name: 't', type: 'C', length: 10 }],
    features: [{ geometry: null, properties: { t: 'กขคงจฉชซฌญฎ' } }],
  }).result;
  assert.equal(cp.features[0].properties.T, 'กขคงจฉชซฌญ');
});

test('numeric, date and logical fields', () => {
  const fields = [
    { name: 'area', type: 'N', length: 10, decimals: 2 },
    { name: 'count', type: 'N' },
    { name: 'regdate', type: 'D' },
    { name: 'paid', type: 'L' },
  ];
  const features = [
    { geometry: null, properties: { area: 3.14159, count: 42, regdate: '2026-11-09', paid: true } },
    { geometry: null, properties: { area: -1234.5, count: -7, regdate: new Date(2025, 0, 5), paid: false } },
    { geometry: null, properties: { area: null, count: '', regdate: null, paid: null } },
    { geometry: null, properties: { area: '12.5', count: undefined, regdate: '20240229', paid: 'Y' } },
  ];
  const { files, result } = roundTrip({ geometryType: 'Point', fields, features });

  assert.deepEqual(result.fields, [
    { name: 'AREA', type: 'N', length: 10, decimals: 2 },
    { name: 'COUNT', type: 'N', length: 18, decimals: 0 },
    { name: 'REGDATE', type: 'D', length: 8, decimals: 0 },
    { name: 'PAID', type: 'L', length: 1, decimals: 0 },
  ]);
  assert.deepEqual(result.features.map((f) => f.properties), [
    { AREA: 3.14, COUNT: 42, REGDATE: '2026-11-09', PAID: true },
    { AREA: -1234.5, COUNT: -7, REGDATE: '2025-01-05', PAID: false },
    { AREA: null, COUNT: null, REGDATE: null, PAID: null },
    { AREA: 12.5, COUNT: null, REGDATE: '2024-02-29', PAID: true },
  ]);

  // Raw layout of the first record: right-aligned fixed decimals.
  const v = view(files.dbf);
  const start = v.getUint16(8, true);
  const record = new TextDecoder().decode(files.dbf.subarray(start, start + v.getUint16(10, true)));
  assert.equal(record, ` ${'      3.14'}${'42'.padStart(18)}20261109T`);

  assert.throws(() => writeShapefile({
    geometryType: 'Point',
    fields: [{ name: 'small', type: 'N', length: 4 }],
    features: [{ geometry: null, properties: { small: 123456 } }],
  }), RangeError);
});

test('field names are sanitised, truncated to 10 chars and de-duplicated', () => {
  const fields = [
    { name: 'parcel_number_long', type: 'C', length: 5 },
    { name: 'parcel_number_long2', type: 'C', length: 5 },
    { name: 'PARCEL_NUMBER_X', type: 'C', length: 5 },
    { name: 'ชื่อ', type: 'C', length: 5 },
    { name: 'ที่อยู่', type: 'C', length: 5 },
    { name: 'land use', type: 'C', length: 5 },
  ];
  const properties = { parcel_number_long: 'a', parcel_number_long2: 'b', PARCEL_NUMBER_X: 'c', 'ชื่อ': 'd', 'ที่อยู่': 'e', 'land use': 'f' };
  const { files, result } = roundTrip({ geometryType: 'Point', fields, features: [{ geometry: null, properties }] });
  const names = ['PARCEL_NUM', 'PARCEL_NU1', 'PARCEL_NU2', 'FIELD', 'FIELD1', 'LAND_USE'];
  assert.deepEqual(files.fields.map((f) => f.name), names);
  assert.deepEqual(files.fields.map((f) => f.source), fields.map((f) => f.name));
  assert.deepEqual(result.fields.map((f) => f.name), names);
  assert.deepEqual(result.features[0].properties, Object.fromEntries(names.map((n, i) => [n, 'abcdef'[i]])));
});

test('no fields still gives a valid DBF (FID column)', () => {
  const { result } = roundTrip({ geometryType: 'Point', fields: [], features: [{ geometry: null }, { geometry: null }] });
  assert.deepEqual(result.fields, [{ name: 'FID', type: 'N', length: 10, decimals: 0 }]);
  assert.deepEqual(result.features.map((f) => f.properties), [{ FID: 0 }, { FID: 1 }]);
});

test('deleted DBF records give empty properties but keep ids aligned', () => {
  const files = writeShapefile({
    geometryType: 'Point',
    fields: [{ name: 'n', type: 'N' }],
    features: [0, 1, 2].map((n) => ({ geometry: { type: 'Point', coordinates: [n, n] }, properties: { n } })),
  });
  const v = view(files.dbf);
  files.dbf[v.getUint16(8, true) + v.getUint16(10, true)] = 0x2a; // delete record 1
  const result = readShapefile({ shp: files.shp, shx: files.shx, dbf: files.dbf });
  assert.deepEqual(result.features.map((f) => [f.id, f.geometry.coordinates[0], f.properties]), [
    [0, 0, { N: 0 }],
    [1, 1, {}],
    [2, 2, { N: 2 }],
  ]);
});

test('works on Uint8Array views with a byteOffset', () => {
  const files = writeShapefile({
    geometryType: 'Polygon',
    fields: [{ name: 'name', type: 'C' }],
    features: [{ geometry: { type: 'Polygon', coordinates: [square(0, 0, 1)] }, properties: { name: 'ที่ดิน' } }],
  });
  const shifted = (bytes) => {
    const big = new Uint8Array(bytes.length + 3);
    big.set(bytes, 3);
    return big.subarray(3);
  };
  const result = readShapefile({ shp: shifted(files.shp), shx: shifted(files.shx), dbf: shifted(files.dbf), cpg: files.cpg });
  assert.deepEqual(result.features[0].properties, { NAME: 'ที่ดิน' });
  assert.deepEqual(result.features[0].geometry.coordinates, [square(0, 0, 1)]);
});
