// Minimal .xlsx writer (pure JS, browser-safe) and reader (Node, or browsers with DecompressionStream).
// Includes a STORE-only ZIP writer and a ZIP reader (STORE + DEFLATE).

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const MAX_ROWS = 1048576;
const MAX_COLS = 16384;
const MAX_CELL_CHARS = 32767;
const MAX_SHEET_NAME = 31;

// ---------------------------------------------------------------- ZIP

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Expected Uint8Array or ArrayBuffer');
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a ZIP archive without compression.
 * @param {{name: string, data: Uint8Array|string}[]} entries strings are stored as UTF-8
 * @returns {Uint8Array}
 */
export function zipStore(entries) {
  const UTF8_NAMES = 0x0800; // general purpose bit 11
  const { time, date } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8Encoder.encode(String(entry.name).replace(/\\/g, '/'));
    const data = typeof entry.data === 'string' ? utf8Encoder.encode(entry.data) : toBytes(entry.data);
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = viewOf(local);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, UTF8_NAMES, true);
    lv.setUint16(8, 0, true); // STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const cv = viewOf(header);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, UTF8_NAMES, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    header.set(name, 46);

    parts.push(local, data);
    central.push(header);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, h) => sum + h.length, 0);
  const end = new Uint8Array(22);
  const ev = viewOf(end);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let p = 0;
  for (const chunk of [...parts, ...central, end]) {
    out.set(chunk, p);
    p += chunk.length;
  }
  return out;
}

