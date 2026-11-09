import { MapView } from './map.js';
import { ENTITIES, label, LAND_USE_TYPES, buildingTypeLabel, DOC_TYPES } from './shared/schema.mjs';
import { toWah, formatNumber, num, buddhistYearNow, formatRNW } from './shared/calc.mjs';
import { CRS_LIST } from './shared/proj.mjs';
import { nextBuildingCode } from './shared/geom.mjs';
import { validateRecord } from './shared/validate.mjs';
import { diffRecord } from './shared/diff.mjs';
import { setupMapEditing } from './map-edit.js';
import { createOps } from './ops.js';
import { landTotal, useValue, buildingValue, deprTable, suggestLandPrice, suggestBuildingPrice } from './shared/valuation.mjs';

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `ผิดพลาด ${res.status}`);
  return data;
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); console.error(e); } };
function confirmBox(html, { ok = 'ยืนยัน', danger = false } = {}) {
  return new Promise(resolve => {
    const d = $('#confirmBox'); $('#confirmText').innerHTML = html;
    const yes = d.querySelector('button[value="yes"]');
    yes.textContent = ok; yes.className = danger ? 'danger-fill' : 'primary';
    d.onclose = () => resolve(d.returnValue === 'yes'); d.returnValue = ''; d.showModal();
  });
}
const fileB64 = file => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(file); });
// "2-(2)ที่อยู่อาศัย - หลังหลัก (...)" → "2-(2)ที่อยู่อาศัย"
const shortUse = v => label(LAND_USE_TYPES, v).replace(/\s.*$/, '');
const ENTITY_TH = { ...Object.fromEntries(Object.entries(ENTITIES).map(([k, v]) => [k, v.th])), parcels: 'รูปแปลง' };

// ---------- state ----------
const S = {
  rec: { owners: [], lands: [], buildings: [], signboards: [] }, by: {}, features: [], layers: [], issues: [], issuesBy: new Map(),
  settings: {}, overlay: null, join: null, selected: new Set(), checks: new Map(), pushes: new Map(), deletions: [], session: { mode: 'none' }, regSel: new Set(), deprTable: {}, landByCode: new Map(), buildingByCode: new Map(), featByCode: new Map(),
};
const ownerName = o => (o ? [o.prefixName, o.firstName, o.lastName].filter(Boolean).join(' ') : '');
const ownerNames = ids => (ids || []).map(id => ownerName(S.by.owners?.get(id))).filter(Boolean).join(', ');
const db = () => ({ ...S.rec, parcels: S.features.filter(f => f.kind === 'parcel').map(f => ({ ...f, parcelCode: f.code })) });

async function loadRecords() {
  S.rec = await api('GET', '/api/records');
  S.by = Object.fromEntries(Object.entries(S.rec).map(([k, v]) => [k, new Map(v.map(r => [r.id, r]))]));
  S.landByCode = new Map(S.rec.lands.filter(l => l.parcelCode).map(l => [l.parcelCode.toUpperCase(), l]));
  S.buildingByCode = new Map(S.rec.buildings.filter(b => b.buildingCode).map(b => [b.buildingCode.toUpperCase(), b]));
  S.deprTable = deprTable(S.rec.buildings);
}
async function loadFeatures() {
  [S.features, S.layers] = await Promise.all([api('GET', '/api/features'), api('GET', '/api/layers')]);
  S.featByCode = new Map();
  for (const f of S.features) if (f.code) S.featByCode.set(f.code, f);
}
async function loadIssues() {
  S.issues = await api('GET', '/api/validate');
  S.issuesBy = new Map();
  for (const i of S.issues) { if (!S.issuesBy.has(i.id)) S.issuesBy.set(i.id, []); S.issuesBy.get(i.id).push(i); }
  const errs = S.issues.filter(i => i.level === 'error').length;
  $('#badgeErrors').textContent = errs ? errs.toLocaleString() : '';
}
async function loadState() {
  const st = await api('GET', '/api/state');
  S.settings = st.settings;
  $('#badgePending').textContent = st.pending ? st.pending.toLocaleString() : '';
  $('#dataDir').textContent = `โฟลเดอร์ข้อมูล: ${st.dataDir}`;
  return st;
}
async function loadChecks() {
  const [checks, pushes, deletions] = await Promise.all([api('GET', '/api/checks'), api('GET', '/api/pushes'), api('GET', '/api/deletions')]);
  S.checks = new Map(checks.map(c => [c.id, c]));
  S.pushes = new Map(pushes.map(p => [p.id, p]));
  S.deletions = deletions;
}
async function reloadAll() {
  await Promise.all([loadRecords(), loadFeatures(), loadState(), loadChecks()]);
  await loadIssues();
  S.overlay = S.features.some(f => f.kind === 'building') ? await api('GET', '/api/reports/overlay') : null;
  refreshMap(true);
  renderActiveTab();
}

// ---------- tabs ----------
let activeTab = 'map';
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  activeTab = b.dataset.tab;
  $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === `tab-${activeTab}`));
  renderActiveTab();
});
function renderActiveTab() {
  ({ map: () => map.resize(), registry: renderRegistry, checks: renderChecks, changes: renderChanges, ltax: renderLtax, data: renderData, settings: renderSettings }[activeTab] || (() => {}))();
}

