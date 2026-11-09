// Simulated DLA SSO + LTAX ONLINE asset register (AST001) for tests. Same field names, commands,
// page flow and prompts as the live system (docs/ltax-online-map.md), kept deliberately small.
// Never point tests at the real ltax.dla.go.th.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const DOC = ['โฉนด', 'น.ส.3ก', 'น.ส.3', 'น.ส.2', 'ส.ค.1', 'ส.ป.ก.4-01', 'ท.ค.', 'ส.ธ.1', 'โฉนดตราจอง', 'น.ส.ล.', 'ก.ส.น.5', 'ที่ราชพัสดุ', 'อื่นๆ'];
const USE = [['1', '1-เกษตรกรรม'], ['2', '2-(1)ที่อยู่อาศัย - หลังหลัก และ หลังอื่นๆอยู่บนพื้นที่เดียวกัน'], ['3', '2-(2)ที่อยู่อาศัย - หลังหลัก (กรณีไม่ใช่เจ้าของกรรมสิทธิ์ที่ดิน)'],
  ['4', '2-(3)ที่อยู่อาศัย - หลังอื่นๆ'], ['5', '3-อื่นๆ (ไม่ใช่เกษตรกรรมหรือที่อยู่อาศัย)'], ['6', '4-ทิ้งไว้ว่างเปล่า/รกร้าง'], ['7', '5-ใช้ประโยชน์หลายประเภท']];
const USED_FOR = [['1', 'ใช้เอง'], ['2', 'ให้เช่า'], ['3', 'ให้บุคคลอื่นทำประโยชน์']];
const AGRI = [['1', 'ปลูกข้าว'], ['2', 'ข้าวโพด'], ['3', 'อ้อย'], ['4', 'มันสำปะหลัง']];
const AMPHUR = { 'น้ำโสม': ['ทุบกุง*', 'นางัว', 'น้ำโสม', 'ศรีสำราญ', 'หนองแวง'], 'บ้านผือ': ['บ้านผือ', 'หายโศก'] };
const PROVINCE = { 'อุดรธานี': ['น้ำโสม', 'บ้านผือ'] };
const BTYPES = [['101', '101 - บ้านพักอาศัยไม้ชั้นเดียว'], ['103', '103 - บ้านพักอาศัยตึกชั้นเดียว'], ['105', '105 - บ้านพักอาศัยตึกสองชั้น'], ['106', '106 - บ้านพักอาศัยครึ่งตึกครึ่งไม้สองชั้น']];

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const wah = (r, n, w) => Number(r || 0) * 400 + Number(n || 0) * 100 + Number(w || 0);

