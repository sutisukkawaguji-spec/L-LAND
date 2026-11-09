// Code lists and record shapes taken from the LTAX ONLINE forms (AST001), 2026-11-09.
// Shared by the browser and the server. LTAX option values are kept where they are known;
// the LTAX engine selects options by label, so a label must match LTAX text exactly.

export const DOC_TYPES = [
  ['1', 'โฉนด'], ['2', 'น.ส.3ก'], ['3', 'น.ส.3'], ['4', 'น.ส.2'], ['5', 'ส.ค.1'], ['6', 'ส.ป.ก.4-01'],
  ['7', 'ท.ค.'], ['8', 'ส.ธ.1'], ['9', 'โฉนดตราจอง'], ['10', 'น.ส.ล.'], ['11', 'ก.ส.น.5'], ['12', 'ที่ราชพัสดุ'], ['13', 'อื่นๆ'],
];

export const UTM_SHEETS = [['1', 'I'], ['2', 'II'], ['3', 'III'], ['4', 'IV']];
export const MAP_SCALES = [['500', '500'], ['1000', '1000'], ['2000', '2000'], ['4000', '4000']];

export const LAND_USE_TYPES = [
  ['1', '1-เกษตรกรรม'],
  ['2', '2-(1)ที่อยู่อาศัย - หลังหลัก และ หลังอื่นๆอยู่บนพื้นที่เดียวกัน'],
  ['3', '2-(2)ที่อยู่อาศัย - หลังหลัก (กรณีไม่ใช่เจ้าของกรรมสิทธิ์ที่ดิน)'],
  ['4', '2-(3)ที่อยู่อาศัย - หลังอื่นๆ'],
  ['5', '3-อื่นๆ (ไม่ใช่เกษตรกรรมหรือที่อยู่อาศัย)'],
  ['6', '4-ทิ้งไว้ว่างเปล่า/รกร้าง'],
  ['8', '4-ทิ้งไว้ว่างเปล่า/รกร้าง (ตั้งแต่ 3 ปีขึ้นไป)'],
  ['9', '4-ทิ้งไว้ว่างเปล่า/รกร้าง (ตั้งแต่ 6 ปีขึ้นไป)'],
  ['7', '5-ใช้ประโยชน์หลายประเภท'],
];

// LTAX narrows a building's use list to fit the linked land use; the office data uses 1, 2-(1..3) and 3.
export const BUILDING_USE_TYPES = LAND_USE_TYPES;

export const LAND_USED_FOR = [['1', 'ใช้เอง'], ['2', 'ให้เช่า'], ['3', 'ให้บุคคลอื่นทำประโยชน์']];
export const BUILDING_USED_FOR = [['1', 'ใช้ประโยชน์เอง'], ['2', 'ให้เช่า']];

export const AGRI_TYPES = [
  ['1', 'ปลูกข้าว'], ['2', 'ข้าวโพด'], ['3', 'อ้อย'], ['4', 'มันสำปะหลัง'], ['5', 'ไม้ล้มลุกอื่นๆ'], ['6', 'ยางพารา'],
  ['7', 'ปาล์ม'], ['8', 'ไม้ยืนต้นอื่นๆ'], ['9', 'เลี้ยงสัตว์ - ไก่'], ['10', 'เลี้ยงสัตว์ - สุกร'], ['11', 'เลี้ยงสัตว์ - วัว'],
  ['12', 'เลี้ยงสัตว์ - ปลา'], ['13', 'เลี้ยงสัตว์อื่นๆ'],
];

export const STRUCTURES = [['1', 'ไม้'], ['2', 'ตึก'], ['3', 'ครึ่งตึกครึ่งไม้']];