// ---------- map ----------
const map = new MapView($('#map'), {
  onSelect: hit => showFeature(hit?.feature || null),
  onHover: (hit, e) => {
    const tip = $('#mapTip');
    if (!hit) { tip.hidden = true; return; }
    const f = hit.feature, rec = recordOfFeature(f);
    tip.textContent = `${f.code || '(ไม่มีรหัส)'}${rec?.ownerIds ? ' · ' + ownerNames(rec.ownerIds) : ''}`;
    const r = $('#map').getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left + 14}px`; tip.style.top = `${e.clientY - r.top + 10}px`; tip.hidden = false;
  },
});
const recordOfFeature = f => (f.kind === 'parcel' ? S.landByCode.get(f.code) : f.kind === 'building' ? S.buildingByCode.get(f.code) : null);
const USE_COLORS = { 1: '#7cc576', 2: '#f4a261', 3: '#f4c27a', 4: '#e9c46a', 5: '#9b8ec4', 6: '#c9c9c9', 8: '#b0b0b0', 9: '#999', 7: '#5fb3c9' };
// Where a record stands with LTAX after L-LAN's own pushes.
function pushState(entity, rec) {
  if (!rec) return ['#dddddd', 'ไม่มีข้อมูลในทะเบียน'];
  const p = S.pushes.get(`${entity}:${rec.id}`);
  if (p?.status === 'error') return ['#d64545', 'ส่งเข้า LTAX ผิดพลาดครั้งล่าสุด'];
  if (p?.mode === 'real' && p.status === 'done') return rec.pending ? ['#f2994a', 'บันทึกแล้วแต่แก้ไขอีก รอส่ง'] : ['#1e7a4f', 'บันทึกเข้า LTAX แล้ว (L-LAN)'];
  if (rec.pending && p?.mode === 'dry' && p.status === 'done') return ['#56ccf2', 'ทดลองกรอกผ่าน รอบันทึกจริง'];
  if (rec.pending === 'create') return ['#9b51e0', 'ยังไม่มีใน LTAX รอส่ง'];
  if (rec.pending === 'update') return ['#f2c94c', 'แก้ไขแล้ว รอส่ง'];
  return ['#b7dfc2', 'ตรงกับ LTAX'];
}
const STYLE = {
  saved: (f, rec) => pushState(f.kind === 'building' ? 'buildings' : 'lands', rec),
  link: (f, rec) => {
    const chk = f.code && S.checks.get(`${f.kind}:${f.code}`);
    if (!f.code) return ['#9e9e9e', 'ไม่มีรหัส เชื่อมกับข้อมูลไม่ได้'];
    if (chk && !chk.found) return ['#d64545', 'ตรวจกับ LTAX แล้ว ไม่พบ'];
    if (chk && chk.count > 1) return ['#f2c94c', 'ตรวจกับ LTAX แล้ว พบรหัสซ้ำ'];
    if (chk) return ['#1e7a4f', 'ตรวจกับ LTAX แล้ว พบ'];
    if (rec?.ltaxId) return ['#6fcf97', 'เชื่อมกับข้อมูล LTAX ได้ (จากไฟล์นำเข้า)'];
    if (rec) return ['#9b51e0', 'มีในทะเบียน แต่ยังไม่มีใน LTAX'];
    return ['#f2994a', 'ไม่มีข้อมูลในทะเบียน'];
  },
  join: (f, rec) => f.kind === 'building' ? (rec ? ['#2f80ed', 'จอยได้ (อาคาร)'] : f.code ? ['#d64545', 'จอยไม่ได้ (อาคาร)'] : ['#888', 'อาคารไม่มีรหัส'])
    : rec ? ['#2e9d6a', 'จอยได้'] : f.code ? ['#f2994a', 'จอยไม่ได้'] : ['#999', 'ไม่มีรหัส'],
  pending: (f, rec) => !rec ? ['#bbb', 'ไม่มีในทะเบียน'] : rec.pending === 'create' ? ['#9b51e0', 'ยังไม่มีใน LTAX'] : rec.pending === 'update' ? ['#f2994a', 'แก้ไขแล้ว รอส่ง'] : ['#2e9d6a', 'ตรงกับ LTAX'],
  issues: (f, rec) => {
    const list = [...(S.issuesBy.get(f.id) || []), ...(rec ? S.issuesBy.get(rec.id) || [] : [])];
    return list.some(i => i.level === 'error') ? ['#d64545', 'มีข้อผิดพลาด'] : list.length ? ['#e2b93b', 'มีคำเตือน'] : ['#2e9d6a', 'ผ่าน'];
  },
  use: (f, rec) => {
    if (f.kind === 'building') return ['#555', 'อาคาร'];
    const u = rec?.uses?.[0]?.usedType;
    return u ? [USE_COLORS[u] || '#ccc', label(LAND_USE_TYPES, u).replace(/\s*\(.*$/, '')] : ['#ddd', 'ไม่มีข้อมูลการใช้ประโยชน์'];
  },
  overlay: f => {
    if (f.kind !== 'building') return ['#cfd8dc', 'แปลงที่ดิน'];
    const r = S.overlayBy?.get(f.id)?.result;
    return { 'ตรงแปลง': ['#2e9d6a', 'ตรงแปลง'], 'แปลงซ้อนกัน': ['#56ccf2', 'แปลงซ้อนกัน'], 'อยู่นอกแปลง': ['#d64545', 'อยู่นอกแปลง'], 'ไม่ตรงแปลง': ['#f2994a', 'ไม่ตรงแปลง'], 'ไม่มีรหัส': ['#888', 'ไม่มีรหัส'] }[r] || ['#bbb', 'ยังไม่ได้ตรวจ'];
  },
};
const lighten = (hex, k) => { const n = parseInt(hex.slice(1), 16); const m = c => Math.round(c + (255 - c) * k); return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`; };
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

function refreshMap(fit = false) {
  S.overlayBy = new Map((S.overlay?.rows || []).map(r => [r.featureId, r]));
  const mode = $('#mapColor').value;
  const legend = new Map();
  const visible = new Set(map.layers.filter(l => l.visible).map(l => l.id));
  for (const id of map.layers.map(l => l.id)) if (!S.layers.some(l => l.id === id)) map.removeLayer(id);
  const order = [...S.layers].sort((a, b) => (a.kind === 'building') - (b.kind === 'building'));
  for (const layer of order) {
    const feats = S.features.filter(f => f.layerId === layer.id);
    map.setLayer({
      id: layer.id, name: layer.name, features: feats, visible: map.layers.find(l => l.id === layer.id) ? visible.has(layer.id) : true,
      style: f => {
        const [color, text] = STYLE[mode](f, recordOfFeature(f));
        legend.set(text, color);
        // On satellite imagery: faint fill, bright line with a dark halo so boundaries stay visible.
        if (map.basemap === 'satellite') return f.kind === 'building'
          ? { fill: hexA(color, 0.45), stroke: '#ffffff', halo: 'rgba(0,0,0,.65)', width: 1.2 }
          : { fill: hexA(color, 0.12), stroke: lighten(color, 0.45), halo: 'rgba(0,0,0,.6)', width: 1.8 };
        return { fill: hexA(color, f.kind === 'building' ? 0.75 : 0.35), stroke: f.kind === 'building' ? '#1d2733' : hexA(color, 1), width: f.kind === 'building' ? 0.8 : 1 };
      },
      label: f => f.code, labelRes: layer.kind === 'building' ? 0.25 : 1.5,
    });
  }
  // Legend with counts over every feature of the visible layers.
  const counts = new Map();
  for (const f of S.features) {
    if (map.layers.find(l => l.id === f.layerId)?.visible === false) continue;
    const [color, text] = STYLE[mode](f, recordOfFeature(f));
    const k = `${f.kind === 'building' && mode !== 'overlay' ? 'อาคาร: ' : ''}${text}`;
    counts.set(k, { color, n: (counts.get(k)?.n || 0) + 1 });
  }
  $('#mapLegend').innerHTML = [...counts].map(([t, { color, n }]) => `<span><i style="background:${color}"></i>${esc(t)} <b>${n.toLocaleString()}</b></span>`).join('');
  $('#layerToggles').innerHTML = order.map(l => `<label><input type="checkbox" data-layer="${l.id}" ${map.layers.find(x => x.id === l.id)?.visible !== false ? 'checked' : ''}> ${esc(l.name)} (${l.count.toLocaleString()})</label>`).join('');
  if (fit && S.features.length && !refreshMap.fitted) { map.fit(S.features.filter(f => f.kind === 'parcel').length ? S.features.filter(f => f.kind === 'parcel') : S.features); refreshMap.fitted = true; }
  // Keep the multi-selection pointing at the freshly loaded shapes.
  if (map.multi?.size) { const ids = new Set([...map.multi].map(f => f.id)); map.multi = new Set(map.layers.flatMap(l => l.features).filter(f => ids.has(f.id))); }
  $('#mapSearchList').innerHTML = [...S.featByCode.keys()].slice(0, 5000).map(c => `<option value="${esc(c)}">`).join('');
  map.draw();
}
$('#mapColor').addEventListener('change', () => refreshMap());
$('#mapBase').addEventListener('change', e => { map.setBasemap(e.target.value); refreshMap(); });
$('#layerToggles').addEventListener('change', e => { if (e.target.dataset.layer) { map.setVisible(e.target.dataset.layer, e.target.checked); refreshMap(); } });
$('#mapSearch').addEventListener('change', e => {
  const q = e.target.value.trim().toUpperCase();
  if (!q) return;
  let f = S.featByCode.get(q);
  if (!f) {
    const owner = S.rec.owners.find(o => ownerName(o).toUpperCase().includes(q) || o.psnId === q);
    const land = owner && S.rec.lands.find(l => (l.ownerIds || []).includes(owner.id) && S.featByCode.has(l.parcelCode));
    f = land && S.featByCode.get(land.parcelCode);
  }
  if (!f) return toast('ไม่พบในแผนที่');
  map.selected = map.layers.flatMap(l => l.features).find(x => x.id === f.id) || null;
  if (map.selected) map.zoomTo(map.selected);
  showFeature(map.selected);
});

async function showFeature(f) {
  const side = $('#mapSide');
  if (!f) { side.classList.remove('open'); side.innerHTML = '<div class="empty">คลิกรูปแปลงหรืออาคารบนแผนที่เพื่อดูข้อมูล</div>'; return; }
  const full = await api('GET', `/api/features/${f.id}`);
  const layer = S.layers.find(l => l.id === f.layerId);
  const rec = recordOfFeature(f);
  const entity = f.kind === 'parcel' ? 'lands' : 'buildings';
  const issues = [...(S.issuesBy.get(f.id) || []), ...(rec ? S.issuesBy.get(rec.id) || [] : [])];
  const ov = S.overlayBy.get(f.id);
  const chk = f.code && S.checks.get(`${f.kind}:${f.code}`);
  let recHtml = '';
  if (rec && entity === 'lands') {
    recHtml = `<dl class="kv">
      <dt>เจ้าของ</dt><dd>${esc(ownerNames(rec.ownerIds)) || '-'}</dd>
      <dt>เอกสารสิทธิ์</dt><dd>${esc(label(DOC_TYPES, rec.docType))} ${esc(rec.docNo)}</dd>
      <dt>เลขที่ดิน / หน้าสำรวจ</dt><dd>${esc(rec.parcelNo || '-')} / ${esc(rec.dealingFileNo || '-')}</dd>
      <dt>หมู่ / ตำบล</dt><dd>${esc(rec.villageNo || '-')} / ${esc(rec.district || '-')}</dd>
      <dt>เนื้อที่ตามเอกสาร</dt><dd>${formatRNW(rec.rai, rec.ngan, rec.wah)} (${formatNumber(toWah(rec.rai, rec.ngan, rec.wah))} ตร.ว.)</dd>
      <dt>การใช้ประโยชน์</dt><dd>${(rec.uses || []).map(u => `${esc(label(LAND_USE_TYPES, u.usedType))} ${formatRNW(u.rai, u.ngan, u.wah)}`).join('<br>') || '-'}</dd>
      <dt>ราคาประเมิน</dt><dd>${rec.pricePerWah ? `${formatNumber(rec.pricePerWah)} บาท/ตร.ว. · รวม ${formatNumber(landTotal(rec))} บาท` : '<span class="pill warn">ยังไม่มี</span>'}${rec.ltaxValues?.tax ? `<br>ภาษีตาม LTAX ${formatNumber(rec.ltaxValues.tax)} บาท` : ''}</dd>
      <dt>สิ่งปลูกสร้าง</dt><dd>${S.rec.buildings.filter(b => (b.landIds || []).includes(rec.id)).map(b => esc(b.buildingCode || b.addrNo)).join(', ') || '-'}</dd>
    </dl>`;
  } else if (rec) {
    recHtml = `<dl class="kv">
      <dt>เจ้าของ</dt><dd>${esc(ownerNames(rec.ownerIds)) || '-'}</dd>
      <dt>เลขที่ / หมู่</dt><dd>${esc(rec.addrNo || '-')} / ${esc(rec.villageNo || '-')}</dd>
      <dt>ประเภท</dt><dd>${esc(buildingTypeLabel(rec.buildingType)) || '-'}</dd>
      <dt>ชั้น / พื้นที่</dt><dd>${esc(rec.noFloor || '-')} ชั้น / ${formatNumber(rec.totalArea)} ตร.ม.</dd>
      <dt>สร้างเสร็จ</dt><dd>${esc(rec.since || '-')}</dd>
      <dt>ราคาประเมิน</dt><dd>${(() => { const v = buildingValue(rec, S.deprTable); return rec.pricePerMeter ? `${formatNumber(rec.pricePerMeter)} บาท/ตร.ม. · ทุนทรัพย์ ${formatNumber(v.gross)} · หักค่าเสื่อม ${v.deprPct ?? '-'}% · คงเหลือ ${formatNumber(v.net)} บาท` : '<span class="pill warn">ยังไม่มี</span>'; })()}</dd>
      <dt>การใช้ประโยชน์</dt><dd>${(rec.uses || []).map(u => esc(label(LAND_USE_TYPES, u.usedType))).join('<br>') || '-'}</dd>
      <dt>แปลงที่ตั้ง</dt><dd>${(rec.landIds || []).map(id => esc(S.by.lands.get(id)?.parcelCode)).join(', ') || '-'}</dd>
    </dl>`;
  }
  side.classList.add('open');
  side.innerHTML = `
    <div class="side-head"><h3>${esc(f.code || '(ไม่มีรหัส)')}</h3><button class="close" id="sideClose" title="ปิด">✕</button></div>
    <div class="muted">${esc(layer?.name)} · FID ${f.fid}${f.areaM2 ? ` · พื้นที่ในแผนที่ ${formatNumber(f.areaM2 / 4)} ตร.ว. (${formatNumber(f.areaM2)} ตร.ม.)` : ''}</div>
    <div>${rec ? `<span class="pill" style="background:${pushState(entity, rec)[0]}33">${esc(pushState(entity, rec)[1])}</span>` : ''}${rec ? `<span class="pill ok">มีในทะเบียน</span>${rec.pending === 'create' ? '<span class="pill info">ยังไม่มีใน LTAX</span>' : rec.pending === 'update' ? '<span class="pill warn">แก้ไขแล้ว รอส่ง</span>' : '<span class="pill ok">ตรงกับ LTAX</span>'}` : '<span class="pill err">ไม่มีในทะเบียน</span>'}
      ${chk ? `<span class="pill ${chk.found ? 'ok' : 'err'}">${chk.found ? (chk.count > 1 ? `พบใน LTAX ${chk.count} รายการ` : 'พบใน LTAX') : 'ไม่พบใน LTAX'} · ตรวจ ${new Date(chk.at).toLocaleDateString('th-TH')}</span>` : ''}
      ${ov ? `<span class="pill ${ov.result === 'ตรงแปลง' || ov.result === 'แปลงซ้อนกัน' ? 'ok' : 'warn'}">${esc(ov.result)}${ov.foundParcels ? ` (${esc(ov.foundParcels)})` : ''}</span>` : ''}</div>
    ${recHtml}
    ${f.code && f.kind !== 'other' ? '<div class="row"><button id="liveLtax" title="อ่านข้อมูลปัจจุบันจาก LTAX ONLINE มาแสดง ไม่บันทึกเก็บไว้">⟳ ดูข้อมูลสดจาก LTAX</button></div><div id="liveBox"></div>' : ''}
    ${issues.length ? `<ul class="issues">${issues.map(i => `<li class="${i.level}">${esc(i.message)}</li>`).join('')}</ul>` : ''}
    <div class="row">
      ${rec ? `<button class="primary" id="sideEdit">แก้ไขข้อมูลทะเบียน</button>` : f.kind !== 'other' ? `<button class="primary" id="sideCreate">สร้างข้อมูล${f.kind === 'parcel' ? 'ที่ดิน' : 'สิ่งปลูกสร้าง'}จากรูปนี้</button>` : ''}
    </div>
    <div class="row">${/Polygon/.test(f.geometry.type) ? '<button id="shapeEdit">✎ แก้ไขรูป</button>' : ''}
      ${f.kind === 'parcel' ? '<button id="shapeAddBuilding">▭ วาดอาคารในแปลงนี้</button>' : ''}<button class="danger" id="shapeDelete">ลบรูป</button></div>
    <h4>ข้อมูลรูปแปลง (แก้ไขได้)</h4>
    <div class="form-row"><label>รหัส${layer?.codeField ? ` (${esc(layer.codeField)})` : ''}</label><input id="featCode" value="${esc(f.code)}"></div>
    <table class="grid attrs">${Object.entries(full.attrs || {}).map(([k, v]) => `<tr><th>${esc(k)}</th><td><input data-attr="${esc(k)}" value="${esc(v ?? '')}"></td></tr>`).join('')}</table>
    <div class="row"><button id="featSave">บันทึกข้อมูลรูปแปลง</button></div>`;
  $('#sideEdit')?.addEventListener('click', () => openEditor(entity, rec.id));
  $('#sideClose').addEventListener('click', () => { map.selected = null; map.draw(); showFeature(null); });
  $('#liveLtax')?.addEventListener('click', guard(async () => {
    if (S.session.mode !== 'ltax') return toast('ต้องเข้าสู่ระบบด้วย DLA SSO ก่อน', true);
    const box = $('#liveBox');
    box.innerHTML = '<p class="muted">กำลังอ่านจาก LTAX…</p>';
    try { box.innerHTML = liveHtml(await api('POST', '/api/ltax/lookup', { kind: f.kind, code: f.code })); }
    catch (e) { box.innerHTML = `<p class="pill err">${esc(e.message)}</p>`; }
  }));
  $('#shapeEdit')?.addEventListener('click', guard(() => mapEdit.editShape(f)));
  $('#shapeDelete').addEventListener('click', guard(() => mapEdit.deleteShape(f)));
  $('#shapeAddBuilding')?.addEventListener('click', () => { map.zoomTo(f, 0.15); $('#mapBar [data-tool="building-rect"]').click(); });
  $('#sideCreate')?.addEventListener('click', () => openEditor(entity, null, f.kind === 'parcel'
    ? { parcelCode: f.code, amphur: S.settings.amphur || '', ownerIds: [], uses: [] }
    : { buildingCode: f.code, ownerIds: [], landIds: S.landByCode.get(f.code.split('-')[0]) ? [S.landByCode.get(f.code.split('-')[0]).id] : [], uses: [] }));
  $('#featSave').addEventListener('click', guard(async () => {
    const attrs = Object.fromEntries($$('#mapSide [data-attr]').map(i => [i.dataset.attr, i.value]));
    for (const [k, v] of Object.entries(attrs)) if (String(full.attrs[k] ?? '') === v) delete attrs[k];
    const code = $('#featCode').value.trim().toUpperCase();
    if (!Object.keys(attrs).length && code === f.code) return toast('ไม่มีการเปลี่ยนแปลง');
    const list = [...(code !== f.code ? [`รหัส: ${f.code || '-'} → ${code || '-'}`] : []), ...Object.entries(attrs).map(([k, v]) => `${k}: ${full.attrs[k] ?? '-'} → ${v || '-'}`)];
    if (!(await confirmBox(`บันทึกข้อมูลรูปแปลง ${list.length} ช่อง?<ul>${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`))) return;
    const res = await api('PUT', `/api/features/${f.id}`, { attrs, code });
    if (res.cloudWarning) toast(res.cloudWarning, true);
    toast('บันทึกข้อมูลรูปแปลงแล้ว');
    await reloadAll();
    const again = map.layers.flatMap(l => l.features).find(x => x.id === f.id);
    map.selected = again; showFeature(again);
  }));
}

// Values read live from LTAX: shown, never stored.
function liveHtml(r) {
  if (!r.found) return `<p class="pill warn">ไม่พบ ${esc(r.code)} ใน LTAX</p>`;
  const def = ENTITIES[r.entity], v = r.values;
  const show = (d, val) => (d.type === 'select' ? label(d.list, val) || val : val);
  const rows = def.fields.filter(d => v[d.key] !== undefined && v[d.key] !== '' && v[d.key] !== false).map(d => `<dt>${esc(d.th)}</dt><dd>${esc(show(d, v[d.key]))}</dd>`).join('');
  const uses = (v.uses || []).map((u, i) => `${i + 1}. ${esc(shortUse(u.usedType))}${r.entity === 'lands' ? ` ${formatRNW(u.rai, u.ngan, u.wah)}` : u.area ? ` ${formatNumber(u.area)} ตร.ม.` : ''}${u.usedBy ? ` · ${esc(u.usedBy)}` : ''}`).join('<br>');
  const owners = (v.ownerRows || []).map(o => `${esc(o.name)}${o.psnId ? ` (${esc(o.psnId)})` : ''}`).join('<br>');
  return `<fieldset><legend>ข้อมูลสดจาก LTAX · ${new Date(r.at).toLocaleTimeString('th-TH')}</legend>
    <dl class="kv">${owners ? `<dt>เจ้าของ</dt><dd>${owners}</dd>` : ''}${rows}${uses ? `<dt>การใช้ประโยชน์</dt><dd>${uses}</dd>` : ''}</dl>
    <p class="muted">แสดงอย่างเดียว ไม่ได้บันทึกเก็บใน L-LAN หรือ Supabase</p></fieldset>`;
}

function selectFeature(id) {
  const f = id && map.layers.flatMap(l => l.features).find(x => x.id === id);
  map.selected = f || null; map.draw();
  showFeature(f || null);
}
const ops = createOps({ S, api, esc, toast, confirmBox, reloadAll: () => reloadAll(), db, onJobStarted: job => { currentJob = job; renderJob(); jobChip(); } });
// Operation on a list of records (registry selection or map selection).
async function runOp(op, entity, ids) {
  if (!ids.length) return toast('ยังไม่ได้เลือกรายการ', true);
  const items = ids.map(recordId => ({ entity, recordId }));
  if (op === 'check') return ops.checkRecords(entity, ids);
  if (op === 'ltax-check') {
    if (!['lands', 'buildings'].includes(entity)) return toast('ตรวจกับ LTAX ได้เฉพาะที่ดินและสิ่งปลูกสร้าง', true);
    const key = entity === 'lands' ? 'parcelCode' : 'buildingCode';
    return ops.runJob('check', 'dry', ids.map(id => S.by[entity].get(id)).filter(r => r?.[key]).map(r => ({ kind: entity === 'lands' ? 'parcel' : 'building', code: r[key] })));
  }
  if (op === 'push-dry') return ops.runJob('push', 'dry', items);
  if (op === 'push-real') {
    if (!S.settings.ltax?.realModeEnabled) return toast('ยังไม่ได้เปิดโหมดบันทึกจริงในหน้าตั้งค่า', true);
    return ops.runJob('push', 'real', items);
  }
  if (op === 'pull') return ops.runJob('pull', 'dry', items);
  if (op === 'prices') return ['lands', 'buildings'].includes(entity) ? ops.fillPrices(entity, ids) : toast('เติมราคาได้เฉพาะที่ดินและสิ่งปลูกสร้าง', true);
  if (op === 'delete') { if (await ops.deleteMany(entity, ids)) { S.regSel.clear(); map.multi.clear(); renderRegistry(); } return; }
  if (op === 'map') {
    const key = entity === 'lands' ? 'parcelCode' : entity === 'buildings' ? 'buildingCode' : null;
    const codes = new Set(ids.map(id => String(S.by[entity].get(id)?.[key] || '').toUpperCase()));
    const feats = map.layers.flatMap(l => l.features).filter(f => codes.has(f.code));
    if (!feats.length) return toast('รายการที่เลือกไม่มีรูปในแผนที่', true);
    map.multi = new Set(feats); $('#tabs button[data-tab="map"]').click(); map.fit(feats, 80); showSelection();
  }
}
// Map multi-select: features → records
function mapSelectionRecords() {
  const out = { lands: [], buildings: [] };
  for (const f of map.multi) { const r = recordOfFeature(f); if (r) out[f.kind === 'building' ? 'buildings' : 'lands'].push(r.id); }
  return out;
}
function showSelection() {
  const side = $('#mapSide');
  if (!map.multi.size && !map.tool?.multi) { showFeature(null); return; }
  const sel = mapSelectionRecords();
  const noRec = [...map.multi].filter(f => !recordOfFeature(f)).length;
  side.classList.add('open');
  side.innerHTML = `<div class="side-head"><h3>เลือกไว้ ${map.multi.size.toLocaleString()} รูป</h3><button class="close" id="sideClose">✕</button></div>
    <p>ที่ดิน ${sel.lands.length.toLocaleString()} แปลง · สิ่งปลูกสร้าง ${sel.buildings.length.toLocaleString()} หลัง${noRec ? ` · <span class="pill warn">ไม่มีข้อมูลทะเบียน ${noRec}</span>` : ''}</p>
    ${['lands', 'buildings'].filter(e => sel[e].length).map(e => `<fieldset><legend>${e === 'lands' ? 'ที่ดิน' : 'สิ่งปลูกสร้าง'} ${sel[e].length.toLocaleString()} รายการ</legend><div class="actions">
      <button data-mop="check" data-e="${e}">ตรวจข้อมูล</button><button data-mop="ltax-check" data-e="${e}">ตรวจว่ามีใน LTAX</button>
      <button data-mop="push-dry" data-e="${e}">ทดลองกรอก LTAX</button><button data-mop="push-real" data-e="${e}" class="danger">บันทึกเข้า LTAX</button>
      <button data-mop="pull" data-e="${e}">ดึงจาก LTAX</button><button data-mop="prices" data-e="${e}">เติมราคาประเมิน</button>
      <button data-mop="registry" data-e="${e}">ดูในทะเบียน</button></div></fieldset>`).join('')}
    <div class="row"><button id="selView">เลือกทุกแปลงในกรอบจอ</button><button id="selClear" class="link">ล้างการเลือก</button></div>
    <p class="muted">แตะรูปบนแผนที่เพื่อเพิ่มหรือเอาออกจากรายการเลือก</p>`;
  $('#sideClose').onclick = $('#selClear').onclick = () => { map.multi.clear(); map.draw(); showSelection(); };
  $('#selView').onclick = () => {
    const [x0, y0] = map.toMap([0, map.h]), [x1, y1] = map.toMap([map.w, 0]);
    for (const l of map.layers) if (l.visible) for (const f of l.features) if (f.kind === 'parcel' && f._mc[0] > x0 && f._mc[0] < x1 && f._mc[1] > y0 && f._mc[1] < y1) map.multi.add(f);
    map.draw(); showSelection();
  };
  side.querySelectorAll('[data-mop]').forEach(b => b.onclick = guard(async () => {
    const e = b.dataset.e, ids = mapSelectionRecords()[e];
    if (b.dataset.mop === 'registry') { S.regSel = new Set(ids); regEntity = e; $('#regFilter').value = 'selected'; $('#regEntity button').forEach(x => x.classList.toggle('on', x.dataset.e === e)); $('#tabs button[data-tab="registry"]').click(); return; }
    await runOp(b.dataset.mop, e, ids);
  }));
}
map.multi = new Set();
const mapEdit = setupMapEditing({ map, S, api, esc, toast, guard, confirmBox, reloadAll: () => reloadAll(), selectFeature, openEditor: (...a) => openEditor(...a), ownerNames,
  // The "เลือกหลายแปลง" tool: taps toggle shapes in the selection instead of opening one.
  onMultiTool: () => {
    map.tool = { multi: true, click: p => { const hit = map.pick(...p.screen); if (hit) { map.multi.has(hit.feature) ? map.multi.delete(hit.feature) : map.multi.add(hit.feature); map.draw(); showSelection(); } return true; } };
    toast('แตะรูปแปลงหรืออาคารเพื่อเลือกหลายรายการ');
    showSelection();
  } });
$('#toolsToggle').addEventListener('click', () => $('#mapTools').classList.toggle('collapsed'));
if (window.matchMedia('(max-width: 700px)').matches) $('#mapTools').classList.add('collapsed');

// ---------- registry ----------
let regEntity = 'lands', regPage = 0;
const PAGE = 100;
const REG_COLUMNS = {
  lands: [['รหัสแปลง', l => l.parcelCode], ['เอกสารสิทธิ์', l => `${label(DOC_TYPES, l.docType)} ${l.docNo || ''}`], ['เลขที่ดิน', l => l.parcelNo], ['หมู่', l => l.villageNo],
    ['ตำบล', l => l.district], ['เนื้อที่ (ร-ง-ว)', l => formatRNW(l.rai, l.ngan, l.wah)], ['การใช้ประโยชน์', l => (l.uses || []).map(u => shortUse(u.usedType)).join(', ')],
    ['ราคาประเมิน (บาท/ตร.ว.)', l => (l.pricePerWah ? formatNumber(l.pricePerWah) : '')], ['เจ้าของ', l => ownerNames(l.ownerIds)]],
  buildings: [['รหัสสิ่งปลูกสร้าง', b => b.buildingCode], ['เลขที่', b => b.addrNo], ['หมู่', b => b.villageNo], ['ประเภท', b => buildingTypeLabel(b.buildingType)],
    ['ชั้น', b => b.noFloor], ['พื้นที่ (ตร.ม.)', b => formatNumber(b.totalArea)], ['ราคา (บาท/ตร.ม.)', b => (b.pricePerMeter ? formatNumber(b.pricePerMeter) : '')], ['แปลง', b => (b.landIds || []).map(id => S.by.lands.get(id)?.parcelCode).join(', ')], ['เจ้าของ', b => ownerNames(b.ownerIds)]],
  owners: [['ชื่อ', o => ownerName(o)], ['เลขประจำตัว', o => o.psnId], ['ประเภท', o => o.personType], ['ที่อยู่', o => [o.addrNo, o.addrVillage && `ม.${o.addrVillage}`, o.addrDistrict, o.addrAmphur].filter(Boolean).join(' ')],
    ['ที่ดิน (แปลง)', o => S.ownerAssets?.get(o.id)?.lands || 0], ['สิ่งปลูกสร้าง (หลัง)', o => S.ownerAssets?.get(o.id)?.buildings || 0]],
  signboards: [['ข้อความในป้าย', s => s.signboardName], ['เลขที่', s => s.addrNo], ['หมู่', s => s.villageNo], ['ขนาด (ซม.)', s => s.width && `${s.width}×${s.height}`], ['เจ้าของ', s => ownerNames(s.ownerIds)]],
};
$('#regEntity').addEventListener('click', e => {
  const b = e.target.closest('button[data-e]'); if (!b) return;
  regEntity = b.dataset.e; regPage = 0; S.regSel.clear();
  $$('#regEntity button').forEach(x => x.classList.toggle('on', x === b));
  renderRegistry();
});
$('#regSearch').addEventListener('input', () => { regPage = 0; renderRegistry(); });
$('#regFilter').addEventListener('change', () => { regPage = 0; renderRegistry(); });
$('#regAdd').addEventListener('click', () => openEditor(regEntity, null, { ownerIds: [], landIds: [], uses: [], amphur: S.settings.amphur || '' }));

function regRows() {
  const q = $('#regSearch').value.trim().toLowerCase();
  const filter = $('#regFilter').value;
  const cols = REG_COLUMNS[regEntity];
  return S.rec[regEntity].filter(r => {
    if (filter === 'pending' && !r.pending) return false;
    if (filter === 'create' && r.pending !== 'create') return false;
    if (filter === 'error' && !(S.issuesBy.get(r.id) || []).some(i => i.level === 'error')) return false;
    if (filter === 'selected' && !S.regSel.has(r.id)) return false;
    if (filter === 'noprice' && !(regEntity === 'lands' ? !r.pricePerWah : regEntity === 'buildings' ? !r.pricePerMeter : false)) return false;
    if (filter === 'saved' && pushState(regEntity, r)[1] !== 'บันทึกเข้า LTAX แล้ว (L-LAN)') return false;
    if (filter === 'pusherr' && S.pushes.get(`${regEntity}:${r.id}`)?.status !== 'error') return false;
    if (filter === 'noshape') {
      const code = regEntity === 'lands' ? r.parcelCode : regEntity === 'buildings' ? r.buildingCode : null;
      if (code === null || S.featByCode.has(String(code || '').toUpperCase())) return false;
    }
    return !q || cols.some(([, fn]) => String(fn(r) ?? '').toLowerCase().includes(q));
  });
}
function renderRegistry() {
  if (!$('#regFilter option[value="selected"]')) $('#regFilter').insertAdjacentHTML('beforeend', '<option value="selected">เฉพาะที่เลือก</option>');
  S.ownerAssets = new Map();
  for (const c of ['lands', 'buildings']) for (const r of S.rec[c]) for (const o of r.ownerIds || []) { const a = S.ownerAssets.get(o) || { lands: 0, buildings: 0 }; a[c]++; S.ownerAssets.set(o, a); }
  const rows = regRows(), cols = REG_COLUMNS[regEntity];
  S.regRows = rows;
  const page = rows.slice(regPage * PAGE, regPage * PAGE + PAGE);
  const allOnPage = page.length && page.every(r => S.regSel.has(r.id));
  $('#regTable').innerHTML = `<tr><th><input type="checkbox" id="regPageAll" title="เลือกทั้งหน้า" ${allOnPage ? 'checked' : ''}></th>${cols.map(([h]) => `<th>${h}</th>`).join('')}<th>สถานะ</th></tr>` + page.map(r => {
    const iss = S.issuesBy.get(r.id) || [];
    const ps = ['lands', 'buildings', 'owners'].includes(regEntity) ? pushState(regEntity, r) : null;
    const st = [ps && ps[1] !== 'ตรงกับ LTAX' ? `<span class="pill" style="background:${ps[0]}44">${esc(ps[1])}</span>` : '',
      iss.some(i => i.level === 'error') ? '<span class="pill err">ผิดพลาด</span>' : iss.length ? '<span class="pill warn">เตือน</span>' : ''].join('');
    return `<tr class="click${S.regSel.has(r.id) ? ' sel' : ''}" data-id="${r.id}"><td><input type="checkbox" data-sel="${r.id}" ${S.regSel.has(r.id) ? 'checked' : ''}></td>${cols.map(([, fn]) => `<td>${esc(fn(r))}</td>`).join('')}<td>${st}</td></tr>`;
  }).join('');
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  $('#regPager').innerHTML = `<button ${regPage ? '' : 'disabled'} data-p="-1">‹ ก่อนหน้า</button> หน้า ${regPage + 1} / ${pages} · ${rows.length.toLocaleString()} รายการ <button ${regPage + 1 < pages ? '' : 'disabled'} data-p="1">ถัดไป ›</button>
    <button class="link" id="regSelAll">เลือกทั้งหมดที่กรองไว้ (${rows.length.toLocaleString()})</button>`;
  regActions();
}
function regActions() {
  $('#regActions').hidden = !S.regSel.size;
  $('#regSelCount').textContent = `เลือก ${S.regSel.size.toLocaleString()} รายการ`;
  const has = op => ({ prices: ['lands', 'buildings'], map: ['lands', 'buildings'], 'ltax-check': ['lands', 'buildings'], 'push-dry': ['owners', 'lands', 'buildings'], 'push-real': ['owners', 'lands', 'buildings'], pull: ['owners', 'lands', 'buildings'] }[op] || null);
  $$('#regActions [data-op]').forEach(b => { const ok = has(b.dataset.op); b.hidden = ok ? !ok.includes(regEntity) : false; });
}
$('#regTable').addEventListener('click', e => {
  if (e.target.id === 'regPageAll') {
    const page = S.regRows.slice(regPage * PAGE, regPage * PAGE + PAGE);
    page.forEach(r => (e.target.checked ? S.regSel.add(r.id) : S.regSel.delete(r.id)));
    return renderRegistry();
  }
  if (e.target.dataset.sel) { e.target.checked ? S.regSel.add(e.target.dataset.sel) : S.regSel.delete(e.target.dataset.sel); e.target.closest('tr').classList.toggle('sel', e.target.checked); return regActions(); }
  if (e.target.closest('td')?.querySelector('[data-sel]') === e.target) return;
  const tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('td:first-child')) openEditor(regEntity, tr.dataset.id);
});
$('#regPager').addEventListener('click', e => {
  if (e.target.id === 'regSelAll') { S.regRows.forEach(r => S.regSel.add(r.id)); return renderRegistry(); }
  const b = e.target.closest('button[data-p]'); if (b) { regPage += Number(b.dataset.p); renderRegistry(); }
});
$('#regActions').addEventListener('click', guard(async e => {
  const op = e.target.closest('[data-op]')?.dataset.op; if (!op) return;
  if (op === 'clear') { S.regSel.clear(); return renderRegistry(); }
  // Keep the table order so batches run in the order shown
  const ids = S.regRows.filter(r => S.regSel.has(r.id)).map(r => r.id);
  await runOp(op, regEntity, ids.length ? ids : [...S.regSel]);
}));

