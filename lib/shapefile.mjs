// ESRI Shapefile reader/writer (.shp/.shx/.dbf/.prj/.cpg) on Uint8Array/DataView only.
// Works in Node and browsers: no Buffer, no fs.
import { decodeCp874, encodeCp874 } from './cp874.mjs';

const UTF8 = 'utf-8';
const CP874 = 'windows-874';

const FILE_CODE = 9994;
const VERSION = 1000;
const HEADER_BYTES = 100;

const POINT = 1;
const POLYLINE = 3;
const POLYGON = 5;
const MULTIPOINT = 8;

// Every Z/M variant shares the XY layout of its base type, so Z/M data is simply ignored.
const BASE_TYPE = {
  1: POINT, 11: POINT, 21: POINT,
  3: POLYLINE, 13: POLYLINE, 23: POLYLINE,
  5: POLYGON, 15: POLYGON, 25: POLYGON,
  8: MULTIPOINT, 18: MULTIPOINT, 28: MULTIPOINT,
};

const TYPE_NAMES = { [POINT]: 'Point', [MULTIPOINT]: 'MultiPoint', [POLYLINE]: 'LineString', [POLYGON]: 'Polygon' };

const WRITE_TYPES = {
  Point: POINT,
  MultiPoint: MULTIPOINT,
  LineString: POLYLINE, MultiLineString: POLYLINE, PolyLine: POLYLINE,
  Polygon: POLYGON, MultiPolygon: POLYGON,
};

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

// ---------------------------------------------------------------- shared helpers

function toBytes(data) {
  if (data == null) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Expected Uint8Array or ArrayBuffer');
}

// Respect byteOffset: Node Buffers are often views into a larger pool.
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toText(data) {
  if (data == null) return null;
  const text = typeof data === 'string' ? data : utf8Decoder.decode(toBytes(data));
  return text.replace(/^﻿/, '');
}

/** Map a .cpg / user label to 'utf-8' or 'windows-874'; null when unknown. */
function encodingFromLabel(label) {
  const s = String(label ?? '').trim().toUpperCase().replace(/[\s_]/g, '');
  if (!s) return null;
  if (/^UTF-?8$/.test(s) || s === '65001') return UTF8;
  if (/874|TIS-?620|8859-?11/.test(s)) return CP874;
  return null;
}

/** Length of `bytes[0..end)` without a trailing, incomplete UTF-8 sequence. */
function utf8CompleteLength(bytes, end) {
  let i = end - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (bytes[i] & 0xc0) === 0x80) { i--; continuation++; }
  if (i < 0) return end;
  const lead = bytes[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end - i < need ? i : end;
}

