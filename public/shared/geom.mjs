// Plane geometry for drawing and editing shapes. Points are [x, y] in any planar unit
// (the map works in Web Mercator metres; lengths are scaled to ground metres by the caller).

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Closest point to p on segment ab.
export function nearestOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}

// Rectangle from two corners of one side (a, b) and any point c on the opposite side.
export function rectFrom3(a, b, c) {
  const len = dist(a, b);
  if (!len) return null;
  const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
  const d = (c[0] - a[0]) * nx + (c[1] - a[1]) * ny;
  return [a, b, [b[0] + nx * d, b[1] + ny * d], [a[0] + nx * d, a[1] + ny * d]];
}

export function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Smallest rotated rectangle around the points: { width, length } with width <= length.
export function minRect(points) {
  const hull = convexHull(points);
  if (hull.length < 3) return { width: 0, length: hull.length === 2 ? dist(hull[0], hull[1]) : 0 };
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = dist(a, b);
    if (!len) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const q of hull) {
      const u = (q[0] - a[0]) * ux + (q[1] - a[1]) * uy, v = -(q[0] - a[0]) * uy + (q[1] - a[1]) * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const w = maxU - minU, h = maxV - minV;
    if (!best || w * h < best.area) best = { area: w * h, width: Math.min(w, h), length: Math.max(w, h) };
  }
  return { width: best.width, length: best.length };
}

export function ringArea(ring) {
  const [ox, oy] = ring[0];
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ox) * (ring[i][1] - oy) - (ring[i][0] - ox) * (ring[j][1] - oy);
  return Math.abs(s / 2);
}

// True when two non-adjacent edges of the (open) ring cross.
// Where segments a-b and p-q cross: t along a-b, u along p-q (u in [0, 1) so a shared vertex counts once).
function crossing(a, b, p, q) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [q[0] - p[0], q[1] - p[1]];
  const d = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(d) < 1e-12) return null;
  const w = [p[0] - a[0], p[1] - a[1]];
  const t = (w[0] * s[1] - w[1] * s[0]) / d, u = (w[0] * r[1] - w[1] * r[0]) / d;
  return t >= 0 && t <= 1 && u >= 0 && u < 1 ? { t, u, pt: [a[0] + t * r[0], a[1] + t * r[1]] } : null;
}
// Cut a polygon ring (open: last point not repeated) with the segment a-b into two rings.
// → { parts: [ringA, ringB] } or { error } (the cut must cross the boundary exactly twice).
export function splitRing(ring, a, b) {
  const hits = [];
  for (let i = 0; i < ring.length; i++) {
    const x = crossing(a, b, ring[i], ring[(i + 1) % ring.length]);
    if (x) hits.push({ i, ...x });
  }
  if (hits.length < 2) return { error: 'เส้นตัดต้องลากผ่านขอบแปลงทั้งสองด้าน (เริ่มและจบนอกแปลง)' };
  if (hits.length > 2) return { error: `เส้นตัดผ่านขอบแปลง ${hits.length} จุด ลากใหม่ให้ผ่านขอบแปลง 2 จุดพอดี` };
  hits.sort((h, k) => h.i - k.i || h.u - k.u);
  const [h0, h1] = hits;
  if (h0.i === h1.i) return { error: 'เส้นตัดไม่ได้แบ่งแปลงออกเป็น 2 ส่วน' };
  const A = [h0.pt, ...ring.slice(h0.i + 1, h1.i + 1), h1.pt];
  const B = [h1.pt, ...ring.slice(h1.i + 1), ...ring.slice(0, h0.i + 1), h0.pt];
  if (A.length < 3 || B.length < 3 || ringArea(A) < 1e-6 || ringArea(B) < 1e-6) return { error: 'ส่วนที่แบ่งเล็กเกินไป' };
  return { parts: [A, B] };
}

export function selfIntersects(ring) {
  const n = ring.length;
  const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j], d = ring[(j + 1) % n];
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return true;
    }
  }
  return false;
}

// Next free building code on a parcel: 11E015 + existing 11E015-B001, -B002 → 11E015-B003.
export function nextBuildingCode(parcelCode, codes) {
  const re = new RegExp(`^${parcelCode}-B(\\d{3})$`, 'i');
  const max = codes.reduce((m, c) => Math.max(m, Number((String(c).match(re) || [])[1] || 0)), 0);
  return `${parcelCode}-B${String(max + 1).padStart(3, '0')}`;
}

// Next free lot in the zone/block of a neighbouring parcel: 58D146 → 58D<largest lot + 1>.
export function nextParcelCode(neighbourCode, codes) {
  const m = String(neighbourCode || '').match(/^(\d{2}[A-Z])\d{3}$/);
  if (!m) return '';
  const re = new RegExp(`^${m[1]}(\\d{3})$`);
  const max = codes.reduce((x, c) => Math.max(x, Number((String(c).match(re) || [])[1] || 0)), 0);
  return `${m[1]}${String(max + 1).padStart(3, '0')}`;
}
