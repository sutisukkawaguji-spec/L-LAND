// Coordinate systems used by Thai cadastral data: WGS84 lon/lat, UTM zones 47/48 on WGS84 or Indian 1975.
// Geometries are kept in WGS84 lon/lat inside L-LAN; layers remember their source CRS for export.

const ELLIPSOIDS = {
  WGS84: { a: 6378137, f: 1 / 298.257223563 },
  Everest1937: { a: 6377276.345, f: 1 / 300.8017 },
};
// Indian 1975 → WGS84 three-parameter shift (EPSG:24047/24048 towgs84 210,814,289).
export const DATUMS = {
  WGS84: { ellipsoid: 'WGS84', toWgs84: [0, 0, 0] },
  Indian1975: { ellipsoid: 'Everest1937', toWgs84: [210, 814, 289] },
};

export const CRS_LIST = [
  { id: 'EPSG:4326', th: 'WGS84 ละติจูด/ลองจิจูด', kind: 'geographic', datum: 'WGS84' },
  { id: 'EPSG:32647', th: 'WGS84 UTM โซน 47N', kind: 'utm', datum: 'WGS84', zone: 47 },
  { id: 'EPSG:32648', th: 'WGS84 UTM โซน 48N', kind: 'utm', datum: 'WGS84', zone: 48 },
  { id: 'EPSG:24047', th: 'Indian 1975 UTM โซน 47N', kind: 'utm', datum: 'Indian1975', zone: 47 },
  { id: 'EPSG:24048', th: 'Indian 1975 UTM โซน 48N', kind: 'utm', datum: 'Indian1975', zone: 48 },
];
export const crsById = id => CRS_LIST.find(c => c.id === id) || null;

// Recognise the CRS from a .prj (ESRI WKT). Returns a CRS_LIST entry or null.
export function crsFromPrj(wkt) {
  if (!wkt) return null;
  const s = String(wkt).toUpperCase();
  const indian = /INDIAN_1975|INDIAN 1975|EVEREST/.test(s);
  const cm = s.match(/CENTRAL_MERIDIAN"?\s*,\s*(\d+)/)?.[1];
  const zone = s.match(/UTM[_ ]ZONE[_ ](\d{2})N/)?.[1] || { 99: '47', 105: '48' }[cm];
  if (s.startsWith('GEOGCS') && /WGS_1984|WGS 84/.test(s)) return crsById('EPSG:4326');
  if (s.startsWith('PROJCS') && zone) return crsById(`EPSG:${indian ? 240 : 326}${zone}`);
  return null;
}

export function prjFor(id) {
  const c = crsById(id);
  if (!c) return '';
  if (c.kind === 'geographic') return 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const cm = c.zone === 47 ? 99 : 105;
  const geog = c.datum === 'WGS84'
    ? 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
    : 'GEOGCS["GCS_Indian_1975",DATUM["D_Indian_1975",SPHEROID["Everest_Adjustment_1937",6377276.345,300.8017]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const name = c.datum === 'WGS84' ? `WGS_1984_UTM_Zone_${c.zone}N` : `Indian_1975_UTM_Zone_${c.zone}N`;
  return `PROJCS["${name}",${geog},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${cm}.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`;
}

const RAD = Math.PI / 180;

// Transverse Mercator (Snyder series), angles in radians.
function tmForward(lat, lon, lon0, { a, f }, k0 = 0.9996) {
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), e4 = e2 * e2, e6 = e4 * e2;
  const sin = Math.sin(lat), cos = Math.cos(lat), tan = Math.tan(lat);
  const N = a / Math.sqrt(1 - e2 * sin * sin), T = tan * tan, C = ep2 * cos * cos, A = (lon - lon0) * cos;
  const M = a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * lat - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * lat)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * lat) - (35 * e6 / 3072) * Math.sin(6 * lat));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const y = k0 * (M + N * tan * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [x + 500000, y];
}

function tmInverse(E, Nn, lon0, { a, f }, k0 = 0.9996) {
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), e4 = e2 * e2, e6 = e4 * e2;
  const x = E - 500000, M = Nn / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sin = Math.sin(p1), cos = Math.cos(p1), tan = Math.tan(p1);
  const C1 = ep2 * cos * cos, T1 = tan * tan, N1 = a / Math.sqrt(1 - e2 * sin * sin);
  const R1 = a * (1 - e2) / (1 - e2 * sin * sin) ** 1.5, D = x / (N1 * k0);
  const lat = p1 - (N1 * tan / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / cos;
  return [lat, lon];
}