/** Signed ring area (shoelace), positive = counter-clockwise. Relative to the first vertex for precision. */
function ringArea(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  const [x0, y0] = ring[0];
  let sum = 0;
  for (let i = 1; i < n - 1; i++) {
    const ax = ring[i][0] - x0, ay = ring[i][1] - y0;
    const bx = ring[i + 1][0] - x0, by = ring[i + 1][1] - y0;
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

function boundsOf(points) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const [x, y] of points) {
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  return [xmin, ymin, xmax, ymax];
}

// ---------------------------------------------------------------- reading .shp

function readMainHeader(view) {
  if (view.byteLength < HEADER_BYTES || view.getInt32(0, false) !== FILE_CODE) {
    throw new Error('Not a shapefile: bad .shp header');
  }
  return {
    fileBytes: view.getInt32(24, false) * 2,
    shapeType: view.getInt32(32, true),
    bbox: [view.getFloat64(36, true), view.getFloat64(44, true), view.getFloat64(52, true), view.getFloat64(60, true)],
  };
}

/** Record positions from the .shx when given, otherwise by walking the .shp. */
function locateRecords(shpView, shxView, fileBytes) {
  const records = [];
  if (shxView && shxView.byteLength >= HEADER_BYTES) {
    for (let p = HEADER_BYTES; p + 8 <= shxView.byteLength; p += 8) {
      records.push({ offset: shxView.getInt32(p, false) * 2, length: shxView.getInt32(p + 4, false) * 2 });
    }
    return records;
  }
  const end = fileBytes > HEADER_BYTES ? Math.min(fileBytes, shpView.byteLength) : shpView.byteLength;
  for (let p = HEADER_BYTES; p + 8 <= end;) {
    const length = shpView.getInt32(p + 4, false) * 2;
    if (length < 0 || p + 8 + length > shpView.byteLength) break;
    records.push({ offset: p, length });
    p += 8 + length;
  }
  return records;
}

function readPoints(view, start, count) {
  const points = new Array(count);
  for (let i = 0; i < count; i++) {
    const p = start + 16 * i;
    points[i] = [view.getFloat64(p, true), view.getFloat64(p + 8, true)];
  }
  return points;
}

function readGeometry(view, { offset, length }, index) {
  const p = offset + 8; // skip the record header
  if (length < 4 || offset < HEADER_BYTES || p + length > view.byteLength) {
    throw new Error(`Shapefile record ${index} is outside the .shp data`);
  }
  const need = (bytes) => {
    if (bytes > length) throw new Error(`Shapefile record ${index} is truncated`);
  };
  const type = BASE_TYPE[view.getInt32(p, true)];

  if (type === POINT) {
    need(20);
    return { type: 'Point', coordinates: [view.getFloat64(p + 4, true), view.getFloat64(p + 12, true)] };
  }
  if (type === MULTIPOINT) {
    need(40);
    const count = view.getInt32(p + 36, true);
    need(40 + 16 * count);
    return count > 0 ? { type: 'MultiPoint', coordinates: readPoints(view, p + 40, count) } : null;
  }
  if (type === POLYLINE || type === POLYGON) {
    need(44);
    const numParts = view.getInt32(p + 36, true);
    const numPoints = view.getInt32(p + 40, true);
    need(44 + 4 * numParts + 16 * numPoints);
    const pointsStart = p + 44 + 4 * numParts;
    const parts = [];
    for (let i = 0; i < numParts; i++) {
      const from = view.getInt32(p + 44 + 4 * i, true);
      const to = i + 1 < numParts ? view.getInt32(p + 48 + 4 * i, true) : numPoints;
      if (to > from) parts.push(readPoints(view, pointsStart + 16 * from, to - from));
    }
    if (!parts.length) return null;
    if (type === POLYGON) return assemblePolygon(parts);
    return parts.length === 1
      ? { type: 'LineString', coordinates: parts[0] }
      : { type: 'MultiLineString', coordinates: parts };
  }
  return null; // null shape or unsupported type
}

function pointOnSegment(px, py, [ax, ay], [bx, by]) {
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const tolerance = 1e-9 * (1 + Math.abs(px) + Math.abs(py));
  const len = Math.hypot(bx - ax, by - ay);
  if (Math.abs(cross) > tolerance * Math.max(len, 1e-300)) return false;
  return px >= Math.min(ax, bx) - tolerance && px <= Math.max(ax, bx) + tolerance
    && py >= Math.min(ay, by) - tolerance && py <= Math.max(ay, by) + tolerance;
}

/** Ray casting; returns 1 inside, -1 outside, 0 on the boundary. */
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (pointOnSegment(x, y, a, b)) return 0;
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}

// Uses the hole's first vertex; if that vertex sits on the outer boundary, the next one decides.
function ringContains(outer, hole) {
  const [oxmin, oymin, oxmax, oymax] = outer.bounds;
  const [hxmin, hymin, hxmax, hymax] = hole.bounds;
  if (hxmin < oxmin || hymin < oymin || hxmax > oxmax || hymax > oymax) return false;
  for (const vertex of hole.ring) {
    const where = pointInRing(vertex, outer.ring);
    if (where !== 0) return where > 0;
  }
  return true;
}

