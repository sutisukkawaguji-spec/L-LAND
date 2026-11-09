// Area and value arithmetic used by the forms, the checks and the map.

export const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// 1 ไร่ = 4 งาน = 400 ตร.ว.; 1 ตร.ว. = 4 ตร.ม.
export const toWah = (rai, ngan, wah) => (num(rai) || 0) * 400 + (num(ngan) || 0) * 100 + (num(wah) || 0);

export const fromWah = total => {
  const t = Math.max(0, Math.round((num(total) || 0) * 100) / 100);
  const rai = Math.floor(t / 400);
  const ngan = Math.floor((t - rai * 400) / 100);
  const wah = Math.round((t - rai * 400 - ngan * 100) * 100) / 100;
  return { rai, ngan, wah };
};

export const formatRNW = (rai, ngan, wah) =>
  `${num(rai) || 0}-${num(ngan) || 0}-${(num(wah) || 0).toFixed(2)}`;

export const landWah = land => toWah(land.rai, land.ngan, land.wah);
export const usesWah = uses => (uses || []).reduce((s, u) => s + toWah(u.rai, u.ngan, u.wah), 0);

// Shoelace area of a GeoJSON-like Polygon/MultiPolygon in map units (m² for UTM). Holes subtract.
const ringArea = ring => {
  const ox = ring[0][0];
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ox + ring[i][0] - ox) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
};
export const polygonArea = geom => {
  if (!geom) return 0;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  let total = 0;
  for (const poly of polys) {
    // Outer ring is the largest; every other ring of the same polygon is a hole.
    const areas = poly.map(ringArea);
    const outer = Math.max(...areas);
    total += outer - (areas.reduce((s, a) => s + a, 0) - outer);
  }
  return total;
};

export const formatNumber = (v, digits = 2) => {
  const n = num(v);
  return n === null ? '' : n.toLocaleString('th-TH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

// Thai national / juristic id: 13 digits, last digit is a mod-11 check.
export const validThaiId = id => {
  if (!/^\d{13}$/.test(id || '')) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
};

export const buddhistYearNow = () => new Date().getFullYear() + 543;