export function createMockLtax({ db = {}, notCurrentYear = '', delayDistricts = 150 } = {}) {
  const DB = { owners: [], lands: [], buildings: [], saves: [], ...db };
  const sessions = new Map();

  const sel = (name, options, value, attrs = '') => `<select name="${name}" ${attrs}><option value="">กรุณาเลือก</option>${options.map(([v, t]) => `<option value="${esc(v)}" ${String(value ?? '') === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const inp = (name, value, attrs = '') => `<input type="text" name="${name}" value="${esc(value)}" ${attrs}>`;

  function page(s, title, body, msg = '') {
    return `<!doctype html><html><head><meta charset="utf-8"><title>DLA_LTAX [mock-app01]</title>
<style>.swal2-popup{position:fixed;top:30%;left:30%;background:#fff;border:1px solid #888;padding:20px}</style></head><body>
<div>ยินดีต้อนรับ : ผู้ทดสอบ / สังกัด : อบต.ทดสอบ <a href="javascript:doLogout()">ออกจากระบบ</a></div>
<h2>${esc(title)}</h2>
<form name="f" method="post" action="/asset/assetRegis.do">
<input type="hidden" name="cmd"><input type="hidden" name="data_index"><input type="hidden" name="notCurrentYear" value="${esc(notCurrentYear)}">
${body}
</form>
<div>Copyright ©2020 Department of Local Administration.</div>
${msg ? `<div>!</div><div>[mock-app01][${new Date().toLocaleTimeString()}]</div><div>${esc(msg)}</div>` : ''}
<script>
function getForm(){ return document.forms[0]; }
function submitForm(form){ form.submit(); }
function validateForm(form){
  for (const el of form.querySelectorAll('[data-required]')) if (!el.value) { alert('กรุณากรอก ' + el.dataset.required); return false; }
  return true;
}
function swal(o){
  return { then(cb){
    const d = document.createElement('div'); d.className = 'swal2-popup';
    d.innerHTML = '<div class="swal2-title">' + o.title + '</div><button class="swal2-confirm">ยืนยัน</button><button class="swal2-cancel">ยกเลิก</button>';
    document.body.appendChild(d);
    d.querySelector('.swal2-confirm').onclick = () => { d.remove(); cb({ value: true }); };
    d.querySelector('.swal2-cancel').onclick = () => { d.remove(); cb({}); };
  } };
}
function doCmd(cmd, index){
  const form = getForm(); form.elements['cmd'].value = cmd; form.elements['data_index'].value = index != null ? index : '';
  const ncy = form.elements['notCurrentYear'].value;
  if (cmd.match('doSave')) {
    if (!validateForm(form)) return;
    if (ncy) swal({ title: 'ยืนยันการแก้ไขข้อมูลปีภาษี ' + ncy }).then(r => { if (r.value) submitForm(form); });
    else submitForm(form);
  } else if (cmd.match('doDelete')) {
    swal({ title: 'ยืนยันการลบข้อมูล' }).then(r => { if (r.value) submitForm(form); });
  } else submitForm(form);
}
function checkArea(){
  const f = getForm(), want = (+f.elements['landUsed.raiStr'].value||0)*400 + (+f.elements['landUsed.nganStr'].value||0)*100 + (+f.elements['landUsed.squareWahStr'].value||0);
  if (want > +f.elements['landUsed.remainWah'].value + 0.001) { swal({ title: 'เนื้อที่การใช้ประโยชน์เกินเนื้อที่ที่เหลือ' }).then(() => {}); return; }
  doCmd('doSaveLandUsed');
}
function popupCmd(){ alert('popup ไม่รองรับใน LTAX จำลอง'); }
function doLogout(){ location.href = '/sso/login.do?cmd=logout'; }
async function loadChain(parent, child, kind){
  const v = getForm().elements[parent].selectedOptions[0]?.text || '';
  const sel = getForm().elements[child];
  sel.innerHTML = '<option value="">กรุณาเลือก</option>';
  const list = await (await fetch('/mock/' + kind + '?of=' + encodeURIComponent(v))).json();
  setTimeout(() => { for (const t of list) sel.add(new Option(t, t)); }, ${delayDistricts});
}
</script></body></html>`;
  }

  const chainOpts = (list, value) => list.map(t => [t, t]).concat(value && !list.includes(value) ? [[value, value]] : []);
  const addrSel = (pName, aName, dName, p, a, d) =>
    `จังหวัด ${sel(pName, Object.keys(PROVINCE).map(t => [t, t]), p, `onchange="loadChain('${pName}','${aName}','amphurs')"`)}
     อำเภอ ${sel(aName, chainOpts(PROVINCE[p] || [], a), a, `onchange="loadChain('${aName}','${dName}','districts')"`)}
     ตำบล ${sel(dName, chainOpts(AMPHUR[a] || [], d), d)}`;

  function listPage(s, msg) {
    const mode = s.mode;
    const rows = s.results || [];
    const search = mode === 'land' ? `รหัสแปลงที่ดิน ${inp('searchCondition.parcelCode', s.search.parcelCode)}`
      : mode === 'building' ? `รหัสสิ่งปลูกสร้าง ${inp('searchCondition.buildingCode', s.search.buildingCode)}`
        : `เลขประจำตัวประชาชน ${inp('searchCondition.psnId', s.search.psnId)}`;
    const cells = r => mode === 'land' ? [r.parcelCode, DOC[r.docType - 1] || '', r.docNo] : mode === 'building' ? [r.buildingCode, r.addrNo] : [r.psnId, r.firstName, r.lastName];
    const q = mode === 'assetOwner' ? "'" : '';
    return page(s, 'ข้อมูลทะเบียนทรัพย์สิน AST001', `${search} <input type="button" value="ค้นหา" onclick="doCmd('listAsset')">
      <table><tr><th></th><th>รหัส</th><th>ข้อมูล</th><th></th></tr>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td>${cells(r).map(c => `<td>${esc(c)}</td>`).join('')}<td><a href="javascript:doCmd('goView', ${q}${i}${q})">ดูข้อมูล</a> <a href="javascript:doCmd('goUpdate', ${q}${i}${q})">แก้ไข</a> <a href="javascript:doCmd('doDelete', ${q}${i}${q})">ลบข้อมูล</a></td></tr>`).join('')}
      </table><div>1 ถึง ${rows.length} จาก ${rows.length}</div>`, msg);
  }

  function landForm(s, msg) {
    const l = s.edit;
    const owners = l.ownerIds.map(id => DB.owners.find(o => o.id === id)).filter(Boolean);
    return page(s, l.id ? 'แก้ไขข้อมูลที่ดิน' : 'เพิ่มข้อมูลที่ดิน', `
      <table><tr><th>ลำดับ</th><th>ชื่อ - นามสกุล</th><th>เลขประจำตัวประชาชน</th><th>ที่อยู่</th></tr>
      ${owners.map((o, i) => `<tr><td>${i + 1}</td><td>${esc(o.prefixName)} ${esc(o.firstName)} ${esc(o.lastName)}</td><td>${esc(o.psnId)}</td><td>-</td></tr>`).join('') || '<tr><td colspan="4">ยังไม่พบข้อมูล</td></tr>'}</table>
      <input type="hidden" name="land.id" value="${esc(l.id)}">
      รหัสแปลง ${inp('land.parcelCode', l.parcelCode)} รหัสกลุ่ม ${inp('land.landGroup', l.landGroup)}
      ประเภทเอกสารสิทธิ์ ${sel('land.docType', DOC.map((t, i) => [String(i + 1), t]), l.docType, 'data-required="ประเภทเอกสารสิทธิ์"')}
      เลขที่ ${inp('land.docNo', l.docNo)} ระวาง ${inp('land.utm1', l.utm1)} ${sel('land.utm2', [['1', 'I'], ['2', 'II'], ['3', 'III'], ['4', 'IV']], l.utm2)}
      ${inp('land.utm3', l.utm3)} ${inp('land.utm4', l.utm4)} ${sel('land.scale', [['500', '500'], ['1000', '1000'], ['2000', '2000'], ['4000', '4000']], l.scale)}
      เลขที่ดิน ${inp('land.parcelNo', l.parcelNo)} หน้าสำรวจ ${inp('land.dealingFileNo', l.dealingFileNo)} ${inp('land.volume', l.volume)} ${inp('land.page', l.page)}
      ${inp('land.road', l.road)} ${inp('land.alley', l.alley)} หมู่ ${inp('land.villageNo', l.villageNo)}
      อำเภอ ${sel('amphurId', Object.keys(AMPHUR).map(t => [t, t]), l.amphur, `onchange="loadChain('amphurId','districtId','districts')"`)}
      ตำบล ${sel('districtId', chainOpts(AMPHUR[l.amphur] || [], l.district), l.district, 'data-required="ตำบล"')}
      ${inp('land.raiStr', l.rai)} ${inp('land.nganStr', l.ngan)} ${inp('land.squareWahStr', l.wah)} ${inp('land.pricePerWahStr', l.pricePerWah)}
      <textarea name="land.note">${esc(l.note)}</textarea><textarea name="land.ltaxRemark">${esc(l.ltaxRemark)}</textarea>
      <table><tr><th>ลำดับ</th><th>ประเภทการใช้ประโยชน์ที่ดิน</th><th>เนื้อที่ (ไร่-งาน-ตร.ว.)</th><th></th></tr>
      ${l.uses.map((u, i) => `<tr><td>${i + 1}</td><td>${esc((USE.find(x => x[0] === u.usedType) || [, ''])[1])}</td><td>${u.rai} - ${u.ngan} - ${u.wah}</td><td><a href="javascript:doCmd('doUpdateLandUsed', ${i})">แก้ไข</a> <a href="javascript:doCmd('doDeleteLandUsed', ${i})">ลบข้อมูล</a></td></tr>`).join('') || '<tr><td colspan="4">ยังไม่พบข้อมูล</td></tr>'}</table>
      <input type="button" value="เพิ่มการใช้ประโยชน์ที่ดิน" onclick="doCmd('goAddLandUsed')">
      <input type="button" value="บันทึก" onclick="doCmd('doSave')"> <input type="button" value="กลับไป" onclick="doCmd('listAsset')">`, msg);
  }

  function landUseForm(s, msg) {
    const l = s.edit, i = s.useIndex, u = i >= 0 ? l.uses[i] : {};
    const used = l.uses.reduce((t, x, j) => t + (j === i ? 0 : wah(x.rai, x.ngan, x.wah)), 0);
    return page(s, 'แก้ไขข้อมูลการใช้ประโยชน์', `
      <input type="hidden" name="landUsed.remainWah" value="${wah(l.rai, l.ngan, l.wah) - used}">
      ${sel('landUsed.usedType', USE, u.usedType, 'data-required="การใช้ประโยชน์"')}
      ${inp('landUsed.raiStr', u.rai)} ${inp('landUsed.nganStr', u.ngan)} ${inp('landUsed.squareWahStr', u.wah)}
      ${sel('landUsed.usedFor', USED_FOR, u.usedFor)} ${inp('landUsed.usedBy', u.usedBy)} ${sel('landUsed.agriType', AGRI, u.agriType)}
      <textarea name="landUsed.note">${esc(u.note)}</textarea>
      <input type="button" value="ตกลง" onclick="if(validateForm(this.form)) checkArea();"> <input type="button" value="กลับไป" onclick="doCmd('goBackLandForm')">`, msg);
  }

  function ownerPage(s, msg) {
    const o = DB.owners.find(x => x.id === s.ownerId);
    return page(s, 'ข้อมูลทะเบียนทรัพย์สิน AST001', `<div>${esc(o.prefixName)} ${esc(o.firstName)} ${esc(o.lastName)} ${esc(o.psnId)}</div>
      <input type="button" value="แก้ไขข้อมูล" onclick="doCmd('doUpdateOwner')"> <input type="button" value="เพิ่มที่ดินใหม่" onclick="doCmd('doAddNewAsset', 'land')">
      <input type="button" value="กลับไป" onclick="doCmd('listAsset')">`, msg);
  }

  function ownerForm(s, msg) {
    const o = s.edit;
    return page(s, o.id ? 'แก้ไขข้อมูลเจ้าของทรัพย์สิน' : 'เพิ่มข้อมูลเจ้าของทรัพย์สิน', `
      <input type="hidden" name="assetOwner.id" value="${esc(o.id)}">
      ${sel('assetOwner.personType', ['บุคคลธรรมดา', 'นิติบุคคล'].map(t => [t, t]), o.personType, 'data-required="ประเภทบุคคล"')}
      ${inp('assetOwner.psnId', o.psnId)} ${sel('assetOwner.prefixName', ['นาย', 'นาง', 'น.ส.', 'พระ'].map(t => [t, t]), o.prefixName)}
      ${inp('assetOwner.firstName', o.firstName, 'data-required="ชื่อ"')} ${inp('assetOwner.lastName', o.lastName)}
      ${inp('assetOwner.addrNo', o.addrNo)} ${inp('assetOwner.addrVillage', o.addrVillage)} ${addrSel('provinceId', 'amphurId', 'districtId', o.addrProvince, o.addrAmphur, o.addrDistrict)}
      ${inp('assetOwner.postalCode', o.postalCode)} ${inp('assetOwner.tel', o.tel)}
      <input type="button" value="บันทึก" onclick="if(validateForm(this.form)) doCmd('doSaveOwner');"> <input type="button" value="กลับไป" onclick="doCmd('listAsset')">`, msg);
  }

  const LAND_FIELDS = { parcelCode: 'land.parcelCode', landGroup: 'land.landGroup', docType: 'land.docType', docNo: 'land.docNo', utm1: 'land.utm1', utm2: 'land.utm2',
    utm3: 'land.utm3', utm4: 'land.utm4', scale: 'land.scale', parcelNo: 'land.parcelNo', dealingFileNo: 'land.dealingFileNo', volume: 'land.volume', page: 'land.page',
    road: 'land.road', alley: 'land.alley', villageNo: 'land.villageNo', amphur: 'amphurId', district: 'districtId', rai: 'land.raiStr', ngan: 'land.nganStr',
    wah: 'land.squareWahStr', pricePerWah: 'land.pricePerWahStr', note: 'land.note', ltaxRemark: 'land.ltaxRemark' };
  const USE_FIELDS = { usedType: 'landUsed.usedType', rai: 'landUsed.raiStr', ngan: 'landUsed.nganStr', wah: 'landUsed.squareWahStr', usedFor: 'landUsed.usedFor', usedBy: 'landUsed.usedBy', agriType: 'landUsed.agriType', note: 'landUsed.note' };
  const OWNER_FIELDS = { personType: 'assetOwner.personType', psnId: 'assetOwner.psnId', prefixName: 'assetOwner.prefixName', firstName: 'assetOwner.firstName',
    lastName: 'assetOwner.lastName', addrNo: 'assetOwner.addrNo', addrVillage: 'assetOwner.addrVillage', addrProvince: 'provinceId', addrAmphur: 'amphurId',
    addrDistrict: 'districtId', postalCode: 'assetOwner.postalCode', tel: 'assetOwner.tel' };
  const take = (map, form, obj) => { for (const [k, n] of Object.entries(map)) if (n in form) obj[k] = form[n]; return obj; };

  function handle(s, cmd, idx, form) {
    // Posted main-form values are kept in the session copy, like the real system does between round trips.
    if (s.view === 'land' && s.edit) take(LAND_FIELDS, form, s.edit);
    if (s.view === 'owner' && s.edit) take(OWNER_FIELDS, form, s.edit);
    for (const k of ['parcelCode', 'buildingCode', 'psnId']) if (`searchCondition.${k}` in form) s.search[k] = form[`searchCondition.${k}`];
    const coll = { land: 'lands', building: 'buildings', assetOwner: 'owners' }[s.mode];
    switch (cmd) {
      case 'goAsset': s.mode = idx; s.results = DB[{ land: 'lands', building: 'buildings', assetOwner: 'owners' }[idx]].slice(0, 10); s.view = 'list'; return listPage(s);
      case 'listAsset': {
        const key = { land: 'parcelCode', building: 'buildingCode', assetOwner: 'psnId' }[s.mode];
        const q = (s.search[key] || '').trim().toUpperCase();
        s.results = DB[coll].filter(r => !q || String(r[key] || '').toUpperCase().includes(q));
        s.view = 'list'; return listPage(s);
      }
      case 'goUpdate': case 'goView': {
        const r = s.results[Number(idx)];
        if (s.mode === 'assetOwner') { s.ownerId = r.id; s.view = 'ownerPage'; return ownerPage(s); }
        s.edit = structuredClone(r); s.view = 'land'; return landForm(s);
      }
      case 'goCreate':
        if (s.mode === 'assetOwner') { s.edit = { id: '' }; s.view = 'owner'; return ownerForm(s); }
        s.edit = { id: '', ownerIds: [], uses: [] }; s.view = 'land'; return landForm(s);
      case 'doUpdateOwner': s.edit = structuredClone(DB.owners.find(o => o.id === s.ownerId)); s.view = 'owner'; return ownerForm(s);
      case 'doAddNewAsset': s.mode = 'land'; s.edit = { id: '', ownerIds: [s.ownerId], uses: [] }; s.view = 'land'; return landForm(s);
      case 'goAddLandUsed':
        if (s.edit.uses.reduce((t, u) => t + wah(u.rai, u.ngan, u.wah), 0) >= wah(s.edit.rai, s.edit.ngan, s.edit.wah)) return landForm(s, 'ใช้ประโยชน์เต็มพื้นที่แล้ว');
        s.useIndex = -1; s.view = 'landUse'; return landUseForm(s);
      case 'doUpdateLandUsed': s.useIndex = Number(idx); s.view = 'landUse'; return landUseForm(s);
      case 'doSaveLandUsed': {
        const u = take(USE_FIELDS, form, s.useIndex >= 0 ? s.edit.uses[s.useIndex] : {});
        if (s.useIndex < 0) s.edit.uses.push(u);
        s.view = 'land'; return landForm(s);
      }
      case 'goBackLandForm': s.view = 'land'; return landForm(s);
      case 'doSave': {
        const l = s.edit;
        if (!l.id) { l.id = String(100000 + DB.lands.length + 1); DB.lands.push(l); } else DB.lands[DB.lands.findIndex(x => x.id === l.id)] = l;
        DB.saves.push({ kind: 'land', id: l.id, at: Date.now() });
        s.edit = null; s.mode = 'land'; s.results = []; s.view = 'list';
        return listPage(s, 'บันทึกข้อมูลเรียบร้อยแล้ว');
      }
      case 'doSaveOwner': {
        const o = s.edit;
        if (!o.id) { o.id = String(200000 + DB.owners.length + 1); DB.owners.push(o); } else DB.owners[DB.owners.findIndex(x => x.id === o.id)] = o;
        DB.saves.push({ kind: 'owner', id: o.id, at: Date.now() });
        s.edit = null; s.mode = 'assetOwner'; s.results = []; s.view = 'list';
        return listPage(s, 'บันทึกข้อมูลเรียบร้อยแล้ว');
      }
      default: return page(s, 'ข้อผิดพลาด', '', `ไม่รู้จักคำสั่ง ${cmd}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
    const sid = (req.headers.cookie || '').match(/MOCKSID=([\w-]+)/)?.[1];
    let s = sid && sessions.get(sid);
    let raw = '';
    for await (const c of req) raw += c;
    const form = Object.fromEntries(new URLSearchParams(raw));

    if (url.pathname.startsWith('/mock/')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (url.pathname === '/mock/districts') return res.end(JSON.stringify(AMPHUR[url.searchParams.get('of')] || []));
      if (url.pathname === '/mock/amphurs') return res.end(JSON.stringify(PROVINCE[url.searchParams.get('of')] || []));
      if (url.pathname === '/mock/db') return res.end(JSON.stringify(DB));
    }
    if (url.pathname === '/sso/login.do') {
      if (url.searchParams.get('cmd') === 'logout') { sessions.delete(sid); return html('<p>ออกจากระบบแล้ว</p>'); }
      if (req.method === 'POST' && form.login) {
        const id = randomUUID();
        sessions.set(id, { sso: true, ltax: false, search: {}, mode: 'assetOwner', results: [] });
        res.writeHead(302, { 'Set-Cookie': `MOCKSID=${id}; Path=/`, Location: '/sso/login.do' }); return res.end();
      }
      if (url.searchParams.get('cmd') === 'jump' && s) { s.ltax = true; res.writeHead(302, { Location: '/home.jsp' }); return res.end(); }
      if (s) return html(`<html><body><h1>DLA Single Sign-on</h1><a href="/sso/login.do?cmd=jump&ind=1">LTAX LTAX ONLINE</a> <a href="javascript:doLogout()">ออกจากระบบ</a></body></html>`);
      return html(`<html><body><form method="post"><input name="login"><input type="password" name="password"><button>เข้าสู่ระบบ</button></form></body></html>`);
    }
    if (!s || !s.ltax) { res.writeHead(302, { Location: '/sso/login.do' }); return res.end(); }
    if (url.pathname === '/home.jsp') return html(page(s, 'หน้าหลัก', ''));
    if (url.pathname === '/asset/assetRegis.do') {
      if (req.method === 'GET') { s.mode = 'assetOwner'; s.results = DB.owners.slice(0, 10); s.view = 'list'; s.edit = null; return html(listPage(s)); }
      return html(handle(s, form.cmd, form.data_index, form));
    }
    html('<p>ไม่พบหน้า</p>', 404);
  });
  return { server, DB };
}

// node mock-ltax/server.mjs [port] — run by hand to look at the simulated pages.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const { server } = createMockLtax({
    db: {
      owners: [{ id: '200001', personType: 'บุคคลธรรมดา', psnId: '1100000000016', prefixName: 'นาง', firstName: 'ทดสอบ', lastName: 'ตัวอย่าง', addrProvince: 'อุดรธานี', addrAmphur: 'น้ำโสม', addrDistrict: 'น้ำโสม' }],
      lands: [{ id: '100001', parcelCode: '60A002', docType: '6', docNo: '1234', amphur: 'น้ำโสม', district: 'น้ำโสม', rai: '15', ngan: '3', wah: '12', ownerIds: ['200001'], uses: [{ usedType: '1', rai: '15', ngan: '3', wah: '12', usedFor: '1' }] }],
    },
  });
  const port = Number(process.argv[2] || 4390);
  server.listen(port, '127.0.0.1', () => console.log(`LTAX จำลอง: http://127.0.0.1:${port}/sso/login.do`));
}