/** Clockwise rings are outers, counter-clockwise rings are holes of the smallest containing outer. */
function assemblePolygon(rings) {
  const outers = [];
  const holes = [];
  for (const ring of rings) {
    const area = ringArea(ring);
    const entry = { ring, area: Math.abs(area), bounds: boundsOf(ring), rings: [ring] };
    (area < 0 ? outers : holes).push(entry);
  }
  const orphans = [];
  for (const hole of holes) {
    let best = null;
    for (const outer of outers) {
      if ((!best || outer.area < best.area) && ringContains(outer, hole)) best = outer;
    }
    if (best) best.rings.push(hole.ring);
    else orphans.push(hole);
  }
  const polygons = [...outers, ...orphans].map((entry) => entry.rings);
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

// ---------------------------------------------------------------- reading .dbf

function readDbfLayout(bytes) {
  if (bytes.length < 32) throw new Error('Not a dBASE file: .dbf too short');
  const view = viewOf(bytes);
  const recordCount = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const fields = [];
  let offset = 1; // deletion flag byte
  for (let p = 32; p + 32 <= Math.min(headerLength, bytes.length) && bytes[p] !== 0x0d; p += 32) {
    let nameEnd = p;
    while (nameEnd < p + 11 && bytes[nameEnd] !== 0) nameEnd++;
    const length = bytes[p + 16];
    fields.push({
      nameBytes: bytes.subarray(p, nameEnd),
      type: String.fromCharCode(bytes[p + 11]),
      length,
      decimals: bytes[p + 17],
      offset,
    });
    offset += length;
  }
  const available = recordLength > 0 ? Math.floor((bytes.length - headerLength) / recordLength) : 0;
  return { recordCount: Math.max(0, Math.min(recordCount, available)), headerLength, recordLength, fields };
}

function hasHighByte(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) return true;
  return false;
}

function trimmedEnd(bytes, start, end) {
  while (end > start && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x00)) end--;
  return end;
}

/** utf-8 when every non-ASCII run in names and character fields is valid UTF-8, otherwise windows-874. */
function detectDbfEncoding(bytes, layout) {
  const fatal = new TextDecoder('utf-8', { fatal: true });
  const isUtf8 = (slice) => {
    if (!hasHighByte(slice)) return true;
    try {
      fatal.decode(slice.subarray(0, utf8CompleteLength(slice, slice.length)));
      return true;
    } catch {
      return false;
    }
  };
  if (!layout.fields.every((f) => isUtf8(f.nameBytes))) return CP874;
  const textFields = layout.fields.filter((f) => f.type === 'C');
  for (let r = 0; r < layout.recordCount; r++) {
    const base = layout.headerLength + r * layout.recordLength;
    for (const f of textFields) {
      const start = base + f.offset;
      const end = trimmedEnd(bytes, start, start + f.length);
      if (!isUtf8(bytes.subarray(start, end))) return CP874;
    }
  }
  return UTF8;
}

function asciiOf(bytes, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s.trim();
}

function makeTextDecoder(encoding) {
  if (encoding === CP874) return decodeCp874;
  return (slice) => utf8Decoder.decode(slice.subarray(0, utf8CompleteLength(slice, slice.length)));
}