function readZipDirectory(bytes) {
  const view = viewOf(bytes);
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 0xffff); p--) {
    if (view.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file: end of central directory not found');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    let compressedSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    let localOffset = view.getUint32(p + 42, true);
    // Names are decoded as UTF-8 whether or not bit 11 is set (CP437 names are not supported).
    const name = utf8Decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)).replace(/\\/g, '/');

    // ZIP64 extra field: only the values saturated at 0xFFFFFFFF are present, in this order.
    for (let q = p + 46 + nameLength, end = q + extraLength; q + 4 <= end;) {
      const id = view.getUint16(q, true);
      const length = view.getUint16(q + 2, true);
      if (id === 0x0001) {
        let r = q + 4;
        const next = () => { const v = Number(view.getBigUint64(r, true)); r += 8; return v; };
        if (size === 0xffffffff) size = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (localOffset === 0xffffffff) localOffset = next();
      }
      q += 4 + length;
    }
    entries.push({ name, flags, method, compressedSize, size, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function rawEntryData(bytes, entry) {
  const view = viewOf(bytes);
  const p = entry.localOffset;
  if (view.getUint32(p, true) !== 0x04034b50) throw new Error(`Corrupt ZIP local header for ${entry.name}`);
  if (entry.flags & 1) throw new Error(`Encrypted ZIP entry not supported: ${entry.name}`);
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  return bytes.subarray(start, start + entry.compressedSize);
}

let inflaterPromise = null;

function loadInflater() {
  inflaterPromise ??= (async () => {
    try {
      const { inflateRawSync } = await import('node:zlib');
      return async (data) => {
        const out = inflateRawSync(data);
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
      };
    } catch {
      if (typeof DecompressionStream !== 'function') throw new Error('No DEFLATE support in this environment');
      return async (data) => {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      };
    }
  })();
  return inflaterPromise;
}

async function entryData(bytes, entry) {
  const raw = rawEntryData(bytes, entry);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return (await loadInflater())(raw);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/**
 * Extract every file entry of a ZIP archive (STORE and DEFLATE).
 * @returns {Promise<{name: string, data: Uint8Array}[]>}
 */
export async function unzip(bytes) {
  const data = toBytes(bytes);
  const out = [];
  for (const entry of readZipDirectory(data)) {
    if (entry.name.endsWith('/')) continue; // directory
    out.push({ name: entry.name, data: await entryData(data, entry) });
  }
  return out;
}

// ---------------------------------------------------------------- XML helpers

// Characters XML 1.0 cannot carry at all (control chars, lone surrogates, U+FFFE/U+FFFF).
const INVALID_XML_CHARS = /[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu;

function escapeXml(text) {
  return String(text)
    .replace(INVALID_XML_CHARS, '')
    .replace(/[&<>"\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': '&#13;' })[c]);
}

// Excel reads "_xHHHH_" as an escaped character, so a literal one needs its "_" escaped.
function escapeCellText(text) {
  return escapeXml(text).replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_');
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function codePointText(code) {
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
}

function decodeEntities(text) {
  return text
    .replace(/\r\n?/g, '\n') // XML end-of-line normalisation
    .replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (m, hex, dec, name) =>
      hex ? codePointText(parseInt(hex, 16)) : dec ? codePointText(parseInt(dec, 10)) : NAMED_ENTITIES[name]);
}

function unescapeExcel(text) {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseAttrs(source) {
  const attrs = {};
  for (const m of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3]);
  }
  return attrs;
}

/** Regex for an element (optionally namespace-prefixed): group 1 = attributes, group 2 = inner XML. */
function elementRegex(tag) {
  return new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>)`, 'g');
}

const RE_ROW = elementRegex('row');
const RE_CELL = elementRegex('c');
const RE_SI = elementRegex('si');
const RE_T = elementRegex('t');
const RE_RPH = elementRegex('rPh');
const RE_SHEET_DATA = elementRegex('sheetData');
const RE_V = elementRegex('v');
const RE_IS = elementRegex('is');
const RE_SHEET = /<(?:[\w.-]+:)?sheet\b([^>]*?)\/?>/g;
const RE_RELATIONSHIP = /<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?>/g;

function firstMatch(regex, text) {
  regex.lastIndex = 0;
  const m = regex.exec(text);
  regex.lastIndex = 0;
  return m;
}

// ---------------------------------------------------------------- writing

function columnLetter(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function truncateUnits(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Excel rules: max 31 chars, none of []:*?/\, no leading/trailing apostrophe, unique ignoring case. */
function sheetNames(sheets) {
  const used = new Set(['history']); // reserved by Excel
  return sheets.map((sheet, i) => {
    let base = String(sheet?.name ?? '')
      .replace(/[[\]:*?/\\]/g, '')
      .replace(INVALID_XML_CHARS, '')
      .trim()
      .replace(/^'+|'+$/g, '');
    base = truncateUnits(base || `Sheet${i + 1}`, MAX_SHEET_NAME);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = truncateUnits(base, MAX_SHEET_NAME - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function localDateText(date) {
  if (Number.isNaN(date.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  const time = `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  return time === '00:00:00' ? day : `${day} ${time}`;
}

function cellText(value) {
  if (value instanceof Date) return localDateText(value);
  return String(value);
}

// Thai above/below marks take no horizontal space.
const ZERO_WIDTH_THAI = /[ัิ-ฺ็-๎]/g;

function displayWidth(text) {
  let widest = 0;
  for (const line of text.split('\n')) widest = Math.max(widest, line.replace(ZERO_WIDTH_THAI, '').length);
  return widest;
}

function columnWidth(column, rows) {
  const given = Number(column.width);
  if (Number.isFinite(given) && given > 0) return Math.min(255, given);
  let widest = displayWidth(String(column.header ?? column.key ?? '')) + 1; // header is bold
  for (const row of rows) {
    const value = row?.[column.key];
    if (value !== null && value !== undefined) widest = Math.max(widest, displayWidth(cellText(value)));
  }
  return Math.min(60, Math.max(8, widest + 2));
}

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : '';
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = truncateUnits(cellText(value), MAX_CELL_CHARS);
  if (text === '') return '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeCellText(text)}</t></is></c>`;
}

function deriveColumns(rows) {
  const keys = new Set();
  for (const row of rows) if (row && typeof row === 'object') for (const key of Object.keys(row)) keys.add(key);
  return [...keys].map((key) => ({ header: key, key }));
}

function worksheetXml(sheet, isFirst) {
  const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
  const columns = Array.isArray(sheet?.columns) ? sheet.columns : deriveColumns(rows);
  if (columns.length > MAX_COLS) throw new RangeError(`Too many columns (${columns.length}) for one sheet`);
  if (rows.length + 1 > MAX_ROWS) throw new RangeError(`Too many rows (${rows.length}) for one sheet`);
  const letters = columns.map((_, i) => columnLetter(i));

  const body = [];
  const header = columns.map((col, i) => cellXml(`${letters[i]}1`, String(col.header ?? col.key ?? ''), col.headerStyle ?? 1)).join('');
  if (header) body.push(`<row r="1">${header}</row>`);
  rows.forEach((row, r) => {
    const n = r + 2;
    const cells = columns.map((col, i) => cellXml(`${letters[i]}${n}`, row?.[col.key], col.style)).join('');
    if (cells) body.push(`<row r="${n}">${cells}</row>`);
  });
  // Drop-down lists: { key, formula } → the column's cells from row 2 down to a few thousand rows past the data.
  const lastRow = Math.min(MAX_ROWS, rows.length + 5000);
  const validations = (Array.isArray(sheet?.validations) ? sheet.validations : [])
    .map(v => ({ ...v, i: columns.findIndex(c => c.key === v.key) })).filter(v => v.i >= 0 && v.formula);
  const dataValidations = validations.length
    ? `<dataValidations count="${validations.length}">${validations.map(v => `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="${v.strict ? 1 : 0}"`
      + `${v.prompt ? ` promptTitle="${escapeXml(truncateUnits(v.promptTitle || '', 32))}" prompt="${escapeXml(truncateUnits(v.prompt, 250))}"` : ''} sqref="${letters[v.i]}2:${letters[v.i]}${lastRow}">`
      + `<formula1>${escapeXml(v.formula)}</formula1></dataValidation>`).join('')}</dataValidations>`
    : '';

  const lastRef = columns.length ? `${letters[letters.length - 1]}${rows.length + 1}` : 'A1';
  const cols = columns.length
    ? `<cols>${columns.map((col, i) => `<col min="${i + 1}" max="${i + 1}" width="${columnWidth(col, rows)}"${col.style ? ` style="${col.style}"` : ''} customWidth="1"/>`).join('')}</cols>`
    : '';
  const view = `<sheetView${isFirst ? ' tabSelected="1"' : ''} workbookViewId="0">`
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>';

  return `${XML_DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + `<dimension ref="${lastRef === 'A1' ? 'A1' : `A1:${lastRef}`}"/>`
    + `<sheetViews>${view}</sheetViews>`
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + cols
    + `<sheetData>${body.join('')}</sheetData>`
    + dataValidations
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    + '</worksheet>';
}

const STYLES_XML = `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">`
  + '<fonts count="3">'
  + '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/><family val="2"/></font>'
  + '</fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  // 0 normal · 1 bold header · 2 bold red header (required) · 3 text · 4 grey text (read only) · 5 bold header on grey
  + '<cellXfs count="6">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="49" fontId="0" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/**
 * Build an .xlsx workbook.
 * @param {{name: string, columns?: {header: string, key: string, width?: number}[], rows: object[]}[]} sheets
 * @returns {Uint8Array}
 */
export const XLSX_STYLE = { header: 1, required: 2, text: 3, readOnly: 4, readOnlyHeader: 5 };
export function writeXlsx(sheets) {
  const list = Array.isArray(sheets) && sheets.length ? sheets : [{ name: 'Sheet1', columns: [], rows: [] }];
  const names = sheetNames(list);
  const n = list.length;

  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>';

  const rootRels = `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">`
    + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
    + '</Relationships>';

  const workbook = `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + '<bookViews><workbookView activeTab="0"/></bookViews><sheets>'
    + names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>';

  const workbookRels = `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">`
    + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${n + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`
    + '</Relationships>';

  return zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...list.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: worksheetXml(sheet, i === 0) })),
  ]);
}

// ---------------------------------------------------------------- reading

function resolvePath(baseDir, target) {
  const joined = target.startsWith('/') ? target.slice(1) : baseDir + target;
  const out = [];
  for (const seg of joined.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

function relsPathFor(partPath) {
  const dir = dirOf(partPath);
  return `${dir}_rels/${partPath.slice(dir.length)}.rels`;
}

function parseRels(xml, baseDir) {
  const rels = [];
  for (const m of (xml ?? '').matchAll(RE_RELATIONSHIP)) {
    const a = parseAttrs(m[1]);
    if (!a.Id || !a.Target || a.TargetMode === 'External') continue;
    rels.push({ id: a.Id, type: a.Type ?? '', target: resolvePath(baseDir, a.Target) });
  }
  return rels;
}

/** Concatenated <t> text of a shared-string item or inline string, without phonetic runs. */
function richText(xml) {
  let text = '';
  for (const m of xml.replace(RE_RPH, '').matchAll(RE_T)) text += m[2] ?? '';
  return unescapeExcel(decodeEntities(text));
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(RE_SI)].map((m) => richText(m[2] ?? ''));
}

function parseRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref ?? '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

function cellValue(type, inner, shared) {
  if (type === 'inlineStr') {
    const is = firstMatch(RE_IS, inner);
    if (is) return richText(is[2] ?? '');
  }
  const v = firstMatch(RE_V, inner);
  const raw = v ? decodeEntities(v[2] ?? '') : '';
  switch (type) {
    case 's': return raw === '' ? '' : shared[parseInt(raw, 10)] ?? '';
    case 'b': return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    case 'str':
    case 'inlineStr': return unescapeExcel(raw);
    default: return raw; // numbers (raw text), errors, ISO dates
  }
}

/** Sheet XML → rectangular string grid, trimmed after the last non-empty row and column. */
function parseSheet(xml, shared) {
  const grid = [];
  let width = 0;
  const sheetData = firstMatch(RE_SHEET_DATA, xml);
  let rowIndex = -1;
  for (const rm of (sheetData?.[2] ?? '').matchAll(RE_ROW)) {
    const rowAttrs = parseAttrs(rm[1]);
    rowIndex = rowAttrs.r ? parseInt(rowAttrs.r, 10) - 1 : rowIndex + 1;
    let col = -1;
    for (const cm of (rm[2] ?? '').matchAll(RE_CELL)) {
      const attrs = parseAttrs(cm[1]);
      const ref = parseRef(attrs.r);
      col = ref ? ref.col : col + 1;
      const row = ref ? ref.row : rowIndex;
      const value = cellValue(attrs.t, cm[2] ?? '', shared);
      if (value === '') continue;
      (grid[row] ??= [])[col] = value;
      width = Math.max(width, col + 1);
    }
  }
  const rows = [];
  for (let r = 0; r < grid.length; r++) {
    const source = grid[r] ?? [];
    const row = new Array(width);
    for (let c = 0; c < width; c++) row[c] = source[c] ?? '';
    rows.push(row);
  }
  return rows;
}

/**
 * Read every sheet of an .xlsx file as strings. Async because DEFLATE support is loaded lazily.
 * @returns {Promise<{name: string, rows: string[][]}[]>}
 */
export async function readXlsx(bytes) {
  const data = toBytes(bytes);
  const entries = new Map();
  for (const entry of readZipDirectory(data)) {
    entries.set(entry.name, entry);
    if (!entries.has(entry.name.toLowerCase())) entries.set(entry.name.toLowerCase(), entry);
  }
  const readText = async (path) => {
    const entry = entries.get(path) ?? entries.get(path.toLowerCase());
    return entry ? utf8Decoder.decode(await entryData(data, entry)).replace(/^﻿/, '') : null;
  };

  const rootRels = parseRels(await readText('_rels/.rels'), '');
  const workbookPath = rootRels.find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
  const workbookXml = await readText(workbookPath);
  if (workbookXml === null) throw new Error('Not an .xlsx file: workbook part not found');

  const workbookRels = parseRels(await readText(relsPathFor(workbookPath)), dirOf(workbookPath));
  const relById = new Map(workbookRels.map((r) => [r.id, r]));
  const sharedRel = workbookRels.find((r) => r.type.endsWith('/sharedStrings'));
  const sharedXml = await readText(sharedRel ? sharedRel.target : `${dirOf(workbookPath)}sharedStrings.xml`);
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];

  const sheets = [];
  for (const m of workbookXml.matchAll(RE_SHEET)) {
    const attrs = parseAttrs(m[1]);
    const relId = Object.entries(attrs).find(([key]) => key.endsWith(':id'))?.[1];
    const rel = relById.get(relId);
    const xml = rel ? await readText(rel.target) : null;
    sheets.push({ name: attrs.name ?? '', rows: xml ? parseSheet(xml, shared) : [] });
  }
  return sheets;
}
