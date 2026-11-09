// Repairs Thai text that was saved twice: UTF-8 bytes read as windows-874 and written again as UTF-8,
// e.g. "เธช.เธ.เธ.4-01" → "ส.ป.ก.4-01". Bytes windows-874 leaves undefined come through as
// U+0080–U+00FF, so the original bytes are fully recoverable. Text is only replaced when the
// recovered bytes are valid UTF-8 and read as Thai/ASCII, so ordinary Thai ("เนิน") is left alone.

const SPECIAL = { 0x80: 0x20ac, 0x85: 0x2026, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0xa0: 0xa0 };
const toByte = new Map();
for (let b = 0x80; b <= 0xff; b++) {
  let cp = SPECIAL[b];
  if (cp === undefined && b >= 0xa1 && b <= 0xda) cp = 0x0e01 + (b - 0xa1);
  if (cp === undefined && b >= 0xdf && b <= 0xfb) cp = 0x0e3f + (b - 0xdf);
  toByte.set(cp ?? b, b); // undefined positions survive as the same-numbered code point
}

const SIGNATURE = /เ[ธน]/; // เธ / เน: the windows-874 view of UTF-8 lead bytes E0 B8 / E0 B9
const CLEAN = /^[\u0000-\u007F ก-๛–—‘-”•…€]*$/;
const strict = new TextDecoder('utf-8', { fatal: true });

export function repairThai(s) {
  if (typeof s !== 'string' || !SIGNATURE.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (toByte.has(cp)) bytes.push(toByte.get(cp));
    else return s; // a character windows-874 can't produce: not this kind of damage
  }
  let fixed;
  try { fixed = strict.decode(new Uint8Array(bytes)); } catch { return s; }
  return fixed !== s && /[ก-๛]/.test(fixed) && CLEAN.test(fixed) ? fixed : s;
}

// Repairs every string value of an object; returns the names of the fields it changed.
export function repairObject(obj) {
  const changed = [];
  for (const [k, v] of Object.entries(obj)) {
    const r = repairThai(v);
    if (r !== v) { obj[k] = r; changed.push(k); }
  }
  return changed;
}