function parseDbfValue(bytes, start, field, decodeText) {
  const end = start + field.length;
  switch (field.type) {
    case 'N':
    case 'F': {
      const s = asciiOf(bytes, start, end);
      if (!s || /^[*.]+$/.test(s)) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    case 'D': {
      const s = asciiOf(bytes, start, end);
      return /^\d{8}$/.test(s) && s !== '00000000' ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
    }
    case 'L': {
      const c = String.fromCharCode(bytes[start]).toUpperCase();
      if (c === 'T' || c === 'Y') return true;
      if (c === 'F' || c === 'N') return false;
      return null;
    }
    default: // 'C' and anything else: text without trailing padding
      return decodeText(bytes.subarray(start, trimmedEnd(bytes, start, end)));
  }
}

function readDbfRow(bytes, layout, index, decodeText) {
  if (index >= layout.recordCount) return {};
  const base = layout.headerLength + index * layout.recordLength;
  if (bytes[base] === 0x2a) return {}; // deleted record
  const properties = {};
  for (const field of layout.fields) {
    properties[field.name] = parseDbfValue(bytes, base + field.offset, field, decodeText);
  }
  return properties;
}

/**
 * Read a shapefile set.
 * @param {{shp: Uint8Array, dbf?: Uint8Array, shx?: Uint8Array, prj?: string|Uint8Array, cpg?: string|Uint8Array}} files
 */
export function readShapefile({ shp, dbf, shx, prj, cpg } = {}) {
  const shpBytes = toBytes(shp);
  if (!shpBytes) throw new Error('readShapefile: .shp data is required');
  const shpView = viewOf(shpBytes);
  const header = readMainHeader(shpView);
  const shxBytes = toBytes(shx);
  const records = locateRecords(shpView, shxBytes ? viewOf(shxBytes) : null, header.fileBytes);

  const dbfBytes = toBytes(dbf);
  const layout = dbfBytes ? readDbfLayout(dbfBytes) : { recordCount: 0, fields: [] };
  const encoding = encodingFromLabel(toText(cpg))
    ?? (dbfBytes ? detectDbfEncoding(dbfBytes, layout) : UTF8);
  const decodeText = makeTextDecoder(encoding);
  for (const field of layout.fields) field.name = decodeText(field.nameBytes).trim();

  const features = records.map((record, id) => ({
    id,
    geometry: readGeometry(shpView, record, id),
    properties: dbfBytes ? readDbfRow(dbfBytes, layout, id, decodeText) : {},
  }));

  const baseType = BASE_TYPE[header.shapeType];
  return {
    geometryType: TYPE_NAMES[baseType] ?? null,
    shapeType: header.shapeType,
    bbox: header.bbox,
    prj: toText(prj),
    encoding,
    fields: layout.fields.map(({ name, type, length, decimals }) => ({ name, type, length, decimals })),
    features,
  };
}

// ---------------------------------------------------------------- writing .shp/.shx

function toXY(position, index) {
  const x = Number(position?.[0]);
  const y = Number(position?.[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Feature ${index}: invalid coordinate ${JSON.stringify(position)}`);
  }
  return [x, y];
}

function closeRing(ring) {
  const first = ring[0], last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [first[0], first[1]]];
}

/** Outer ring clockwise, holes counter-clockwise, every ring closed. */
function orientPolygon(rings, index) {
  return rings
    .filter((ring) => Array.isArray(ring) && ring.length > 0)
    .map((ring, k) => {
      const closed = closeRing(ring.map((pos) => toXY(pos, index)));
      const area = ringArea(closed);
      const wrongWay = k === 0 ? area > 0 : area < 0;
      return wrongWay ? closed.reverse() : closed;
    });
}

/** Geometry → list of parts (each a list of [x, y]); null for a null shape. */
function geometryParts(shapeType, geometry, index) {
  if (!geometry || !geometry.type) return null;
  const { type } = geometry;
  const coords = geometry.coordinates;
  if (!Array.isArray(coords) || coords.length === 0) return null;
  const reject = () => {
    throw new Error(`Feature ${index}: ${type} geometry cannot be written to a ${TYPE_NAMES[shapeType]} shapefile`);
  };
  let parts;
  switch (shapeType) {
    case POINT:
      if (type !== 'Point') reject();
      parts = [[toXY(coords, index)]];
      break;
    case MULTIPOINT:
      if (type === 'Point') parts = [[toXY(coords, index)]];
      else if (type === 'MultiPoint') parts = [coords.map((pos) => toXY(pos, index))];
      else reject();
      break;
    case POLYLINE:
      if (type === 'LineString') parts = [coords];
      else if (type === 'MultiLineString') parts = coords;
      else reject();
      parts = parts.filter((line) => Array.isArray(line) && line.length > 0).map((line) => line.map((pos) => toXY(pos, index)));
      break;
    case POLYGON:
      if (type === 'Polygon') parts = orientPolygon(coords, index);
      else if (type === 'MultiPolygon') parts = coords.flatMap((polygon) => orientPolygon(polygon ?? [], index));
      else reject();
      break;
  }
  return parts.some((part) => part.length > 0) ? parts : null;
}

function encodeRecordContent(shapeType, parts) {
  if (!parts) {
    const content = new Uint8Array(4); // shape type 0 is all zero bytes
    return { content, bbox: null };
  }
  const points = parts.flat();
  const bbox = boundsOf(points);
  let content;
  if (shapeType === POINT) {
    content = new Uint8Array(20);
    const v = viewOf(content);
    v.setInt32(0, POINT, true);
    v.setFloat64(4, points[0][0], true);
    v.setFloat64(12, points[0][1], true);
    return { content, bbox };
  }
  const multi = shapeType === MULTIPOINT;
  const pointsStart = multi ? 40 : 44 + 4 * parts.length;
  content = new Uint8Array(pointsStart + 16 * points.length);
  const v = viewOf(content);
  v.setInt32(0, shapeType, true);
  bbox.forEach((value, i) => v.setFloat64(4 + 8 * i, value, true));
  if (multi) {
    v.setInt32(36, points.length, true);
  } else {
    v.setInt32(36, parts.length, true);
    v.setInt32(40, points.length, true);
    let start = 0;
    parts.forEach((part, i) => {
      v.setInt32(44 + 4 * i, start, true);
      start += part.length;
    });
  }
  points.forEach(([x, y], i) => {
    v.setFloat64(pointsStart + 16 * i, x, true);
    v.setFloat64(pointsStart + 16 * i + 8, y, true);
  });
  return { content, bbox };
}

function writeMainHeader(view, shapeType, byteLength, bbox) {
  view.setInt32(0, FILE_CODE, false);
  view.setInt32(24, byteLength / 2, false);
  view.setInt32(28, VERSION, true);
  view.setInt32(32, shapeType, true);
  bbox.forEach((value, i) => view.setFloat64(36 + 8 * i, value, true));
  // Z and M ranges (bytes 68..99) stay zero.
}

function buildShpShx(shapeType, records) {
  let bbox = null;
  for (const { bbox: b } of records) {
    if (!b) continue;
    bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : [...b];
  }
  bbox ??= [0, 0, 0, 0];

  const shpLength = records.reduce((sum, r) => sum + 8 + r.content.length, HEADER_BYTES);
  const shp = new Uint8Array(shpLength);
  const shx = new Uint8Array(HEADER_BYTES + 8 * records.length);
  const shpView = viewOf(shp);
  const shxView = viewOf(shx);
  writeMainHeader(shpView, shapeType, shp.length, bbox);
  writeMainHeader(shxView, shapeType, shx.length, bbox);

  let offset = HEADER_BYTES;
  records.forEach(({ content }, i) => {
    shxView.setInt32(HEADER_BYTES + 8 * i, offset / 2, false);
    shxView.setInt32(HEADER_BYTES + 8 * i + 4, content.length / 2, false);
    shpView.setInt32(offset, i + 1, false); // record numbers are 1-based
    shpView.setInt32(offset + 4, content.length / 2, false);
    shp.set(content, offset + 8);
    offset += 8 + content.length;
  });
  return { shp, shx };
}

// ---------------------------------------------------------------- writing .dbf

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

/** Uppercase ASCII, max 10 chars, unique (numeric suffix replaces the tail). */
function uniqueFieldName(raw, used) {
  let base = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9_]+/g, '_').slice(0, 10);
  if (!/[A-Z0-9]/.test(base)) base = 'FIELD';
  let name = base;
  for (let n = 1; used.has(name); n++) name = base.slice(0, 10 - String(n).length) + n;
  used.add(name);
  return name;
}

function normalizeFields(defs) {
  if (!defs.length) return [{ name: 'FID', source: null, type: 'N', length: 10, decimals: 0, autoId: true }];
  const used = new Set();
  return defs.map((def) => {
    const type = String(def.type ?? 'C').toUpperCase();
    let length;
    let decimals = 0;
    switch (type) {
      case 'C':
        length = clampInt(def.length ?? 80, 1, 254);
        break;
      case 'N':
      case 'F':
        length = clampInt(def.length ?? 18, 1, 254);
        decimals = clampInt(def.decimals ?? 0, 0, Math.max(0, length - 2));
        break;
      case 'D':
        length = 8;
        break;
      case 'L':
        length = 1;
        break;
      default:
        throw new Error(`Unsupported DBF field type '${def.type}' for field ${def.name}`);
    }
    return { name: uniqueFieldName(def.name, used), source: def.name, type, length, decimals };
  });
}

function formatNumber(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  let text = Math.abs(n) < 1e21 ? n.toFixed(field.decimals) : null;
  if (text && /^-0(\.0+)?$/.test(text)) text = text.slice(1);
  if (!text || text.length > field.length) {
    throw new RangeError(`Value ${value} does not fit field ${field.name} (${field.type} ${field.length}.${field.decimals})`);
  }
  return text;
}

const pad = (n, width) => String(n).padStart(width, '0');

function formatDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return pad(value.getFullYear(), 4) + pad(value.getMonth() + 1, 2) + pad(value.getDate(), 2);
  }
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(value).trim());
  return m ? m[1] + m[2] + m[3] : null;
}

function formatLogical(value) {
  if (value === true) return 'T';
  if (value === false) return 'F';
  if (typeof value === 'number' && !Number.isNaN(value)) return value ? 'T' : 'F';
  if (typeof value === 'string') {
    const c = value.trim().charAt(0).toUpperCase();
    if (c && 'TY1'.includes(c)) return 'T';
    if (c && 'FN0'.includes(c)) return 'F';
  }
  return '?';
}

function writeAscii(out, offset, text) {
  for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
}

function writeDbfValue(out, offset, field, value, encoding) {
  switch (field.type) {
    case 'C': {
      if (value === null || value === undefined) return;
      const utf8 = encoding === UTF8;
      const bytes = utf8 ? utf8Encoder.encode(String(value)) : encodeCp874(String(value));
      let cut = Math.min(bytes.length, field.length);
      // never split a multi-byte UTF-8 character (cp874 is single-byte, any cut is safe)
      if (utf8 && cut < bytes.length) while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
      out.set(bytes.subarray(0, cut), offset);
      return;
    }
    case 'N':
    case 'F': {
      const text = formatNumber(value, field);
      if (text) writeAscii(out, offset + field.length - text.length, text);
      return;
    }
    case 'D': {
      const text = formatDate(value);
      if (text) writeAscii(out, offset, text);
      return;
    }
    case 'L':
      out[offset] = formatLogical(value).charCodeAt(0);
  }
}

function buildDbf(fieldDefs, features, encoding) {
  const fields = normalizeFields(fieldDefs);
  const recordLength = fields.reduce((sum, f) => sum + f.length, 1);
  const headerLength = 32 + 32 * fields.length + 1;
  if (recordLength > 0xffff || headerLength > 0xffff) throw new Error('Too many or too wide DBF fields');

  const total = headerLength + recordLength * features.length + 1;
  const out = new Uint8Array(total);
  const view = viewOf(out);
  const today = new Date();
  out[0] = 0x03; // dBASE III without memo
  out[1] = today.getFullYear() - 1900;
  out[2] = today.getMonth() + 1;
  out[3] = today.getDate();
  view.setUint32(4, features.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  out[29] = 0x00; // language driver: none, the .cpg carries the code page

  fields.forEach((field, k) => {
    const p = 32 + 32 * k;
    writeAscii(out, p, field.name);
    out[p + 11] = field.type.charCodeAt(0);
    out[p + 16] = field.length;
    out[p + 17] = field.decimals;
  });
  out[headerLength - 1] = 0x0d;
  out.fill(0x20, headerLength, total - 1); // deletion flags and padding are spaces

  features.forEach((feature, r) => {
    let offset = headerLength + r * recordLength + 1;
    for (const field of fields) {
      const value = field.autoId ? r : feature?.properties?.[field.source];
      writeDbfValue(out, offset, field, value, encoding);
      offset += field.length;
    }
  });
  out[total - 1] = 0x1a;
  return { dbf: out, fields };
}

/**
 * Write a shapefile set.
 * Returns { shp, shx, dbf, prj, cpg, fields } where `fields` lists the DBF fields as written
 * ({ name, source, type, length, decimals }; `source` is the property key that was read).
 */
export function writeShapefile({ geometryType, fields = [], features = [], prj, encoding = CP874 } = {}) {
  const shapeType = WRITE_TYPES[geometryType];
  if (!shapeType) throw new Error(`Unsupported geometryType: ${geometryType}`);
  const enc = encodingFromLabel(encoding);
  if (!enc) throw new Error(`Unsupported encoding: ${encoding}`);

  const records = features.map((feature, i) => encodeRecordContent(shapeType, geometryParts(shapeType, feature?.geometry, i)));
  const { shp, shx } = buildShpShx(shapeType, records);
  const { dbf, fields: written } = buildDbf(fields, features, enc);
  return {
    shp,
    shx,
    dbf,
    prj: prj == null ? undefined : toText(prj),
    cpg: enc === UTF8 ? 'UTF-8' : '874',
    fields: written.map(({ name, source, type, length, decimals }) => ({ name, source, type, length, decimals })),
  };
}
