import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readXlsx, unzip, writeXlsx, zipStore } from '../lib/xlsx.mjs';

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const text = (bytes) => new TextDecoder().decode(bytes);

/** Walk local file headers independently of the library; returns [{ name, flags, method, crc, data }]. */
function localEntries(bytes) {
  const v = view(bytes);
  const out = [];
  let p = 0;
  while (p + 30 <= bytes.length && v.getUint32(p, true) === 0x04034b50) {
    const flags = v.getUint16(p + 6, true);
    const method = v.getUint16(p + 8, true);
    const crc = v.getUint32(p + 14, true);
    const size = v.getUint32(p + 18, true);
    const nameLength = v.getUint16(p + 26, true);
    const extraLength = v.getUint16(p + 28, true);
    const name = text(bytes.subarray(p + 30, p + 30 + nameLength));
    const start = p + 30 + nameLength + extraLength;
    out.push({ name, flags, method, crc, data: bytes.subarray(start, start + size) });
    p = start + size;
  }
  return out;
}

/** Independent DEFLATE zip writer (node:zlib) to exercise the reader's inflate path. */
function deflateZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const raw = typeof data === 'string' ? enc.encode(data) : data;
    const packed = new Uint8Array(zlib.deflateRawSync(raw));
    const nameBytes = enc.encode(name);
    const crc = zlib.crc32(raw);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = view(local);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const head = new Uint8Array(46 + nameBytes.length);
    const cv = view(head);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    head.set(nameBytes, 46);
    chunks.push(local, packed);
    central.push(head);
    offset += local.length + packed.length;
  }
  const cdSize = central.reduce((s, h) => s + h.length, 0);
  const end = new Uint8Array(22);
  const ev = view(end);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}

const parcels = {
  name: 'ทะเบียนแปลงที่ดิน',
  columns: [
    { header: 'รหัสแปลง', key: 'code' },
    { header: 'ชื่อเจ้าของ', key: 'owner', width: 30 },
    { header: 'เนื้อที่ (ตร.ว.)', key: 'area' },
    { header: 'หมายเหตุ', key: 'note' },
    { header: 'ชำระแล้ว', key: 'paid' },
  ],
  rows: [
    { code: 'P-001', owner: 'นายสมชาย ใจดี', area: 400, note: 'A & B <c> "d" \'e\'', paid: true },
    { code: 'P-002', owner: null, area: 1234.56, note: undefined, paid: false },
    { code: 'P-003', owner: 'บริษัท ก & ข จำกัด', area: -0.5, note: '  leading/trailing  ', paid: null },
    { code: '', owner: 'แถวไม่มีรหัส', area: 0, note: 'บรรทัด 1\nบรรทัด 2' },
  ],
};

const summary = {
  name: 'Summary [2026]?',
  columns: [{ header: 'Item', key: 'k' }, { header: 'Value', key: 'v' }],
  rows: [
    { k: 'literal _x0041_ escape', v: 12345678901234 },
    { k: 'float', v: 0.1 + 0.2 },
    { k: 'tab\there', v: 'ส.ป.ก.4-01 ๑๒๓' },
    {},
    { k: 'after gap', v: -7 },
  ],
};

const expectedParcels = [
  ['รหัสแปลง', 'ชื่อเจ้าของ', 'เนื้อที่ (ตร.ว.)', 'หมายเหตุ', 'ชำระแล้ว'],
  ['P-001', 'นายสมชาย ใจดี', '400', 'A & B <c> "d" \'e\'', 'TRUE'],
  ['P-002', '', '1234.56', '', 'FALSE'],
  ['P-003', 'บริษัท ก & ข จำกัด', '-0.5', '  leading/trailing  ', ''],
  ['', 'แถวไม่มีรหัส', '0', 'บรรทัด 1\nบรรทัด 2', ''],
];

const expectedSummary = [
  ['Item', 'Value'],
  ['literal _x0041_ escape', '12345678901234'],
  ['float', '0.30000000000000004'],
  ['tab\there', 'ส.ป.ก.4-01 ๑๒๓'],
  ['', ''],
  ['after gap', '-7'],
];

