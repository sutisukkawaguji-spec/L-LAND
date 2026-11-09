// Appraised values. LTAX computes the official figures; these are previews and suggestions for missing prices.
// rec.ltaxValues holds the figures LTAX itself reported in its Excel export (read-only, never sent back).
import { num, toWah, landWah, buddhistYearNow } from './calc.mjs';

const round2 = v => Math.round(v * 100) / 100;

export function landTotal(l) {
  const p = num(l.pricePerWah);
  return p === null ? null : round2(landWah(l) * p);
}
export function useValue(u, land) {
  const p = num(land.pricePerWah);
  return p === null ? null : round2(toWah(u.rai, u.ngan, u.wah) * p);
}

// Depreciation % LTAX applied, by structure and age, learned from imported buildings: { 'structure|age': pct }.
export function deprTable(buildings) {
  const votes = new Map();
  for (const b of buildings) {
    const pct = num(b.ltaxValues?.deprPct), age = num(b.age);
    if (pct === null || age === null || !b.structure) continue;
    const k = `${b.structure}|${age}`;
    const m = votes.get(k) || new Map();
    m.set(pct, (m.get(pct) || 0) + 1);
    votes.set(k, m);
  }
  const out = {};
  for (const [k, m] of votes) out[k] = [...m].sort((a, b) => b[1] - a[1])[0][0];
  return out;
}

// Estimate from the table: exact age, else linear between the nearest known ages of the same structure.
export function estimateDepr(structure, age, table) {
  if (!structure || age === null) return null;
  if (table[`${structure}|${age}`] !== undefined) return table[`${structure}|${age}`];
  const known = Object.entries(table).filter(([k]) => k.startsWith(`${structure}|`)).map(([k, v]) => [Number(k.split('|')[1]), v]).sort((a, b) => a[0] - b[0]);
  if (!known.length) return null;
  const lo = [...known].reverse().find(([a]) => a < age), hi = known.find(([a]) => a > age);
  if (lo && hi) return Math.round(lo[1] + (hi[1] - lo[1]) * (age - lo[0]) / (hi[0] - lo[0]));
  return (lo || hi)[1];
}

export function buildingValue(b, table = {}) {
  const area = num(b.totalArea), price = num(b.pricePerMeter);
  const gross = area !== null && price !== null ? round2(area * price) : null;
  const age = num(b.age) ?? (num(b.since) !== null ? buddhistYearNow() - num(b.since) : null);
  // LTAX's own figure is used while structure and age are unchanged since the import.
  const fromLtax = num(b.ltaxValues?.deprPct) !== null && (!b.synced || (b.synced.structure === String(b.structure ?? '') && b.synced.age === String(b.age ?? '')));
  const pct = fromLtax ? num(b.ltaxValues.deprPct) : estimateDepr(b.structure, age, table);
  const depr = gross !== null && pct !== null ? round2(gross * pct / 100) : null;
  return { gross, deprPct: pct, deprSource: pct === null ? null : fromLtax ? 'ltax' : 'estimate', depr, net: depr !== null ? round2(gross - depr) : gross };
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mode = xs => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };

// Suggested price per ตร.ว. for a land without one: the usual price of the same block, then zone, then document type.
export function suggestLandPrice(land, lands) {
  const code = String(land.parcelCode || '').toUpperCase();
  const priced = lands.filter(l => l.id !== land.id && num(l.pricePerWah) !== null && num(l.pricePerWah) > 0);
  const tiers = [
    [`บล็อก ${code.slice(0, 3)} เอกสารเดียวกัน`, l => code.length >= 3 && String(l.parcelCode || '').toUpperCase().startsWith(code.slice(0, 3)) && l.docType === land.docType],
    [`บล็อก ${code.slice(0, 3)}`, l => code.length >= 3 && String(l.parcelCode || '').toUpperCase().startsWith(code.slice(0, 3))],
    [`โซน ${code.slice(0, 2)} เอกสารเดียวกัน`, l => code.length >= 2 && String(l.parcelCode || '').toUpperCase().startsWith(code.slice(0, 2)) && l.docType === land.docType],
    ['เอกสารสิทธิ์ประเภทเดียวกันทั้งตำบล', l => l.docType === land.docType],
  ];
  for (const [basis, fit] of tiers) {
    const xs = priced.filter(fit).map(l => num(l.pricePerWah));
    if (xs.length >= 3) return { value: mode(xs) ?? median(xs), basis, n: xs.length };
  }
  return null;
}

// Suggested price per ตร.ม.: what LTAX uses for the same building type in this office's data.
export function suggestBuildingPrice(b, buildings) {
  const xs = buildings.filter(x => x.id !== b.id && x.buildingType === b.buildingType && num(x.pricePerMeter) > 0).map(x => num(x.pricePerMeter));
  return xs.length ? { value: mode(xs), basis: `ประเภท ${b.buildingType} ในข้อมูลเดิม`, n: xs.length } : null;
}