// ---------- record editor ----------
function fieldInput(def, value, synced, prefix = '') {
  const name = prefix + def.key;
  const was = synced?.[def.key];
  const changed = synced && was !== undefined && String(was ?? '') !== String(value ?? '');
  const cls = changed ? 'changed' : '';
  const title = changed ? ` title="ค่าใน LTAX: ${esc(was || '(ว่าง)')}"` : '';
  if (def.type === 'select') {
    const opts = def.list.some(([v]) => v === String(value ?? '')) || !value ? def.list : [[String(value), `${value} (ไม่อยู่ในรายการ)`], ...def.list];
    return `<select name="${name}" class="${cls}"${title}><option value="">- เลือก -</option>${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(value ?? '') === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  }
  if (def.type === 'combo') return `<input name="${name}" value="${esc(value)}" list="dl-${def.key}" class="${cls}"${title}><datalist id="dl-${def.key}">${def.list.map(([v]) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  if (def.type === 'textarea') return `<textarea name="${name}" class="${cls}"${title}>${esc(value)}</textarea>`;
  if (def.type === 'checkbox') return `<input type="checkbox" name="${name}" ${value ? 'checked' : ''}>`;
  return `<input name="${name}" value="${esc(value)}" ${def.type === 'number' ? 'inputmode="decimal"' : ''} class="${cls}"${title}>`;
}

// Appraisal block of the editor: computed totals, LTAX's own figures and a suggested price when missing.
function valuationHtml(entity, rec) {
  if (entity === 'lands') {
    const total = landTotal(rec), sug = !rec.pricePerWah && suggestLandPrice(rec, S.rec.lands);
    const lv = rec.ltaxValues || {};
    return `<fieldset><legend>ราคาประเมิน</legend><dl class="kv">
      <dt>ราคาต่อ ตร.ว.</dt><dd>${rec.pricePerWah ? `${formatNumber(rec.pricePerWah)} บาท` : '<span class="pill warn">ยังไม่มี</span>'}
        ${sug ? ` <button type="button" data-suggest="pricePerWah" data-value="${sug.value}">ใช้ราคาแนะนำ ${formatNumber(sug.value)} บาท (${esc(sug.basis)} ${sug.n} แปลง)</button>` : ''}</dd>
      <dt>ราคาประเมินรวม (คำนวณ)</dt><dd>${total === null ? '-' : `${formatNumber(total)} บาท`}</dd>
      ${lv.totalPrice || lv.tax ? `<dt>ตามข้อมูล LTAX</dt><dd>รวม ${formatNumber(lv.totalPrice)} บาท${lv.tax ? ` · ภาษีสุทธิ ${formatNumber(lv.tax)} บาท` : ''}</dd>` : ''}
      ${(rec.uses || []).length ? `<dt>แยกตามการใช้ประโยชน์</dt><dd>${rec.uses.map((u, i) => `${i + 1}. ${esc(shortUse(u.usedType))}: ${useValue(u, rec) === null ? '-' : formatNumber(useValue(u, rec))} บาท${u.ltax?.taxRate ? ` · อัตรา ${u.ltax.taxRate}% · ภาษี ${formatNumber(u.ltax.tax)} บาท (LTAX)` : ''}`).join('<br>')}</dd>` : ''}
    </dl></fieldset>`;
  }
  if (entity === 'buildings') {
    const v = buildingValue(rec, S.deprTable), sug = !rec.pricePerMeter && rec.buildingType && suggestBuildingPrice(rec, S.rec.buildings);
    const lv = rec.ltaxValues || {};
    return `<fieldset><legend>ราคาประเมิน</legend><dl class="kv">
      <dt>ราคาต่อ ตร.ม.</dt><dd>${rec.pricePerMeter ? `${formatNumber(rec.pricePerMeter)} บาท` : '<span class="pill warn">ยังไม่มี</span>'}
        ${sug ? ` <button type="button" data-suggest="pricePerMeter" data-value="${sug.value}">ใช้ราคาแนะนำ ${formatNumber(sug.value)} บาท (${esc(sug.basis)} ${sug.n} หลัง)</button>` : ''}</dd>
      <dt>ราคาทุนทรัพย์ (คำนวณ)</dt><dd>${v.gross === null ? '-' : `${formatNumber(v.gross)} บาท`}</dd>
      <dt>หักค่าเสื่อม</dt><dd>${v.deprPct === null ? '-' : `${v.deprPct}% (${v.deprSource === 'ltax' ? 'ตาม LTAX' : 'ประมาณจากอาคารลักษณะและอายุเดียวกัน'}) = ${formatNumber(v.depr)} บาท`}</dd>
      <dt>คงเหลือ</dt><dd>${v.net === null ? '-' : `${formatNumber(v.net)} บาท`}</dd>
      ${lv.netPrice ? `<dt>ตามข้อมูล LTAX</dt><dd>ทุนทรัพย์ ${formatNumber(lv.totalPrice)} · ค่าเสื่อม ${formatNumber(lv.deprAmount)} · คงเหลือ ${formatNumber(lv.netPrice)} บาท</dd>` : ''}
    </dl></fieldset>`;
  }
  return '';
}

// Buildings and signboards on a land: linked records, plus buildings whose code starts with the parcel code.
function assetsOnLand(land) {
  const code = String(land.parcelCode || '').toUpperCase();
  const blds = S.rec.buildings.filter(b => (land.id && (b.landIds || []).includes(land.id)) || (code && String(b.buildingCode || '').toUpperCase().startsWith(`${code}-`)));
  const signs = S.rec.signboards.filter(sg => (land.id && sg.landId === land.id) || (code && String(sg.landCode || '').toUpperCase() === code));
  const pend = r => (r.pending === 'create' ? '<span class="pill info">ยังไม่มีใน LTAX</span>' : r.pending === 'update' ? '<span class="pill warn">รอส่ง</span>' : '');
  return `<fieldset><legend>สิ่งปลูกสร้างในแปลงนี้ (${blds.length})</legend>
    ${blds.length ? `<table class="grid"><tr><th>รหัส</th><th>เลขที่</th><th>ประเภท</th><th>ชั้น</th><th>พื้นที่ (ตร.ม.)</th><th>การใช้ประโยชน์</th><th>เจ้าของ</th><th></th></tr>
      ${blds.map(b => `<tr><td>${esc(b.buildingCode)} ${S.featByCode.has(String(b.buildingCode || '').toUpperCase()) ? '' : '<span class="pill warn">ไม่มีรูป</span>'}</td><td>${esc(b.addrNo)}</td><td>${esc(buildingTypeLabel(b.buildingType))}</td>
        <td>${esc(b.noFloor)}</td><td class="num">${formatNumber(b.totalArea)}</td><td>${(b.uses || []).map(u => esc(shortUse(u.usedType))).join(', ')}</td>
        <td>${esc(ownerNames(b.ownerIds))}</td><td>${pend(b)} <button type="button" data-openrec="buildings:${b.id}">เปิด</button></td></tr>`).join('')}</table>` : '<p class="muted">ยังไม่มีสิ่งปลูกสร้างในทะเบียน</p>'}
    <div class="row"><button type="button" id="addBuildingOnLand">+ เพิ่มสิ่งปลูกสร้างในแปลงนี้</button></div></fieldset>
    <fieldset><legend>ป้ายในแปลงนี้ (${signs.length})</legend>
    ${signs.length ? `<table class="grid"><tr><th>ข้อความในป้าย</th><th>ขนาด (ซม.)</th><th>ด้าน</th><th>เจ้าของ</th><th></th></tr>
      ${signs.map(sg => `<tr><td>${esc(sg.signboardName)}</td><td>${esc(sg.width ? `${sg.width}×${sg.height}` : '')}</td><td>${esc(sg.noSide)}</td><td>${esc(ownerNames(sg.ownerIds))}</td>
        <td>${pend(sg)} <button type="button" data-openrec="signboards:${sg.id}">เปิด</button></td></tr>`).join('')}</table>` : '<p class="muted">ไม่มีป้าย</p>'}</fieldset>`;
}

function openEditor(entity, id, preset = {}) {
  const def = ENTITIES[entity];
  const rec = id ? structuredClone(S.by[entity].get(id)) : { ...preset };
  const original = JSON.stringify(rec);
  const isDirty = () => JSON.stringify(rec) !== original;
  const d = $('#editor'), form = $('#editorForm');
  const groups = [];
  for (const f of def.fields) {
    const g = f.group || '';
    let grp = groups.find(x => x.name === g);
    if (!grp) groups.push(grp = { name: g, fields: [] });
    grp.fields.push(f);
  }
  const usesHtml = () => !def.uses ? '' : `<fieldset class="uses"><legend>การใช้ประโยชน์</legend><table><tr>${def.uses.map(u => `<th>${esc(u.th)}</th>`).join('')}<th></th></tr>
    ${(rec.uses || []).map((u, i) => `<tr>${def.uses.map(x => `<td>${fieldInput(x, u[x.key], rec.synced?.uses?.[i], `uses.${i}.`)}</td>`).join('')}<td><button type="button" data-deluse="${i}">ลบ</button></td></tr>`).join('')}
    </table><div class="row"><button type="button" id="addUse">+ เพิ่มการใช้ประโยชน์</button><span class="muted" id="useSum"></span></div></fieldset>`;
  const linkHtml = (key, th, items, listId, options) => `<fieldset><legend>${th}</legend><div class="links">${items.map(it => `<span class="pill">${esc(it.text)}<button type="button" data-unlink="${key}:${it.id}">×</button></span>`).join('') || '<span class="muted">ยังไม่มี</span>'}
    <input list="${listId}" data-link="${key}" placeholder="พิมพ์เพื่อค้นหาแล้วเลือก"><datalist id="${listId}">${options}</datalist></div></fieldset>`;
  const render = () => {
    const issues = validateRecord(entity, rec, { ...db(), [entity]: [...S.rec[entity].filter(r => r.id !== rec.id), rec] }, { areaTolerance: (S.settings.areaTolerance ?? 10) / 100 });
    const bad = new Set(issues.filter(i => i.level === 'error').map(i => i.field));
    const changes = rec.synced ? diffRecord(entity, rec) || [] : null;
    const ownerOpts = S.rec.owners.slice(0, 6000).map(o => `<option value="${esc(`${ownerName(o)} | ${o.psnId || '-'} | ${o.id}`)}">`).join('');
    const landOpts = S.rec.lands.map(l => `<option value="${esc(`${l.parcelCode} | ${ownerNames(l.ownerIds)} | ${l.id}`)}">`).join('');
    form.innerHTML = `<div class="head"><h3>${id ? 'แก้ไข' : 'เพิ่ม'}${def.th}: ${esc(def.title(rec))}</h3>
        ${rec.ltaxId ? `<span class="pill">รหัสใน LTAX ${esc(rec.ltaxId)}</span>` : '<span class="pill info">ยังไม่มีใน LTAX</span>'}
        <button type="button" data-close>ปิด</button></div>
      <div class="body">
        ${issues.length ? `<ul class="issues">${issues.map(i => `<li class="${i.level}">${esc(i.message)}</li>`).join('')}</ul>` : '<p class="pill ok">ผ่านการตรวจสอบ</p>'}
        ${changes && changes.length ? `<p class="muted">ช่องสีเหลือง = ต่างจากค่าใน LTAX (${changes.length} ช่อง) ชี้ที่ช่องเพื่อดูค่าเดิม</p>` : ''}
        ${groups.map(g => `<fieldset><legend>${esc(g.name || 'ข้อมูลหลัก')}</legend><div class="fields">${g.fields.map(f => `<label class="${f.type === 'textarea' ? 'wide' : ''}"><span>${esc(f.th)}${f.required ? ' <span class="req">*</span>' : ''}</span>${fieldInput(f, rec[f.key], rec.synced).replace(/class="([^"]*)"/, (m, c) => `class="${c}${bad.has(f.key) ? ' bad' : ''}"`)}</label>`).join('')}</div></fieldset>`).join('')}
        ${valuationHtml(entity, rec)}
        ${entity === 'lands' ? `<p class="muted">รวมเนื้อที่ ${formatNumber(toWah(rec.rai, rec.ngan, rec.wah))} ตร.ว.${S.featByCode.get(String(rec.parcelCode || '').toUpperCase())?.areaM2 ? ` · รูปแปลงในแผนที่ ${formatNumber(S.featByCode.get(rec.parcelCode.toUpperCase()).areaM2 / 4)} ตร.ว.` : ''}</p>` : ''}
        ${entity === 'buildings' ? `<div class="row"><button type="button" id="calcArea">คำนวณพื้นที่ = กว้าง × ยาว × ชั้น</button><button type="button" id="calcAge">คำนวณอายุจากปีที่สร้างเสร็จ</button></div>` : ''}
        ${usesHtml()}
        ${['lands', 'buildings', 'signboards'].includes(entity) ? linkHtml('ownerIds', 'เจ้าของกรรมสิทธิ์', (rec.ownerIds || []).map(oid => ({ id: oid, text: ownerName(S.by.owners.get(oid)) || '(ไม่พบ)' })), 'dl-owners', ownerOpts) : ''}
        ${entity === 'lands' ? assetsOnLand(rec) : ''}
        ${entity === 'buildings' ? linkHtml('landIds', 'แปลงที่ดินที่ตั้ง', (rec.landIds || []).map(lid => ({ id: lid, text: S.by.lands.get(lid)?.parcelCode || '(ไม่พบ)' })), 'dl-lands', landOpts) : ''}
      </div>
      <div class="foot">${id ? '<button type="button" class="danger" id="delRec">ลบในเครื่อง</button>' : ''}<span class="grow"></span>
        <button type="button" data-close>ยกเลิก</button><button type="button" class="primary" id="saveRec">บันทึก</button></div>`;
    if (def.uses) {
      const total = entity === 'lands' ? toWah(rec.rai, rec.ngan, rec.wah) : num(rec.totalArea) || 0;
      const used = entity === 'lands' ? (rec.uses || []).reduce((s, u) => s + toWah(u.rai, u.ngan, u.wah), 0) : (rec.uses || []).reduce((s, u) => s + (num(u.area) || 0), 0);
      $('#useSum').textContent = `ใช้แล้ว ${formatNumber(used)} จาก ${formatNumber(total)} ${entity === 'lands' ? 'ตร.ว.' : 'ตร.ม.'}`;
    }
  };
  const read = () => {
    for (const el of form.querySelectorAll('[name]')) {
      const val = el.type === 'checkbox' ? el.checked : el.value.trim();
      const m = el.name.match(/^uses\.(\d+)\.(\w+)$/);
      if (m) rec.uses[m[1]][m[2]] = val; else rec[el.name] = val;
    }
  };
  form.oninput = e => { if (e.target.dataset.link) return; read(); };
  form.onchange = e => {
    const key = e.target.dataset.link;
    if (key) {
      const idPart = e.target.value.split('|').pop().trim();
      if ((key === 'ownerIds' ? S.by.owners : S.by.lands).has(idPart)) { rec[key] = [...new Set([...(rec[key] || []), idPart])]; render(); }
      return;
    }
    read(); render();
  };
  const leave = async () => !isDirty() || confirmBox('ยังไม่ได้บันทึกการแก้ไข ต้องการปิดโดยไม่บันทึกหรือไม่?', { ok: 'ปิดโดยไม่บันทึก', danger: true });
  d.oncancel = e => { e.preventDefault(); guard(async () => { if (await leave()) d.close(); })(); };
  form.onclick = guard(async e => {
    const t = e.target.closest('button') || e.target;
    if (t.dataset.close !== undefined) { if (await leave()) d.close(); }
    else if (t.dataset.openrec) { if (await leave()) { const [en, rid] = t.dataset.openrec.split(':'); d.close(); openEditor(en, rid); } }
    else if (t.id === 'addBuildingOnLand') {
      if (!rec.id) return toast('บันทึกที่ดินก่อน แล้วจึงเพิ่มสิ่งปลูกสร้าง', true);
      if (await leave()) {
        const codes = [...S.rec.buildings.map(b => b.buildingCode), ...S.features.map(f => f.code)].filter(Boolean);
        d.close();
        openEditor('buildings', null, { buildingCode: rec.parcelCode ? nextBuildingCode(rec.parcelCode, codes) : '', landIds: [rec.id], ownerIds: [...(rec.ownerIds || [])], villageNo: rec.villageNo || '', noFloor: '1', uses: [] });
      }
    }
    else if (t.dataset.suggest) { read(); rec[t.dataset.suggest] = t.dataset.value; render(); }
    else if (t.id === 'addUse') { read(); rec.uses = [...(rec.uses || []), {}]; render(); }
    else if (t.dataset.deluse !== undefined) { read(); rec.uses.splice(Number(t.dataset.deluse), 1); render(); }
    else if (t.dataset.unlink) { read(); const [k, v] = t.dataset.unlink.split(':'); rec[k] = (rec[k] || []).filter(x => x !== v); render(); }
    else if (t.id === 'calcArea') { read(); const a = (num(rec.width) || 0) * (num(rec.length) || 0) * (num(rec.noFloor) || 1); if (a) rec.totalArea = String(Math.round(a * 100) / 100); render(); }
    else if (t.id === 'calcAge') { read(); if (num(rec.since)) rec.age = String(buddhistYearNow() - num(rec.since)); render(); }
    else if (t.id === 'delRec' && entity === 'owners') {
      if (isDirty() && !(await confirmBox('ยังไม่ได้บันทึกการแก้ไข ต้องการทิ้งแล้วไปลบหรือไม่?', { ok: 'ทิ้งแล้วไปลบ', danger: true }))) return;
      d.close();
      if (!(await ops.deleteOwner(id))) openEditor(entity, id);
    }
    else if (t.id === 'delRec') {
      if (!(await confirmBox(`ลบ <b>${esc(def.title(rec))}</b> ออกจาก L-LAN?<br><span class="muted">ลบเฉพาะในเครื่อง ไม่ลบใน LTAX</span>`))) return;
      await api('DELETE', `/api/${entity}/${id}`); d.close(); toast('ลบแล้ว'); await reloadAll();
    } else if (t.id === 'saveRec') {
      read();
      if (id && !isDirty()) { d.close(); return toast('ไม่มีการเปลี่ยนแปลง'); }
      const before = id ? S.by[entity].get(id) : {};
      const changed = [...def.fields.filter(f => String(before[f.key] ?? '') !== String(rec[f.key] ?? '')).map(f => `${f.th}: ${before[f.key] || '-'} → ${rec[f.key] || '-'}`),
        ...(JSON.stringify(before.uses || []) !== JSON.stringify(rec.uses || []) ? ['การใช้ประโยชน์'] : []),
        ...(JSON.stringify(before.ownerIds || []) !== JSON.stringify(rec.ownerIds || []) ? ['เจ้าของ'] : []),
        ...(JSON.stringify(before.landIds || []) !== JSON.stringify(rec.landIds || []) ? ['แปลงที่ดินที่ตั้ง'] : [])];
      const errs = validateRecord(entity, rec, { ...db(), [entity]: [...S.rec[entity].filter(r => r.id !== rec.id), rec] }).filter(i => i.level === 'error');
      if (!(await confirmBox(`${id ? `บันทึกการแก้ไข${def.th} <b>${esc(def.title(rec))}</b> ${changed.length} รายการ?` : `เพิ่ม${def.th} <b>${esc(def.title(rec))}</b>?`}
        ${id ? `<ul>${changed.slice(0, 15).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${errs.length ? `<p class="pill err">ยังมีข้อผิดพลาด ${errs.length} รายการ บันทึกในเครื่องได้ แต่ยังส่งเข้า LTAX ไม่ได้</p>` : ''}`, { ok: 'บันทึก' }))) return;
      const saved = id ? await api('PUT', `/api/${entity}/${id}`, rec) : await api('POST', `/api/${entity}`, rec);
      d.close();
      toast(`บันทึก${def.th} ${def.title(saved)} แล้ว`);
      await reloadAll();
    }
  });
  render();
  d.showModal();
}

// ---------- checks ----------
let chkPage = 0;
['#chkLevel', '#chkEntity', '#chkSearch'].forEach(s => $(s).addEventListener('input', () => { chkPage = 0; renderChecks(); }));
$('#chkRefresh').addEventListener('click', guard(async () => { await loadIssues(); renderChecks(); toast('ตรวจใหม่แล้ว'); }));
const titleOf = (entity, id) => {
  if (entity === 'parcels') { const f = S.features.find(x => x.id === id); return f ? `รูปแปลง ${f.code || f.fid}` : ''; }
  const r = S.by[entity]?.get(id); return r ? ENTITIES[entity].title(r) : '';
};
function renderChecks() {
  const lv = $('#chkLevel').value, en = $('#chkEntity').value, q = $('#chkSearch').value.trim();
  const rows = S.issues.filter(i => (!lv || i.level === lv) && (!en || i.entity === en) && (!q || i.message.includes(q) || titleOf(i.entity, i.id).includes(q)));
  const groups = new Map();
  for (const i of S.issues) { const k = `${i.level}|${ENTITY_TH[i.entity]}|${i.message.replace(/[\d,.]+|"[^"]*"/g, '…')}`; groups.set(k, (groups.get(k) || 0) + 1); }
  const errs = S.issues.filter(i => i.level === 'error').length;
  $('#chkSummary').innerHTML = `<div class="card err"><b>${errs.toLocaleString()}</b>ผิดพลาด (ส่งเข้า LTAX ไม่ได้)</div><div class="card warn"><b>${(S.issues.length - errs).toLocaleString()}</b>คำเตือน</div>`
    + [...groups].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => { const [l, e, m] = k.split('|'); return `<div class="card ${l === 'error' ? 'err' : 'warn'}"><b>${n.toLocaleString()}</b>${esc(e)}: ${esc(m)}</div>`; }).join('');
  const page = rows.slice(chkPage * PAGE, chkPage * PAGE + PAGE);
  $('#chkTable').innerHTML = '<tr><th>ระดับ</th><th>ประเภท</th><th>รายการ</th><th>รายละเอียด</th></tr>' + page.map(i =>
    `<tr class="click" data-e="${i.entity}" data-id="${i.id}"><td><span class="pill ${i.level === 'error' ? 'err' : 'warn'}">${i.level === 'error' ? 'ผิดพลาด' : 'เตือน'}</span></td><td>${esc(ENTITY_TH[i.entity])}</td><td>${esc(titleOf(i.entity, i.id))}</td><td>${esc(i.message)}</td></tr>`).join('');
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  $('#chkPager').innerHTML = `<button ${chkPage ? '' : 'disabled'} data-p="-1">‹</button> หน้า ${chkPage + 1} / ${pages} · ${rows.length.toLocaleString()} รายการ <button ${chkPage + 1 < pages ? '' : 'disabled'} data-p="1">›</button>`;
}
$('#chkPager').addEventListener('click', e => { const b = e.target.closest('button[data-p]'); if (b) { chkPage += Number(b.dataset.p); renderChecks(); } });
$('#chkTable').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  if (tr.dataset.e === 'parcels') {
    const f = map.layers.flatMap(l => l.features).find(x => x.id === tr.dataset.id);
    $('#tabs button[data-tab="map"]').click();
    if (f) { map.selected = f; map.zoomTo(f); showFeature(f); }
  } else openEditor(tr.dataset.e, tr.dataset.id);
});

// ---------- changes ----------
let chgView = 'pending';
$('#chgView').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  chgView = b.dataset.v; $$('#chgView button').forEach(x => x.classList.toggle('on', x === b)); renderChanges();
});
const ACTION_TH = { create: 'เพิ่ม', update: 'แก้ไข', delete: 'ลบ' };
async function renderChanges() {
  if (chgView === 'log') {
    const log = await api('GET', '/api/log?limit=400');
    $('#chgSummary').innerHTML = `<div class="card"><b>${log.length}</b>รายการล่าสุด</div>`;
    $('#chgList').innerHTML = log.map(l => {
      const diffs = l.before && l.after ? Object.keys({ ...l.before, ...l.after }).filter(k => !['updatedAt', 'pending', 'pendingCount'].includes(k) && JSON.stringify(l.before[k]) !== JSON.stringify(l.after[k])) : [];
      const who = { user: 'ผู้ใช้', 'ltax-pull': 'ดึงจาก LTAX', 'ltax-push': 'ส่งเข้า LTAX' }[l.by] || l.by || '';
      return `<div class="item"><header><b>${esc(ENTITY_TH[l.entity] || l.entity)}</b> ${esc(ACTION_TH[l.action] || l.action)} <span class="muted">${new Date(l.at).toLocaleString('th-TH')} · ${esc(who)}${l.reason ? ' · ' + esc(l.reason) : ''}</span></header>
        ${diffs.length ? `<ul>${diffs.slice(0, 20).map(k => `<li>${esc(k)}: <span class="from">${esc(JSON.stringify(l.before[k]) ?? '')}</span> → <span class="to">${esc(JSON.stringify(l.after[k]) ?? '')}</span></li>`).join('')}</ul>`
          : l.after && !l.before ? `<div class="muted">${esc(JSON.stringify(l.after).slice(0, 200))}</div>` : ''}</div>`;
    }).join('') || '<p class="muted">ยังไม่มีประวัติ</p>';
    return;
  }
  const list = await api('GET', '/api/changes');
  const errIds = new Set(S.issues.filter(i => i.level === 'error').map(i => i.id));
  const by = list.reduce((m, c) => ((m[`${c.entityTh}|${c.action}`] = (m[`${c.entityTh}|${c.action}`] || 0) + 1), m), {});
  $('#chgSummary').innerHTML = Object.entries(by).map(([k, n]) => { const [e, a] = k.split('|'); return `<div class="card ${a === 'create' ? '' : 'warn'}"><b>${n.toLocaleString()}</b>${esc(e)} ${a === 'create' ? 'ยังไม่มีใน LTAX' : 'แก้ไขแล้ว รอส่ง'}</div>`; }).join('')
    || '<div class="card ok"><b>0</b>ข้อมูลตรงกับ LTAX ทั้งหมด</div>';
  const shown = list.slice(0, 500);
  if (S.deletions.length) $('#chgSummary').insertAdjacentHTML('beforeend', `<div class="card err"><b>${S.deletions.length.toLocaleString()}</b>ลบในเครื่องแล้ว รอลบใน LTAX</div>`);
  const delHtml = S.deletions.length ? `<div class="item"><header><b>รอลบใน LTAX (${S.deletions.length})</b><span class="muted">L-LAN ไม่ลบใน LTAX ให้ ต้องลบในระบบเอง แล้วกด "ลบใน LTAX แล้ว"</span></header>
    <ul>${S.deletions.map(x => `<li>${esc(ENTITY_TH[x.entity])} ${esc(x.title)} (รหัสใน LTAX ${esc(x.ltaxId)}) <button data-deldone="${esc(x.id)}">ลบใน LTAX แล้ว</button></li>`).join('')}</ul></div>` : '';
  $('#chgList').innerHTML = delHtml + `<div class="row"><label class="check"><input type="checkbox" id="chgAll"> เลือกทั้งหมด (ไม่รวมรายการที่มีข้อผิดพลาด)</label><span class="muted">${list.length > 500 ? `แสดง 500 จาก ${list.length.toLocaleString()} รายการ` : ''}</span></div>`
    + shown.map(c => `<div class="item"><header><input type="checkbox" data-sel="${c.entity}:${c.id}" ${S.selected.has(`${c.entity}:${c.id}`) ? 'checked' : ''} ${errIds.has(c.id) ? 'disabled title="มีข้อผิดพลาด ต้องแก้ก่อนส่ง"' : ''}>
      <b>${esc(c.entityTh)} ${esc(c.title)}</b> <span class="pill ${c.action === 'create' ? 'info' : 'warn'}">${c.action === 'create' ? 'ยังไม่มีใน LTAX' : `แก้ ${c.changes.length} ช่อง`}</span>
      ${errIds.has(c.id) ? '<span class="pill err">มีข้อผิดพลาด</span>' : ''}<span class="grow"></span><button data-open="${c.entity}:${c.id}">เปิด</button></header>
      ${c.changes.length ? `<ul>${c.changes.map(x => `<li>${esc(x.th)}: <span class="from">${esc(x.before || '(ว่าง)')}</span> → <span class="to">${esc(x.after || '(ว่าง)')}</span></li>`).join('')}</ul>` : ''}</div>`).join('');
  $('#chgAll').onchange = e => { for (const c of list) if (!errIds.has(c.id)) e.target.checked ? S.selected.add(`${c.entity}:${c.id}`) : S.selected.delete(`${c.entity}:${c.id}`); renderChanges(); };
}
$('#chgList').addEventListener('change', e => { const k = e.target.dataset.sel; if (k) e.target.checked ? S.selected.add(k) : S.selected.delete(k); });
$('#chgList').addEventListener('click', guard(async e => {
  const k = e.target.dataset.deldone; if (!k) return;
  if (!(await confirmBox('ยืนยันว่าลบรายการนี้ใน LTAX แล้ว?'))) return;
  await api('DELETE', `/api/deletions/${encodeURIComponent(k)}`); await loadChecks(); await loadState(); renderChanges();
}));
$('#chgList').addEventListener('click', e => { const k = e.target.dataset.open; if (k) { const [en, id] = k.split(':'); openEditor(en, id); } });
$('#chgSendSel').addEventListener('click', () => { $('#jobScope').value = 'selected'; $('#jobType').value = 'push'; $('#tabs button[data-tab="ltax"]').click(); });

// ---------- LTAX ----------
let currentJob = null;
async function ltaxStatus() {
  const s = await api('GET', '/api/ltax/status').catch(() => null);
  const chip = $('#ltaxChip');
  chip.textContent = !s ? 'LTAX: -' : s.loggedIn ? 'LTAX: เข้าสู่ระบบแล้ว' : s.browser ? 'LTAX: รอเข้าสู่ระบบ' : 'LTAX: ยังไม่เชื่อมต่อ';
  chip.classList.toggle('ok', !!s?.loggedIn);
  if (s) $('#ltaxState').innerHTML = `Chrome ของ L-LAN: <b>${s.browser ? 'เปิดอยู่' : 'ปิด'}</b> · LTAX: <b>${s.loggedIn ? 'เข้าสู่ระบบแล้ว' : 'ยังไม่เข้าสู่ระบบ'}</b>${s.url ? `<br><span class="muted">${esc(s.url)}</span>` : ''}<br>โหมดบันทึกจริง: <b>${s.realModeEnabled ? 'เปิด' : 'ปิด (ตั้งค่าได้ที่หน้าตั้งค่า)'}</b>`;
  return s;
}
$('#ltaxOpen').addEventListener('click', guard(async () => { await api('POST', '/api/ltax/browser'); toast('เปิดหน้าต่างแล้ว เข้าสู่ระบบด้วยชื่อผู้ใช้ รหัสผ่าน และ OTP'); ltaxStatus(); }));
$('#ltaxEnter').addEventListener('click', guard(async () => { const r = await api('POST', '/api/ltax/enter'); toast(r.ok ? 'อยู่ใน LTAX ONLINE แล้ว' : 'ยังไม่พบลิงก์ LTAX ONLINE กรุณาเข้าสู่ระบบ SSO ก่อน', !r.ok); ltaxStatus(); }));
$('#ltaxCheck').addEventListener('click', guard(ltaxStatus));
['#jobType', '#jobMode', '#jobScope'].forEach(s => $(s).addEventListener('change', () => { restoreFrom(); jobHint(); }));
['#jobFrom', '#jobLimit'].forEach(s => $(s).addEventListener('input', jobHint));
function jobItems() {
  const all = scopeItems(), from = Math.max(1, Number($('#jobFrom').value) || 1), limit = Number($('#jobLimit').value) || 20;
  return all.slice(from - 1, from - 1 + limit);
}
const scopeKey = () => `llan.next.${$('#jobType').value}.${$('#jobMode').value}.${$('#jobScope').value}`;
function restoreFrom() { let n = 1; try { n = Number(localStorage.getItem(scopeKey())) || 1; } catch { /* no storage */ } $('#jobFrom').value = n > scopeItems().length ? 1 : n; }
function scopeItems() {
  const scope = $('#jobScope').value, limit = Infinity;
  const errIds = new Set(S.issues.filter(i => i.level === 'error').map(i => i.id));
  let items = [];
  if ($('#jobType').value === 'check') {
    const shapes = S.features.filter(f => f.code && (scope === 'buildings-shapes' ? f.kind === 'building' : f.kind === 'parcel'));
    const pick = scope === 'parcels-unchecked' ? shapes.filter(f => !S.checks.has(`parcel:${f.code}`))
      : scope === 'parcels-unjoined' ? shapes.filter(f => !recordOfFeature(f))
        : scope === 'selected' ? [...S.selected].map(k => { const [e, id] = k.split(':'); const r = S.by[e]?.get(id); return r && { kind: e === 'buildings' ? 'building' : 'parcel', code: e === 'buildings' ? r.buildingCode : r.parcelCode }; }).filter(x => x && x.code)
          : shapes;
    return [...new Map(pick.map(f => [`${f.kind}:${f.code}`, { kind: f.kind, code: f.code }])).values()].slice(0, limit);
  }
  if (scope === 'selected') items = [...S.selected].map(k => { const [entity, recordId] = k.split(':'); return { entity, recordId }; });
  else if (scope === 'lands-all') items = S.rec.lands.filter(l => l.parcelCode).map(l => ({ entity: 'lands', recordId: l.id }));
  else items = ['owners', 'lands', 'buildings'].flatMap(e => S.rec[e].filter(r => r.pending && !errIds.has(r.id)).map(r => ({ entity: e, recordId: r.id })));
  return items.slice(0, limit);
}
function jobHint() {
  const type = $('#jobType').value, mode = $('#jobMode').value;
  $('#jobMode').disabled = type !== 'push';
  const total = scopeItems().length, from = Math.max(1, Number($('#jobFrom').value) || 1), n = jobItems().length;
  $('#jobHint').textContent = `ทั้งหมด ${total.toLocaleString()} รายการ · รอบนี้ลำดับ ${n ? `${from.toLocaleString()}–${(from + n - 1).toLocaleString()}` : '-'} · ` + (type === 'check' ? 'ค้นหารหัสในหน้าทะเบียนทรัพย์สินของ LTAX ทีละรายการ แล้วเก็บผลว่าพบหรือไม่ ไม่เปิดและไม่แก้ไขข้อมูลใน LTAX ดูผลได้ในแผนที่ โหมด "การเชื่อมต่อข้อมูล"'
    : type === 'pull' ? 'อ่านข้อมูลจาก LTAX มาเก็บในเครื่อง ไม่แก้ไขอะไรใน LTAX'
    : mode === 'dry' ? 'เปิดฟอร์มใน LTAX กรอกค่า แล้วอ่านกลับมาเทียบ จากนั้นออกโดยไม่บันทึก ใช้ตรวจก่อนบันทึกจริง'
      : 'กรอกและกดบันทึกใน LTAX จริง แล้วอ่านกลับมาตรวจว่าตรงกัน');
}
$('#jobStart').addEventListener('click', guard(async () => {
  const items = jobItems(), type = $('#jobType').value, mode = type === 'push' ? $('#jobMode').value : 'dry';
  if (!items.length) return toast('ไม่มีรายการให้ทำ', true);
  if (S.session.mode !== 'ltax') return toast('ต้องเข้าสู่ระบบด้วย DLA SSO ก่อน (ตอนนี้ใช้งานแบบออฟไลน์)', true);
  if (type === 'push' && mode === 'real' && !(await confirmBox(`บันทึกจริงลง LTAX ONLINE <b>${items.length}</b> รายการ?<br><span class="muted">ระบบจะกดบันทึกในระบบจริงด้วยบัญชีที่เข้าสู่ระบบอยู่ และตรวจผลทุกรายการ</span>`))) return;
  currentJob = await api('POST', '/api/ltax/jobs', { type, mode, items });
  const next = (Number($('#jobFrom').value) || 1) + items.length;
  try { localStorage.setItem(scopeKey(), String(next)); } catch { /* no storage */ }
  $('#jobFrom').value = next;
  $('#jobStop').disabled = false;
  renderJob(); jobChip(); jobHint();
}));
$('#jobResume').addEventListener('click', guard(async () => {
  if (!currentJob) return toast('ยังไม่มีงานเดิม', true);
  const left = (currentJob.items || []).filter(i => i.status !== 'done').length;
  if (!left) return toast('งานนี้ทำครบทุกรายการแล้ว');
  if (S.session.mode !== 'ltax') return toast('ต้องเข้าสู่ระบบด้วย DLA SSO ก่อน', true);
  if (currentJob.type === 'push' && currentJob.mode === 'real' && !(await confirmBox(`ทำต่อ ${left} รายการที่ยังไม่สำเร็จ ด้วยการบันทึกจริงลง LTAX?`, { ok: 'ทำต่อ', danger: true }))) return;
  currentJob = await api('POST', '/api/ltax/jobs', { resumeOf: currentJob.id });
  $('#jobStop').disabled = false; renderJob(); jobChip();
}));
$('#jobStop').addEventListener('click', guard(async () => { if (currentJob) await api('POST', `/api/ltax/jobs/${currentJob.id}/stop`); }));
const STATUS_TH = { waiting: ['รอ', ''], running: ['กำลังทำ', 'info'], done: ['สำเร็จ', 'ok'], error: ['ผิดพลาด', 'err'], skipped: ['ข้าม', 'warn'], cancelled: ['ยกเลิก', 'warn'] };
// Small progress chip in the top bar while a job runs.
function jobChip() {
  const c = $('#jobChip');
  const items = currentJob?.items || [];
  const running = currentJob && (currentJob.status === 'running' || items.some(i => i.status === 'running' || i.status === 'waiting'));
  c.hidden = !running;
  if (running) c.textContent = `LTAX กำลังทำ ${items.filter(i => !['waiting', 'running'].includes(i.status)).length}/${items.length}`;
}
function renderJob() {
  if (currentJob) $('#jobResume').disabled = !(currentJob.items || []).some(i => i.status !== 'done') || currentJob.status === 'running';
  if (!currentJob) { $('#jobItems').innerHTML = ''; $('#jobInfo').textContent = 'ยังไม่มีงาน'; return; }
  const items = currentJob.items || [];
  const done = items.filter(i => !['waiting', 'running'].includes(i.status)).length;
  $('#jobBar').style.width = `${items.length ? (done / items.length) * 100 : 0}%`;
  const count = s => items.filter(i => i.status === s).length;
  $('#jobInfo').innerHTML = `${JOB_TH(currentJob)} · ${done}/${items.length} · สำเร็จ ${count('done')} · ผิดพลาด ${count('error')} · ข้าม ${count('skipped')}`
    + ` · <a href="/api/jobs/${currentJob.id}/report">ดาวน์โหลดรายงาน Excel</a>`;
  $('#jobItems').innerHTML = '<tr><th>#</th><th>ประเภท</th><th>รายการ</th><th>ผล</th><th>ข้อความ</th><th>ช่องที่ต่างจาก LTAX</th><th>ต้องทำเอง</th></tr>' + items.map((it, i) => {
    const [t, c] = STATUS_TH[it.status] || [it.status, ''];
    return `<tr><td>${i + 1}</td><td>${esc(ENTITY_TH[it.entity])}</td><td>${esc(it.label)}</td><td><span class="pill ${c}">${t}</span></td><td>${esc(it.message)}</td>
      <td><pre>${esc((it.changes || []).map(x => `${x.th}: ${x.ltax || '-'} → ${x.local || '-'}`).join('\n'))}</pre></td><td><pre>${esc((it.manual || []).join('\n'))}</pre></td></tr>`;
  }).join('');
}
async function renderLtax() {
  await ltaxStatus(); if (!renderLtax.init) { restoreFrom(); renderLtax.init = true; } jobHint();
  const jobs = await api('GET', '/api/ltax/jobs');
  $('#jobHistory').innerHTML = '<tr><th>เวลา</th><th>งาน</th><th>สถานะ</th><th>ผล</th><th></th></tr>' + jobs.slice(0, 50).map(j => `<tr class="click" data-job="${j.id}">
    <td>${new Date(j.createdAt).toLocaleString('th-TH')}</td><td>${JOB_TH(j)} ${j.total} รายการ</td><td>${esc(j.status)}</td>
    <td>${Object.entries(j.summary || {}).map(([k, v]) => `${STATUS_TH[k]?.[0] || k} ${v}`).join(' · ')}</td><td><a href="/api/jobs/${j.id}/report">รายงาน</a></td></tr>`).join('');
  if (!currentJob && jobs[0]) currentJob = await api('GET', `/api/ltax/jobs/${jobs[0].id}`);
  renderJob();
}
const JOB_TH = j => (j.type === 'check' ? 'ตรวจกับ LTAX' : j.type === 'pull' ? 'ดึงข้อมูล' : j.mode === 'real' ? 'บันทึกจริง' : 'ทดลอง');
$('#jobHistory').addEventListener('click', guard(async e => { const tr = e.target.closest('tr[data-job]'); if (tr && e.target.tagName !== 'A') { currentJob = await api('GET', `/api/ltax/jobs/${tr.dataset.job}`); renderJob(); } }));
const events = new EventSource('/api/ltax/events');
events.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (!currentJob || ev.jobId !== currentJob.id) return;
  if (ev.type === 'item') { currentJob.items[ev.index] = ev.item; renderJob(); jobChip(); }
  if (ev.type === 'done') { loadChecks().then(() => refreshMap()); Object.assign(currentJob, ev.job, { items: currentJob.items }); $('#jobStop').disabled = true; renderJob(); jobChip(); toast('งานเสร็จแล้ว'); reloadAll(); }
  if (ev.type === 'error') toast(ev.message, true);
};

// ---------- import / export ----------
$('#shpCrs').innerHTML += CRS_LIST.map(c => `<option value="${c.id}">${esc(c.th)} (${c.id})</option>`).join('');
async function postXlsx(preview) {
  const file = $('#xlsxFile').files[0];
  if (!file) throw new Error('เลือกไฟล์ Excel ก่อน');
  $('#xlsxResult').textContent = 'กำลังอ่านไฟล์…';
  const r = await api('POST', '/api/import/ltax-xlsx', { name: file.name, file: await fileB64(file), preview });
  const c = r.report.counts;
  $('#xlsxResult').innerHTML = `<table><tr><td>เจ้าของ</td><td>${c.owners}</td></tr><tr><td>ที่ดิน</td><td>${c.lands} (การใช้ประโยชน์ ${c.landUses})</td></tr><tr><td>สิ่งปลูกสร้าง</td><td>${c.buildings} (การใช้ประโยชน์ ${c.buildingUses})</td></tr><tr><td>ป้าย</td><td>${c.signboards}</td></tr></table>`
    + (r.result ? `<p>นำเข้าแล้ว: เพิ่ม ${Object.values(r.result.added).reduce((a, b) => a + b, 0)} · ปรับตาม LTAX ${Object.values(r.result.updated).reduce((a, b) => a + b, 0)} · เก็บค่าที่แก้ในเครื่อง ${Object.values(r.result.keptLocal).reduce((a, b) => a + b, 0)}${r.result.conflicts.length ? ` · ขัดแย้ง ${r.result.conflicts.length}` : ''}</p>` : '')
    + (r.report.problems.length ? `<details><summary>ข้อสังเกต ${r.report.problems.length} รายการ</summary><ul>${r.report.problems.slice(0, 300).map(p => `<li>${esc(p.sheet)} ${esc(p.row)}: ${esc(p.message)}</li>`).join('')}</ul></details>` : '');
  if (!preview) { toast('นำเข้า Excel แล้ว'); await reloadAll(); }
}
$('#xlsxPreview').addEventListener('click', guard(() => postXlsx(true)));
$('#xlsxImport').addEventListener('click', guard(() => postXlsx(false)));
$('#shpImport').addEventListener('click', guard(async () => {
  const files = [...$('#shpFiles').files];
  const groups = new Map();
  for (const f of files) { const m = f.name.match(/^(.*)\.(shp|dbf|shx|prj|cpg)$/i); if (m) { if (!groups.has(m[1])) groups.set(m[1], {}); groups.get(m[1])[m[2].toLowerCase()] = f; } }
  if (!groups.size) throw new Error('เลือกไฟล์ .shp และ .dbf ก่อน');
  const out = [];
  for (const [name, g] of groups) {
    if (!g.shp || !g.dbf) { out.push(`${name}: ขาดไฟล์ .shp หรือ .dbf`); continue; }
    $('#shpResult').textContent = `กำลังนำเข้า ${name}…`;
    const body = { name, kind: $('#shpKind').value, codeField: $('#shpCode').value.trim() || undefined, crs: $('#shpCrs').value };
    for (const ext of ['shp', 'dbf', 'shx', 'prj', 'cpg']) if (g[ext]) body[ext] = await fileB64(g[ext]);
    const r = await api('POST', '/api/import/shapefile', body);
    const j = r.join;
    out.push(`${name}: ${r.layer.count.toLocaleString()} รูป · ${r.layer.kind === 'parcel' ? 'แปลงที่ดิน' : r.layer.kind === 'building' ? 'สิ่งปลูกสร้าง' : 'อื่น ๆ'} · ${r.layer.crs} · ช่องรหัส ${r.layer.codeField || '-'}${j ? ` · จอยได้ ${j.joined.toLocaleString()} จอยไม่ได้ ${j.notJoined.toLocaleString()}` : ''}`);
  }
  $('#shpResult').innerHTML = out.map(esc).join('<br>');
  refreshMap.fitted = false;
  await reloadAll();
}));
async function renderData() {
  $('#layerTable').innerHTML = '<tr><th>ชื่อ</th><th>ชนิด</th><th>จำนวน</th><th>ระบบพิกัด</th><th>ช่องรหัส</th><th>นำเข้าเมื่อ</th><th></th></tr>' + S.layers.map(l => `<tr>
    <td>${esc(l.name)}</td><td>${l.kind === 'parcel' ? 'แปลงที่ดิน' : l.kind === 'building' ? 'สิ่งปลูกสร้าง' : 'อื่น ๆ'}</td><td class="num">${l.count.toLocaleString()}</td><td>${esc(l.crs)}</td><td>${esc(l.codeField || '-')}${Object.keys(l.repairedText || {}).length ? `<br><span class="pill info">ซ่อมข้อความไทย ${Object.entries(l.repairedText).map(([k, n]) => `${esc(k)} ${n.toLocaleString()}`).join(', ')}</span>` : ''}</td>
    <td>${new Date(l.importedAt).toLocaleString('th-TH')}</td><td><a class="button" href="/api/export/shp/${l.id}">ส่งออก .shp</a> <button class="danger" data-dellayer="${l.id}">ลบ</button></td></tr>`).join('');
  if (!S.layers.length) { $('#joinReport').innerHTML = '<span class="muted">ยังไม่มีชั้นแผนที่</span>'; return; }
  S.join = await api('GET', '/api/reports/join');
  const row = (t, v) => `<tr><td>${t}</td><td class="num">${(v ?? 0).toLocaleString()}</td></tr>`;
  $('#joinReport').innerHTML = [['parcel', 'รูปแปลงที่ดิน ↔ ทะเบียนที่ดิน'], ['building', 'รูปสิ่งปลูกสร้าง ↔ ทะเบียนสิ่งปลูกสร้าง']].filter(([k]) => S.join[k]).map(([k, t]) => {
    const s = S.join[k].summary;
    return `<b>${t}</b><table>${row('รูปทั้งหมด', s.features)}${row('จอยได้', s.joined)}${row('จอยไม่ได้', s.notJoined)}${row('ไม่มีรหัส', s.noCode)}${row('รหัสซ้ำในแผนที่', s.duplicateCodes)}${row('ในทะเบียนแต่ไม่มีรูป', s.recordsWithoutShape)}</table>`;
  }).join('') + (S.overlay ? `<b>อาคารกับแปลงที่ตั้ง</b><table>${Object.entries(S.overlay.summary).map(([k, v]) => row(k, v)).join('')}</table>` : '');
}
$('#layerTable').addEventListener('click', guard(async e => {
  const id = e.target.dataset.dellayer; if (!id) return;
  const l = S.layers.find(x => x.id === id);
  if (!(await confirmBox(`ลบชั้นแผนที่ <b>${esc(l.name)}</b> ออกจาก L-LAN?<br><span class="muted">ไม่กระทบไฟล์ต้นฉบับ</span>`))) return;
  await api('DELETE', `/api/layers/${id}`); await reloadAll();
}));

// ---------- settings ----------
function renderSettings() {
  const s = S.settings, l = s.ltax || {};
  $('#setOrg').value = s.org || ''; $('#setAmphur').value = s.amphur || ''; $('#setDistricts').value = (s.districts || []).join(', ');
  $('#setTol').value = s.areaTolerance ?? 10;
  $('#setSso').value = l.ssoUrl || ''; $('#setBase').value = l.baseUrl || ''; $('#setDelay').value = l.delayMs || 1200; $('#setPort').value = l.port || 9444;
  $('#setChrome').value = l.chromePath || ''; $('#setReal').checked = !!l.realModeEnabled;
  const c = s.cloud || {};
  $('#cloudUrl').value = c.url || 'https://csbsrqbqnyiiwyypxyhj.supabase.co';
  $('#cloudKey').value = ''; $('#cloudKey').placeholder = c.hasKey ? 'บันทึก key ไว้แล้ว (ใส่ใหม่เฉพาะเมื่อจะเปลี่ยน)' : 'วางจาก Supabase → Project Settings → API Keys';
  $('#cloudOn').checked = !!c.enabled;
  $('#cloudState').innerHTML = `${c.hasKey ? 'มี key แล้ว' : '<span class="pill warn">ยังไม่มี key</span>'} · ส่งอัตโนมัติ: <b>${c.enabled ? 'เปิด' : 'ปิด'}</b>`
    + `${c.lastSync ? ` · ซิงก์ล่าสุด ${new Date(c.lastSync).toLocaleString('th-TH')}` : ''}${c.dirty ? ' · <span class="pill err">มีการแก้ไขที่ยังไม่ขึ้น Supabase กด "อัปโหลดรูปทั้งหมด"</span>' : ''}`;
}
const cloudSettings = () => ({ url: $('#cloudUrl').value.trim(), enabled: $('#cloudOn').checked, ...($('#cloudKey').value.trim() ? { key: $('#cloudKey').value.trim() } : {}) });
async function saveCloud() { S.settings = await api('PUT', '/api/settings', { cloud: cloudSettings() }); renderSettings(); }
$('#cloudSql').addEventListener('click', guard(async () => {
  const { sql } = await api('GET', '/api/cloud/schema');
  try { await navigator.clipboard.writeText(sql); toast('คัดลอก SQL แล้ว ไปที่ Supabase → SQL Editor → New query แล้ววางและกด Run'); }
  catch { await confirmBox(`<p>คัดลอกข้อความนี้ไปวางใน Supabase → SQL Editor แล้วกด Run</p><textarea style="height:40vh">${esc(sql)}</textarea>`, { ok: 'ปิด' }); }
}));
$('#cloudTest').addEventListener('click', guard(async () => {
  await saveCloud();
  const r = await api('GET', '/api/cloud/status');
  $('#cloudState').innerHTML = r.ok ? `<span class="pill ok">เชื่อมต่อได้</span> ใน Supabase มี ${r.layers} ชั้น ${r.features.toLocaleString()} รูป · ในเครื่อง ${r.local.toLocaleString()} รูป` : `<span class="pill err">${esc(r.message)}</span>`;
}));
$('#cloudPush').addEventListener('click', guard(async () => {
  await saveCloud();
  if (!(await confirmBox(`อัปโหลดรูปทั้งหมด ${S.features.length.toLocaleString()} รูปขึ้น Supabase?<br><span class="muted">ส่งเฉพาะรูป รหัส พื้นที่ และช่องที่ไม่ใช่ข้อมูลส่วนบุคคล</span>`, { ok: 'อัปโหลด' }))) return;
  $('#cloudState').textContent = 'กำลังอัปโหลด…';
  const r = await api('POST', '/api/cloud/push');
  toast(`อัปโหลดแล้ว ${r.layers} ชั้น ${r.features.toLocaleString()} รูป`); await loadState(); renderSettings();
}));
$('#cloudPull').addEventListener('click', guard(async () => {
  await saveCloud();
  const r0 = await api('GET', '/api/cloud/status');
  if (!r0.ok) return toast(r0.message, true);
  if (!(await confirmBox(`ดึงรูปจาก Supabase (${r0.features.toLocaleString()} รูป) มาแทนรูปในเครื่อง (${r0.local.toLocaleString()} รูป)?<br><span class="muted">รูปที่มีในเครื่องแต่ไม่มีใน Supabase จะหายไป ข้อมูลทะเบียนไม่ถูกแตะ</span>`, { ok: 'ดึงมาแทน', danger: true }))) return;
  const r = await api('POST', '/api/cloud/pull');
  toast(`ดึงแล้ว ${r.layers} ชั้น ${r.features.toLocaleString()} รูป`); refreshMap.fitted = false; await reloadAll(); renderSettings();
}));
$('#setSave').addEventListener('click', guard(async () => {
  if ($('#setReal').checked && !S.settings.ltax?.realModeEnabled && !(await confirmBox('เปิดโหมดบันทึกจริงลง LTAX ONLINE?<br><span class="muted">L-LAN จะกดบันทึกในระบบจริงได้เมื่อสั่งงานแบบ "บันทึกจริง" เท่านั้น</span>'))) return;
  S.settings = await api('PUT', '/api/settings', {
    org: $('#setOrg').value.trim(), amphur: $('#setAmphur').value.trim(), districts: $('#setDistricts').value.split(',').map(x => x.trim()).filter(Boolean),
    areaTolerance: Number($('#setTol').value) || 10,
    ltax: { ssoUrl: $('#setSso').value.trim(), baseUrl: $('#setBase').value.trim(), delayMs: Number($('#setDelay').value) || 1200, port: Number($('#setPort').value) || 9444,
      chromePath: $('#setChrome').value.trim(), realModeEnabled: $('#setReal').checked },
    cloud: cloudSettings(),
  });
  renderSettings();
  await loadState(); await loadIssues();
  $('#setMsg').textContent = 'บันทึกแล้ว';
}));

// ---------- sign-in ----------
function showSession() {
  const s = S.session;
  $('#login').hidden = s.mode !== 'none';
  $('#userChip').innerHTML = s.mode === 'ltax' ? `${esc(s.user?.name || 'ผู้ใช้ LTAX')}<br><span style="opacity:.8">${esc(s.user?.org || '')}</span><button id="logout">ออกจากระบบ</button>`
    : s.mode === 'offline' ? 'ใช้งานแบบออฟไลน์ <button id="logout">เข้าสู่ระบบ</button>' : '';
  $('#logout')?.addEventListener('click', guard(async () => { S.session = await api('POST', '/api/session/logout'); $('#loginState').textContent = ''; showSession(); }));
}
let loginTimer = null;
async function pollLogin() {
  const r = await api('POST', '/api/session/ltax');
  if (r.mode === 'ltax') {
    clearInterval(loginTimer); loginTimer = null;
    S.session = r; showSession(); ltaxStatus();
    toast(`เข้าสู่ระบบแล้ว: ${r.user?.name || ''}`);
    return;
  }
  $('#loginState').innerHTML = r.browser ? 'กรอกชื่อผู้ใช้ รหัสผ่าน และ OTP ในหน้าต่าง Chrome ที่เปิดขึ้น<br><span class="muted">L-LAN จะเข้าหน้า LTAX ONLINE ให้เองเมื่อเข้าสู่ระบบสำเร็จ</span>'
    : 'หน้าต่างเข้าสู่ระบบถูกปิด กดปุ่มอีกครั้งเพื่อเปิดใหม่';
  if (!r.browser) { clearInterval(loginTimer); loginTimer = null; }
}
$('#loginSso').addEventListener('click', guard(async () => {
  $('#loginState').textContent = 'กำลังเปิดหน้าต่างเข้าสู่ระบบ…';
  await api('POST', '/api/ltax/browser');
  await pollLogin();
  if (!loginTimer && S.session.mode !== 'ltax') loginTimer = setInterval(() => pollLogin().catch(e => ($('#loginState').textContent = e.message)), 2500);
}));
$('#loginOffline').addEventListener('click', guard(async () => { S.session = await api('POST', '/api/session/offline'); showSession(); }));

// ---------- start ----------
guard(async () => {
  S.session = await api('GET', '/api/session');
  showSession();
  await reloadAll(); ltaxStatus(); setInterval(ltaxStatus, 15000);
})();