test('writeXlsx → readXlsx round trip with Thai text, numbers, gaps and special characters', async () => {
  const bytes = writeXlsx([parcels, summary]);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');

  const sheets = await readXlsx(bytes);
  assert.deepEqual(sheets.map((s) => s.name), ['ทะเบียนแปลงที่ดิน', 'Summary 2026']);
  assert.deepEqual(sheets[0].rows, expectedParcels);
  assert.deepEqual(sheets[1].rows, expectedSummary);
});

test('every local file header CRC matches its data (checked with node:zlib)', () => {
  const bytes = writeXlsx([parcels, summary]);
  const entries = localEntries(bytes);
  assert.deepEqual(entries.map((e) => e.name), [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
  ]);
  for (const entry of entries) {
    assert.equal(entry.method, 0, `${entry.name} stored`);
    assert.equal(entry.crc, zlib.crc32(entry.data), `${entry.name} CRC`);
  }
});

test('workbook parts carry bold header, frozen row, widths, inline strings', () => {
  const entries = Object.fromEntries(localEntries(writeXlsx([parcels, summary])).map((e) => [e.name, text(e.data)]));
  const sheet1 = entries['xl/worksheets/sheet1.xml'];
  assert.match(sheet1, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet1, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">รหัสแปลง<\/t><\/is><\/c>/);
  assert.match(sheet1, /<col min="2" max="2" width="30" customWidth="1"\/>/);
  assert.match(sheet1, /<c r="C2"><v>400<\/v><\/c>/);
  assert.match(sheet1, /<c r="E2" t="b"><v>1<\/v><\/c>/);
  assert.match(sheet1, /A &amp; B &lt;c&gt; &quot;d&quot;/);
  assert.match(sheet1, /<dimension ref="A1:E5"\/>/);
  assert.match(entries['xl/styles.xml'], /<font><b\/>/);
  assert.match(entries['xl/workbook.xml'], /<sheet name="Summary 2026" sheetId="2" r:id="rId2"\/>/);
  assert.match(entries['xl/worksheets/sheet2.xml'], /literal _x005F_x0041_ escape/);
  assert.match(entries['[Content_Types].xml'], /\/xl\/worksheets\/sheet2\.xml/);
});

test('sheet names are cleaned, truncated to 31 chars and unique', async () => {
  const sheets = [
    { name: 'Data', rows: [] },
    { name: 'data', rows: [] },
    { name: 'x'.repeat(40), rows: [] },
    { name: 'x'.repeat(40), rows: [] },
    { name: 'History', rows: [] },
    { name: '[]:*?/\\', rows: [] },
    { name: "'quoted'", rows: [] },
  ];
  const names = (await readXlsx(writeXlsx(sheets))).map((s) => s.name);
  assert.deepEqual(names, [
    'Data', 'data (2)', 'x'.repeat(31), `${'x'.repeat(27)} (2)`, 'History (2)', 'Sheet6', 'quoted',
  ]);
  assert.ok(names.every((n) => n.length <= 31));
});

test('columns are derived from row keys when not given; empty workbook gets one sheet', async () => {
  const [sheet] = await readXlsx(writeXlsx([{ name: 'auto', rows: [{ a: 1, b: 'x' }, { c: true }] }]));
  assert.deepEqual(sheet.rows, [['a', 'b', 'c'], ['1', 'x', ''], ['', '', 'TRUE']]);
  const empty = await readXlsx(writeXlsx([]));
  assert.deepEqual(empty, [{ name: 'Sheet1', rows: [] }]);
});

test('readXlsx handles DEFLATE entries (re-zipped output)', async () => {
  const stored = writeXlsx([parcels, summary]);
  const deflated = deflateZip(await unzip(stored));
  assert.ok(localEntries(deflated).every((e) => e.method === 8));
  const sheets = await readXlsx(deflated);
  assert.deepEqual(sheets.map((s) => s.rows), [expectedParcels, expectedSummary]);
});

test('readXlsx: shared strings with rich text, prefixes, absolute targets, gaps by cell reference', async () => {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const files = [
    { name: '_rels/.rels', data: `<Relationships xmlns="${pkg}"><Relationship Id="r1" Type="${rel}/officeDocument" Target="/xl/workbook.xml"/></Relationships>` },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0"?><x:workbook xmlns:x="${main}" xmlns:r="${rel}"><x:sheets>`
        + '<x:sheet name="ข้อมูล &amp; สรุป" sheetId="1" r:id="rId3"/>'
        + '<x:sheet name="Empty" sheetId="2" r:id="rId4"/></x:sheets></x:workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<Relationships xmlns="${pkg}">`
        + `<Relationship Id="rId3" Type="${rel}/worksheet" Target="worksheets/data.xml"/>`
        + `<Relationship Id="rId4" Type="${rel}/worksheet" Target="/xl/worksheets/empty.xml"/>`
        + `<Relationship Id="rId9" Type="${rel}/sharedStrings" Target="strings.xml"/></Relationships>`,
    },
    {
      name: 'xl/strings.xml',
      data: `<sst xmlns="${main}" count="5" uniqueCount="5">`
        + '<si><t>plain</t></si>'
        + '<si><r><rPr><b/><rFont val="Tahoma"/></rPr><t>ที่</t></r><r><t xml:space="preserve">ดิน 1 </t></r></si>'
        + '<si><t>漢</t><rPh sb="0" eb="1"><t>かん</t></rPh><phoneticPr fontId="1"/></si>'
        + '<si><t>a&lt;b&gt;&amp;&quot;c&apos;&#3585;&#x0E02;</t></si>'
        + '<si><t>_x0041_x_x005F_x0042_</t></si></sst>',
    },
    {
      name: 'xl/worksheets/data.xml',
      data: `<worksheet xmlns="${main}"><sheetData>`
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
        + '<row r="2"><c r="B2" s="3"><v>3.5</v></c><c r="D2" t="str"><f>A1&amp;"x"</f><v>plainx</v></c><c r="E2" t="e"><v>#DIV/0!</v></c></row>'
        + '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="b"><v>0</v></c><c r="C3" s="2"/></row>'
        + '<row r="4"><c t="s"><v>2</v></c><c><v>7</v></c><c t="s"><v>3</v></c><c t="s"><v>4</v></c></row>'
        + '<row r="12"><c r="AB12" t="inlineStr"><is><r><t>fa</t></r><r><t>r</t></r></is></c></row>'
        + '<row r="13" customHeight="1"/>'
        + '</sheetData></worksheet>',
    },
    { name: 'xl/worksheets/empty.xml', data: `<worksheet xmlns="${main}"><sheetData/></worksheet>` },
  ];
  const sheets = await readXlsx(deflateZip(files));
  assert.deepEqual(sheets.map((s) => s.name), ['ข้อมูล & สรุป', 'Empty']);
  assert.deepEqual(sheets[1].rows, []);

  const rows = sheets[0].rows;
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r) => r.length === 28)); // A..AB
  assert.deepEqual(rows[0].slice(0, 4), ['plain', '', 'ที่ดิน 1 ', '']);
  assert.deepEqual(rows[1].slice(0, 5), ['', '3.5', '', 'plainx', '#DIV/0!']);
  assert.deepEqual(rows[2].slice(0, 3), ['TRUE', 'FALSE', '']);
  assert.deepEqual(rows[3].slice(0, 4), ['漢', '7', 'a<b>&"c\'กข', 'Ax_x0042_']);
  assert.ok(rows.slice(4, 11).every((r) => r.every((c) => c === '')));
  assert.equal(rows[11][27], 'far');
});

test('zipStore → unzip round trip with Thai file names and the UTF-8 name flag', async () => {
  const binary = new Uint8Array(300).map((_, i) => (i * 7) & 0xff);
  const entries = [
    { name: 'ข้อมูล/แปลงที่ดิน.txt', data: 'โฉนด ๑๒๓\nline 2' },
    { name: 'bin/data.bin', data: binary },
    { name: 'empty.txt', data: '' },
  ];
  const zip = zipStore(entries);
  assert.equal(String.fromCharCode(zip[0], zip[1]), 'PK');

  const local = localEntries(zip);
  assert.deepEqual(local.map((e) => e.name), entries.map((e) => e.name));
  for (const e of local) {
    assert.equal(e.flags & 0x0800, 0x0800, `${e.name} has the UTF-8 flag`);
    assert.equal(e.crc, zlib.crc32(e.data));
  }

  const back = await unzip(zip);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  assert.equal(text(back[0].data), entries[0].data);
  assert.deepEqual(back[1].data, binary);
  assert.equal(back[2].data.length, 0);

  // and the DEFLATE path of unzip
  const inflated = await unzip(deflateZip(entries));
  assert.deepEqual(inflated.map((e) => text(e.data)), back.map((e) => text(e.data)));
});