function toEcef(lat, lon, { a, f }) {
  const e2 = f * (2 - f), N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [N * Math.cos(lat) * Math.cos(lon), N * Math.cos(lat) * Math.sin(lon), N * (1 - e2) * Math.sin(lat)];
}
function fromEcef(X, Y, Z, { a, f }) {
  const e2 = f * (2 - f), p = Math.hypot(X, Y), lon = Math.atan2(Y, X);
  let lat = Math.atan2(Z, p * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(Z + e2 * N * Math.sin(lat), p);
  }
  return [lat, lon];
}
function shiftDatum(lat, lon, from, to) {
  if (from === to) return [lat, lon];
  const src = DATUMS[from], dst = DATUMS[to];
  let [X, Y, Z] = toEcef(lat, lon, ELLIPSOIDS[src.ellipsoid]);
  X += src.toWgs84[0] - dst.toWgs84[0]; Y += src.toWgs84[1] - dst.toWgs84[1]; Z += src.toWgs84[2] - dst.toWgs84[2];
  return fromEcef(X, Y, Z, ELLIPSOIDS[dst.ellipsoid]);
}

// One point: source CRS → WGS84 [lon, lat] degrees.
export function toWgs84(x, y, crsId) {
  const c = crsById(crsId);
  if (!c || c.kind === 'geographic') return [x, y];
  const ell = ELLIPSOIDS[DATUMS[c.datum].ellipsoid];
  const [lat, lon] = tmInverse(x, y, (c.zone * 6 - 183) * RAD, ell);
  const [la, lo] = shiftDatum(lat, lon, c.datum, 'WGS84');
  return [lo / RAD, la / RAD];
}

// One point: WGS84 [lon, lat] degrees → target CRS.
export function fromWgs84(lon, lat, crsId) {
  const c = crsById(crsId);
  if (!c || c.kind === 'geographic') return [lon, lat];
  const [la, lo] = shiftDatum(lat * RAD, lon * RAD, 'WGS84', c.datum);
  return tmForward(la, lo, (c.zone * 6 - 183) * RAD, ELLIPSOIDS[DATUMS[c.datum].ellipsoid]);
}

export function mapCoords(geom, fn) {
  if (!geom) return geom;
  const walk = c => (typeof c[0] === 'number' ? fn(c[0], c[1]) : c.map(walk));
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}
export const geomToWgs84 = (geom, crsId) => mapCoords(geom, (x, y) => toWgs84(x, y, crsId));
export const geomFromWgs84 = (geom, crsId) => mapCoords(geom, (x, y) => fromWgs84(x, y, crsId));

// Area in m² of a WGS84 polygon, measured in WGS84 UTM of the polygon's own zone.
export function areaM2(geom) {
  if (!geom || !/Polygon/.test(geom.type)) return 0;
  const first = geom.type === 'Polygon' ? geom.coordinates[0][0] : geom.coordinates[0][0][0];
  const zone = Math.floor((first[0] + 180) / 6) + 1;
  const utm = mapCoords(geom, (lon, lat) => fromWgs84(lon, lat, `EPSG:326${zone}`));
  const ringArea = r => {
    const [ox, oy] = r[0];
    let s = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - ox + r[i][0] - ox) * (r[j][1] - r[i][1]);
    return Math.abs(s / 2);
  };
  const polys = utm.type === 'Polygon' ? [utm.coordinates] : utm.coordinates;
  let total = 0;
  for (const poly of polys) {
    const areas = poly.map(ringArea), outer = Math.max(...areas);
    total += outer - (areas.reduce((s, x) => s + x, 0) - outer);
  }
  return total;
}

export function bboxOf(geom, box = [Infinity, Infinity, -Infinity, -Infinity]) {
  if (!geom) return box;
  const walk = c => {
    if (typeof c[0] === 'number') { box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]); box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]); }
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return box;
}

// Point-in-polygon for WGS84 or projected coordinates (holes respected).
export function pointInGeom([x, y], geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const inRing = r => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++)
      if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
    return inside;
  };
  return polys.some(poly => {
    const hits = poly.filter(inRing).length;
    return hits % 2 === 1; // inside the outer ring and not inside a hole
  });
}

// Area-weighted centroid of the largest outer ring (good enough for labels and building-in-parcel tests).
export function centroid(geom) {
  if (!geom) return null;
  if (geom.type === 'Point') return geom.coordinates;
  const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.type === 'MultiPolygon' ? geom.coordinates.map(p => p[0]) : null;
  if (!rings) { const b = bboxOf(geom); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
  let best = null, bestA = -1;
  for (const r of rings) {
    // Work relative to the first vertex: raw degrees lose too many digits in the cross products.
    const [ox, oy] = r[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xj = r[j][0] - ox, yj = r[j][1] - oy, xi = r[i][0] - ox, yi = r[i][1] - oy;
      const k = xj * yi - xi * yj;
      a += k; cx += (xj + xi) * k; cy += (yj + yi) * k;
    }
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = a ? [ox + cx / (3 * a), oy + cy / (3 * a)] : r[0]; }
  }
  return best;
}

// Web Mercator for the screen.
const R = 6378137;
export const toMercator = (lon, lat) => [R * lon * RAD, R * Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2))];
export const fromMercator = (x, y) => [x / R / RAD, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / RAD];