export const BUILDING_TYPES = [
  ['101', 'บ้านพักอาศัยไม้ชั้นเดียว'], ['102', 'บ้านพักอาศัยไม้ชั้นเดียวใต้ถุนสูง'], ['103', 'บ้านพักอาศัยตึกชั้นเดียว'],
  ['104', 'บ้านพักอาศัยไม้สองชั้น'], ['105', 'บ้านพักอาศัยตึกสองชั้น'], ['106', 'บ้านพักอาศัยครึ่งตึกครึ่งไม้สองชั้น'],
  ['107', 'บ้านพักอาศัยตึกสามชั้น'], ['108', 'บ้านพักอาศัยแฝดตึกสองชั้น'], ['109', 'บ้านพักอาศัยแฝดตึกสามชั้น'],
  ['110', 'บ้านทรงไทยไม้ชั้นเดียวใต้ถุนสูง'], ['111', 'บ้านทรงไทยครึ่งตึกครึ่งไม้สองชั้น'], ['112', 'บ้านพักอาศัยแฝดตึกชั้นเดียว'],
  ['201', 'บ้านแถว (ทาวน์เฮาส์) ชั้นเดียว'], ['202', 'บ้านแถว (ทาวน์เฮาส์) สองชั้น'], ['203', 'บ้านแถว (ทาวน์เฮาส์) สามชั้น'],
  ['204', 'บ้านแถว (ทาวน์เฮาส์) สี่ชั้น'], ['301', 'ห้องแถวไม้ชั้นเดียว'], ['302', 'ห้องแถวไม้สองชั้น'],
  ['303', 'ห้องแถวครึ่งตึกครึ่งไม้สองชั้น'], ['401', 'ตึกแถวชั้นเดียว'], ['402', 'ตึกแถวสองชั้น'], ['403', 'ตึกแถวสองชั้นครึ่ง'],
  ['404', 'ตึกแถวสามชั้น'], ['405', 'ตึกแถวสามชั้นครึ่ง'], ['406', 'ตึกแถวสี่ชั้น'], ['407', 'ตึกแถวสี่ชั้นครึ่ง'],
  ['408', 'ตึกแถวห้าชั้น'], ['409', 'ตึกแถวหกชั้น'], ['501', 'คลังสินค้า พื้นที่ไม่เกิน 300 ตารางเมตร'],
  ['502', 'คลังสินค้า พื้นที่เกินกว่า 300 ตารางเมตรขึ้นไป'], ['503', 'เรือนคนใช้/ครัว'], ['504', 'โรงจอดรถ'], ['505', 'สถานศึกษา'],
  ['506/1', 'โรงแรม ความสูงไม่เกิน 5 ชั้น'], ['506/2', 'โรงแรม ความสูงเกินกว่า 5 ชั้นขึ้นไป'], ['507', 'โรงมหรสพ'],
  ['508', 'สถานพยาบาล'], ['509/1', 'สํานักงาน ความสูงไม่เกิน 5 ชั้น'], ['509/2', 'สํานักงาน ความสูงเกินกว่า 5 ชั้นขึ้นไป'],
  ['510', 'ภัตตาคาร'], ['511/1', 'ห้างสรรพสินค้า'], ['511/2', 'อาคารพาณิชยกรรม ประเภทค้าปลีก ค้าส่ง'],
  ['512', 'สถานีบริการน้ำมันเชื้อเพลิง'], ['513', 'โรงงาน'], ['514', 'ตลาด พื้นที่ไม่เกิน 1,000 ตารางเมตร'],
  ['515', 'ตลาด พื้นที่เกินกว่า 1,000 ตารางเมตรขึ้นไป'], ['516', 'อาคารพาณิชย์ ประเภทโฮมออฟฟิศ'], ['517', 'โรงเลี้ยงสัตว์'],
  ['518', 'โรงงานซ่อมรถยนต์'], ['519', 'อาคารจอดรถ'], ['520/1', 'อาคารอยู่อาศัยรวม ความสูงไม่เกิน 5 ชั้น'],
  ['520/2', 'อาคารอยู่อาศัยรวม ความสูงเกินกว่า 5 ชั้นขึ้นไป'], ['521', 'ป้อมยาม'], ['522', 'อาคารพาณิชย์ ประเภทโชว์รูมรถยนต์'],
  ['523', 'ห้องน้ำรวม'], ['601', 'รั้วคอนกรีต'], ['602', 'รั้วลวดหนาม'], ['603', 'รั้วสังกะสี'], ['604', 'รั้วลวดถัก'],
  ['605', 'รั้วไม้'], ['606', 'รั้วเหล็กดัด'], ['607', 'รั้วอัลลอยด์'], ['608', 'สระว่ายน้ำ'], ['609', 'ลานกีฬาอเนกประสงค์'],
  ['610', 'ถนนคอนกรีต'], ['611', 'ลานคอนกรีต'], ['612', 'ถนนลาดยาง'], ['613', 'ป้ายโฆษณา'], ['614', 'ท่าเทียบเรือ'],
];
// LTAX shows building types as "101 - บ้านพักอาศัยไม้ชั้นเดียว".
export const buildingTypeLabel = code => {
  const t = BUILDING_TYPES.find(([c]) => c === code);
  return t ? `${t[0]} - ${t[1]}` : '';
};

