// Windows-874 codec (TIS-620 plus the Microsoft punctuation extras). Pure JS, browser-safe.

const EXTRAS = [
  [0x80, 0x20ac], [0x85, 0x2026], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c],
  [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014], [0xa0, 0x00a0],
];

const REPLACEMENT = 0xfffd;
const QUESTION_MARK = 0x3f;

const BYTE_TO_CODE = buildDecodeTable();
const CODE_TO_BYTE = buildEncodeTable(BYTE_TO_CODE);

function buildDecodeTable() {
  const table = new Uint16Array(256).fill(REPLACEMENT);
  for (let b = 0; b < 0x80; b++) table[b] = b;
  for (let b = 0xa1; b <= 0xda; b++) table[b] = b - 0xa1 + 0x0e01;
  for (let b = 0xdf; b <= 0xfb; b++) table[b] = b - 0xdf + 0x0e3f;
  for (const [b, code] of EXTRAS) table[b] = code;
  return table;
}

function buildEncodeTable(decodeTable) {
  const map = new Map();
  for (let b = 0x80; b < 256; b++) {
    if (decodeTable[b] !== REPLACEMENT) map.set(decodeTable[b], b);
  }
  return map;
}

/** Decode Windows-874 bytes to a string; undefined bytes become U+FFFD. */
export function decodeCp874(bytes) {
  const CHUNK = 8192; // keeps String.fromCharCode.apply under the argument limit
  let out = '';
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    const codes = new Uint16Array(end - start);
    for (let i = start; i < end; i++) codes[i - start] = BYTE_TO_CODE[bytes[i]];
    out += String.fromCharCode.apply(null, codes);
  }
  return out;
}

/** Encode a string as Windows-874; characters without a mapping become '?'. */
export function encodeCp874(str) {
  const text = String(str ?? '');
  const out = new Uint8Array(text.length); // never more bytes than UTF-16 units
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out[n++] = code < 0x80 ? code : (CODE_TO_BYTE.get(code) ?? QUESTION_MARK);
  }
  return n === out.length ? out : out.slice(0, n);
}
