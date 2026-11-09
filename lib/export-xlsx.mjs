// Excel export. The registry sheets use the same headers as the LTAX ONLINE export
// (owner, land, land_detail, building, building_detail, sign) so the file can be imported again.
import { ENTITIES, label, DOC_TYPES, UTM_SHEETS, LAND_USE_TYPES, LAND_USED_FOR, AGRI_TYPES, STRUCTURES,
  BUILDING_USE_TYPES, BUILDING_USED_FOR, PERSON_TYPES, buildingTypeLabel } from '../public/shared/schema.mjs';
import { toWah, formatRNW } from '../public/shared/calc.mjs';

const cols = list => list.map(([header, key, width = 14]) => ({ header, key, width }));
const n = v => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? v ?? '' : Number(v));
const PENDING = { create: 'ยังไม่มีใน LTAX', update: 'แก้ไขแล้ว รอส่ง' };

export function buildWorkbook(db, { issues = [], changes = [], join = {}, overlay = { rows: [] }, checks = [] } = {}) {
  const owners = new Map(db.owners.map(o => [o.id, o]));
  const lands = new Map(db.lands.map(l => [l.id, l]));
  const ownerName = o => (o ? [o.prefixName, o.firstName, o.lastName].filter(Boolean).join(' ') : '');
  const ownerNames = ids => (ids || []).map(id => ownerName(owners.get(id))).filter(Boolean).join(', ');
  const titleOf = (entity, id) => { const r = (db[entity] || []).find(x => x.id === id); return r ? ENTITIES[entity].title(r) : ''; };

  const owner = db.owners.map(o => ({
    ltaxId: o.ltaxId || '', type: String(PERSON_TYPES.findIndex(([v]) => v === o.personType) + 1 || ''), prefix: o.prefixName, first: o.firstName, last: o.lastName,
    reg4: o.assetReg4, no: o.addrNo, moo: o.addrVillage, soi: o.addrAlley, road: o.addrRoad, tambon: o.addrDistrict, amphoe: o.addrAmphur,
    province: o.addrProvince, post: o.postalCode, psn: o.psnId, pending: PENDING[o.pending] || '',
  }));

  const land = [], landDetail = [];
  for (const l of db.lands) {
    const names = (l.ownerIds || []).map(id => ownerName(owners.get(id))).filter(Boolean);
    const base = {
      group: l.landGroup, code: l.parcelCode, doc: label(DOC_TYPES, l.docType), docNo: l.docNo,
      rawang: [l.utm1, label(UTM_SHEETS, l.utm2), l.utm3, l.utm4 && `-${l.utm4}`].filter(Boolean).join('').replace(/^(\d+)/, '$1'),
      utm1: l.utm1, utm2: label(UTM_SHEETS, l.utm2), utm3: l.utm3, utm4: l.utm4, scale: l.scale, landNo: l.parcelNo, survey: l.dealingFileNo,
      volume: l.volume, page: l.page, road: l.road, soi: l.alley, moo: l.villageNo, amphoe: l.amphur, tambon: l.district,
      rai: n(l.rai), ngan: n(l.ngan), wah: n(l.wah), total: toWah(l.rai, l.ngan, l.wah), price: n(l.pricePerWah),
      value: l.pricePerWah ? Math.round(toWah(l.rai, l.ngan, l.wah) * Number(l.pricePerWah) * 100) / 100 : '', ltaxId: l.ltaxId || '', pending: PENDING[l.pending] || '',
    };
    for (const name of names.length ? names : ['']) land.push({ ...base, owner: name });
    (l.uses || []).forEach((u, i) => landDetail.push({
      ltaxId: l.ltaxId || '', code: l.parcelCode, landNo: l.parcelNo, moo: l.villageNo, rai: n(l.rai), ngan: n(l.ngan), wah: n(l.wah), order: i + 1,
      use: label(LAND_USE_TYPES, u.usedType), area: formatRNW(u.rai, u.ngan, u.wah), usedFor: label(LAND_USED_FOR, u.usedFor), usedBy: u.usedBy,
      agri: label(AGRI_TYPES, u.agriType), note: u.note, owner: names.join(', '),
    }));
  }

  const building = [], buildingDetail = [];
  for (const b of db.buildings) {
    const l = lands.get((b.landIds || [])[0]);
    const o = owners.get((b.ownerIds || [])[0]);
    building.push({
      code: b.buildingCode, no: b.addrNo, moo: b.villageNo, village: b.villageName, road: b.road, soi: b.alley, type: buildingTypeLabel(b.buildingType),
      struct: label(STRUCTURES, b.structure), floors: n(b.noFloor), width: n(b.width), length: n(b.length), age: n(b.age), since: n(b.since),
      area: n(b.totalArea), price: n(b.pricePerMeter), ltaxId: b.ltaxId || '', landLtax: l?.ltaxId || '', ownerLtax: o?.ltaxId || '', parcel: l?.parcelCode || '',
      note: b.note, owner: ownerNames(b.ownerIds), psn: o?.psnId || '', typeCode: b.buildingType, pending: PENDING[b.pending] || '',
    });
    (b.uses || []).forEach((u, i) => buildingDetail.push({
      ltaxId: b.ltaxId || '', code: b.buildingCode, parcel: l?.parcelCode || '', typeCode: b.buildingType, type: buildingTypeLabel(b.buildingType),
      order: i + 1, floor: u.useFloor, use: label(BUILDING_USE_TYPES, u.usedType), area: n(u.area), full: u.fullArea ? 'ใช่' : '',
      usedFor: label(BUILDING_USED_FOR, u.usedFor), note: u.note, owner: ownerNames(b.ownerIds),
    }));
  }

  const sign = db.signboards.map(s => ({
    ltaxId: s.ltaxId || '', code: s.signboardCode, text: s.signboardName, setup: s.setupDate, no: s.addrNo, moo: s.villageNo, soi: s.alley, road: s.road,
    village: s.villageName, width: n(s.width), height: n(s.height), sides: n(s.noSide), units: n(s.unit), parcel: s.landCode || '', owner: ownerNames(s.ownerIds),
    pending: PENDING[s.pending] || '',
  }));

  const sheets = [
    { name: 'owner', columns: cols([['รหัสเจ้าของ', 'ltaxId', 12], ['ประเภทบุคคล(รหัส)', 'type', 10], ['คำนำหน้าชื่อ', 'prefix', 10], ['ชื่อ', 'first', 18], ['นามสกุล', 'last', 18],
      ['ถอดรหัสชื่อ ผ.ท.4', 'reg4'], ['บ้านเลขที่', 'no', 10], ['หมู่', 'moo', 6], ['ซอย', 'soi'], ['ถนน', 'road'], ['ตำบล', 'tambon'], ['อำเภอ', 'amphoe'],
      ['จังหวัด', 'province'], ['รหัสไปรษณีย์', 'post', 10], ['เลขบัตรปชช.', 'psn', 16], ['สถานะใน L-LAN', 'pending', 18]]), rows: owner },
    { name: 'land', columns: cols([['รหัสกลุ่มที่ดิน', 'group'], ['รหัสแปลงที่ดิน', 'code'], ['ประเภทเอกสารสิทธิ์', 'doc'], ['เลขที่เอกสารสิทธิ์', 'docNo'], ['ระวางที่ดิน', 'rawang', 18],
      ['ระวาง', 'utm1', 8], ['แผนที่ระวางภูมิประเทศ', 'utm2', 8], ['ระวางUTM', 'utm3', 8], ['แผ่นที่ระวางUTM', 'utm4', 8], ['มาตราส่วน', 'scale', 8], ['เลขที่ดิน', 'landNo', 8],
      ['หน้าสำรวจ', 'survey', 10], ['เล่มที่', 'volume', 8], ['หน้าที่', 'page', 8], ['ถนน', 'road'], ['ซอย', 'soi'], ['หมู่ที่', 'moo', 6], ['อำเภอ', 'amphoe'], ['ตำบล', 'tambon'],
      ['เนื้อที่ (ไร่)', 'rai', 8], ['เนื้อที่ (งาน)', 'ngan', 8], ['เนื้อที่ (ตร.ว.)', 'wah', 8], ['รวมเนื้อที่ทั้งหมด (ตร.ว.)', 'total'], ['ราคาประเมินที่ดินต่อ ตร.ว.', 'price'],
      ['รวมราคาประเมินที่ดิน (บาท)', 'value'], ['รหัสที่ดิน', 'ltaxId', 12], ['เจ้าของ', 'owner', 28], ['สถานะใน L-LAN', 'pending', 18]]), rows: land },
    { name: 'land_detail', columns: cols([['รหัสที่ดิน', 'ltaxId', 12], ['รหัสแปลง', 'code'], ['เลขที่ดิน', 'landNo', 8], ['หมู่', 'moo', 6], ['ไร่', 'rai', 6], ['งาน', 'ngan', 6],
      ['ตร.วา', 'wah', 8], ['ลำดับการใช้', 'order', 8], ['การใช้ประโยชน์', 'use', 40], ['เนื้อที่ใช้(ร-ง-ว)', 'area'], ['ลักษณะการทำประโยชน์', 'usedFor'],
      ['ผู้ใช้ประโยชน์', 'usedBy', 24], ['การเกษตรที่ทำ', 'agri'], ['หมายเหตุการใช้', 'note', 24], ['เจ้าของ', 'owner', 28]]), rows: landDetail },
    { name: 'building', columns: cols([['รหัสสิ่งปลูกสร้าง', 'code'], ['เลขที่', 'no', 8], ['หมู่ที่', 'moo', 6], ['หมู่บ้าน/ชุนชน', 'village'], ['ถนน', 'road'], ['ซอย', 'soi'],
      ['ประเภทสิ่งปลูกสร้าง', 'type', 34], ['ลักษณะสิ่งปลูกสร้าง', 'struct'], ['จำนวนชั้น', 'floors', 8], ['ขนาดพื้นที่ กว้าง (เมตร)', 'width', 10], ['ขนาดพื้นที่ ยาว (เมตร)', 'length', 10],
      ['อายุสิ่งปลูกสร้าง (ปี)', 'age', 8], ['ก่อสร้างแล้วเสร็จ ปี พ.ศ.', 'since', 10], ['ขนาดพื้นที่ทั้งอาคาร (ตร.ม.)', 'area', 12],
      ['ราคาประเมินสิ่งปลูกสร้าง (บาท ต่อ ตร.ม.)', 'price', 12], ['รหัสอาคาร', 'ltaxId', 12], ['รหัสที่ดิน', 'landLtax', 12], ['รหัสเจ้าของ', 'ownerLtax', 12],
      ['รหัสแปลง', 'parcel'], ['หมายเหตุ', 'note', 24], ['เจ้าของ', 'owner', 28], ['เลขบัตรปชช.', 'psn', 16], ['รหัสประเภทอาคาร', 'typeCode', 8], ['สถานะใน L-LAN', 'pending', 18]]), rows: building },
    { name: 'building_detail', columns: cols([['รหัสอาคาร', 'ltaxId', 12], ['รหัสอาคาร(เต็ม)', 'code'], ['รหัสแปลง', 'parcel'], ['รหัสประเภทอาคาร', 'typeCode', 8], ['ประเภทอาคาร', 'type', 34],
      ['ลำดับการใช้', 'order', 8], ['ชั้นที่ใช้', 'floor', 8], ['การใช้ประโยชน์', 'use', 40], ['พื้นที่ใช้', 'area', 10], ['เต็มพื้นที่ทุกชั้น', 'full', 8],
      ['ลักษณะการใช้', 'usedFor'], ['หมายเหตุการใช้', 'note', 24], ['เจ้าของ', 'owner', 28]]), rows: buildingDetail },
    { name: 'sign', columns: cols([['รหัสป้าย', 'ltaxId', 12], ['รหัสป้าย(เต็ม)', 'code'], ['ข้อความในป้าย', 'text', 30], ['วันที่ติดตั้งป้าย', 'setup'], ['บ้านเลขที่', 'no', 8],
      ['หมู่', 'moo', 6], ['ซอย', 'soi'], ['ถนน', 'road'], ['ชุมชน', 'village'], ['ความกว้างป้าย (ซม.)', 'width', 10], ['ความยาวป้าย (ซม.)', 'height', 10], ['จำนวนด้าน', 'sides', 8],
      ['จำนวนหน่วย', 'units', 8], ['รหัสแปลง', 'parcel'], ['เจ้าของ', 'owner', 28], ['สถานะใน L-LAN', 'pending', 18]]), rows: sign },
    { name: 'ผลตรวจสอบ', columns: cols([['ระดับ', 'level', 8], ['ประเภท', 'entity', 14], ['รายการ', 'title', 22], ['ช่อง', 'field', 18], ['รายละเอียด', 'message', 80]]),
      rows: issues.map(i => ({ level: i.level === 'error' ? 'ผิดพลาด' : 'เตือน', entity: ENTITIES[i.entity]?.th || 'รูปแปลง', title: ENTITIES[i.entity] ? titleOf(i.entity, i.id) : (db.features || []).find(f => f.id === i.id)?.code || '', field: i.field, message: i.message })) },
    { name: 'รอส่ง LTAX', columns: cols([['ประเภท', 'entityTh', 14], ['รายการ', 'title', 22], ['ต้องทำ', 'action', 14], ['ช่องที่แก้ (ค่าใน LTAX → ค่าใหม่)', 'detail', 90]]),
      rows: changes.map(c => ({ ...c, action: c.action === 'create' ? 'เพิ่มใหม่' : 'แก้ไข', detail: c.changes.map(x => `${x.th}: ${x.before || '-'} → ${x.after || '-'}`).join('\n') })) },
  ];
  for (const [kind, th] of [['parcel', 'รูปแปลงที่ดิน'], ['building', 'รูปสิ่งปลูกสร้าง']]) {
    const j = join[kind];
    if (!j) continue;
    sheets.push({ name: `จอย_${th}`, columns: cols([['FID', 'fid', 8], ['รหัส', 'code'], ['สถานะ', 'status'], ['หมายเหตุ', 'note', 30]]), rows: j.features });
    sheets.push({ name: `ไม่มีรูป_${th}`, columns: cols([['รหัสในทะเบียน', 'code']]), rows: j.recordsWithoutShape });
  }
  if (checks.length) sheets.push({ name: 'ตรวจกับ LTAX', columns: cols([['ชนิด', 'kind', 12], ['รหัส', 'code'], ['ผล', 'result', 16], ['จำนวนที่พบ', 'count', 10], ['ตรวจเมื่อ', 'at', 22]]),
    rows: checks.map(c => ({ kind: c.kind === 'building' ? 'สิ่งปลูกสร้าง' : 'แปลงที่ดิน', code: c.code, result: c.found ? (c.count > 1 ? 'พบซ้ำ' : 'พบใน LTAX') : 'ไม่พบใน LTAX', count: c.count, at: c.at })) });
  if (overlay.rows.length) sheets.push({ name: 'ซ้อนทับ_อาคาร_แปลง', columns: cols([['FID', 'fid', 8], ['รหัสอาคาร', 'code'], ['แปลงตามรหัส', 'expectedParcel'], ['แปลงที่ตั้งจริง', 'foundParcels'], ['ผลตรวจ', 'result', 22], ['ลองจิจูด', 'lon'], ['ละติจูด', 'lat']]), rows: overlay.rows });
  return sheets;
}