export const PERSON_TYPES = ['บุคคลธรรมดา', 'นิติบุคคล', 'รัฐวิสาหกิจ', 'ราชการ', 'สมาคม', 'มูลนิธิ', 'วัด/ศาสนา', 'อื่นๆ'].map(t => [t, t]);
export const PREFIXES = ['นาย', 'นาง', 'น.ส.', 'ด.ช.', 'ด.ญ.', 'ม.ร.ว.', 'ม.ล.', 'หม่อม', 'คุณหญิง', 'ท่านผู้หญิง', 'พ.ญ.คุณหญิง',
  'น.พ.', 'พ.ญ.', 'ภก.', 'ภกญ.', 'ท.พ.', 'ท.พ.ญ.', 'สพ.', 'สพญ.', 'พล.อ.', 'ว่าที่ พล.อ.', 'พล.ท.', 'ว่าที่ พล.ท.', 'พล.ต.',
  'ว่าที่ พล.ต.', 'พ.อ.พิเศษ', 'ว่าที่ พ.อ.พิเศษ', 'พ.อ.', 'ว่าที่ พ.อ.', 'พ.ท.', 'ว่าที่ พ.ท.', 'พ.ต.', 'ว่าที่ พ.ต.', 'ร้อยเอก',
  'ว่าที่ร้อยเอก', 'ร้อยโท', 'ว่าที่ร้อยโท', 'ร้อยตรี', 'ว่าที่ร้อยตรี'].map(t => [t, t]);
export const PERSON_STATUS = ['มีชีวิต', 'ถึงแก่กรรม', 'ล้มละลาย'].map(t => [t, t]);
export const SEND_ADDR = ['ที่อยู่ตามบัตรประชาชน', 'ที่อยู่ปัจจุบัน'].map(t => [t, t]);
export const SEND_PDS = ['ใช้บริการพิมพ์พร้อมส่งของไปรษณีย์ไทย', 'ดำเนินการจัดส่งเอง'].map(t => [t, t]);

export const SIGNBOARD_TYPES = ['ป้าย/แสดงโฆษณาทั่วไป', 'ป้าย/ป้ายภายในอาคาร 3 ตร.ม ขึ้นไป', 'ป้ายตามกฏหมายทะเบียนพาณิชย์'].map(t => [t, t]);
export const SIGN_CHARACTERS = [
  'ป้ายประเภทที่ 1 (ก) ป้ายที่มีอักษรไทยล้วน (ข้อความเคลื่อนที่/เปลี่ยนข้อความได้)',
  'ป้ายประเภทที่ 1 (ข) ป้ายที่มีอักษรไทยล้วน (ข้อความไม่เคลื่อนที่/เปลี่ยนข้อความไม่ได้)',
  'ป้ายประเภทที่ 2 (ก) ป้ายที่มีอักษรไทยปนกับอักษรต่างประเทศ /ภาพ/เครื่องหมายอื่น (ข้อความเคลื่อนที่/เปลี่ยนข้อความได้)',
  'ป้ายประเภทที่ 2 (ข) ป้ายที่มีอักษรไทยปนกับอักษรต่างประเทศ /ภาพ/เครื่องหมายอื่น (ข้อความไม่เคลื่อนที่/เปลี่ยนข้อความไม่ได้)',
  'ป้ายประเภทที่ 3 (ก) ป้ายที่ไม่มีอักษรไทย ไม่ว่าจะมีภาพหรือเครื่องหมาย/มีอักษรไทยบางส่วนหรือทั้งหมดอยู่ใต้หรือต่ำกว่าอักษรต่างประเทศ (ข้อความเคลื่อนที่/เปลี่ยนข้อความได้)',
  'ป้ายประเภทที่ 3 (ข) ป้ายที่ไม่มีอักษรไทย ไม่ว่าจะมีภาพหรือเครื่องหมาย/มีอักษรไทยบางส่วนหรือทั้งหมดอยู่ใต้หรือต่ำกว่าอักษรต่างประเทศ (ข้อความไม่เคลื่อนที่/เปลี่ยนข้อความไม่ได้)',
].map(t => [t, t]);
export const SIGN_PERIODS = ['งวด 1 (มกราคม - มีนาคม)', 'งวด 2 (เมษายน - มิถุนายน)', 'งวด 3 (กรกฎาคม - กันยายน)', 'งวด 4 (ตุลาคม - ธันวาคม)'].map(t => [t, t]);

export const label = (list, value) => (list.find(([v]) => v === String(value ?? '')) || [, ''])[1];

// Field definitions drive the edit forms, the Excel/shp exports and the LTAX field mapping.
// ltax: the LTAX form field name; select fields are matched by label text.
const f = (key, th, opts = {}) => ({ key, th, type: 'text', ...opts });

export const ENTITIES = {
  owners: {
    th: 'เจ้าของทรัพย์สิน',
    title: o => [o.prefixName, o.firstName, o.lastName].filter(Boolean).join(' ') || '(ไม่มีชื่อ)',
    fields: [
      f('personType', 'ประเภทบุคคล', { type: 'select', list: PERSON_TYPES, required: true, ltax: 'assetOwner.personType' }),
      f('assetReg4', 'ถอดรหัสชื่อ ผ.ท.4', { ltax: 'assetOwner.assetReg4' }),
      f('psnId', 'เลขประจำตัวประชาชน', { ltax: 'assetOwner.psnId' }),
      // LTAX has more titles than the 40 captured (พระ, พ.ต.ท. ...): free text with suggestions.
      f('prefixName', 'คำนำหน้าชื่อ/หน่วยงาน', { type: 'combo', list: PREFIXES, required: true, ltax: 'assetOwner.prefixName', ltaxSelect: true }),
      f('firstName', 'ชื่อ', { required: true, ltax: 'assetOwner.firstName' }),
      f('lastName', 'นามสกุล', { ltax: 'assetOwner.lastName' }),
      f('personStatus', 'สถานะบุคคล', { type: 'select', list: PERSON_STATUS, ltax: 'assetOwner.personStatus' }),
      f('addrNo', 'บ้านเลขที่ (ตามบัตร)', { ltax: 'assetOwner.addrNo', group: 'ที่อยู่ตามบัตรประชาชน' }),
      f('addrVillage', 'หมู่ที่/ชุมชน', { ltax: 'assetOwner.addrVillage', group: 'ที่อยู่ตามบัตรประชาชน' }),
      f('addrRoad', 'ถนน', { ltax: 'assetOwner.addrRoad', group: 'ที่อยู่ตามบัตรประชาชน' }),
      f('addrAlley', 'ซอย', { ltax: 'assetOwner.addrAlley', group: 'ที่อยู่ตามบัตรประชาชน' }),
      f('addrProvince', 'จังหวัด', { ltax: 'provinceId', ltaxSelect: true, group: 'ที่อยู่ตามบัตรประชาชน' }),
      f('addrAmphur', 'อำเภอ', { ltax: 'amphurId', ltaxSelect: true, group: 'ที่อยู่ตามบัตรประชาชน' }),
      f('addrDistrict', 'ตำบล', { ltax: 'districtId', ltaxSelect: true, group: 'ที่อยู่ตามบัตรประชาชน' }),
      f('postalCode', 'รหัสไปรษณีย์', { ltax: 'assetOwner.postalCode', group: 'ที่อยู่ตามบัตรประชาชน' }),
      f('currNo', 'บ้านเลขที่ (ปัจจุบัน)', { ltax: 'assetOwner.currNo', group: 'ที่อยู่ปัจจุบัน' }),
      f('currVillage', 'หมู่ที่/ชุมชน', { ltax: 'assetOwner.currVillage', group: 'ที่อยู่ปัจจุบัน' }),
      f('currRoad', 'ถนน', { ltax: 'assetOwner.currRoad', group: 'ที่อยู่ปัจจุบัน' }),
      f('currAlley', 'ซอย', { ltax: 'assetOwner.currAlley', group: 'ที่อยู่ปัจจุบัน' }),
      f('currProvince', 'จังหวัด', { ltax: 'currProvinceId', ltaxSelect: true, group: 'ที่อยู่ปัจจุบัน' }),
      f('currAmphur', 'อำเภอ', { ltax: 'currAmphurId', ltaxSelect: true, group: 'ที่อยู่ปัจจุบัน' }),
      f('currDistrict', 'ตำบล', { ltax: 'currDistrictId', ltaxSelect: true, group: 'ที่อยู่ปัจจุบัน' }),
      f('currPostalCode', 'รหัสไปรษณีย์', { ltax: 'assetOwner.currPostalCode', group: 'ที่อยู่ปัจจุบัน' }),
      f('tel', 'โทรศัพท์', { ltax: 'assetOwner.tel' }),
      f('email', 'อีเมล', { ltax: 'assetOwner.email' }),
      f('sendAddr', 'ที่อยู่เพื่อส่งจดหมาย', { type: 'select', list: SEND_ADDR, ltax: 'assetOwner.sendAddr' }),
      f('sendPdsBy34', 'การส่ง ภ.ด.ส.3,4', { type: 'select', list: SEND_PDS, ltax: 'assetOwner.sendPdsBy34' }),
      f('sendPdsBy678', 'การส่ง ภ.ด.ส.6,7,8', { type: 'select', list: SEND_PDS, ltax: 'assetOwner.sendPdsBy678' }),
      f('ltaxRemark', 'หมายเหตุเจ้าหน้าที่', { type: 'textarea', ltax: 'assetOwner.ltaxRemark' }),
    ],
  },
  lands: {
    th: 'ที่ดิน',
    title: l => l.parcelCode || '(ไม่มีรหัสแปลง)',
    fields: [
      f('parcelCode', 'รหัสแปลงที่ดิน', { required: true, ltax: 'land.parcelCode' }),
      f('landGroup', 'รหัสกลุ่มที่ดิน', { ltax: 'land.landGroup' }),
      f('docType', 'ประเภทเอกสารสิทธิ์', { type: 'select', list: DOC_TYPES, required: true, ltax: 'land.docType' }),
      f('docNo', 'เลขที่เอกสารสิทธิ์', { ltax: 'land.docNo' }),
      f('utm1', 'ระวาง (แผนที่ภูมิประเทศ)', { ltax: 'land.utm1', group: 'ระวางที่ดิน' }),
      f('utm2', 'แผ่น', { type: 'select', list: UTM_SHEETS, ltax: 'land.utm2', group: 'ระวางที่ดิน' }),
      f('utm3', 'ระวาง UTM', { ltax: 'land.utm3', group: 'ระวางที่ดิน' }),
      f('utm4', 'แผ่นที่ระวาง UTM', { ltax: 'land.utm4', group: 'ระวางที่ดิน' }),
      f('scale', 'มาตราส่วน', { type: 'select', list: MAP_SCALES, ltax: 'land.scale', group: 'ระวางที่ดิน' }),
      f('parcelNo', 'เลขที่ดิน', { ltax: 'land.parcelNo' }),
      f('dealingFileNo', 'หน้าสำรวจ', { ltax: 'land.dealingFileNo' }),
      f('volume', 'เล่มที่', { ltax: 'land.volume' }),
      f('page', 'หน้าที่', { ltax: 'land.page' }),
      f('road', 'ถนน', { ltax: 'land.road', group: 'ที่ตั้ง' }),
      f('alley', 'ซอย', { ltax: 'land.alley', group: 'ที่ตั้ง' }),
      f('villageNo', 'หมู่ที่', { ltax: 'land.villageNo', group: 'ที่ตั้ง' }),
      f('amphur', 'อำเภอ', { ltax: 'amphurId', ltaxSelect: true, required: true, group: 'ที่ตั้ง' }),
      f('district', 'ตำบล', { ltax: 'districtId', ltaxSelect: true, required: true, group: 'ที่ตั้ง' }),
      f('rai', 'ไร่', { type: 'number', ltax: 'land.raiStr', group: 'เนื้อที่' }),
      f('ngan', 'งาน', { type: 'number', ltax: 'land.nganStr', group: 'เนื้อที่' }),
      f('wah', 'ตร.ว.', { type: 'number', ltax: 'land.squareWahStr', group: 'เนื้อที่' }),
      f('pricePerWah', 'ราคาประเมินต่อ ตร.ว.', { type: 'number', ltax: 'land.pricePerWahStr' }),
      f('note', 'หมายเหตุ', { type: 'textarea', ltax: 'land.note' }),
      f('ltaxRemark', 'หมายเหตุเจ้าหน้าที่', { type: 'textarea', ltax: 'land.ltaxRemark' }),
    ],
    uses: [
      f('usedType', 'ประเภทการใช้ประโยชน์', { type: 'select', list: LAND_USE_TYPES, required: true, ltax: 'landUsed.usedType' }),
      f('rai', 'ไร่', { type: 'number', ltax: 'landUsed.raiStr' }),
      f('ngan', 'งาน', { type: 'number', ltax: 'landUsed.nganStr' }),
      f('wah', 'ตร.ว.', { type: 'number', ltax: 'landUsed.squareWahStr' }),
      f('usedFor', 'ผู้ทำประโยชน์', { type: 'select', list: LAND_USED_FOR, ltax: 'landUsed.usedFor' }),
      f('usedBy', 'ชื่อ-สกุล ผู้ทำประโยชน์', { ltax: 'landUsed.usedBy' }),
      f('agriType', 'การเกษตรที่ทำ', { type: 'select', list: AGRI_TYPES, ltax: 'landUsed.agriType' }),
      f('note', 'หมายเหตุ', { type: 'textarea', ltax: 'landUsed.note' }),
    ],
  },
  buildings: {
    th: 'สิ่งปลูกสร้าง',
    title: b => b.buildingCode || (b.addrNo ? `เลขที่ ${b.addrNo}` : '(ไม่มีรหัส)'),
    fields: [
      f('buildingCode', 'รหัสสิ่งปลูกสร้าง', { ltax: 'building.buildingCode' }),
      f('addrNo', 'เลขที่', { ltax: 'building.addrNo' }),
      f('villageNo', 'หมู่ที่', { ltax: 'building.villageNo' }),
      f('villageName', 'หมู่บ้าน/ชุมชน', { ltax: 'building.villageName' }),
      f('road', 'ถนน', { ltax: 'building.road' }),
      f('alley', 'ซอย', { ltax: 'building.alley' }),
      f('buildingType', 'ประเภทสิ่งปลูกสร้าง', { type: 'select', list: BUILDING_TYPES.map(([c]) => [c, buildingTypeLabel(c)]), required: true, ltax: 'building.buildingType' }),
      f('structure', 'ลักษณะสิ่งปลูกสร้าง', { type: 'select', list: STRUCTURES, ltax: 'building.structure' }),
      f('noFloor', 'จำนวนชั้น', { type: 'number', ltax: 'building.noFloor' }),
      f('width', 'กว้าง (ม.)', { type: 'number', ltax: 'building.widthStr' }),
      f('length', 'ยาว (ม.)', { type: 'number', ltax: 'building.heightStr' }),
      f('since', 'ก่อสร้างแล้วเสร็จ ปี พ.ศ.', { type: 'number', ltax: 'building.since' }),
      f('age', 'อายุ (ปี)', { type: 'number', ltax: 'building.ageStr' }),
      f('totalArea', 'พื้นที่ทั้งอาคาร (ตร.ม.)', { type: 'number', ltax: 'building.totalAreaStr' }),
      f('pricePerMeter', 'ราคาประเมิน (บาท/ตร.ม.)', { type: 'number', ltax: 'building.pricePerMeterStr' }),
      f('note', 'หมายเหตุ', { type: 'textarea', ltax: 'building.note' }),
      f('ltaxRemark', 'หมายเหตุเจ้าหน้าที่', { type: 'textarea', ltax: 'building.ltaxRemark' }),
    ],
    uses: [
      f('usedType', 'การใช้ประโยชน์', { type: 'select', list: BUILDING_USE_TYPES, required: true, ltax: 'buildingUsed.usedType' }),
      f('fullArea', 'เต็มพื้นที่ทุกชั้น', { type: 'checkbox', ltax: 'fullArea' }),
      f('useFloor', 'ชั้นที่', { ltax: 'buildingUsed.useFloor' }),
      f('width', 'กว้าง (ม.)', { type: 'number', ltax: 'buildingUsed.widthStr' }),
      f('length', 'ยาว (ม.)', { type: 'number', ltax: 'buildingUsed.lengthStr' }),
      f('area', 'พื้นที่รวม (ตร.ม.)', { type: 'number', ltax: 'buildingUsed.areaStr' }),
      f('usedFor', 'ลักษณะการใช้', { type: 'select', list: BUILDING_USED_FOR, ltax: 'buildingUsed.usedFor' }),
      f('note', 'หมายเหตุ', { type: 'textarea', ltax: 'buildingUsed.note' }),
    ],
  },
  signboards: {
    th: 'ป้าย',
    title: s => s.signboardName || s.signboardCode || '(ไม่มีข้อความ)',
    fields: [
      f('signboardCode', 'รหัสป้าย', { ltax: 'signboard.signboardCode' }),
      f('signboardName', 'ข้อความภายในป้าย', { type: 'textarea', required: true, ltax: 'signboard.signboardName' }),
      f('setupDate', 'วันที่ติดตั้ง', { ltax: 'signboard.setupDateStr' }),
      f('addrNo', 'เลขที่', { ltax: 'signboard.addrNo' }),
      f('villageNo', 'หมู่ที่', { ltax: 'signboard.villageNo' }),
      f('villageName', 'หมู่บ้าน/ชุมชน', { ltax: 'signboard.villageName' }),
      f('road', 'ถนน', { ltax: 'signboard.road' }),
      f('alley', 'ซอย', { ltax: 'signboard.alley' }),
      f('signboardType', 'ประเภทป้าย', { type: 'select', list: SIGNBOARD_TYPES, required: true, ltax: 'signboard.signboardType' }),
      f('character', 'ลักษณะของป้าย', { type: 'select', list: SIGN_CHARACTERS, required: true, ltax: 'signboard.character' }),
      f('width', 'กว้าง (ซม.)', { type: 'number', ltax: 'signboard.widthStr' }),
      f('height', 'สูง (ซม.)', { type: 'number', ltax: 'signboard.heightStr' }),
      f('noSide', 'จำนวนด้าน', { type: 'number', ltax: 'signboard.noSideStr' }),
      f('unit', 'จำนวนป้าย', { type: 'number', ltax: 'signboard.unitStr' }),
      f('period', 'งวดที่ติดตั้ง', { type: 'select', list: SIGN_PERIODS, ltax: 'signboard.period' }),
      f('signboardDesc', 'รายละเอียด', { type: 'textarea', ltax: 'signboard.signboardDesc' }),
      f('note', 'หมายเหตุ', { type: 'textarea', ltax: 'signboard.note' }),
    ],
  },
};

// Links between records (not plain fields): lands.ownerIds, buildings.ownerIds, buildings.landIds,
// signboards.ownerIds, signboards.landId. Every record may carry `ltaxId` (LTAX record id, read back)
// and `synced` (the field values LTAX held at the last pull or push).
export const LINK_KEYS = ['ownerIds', 'landIds', 'landId'];
