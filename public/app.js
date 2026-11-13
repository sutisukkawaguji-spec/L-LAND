import { MapView } from './map.js';
import { ENTITIES, label, LAND_USE_TYPES, buildingTypeLabel, DOC_TYPES } from './shared/schema.mjs';
import { toWah, formatNumber, num, buddhistYearNow, formatRNW } from './shared/calc.mjs';
import { CRS_LIST, toMercator } from './shared/proj.mjs';
import { nextBuildingCode } from './shared/geom.mjs';
import { validateRecord } from './shared/validate.mjs';
import { diffRecord } from './shared/diff.mjs';
import { setupMapEditing } from './map-edit.js';
import { createOps } from './ops.js';
import { landTotal, useValue, buildingValue, deprTable, suggestLandPrice, suggestBuildingPrice } from './shared/valuation.mjs';
// Parcel status labels (same as lib/parcel-status.mjs, which the office uses to decide them).
const STATUS_STYLE = { ok: ['#2e9d6a', 'ข้อมูลตรง', 'ok'], fix: ['#d64545', 'ต้องปรับแก้ (สำรวจ)', 'err'], send: ['#9b51e0', 'รอดำเนินการใน LTAX', 'warn'] };
const LINK_TH = { ok: 'รูปแปลงตรงกับทะเบียน', 'no-record': 'มีรูป ไม่มีทะเบียน', 'no-shape': 'มีทะเบียน ไม่มีรูป', 'dup-shape': 'รหัสซ้ำบนแผนที่', 'dup-record': 'รหัสซ้ำในทะเบียน', 'no-code': 'รูปไม่มีรหัส' };
const LTAX_TH = { found: 'พบใน LTAX', 'not-found': 'ไม่พบใน LTAX', dup: 'รหัสซ้ำใน LTAX', new: 'ยังไม่มีใน LTAX', none: '-' };
// Survey state of a parcel: [label, pill class, map colour]
const SURVEY_STYLE = { draft: ['กำลังสำรวจ', 'info', '#2f80ed'], revisit: ['ต้องกลับไปสำรวจซ้ำ', 'err', '#d64545'], ready: ['สำรวจเสร็จ รอลง LTAX', 'ok', '#27ae60'],
  done: ['สำรวจเสร็จ ตรงกับ LTAX แล้ว', 'ok', '#1e7a4f'], changed: ['แก้ไขหลังกดสำรวจเสร็จ', 'warn', '#f2994a'] };

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Web mode: the page comes from github.io and works on the shared copy in Supabase (members sign in).
// The same data API runs in the browser. LTAX work stays on the office machine (127.0.0.1), which syncs.
const WEB = !/^(127\.0\.0\.1|localhost)$/.test(location.hostname);
const CONFIG = WEB ? (await import('./config.js')).default : null;
const WEBAUTH = { session: null, dispatch: null, store: null, role: null };
async function api(method, url, body) {
  if (WEB) return webApi(method, url, body);
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `ผิดพลาด ${res.status}`);
  return data;
}
async function webApi(method, url, body) {
  if (!WEBAUTH.dispatch) throw new Error('กรุณาเข้าสู่ระบบ');
  const hit = WEBAUTH.dispatch(method, new URL(url, location.href));
  if (!hit.found) throw new Error('ส่วนนี้ใช้ได้ที่เครื่องสำนักงานเท่านั้น');
  if (method !== 'GET' && WEBAUTH.role === 'viewer') throw new Error('บัญชีนี้ดูข้อมูลได้อย่างเดียว');
  // Copies, like a server would send: the page never edits the store's own objects.
  return structuredClone((await hit.run(body ? structuredClone(body) : null)) ?? null);
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
// ID number shown in the field with the middle digits hidden: 1-1017x-xxxx-45-1
const maskId = v => { const s = String(v || '').replace(/\D/g, ''); return s.length === 13 ? `${s[0]}-${s.slice(1, 5)}x-xxxx-${s.slice(10, 12)}-${s[12]}` : String(v || ''); };
function ownerAddr(o) {
  const cur = o.currNo || o.currVillage || o.currDistrict, p = cur ? 'curr' : 'addr';
  const v = k => o[`${p}${k}`];
  return [v('No') && `เลขที่ ${v('No')}`, v('Village') && `หมู่ ${v('Village')}`, v('Road') && `ถ.${v('Road')}`, v('Alley') && `ซ.${v('Alley')}`,
    v('District') && `ต.${v('District')}`, v('Amphur') && `อ.${v('Amphur')}`].filter(Boolean).join(' ');
}
// Owner cards for the map panel: name, masked ID, phone (tap to call), address.
const ownerCards = ids => (ids || []).map(id => S.by.owners?.get(id)).filter(Boolean).map(o => `<div class="owner-card">
  <button class="link" data-open-owner="${esc(o.id)}">${esc(ownerName(o))}</button>
  <div class="muted">${o.psnId ? `เลขประจำตัว ${esc(maskId(o.psnId))}` : ''}${o.tel ? ` · โทร <a href="tel:${esc(String(o.tel).replace(/[^\d+]/g, ''))}">${esc(o.tel)}</a>` : ''}</div>
  ${ownerAddr(o) ? `<div class="muted">${esc(ownerAddr(o))}</div>` : ''}</div>`).join('') || '-';
// Directions to a shape from where the phone is (Google Maps).
function navLink(f) {
  const b = f?.bbox; if (!b) return '';
  const lat = ((b[1] + b[3]) / 2).toFixed(6), lon = ((b[0] + b[2]) / 2).toFixed(6);
  return `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" title="เปิดเส้นทางใน Google Maps">➜ นำทาง</a>`;
}
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
async function loadStatuses() {
  [S.status, S.survey] = await Promise.all([api('GET', '/api/parcel-status'), api('GET', '/api/survey')]);
  S.statusBy = new Map(S.status.rows.map(r => [r.id, r]));
  $('#badgeFix').textContent = S.status.summary.fix ? S.status.summary.fix.toLocaleString() : '';
  S.surveyBy = new Map(S.survey.map(s => [s.code, s]));
  const ready = S.survey.filter(s => s.state === 'ready').length;
  $('#badgeReady').textContent = ready ? ready.toLocaleString() : '';
}
// ---------- field photos (Supabase Storage; the record keeps the list) ----------
const photoCache = new Map();
function photoSrc(path) {
  if (!WEB) return Promise.resolve(`/api/photos/file?path=${encodeURIComponent(path)}`);
  if (!photoCache.has(path)) photoCache.set(path, WEBAUTH.cloud.photo(path).then(r => URL.createObjectURL(new Blob([r.bytes], { type: r.type }))).catch(err => { photoCache.delete(path); throw err; }));
  return photoCache.get(path);
}
function photosHtml(entity, rec) {
  if (!rec?.id) return '';
  const list = rec.photos || [];
  return `<div class="photos-box" data-photos="${esc(entity)}|${esc(rec.id)}"><b>รูปถ่าย (${list.length})</b>
    <div class="photos">${list.map(p => `<figure><img data-photo="${esc(p.path)}" alt="" title="${esc(p.by || '')} ${whenTh(p.at)}">
      <button type="button" class="edit-only" data-photo-del="${esc(p.path)}" title="ลบรูป">✕</button></figure>`).join('') || '<span class="muted">ยังไม่มีรูป</span>'}</div>
    <button type="button" class="edit-only" data-photo-add>📷 ถ่ายรูป / เพิ่มรูป</button></div>`;
}
function hydratePhotos(root) {
  for (const img of root.querySelectorAll('img[data-photo]:not([src])')) photoSrc(img.dataset.photo).then(src => { img.src = src; }).catch(() => { img.alt = 'โหลดรูปไม่ได้'; img.classList.add('broken'); });
}
// Phone pictures are large: keep the long side at 1600 px, JPEG.
async function shrinkPhoto(file, max = 1600) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file))
    .catch(() => { throw new Error(`อ่านไฟล์รูป ${file.name || ''} ไม่ได้ ใช้รูป JPG หรือ PNG`); });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((ok, bad) => c.toBlob(b => (b ? ok(b) : bad(new Error('แปลงรูปไม่ได้'))), 'image/jpeg', 0.8));
}
function putLocal(entity, rec) {
  const list = S.rec[entity], i = list.findIndex(r => r.id === rec.id);
  const next = i >= 0 ? { ...list[i], ...rec } : rec;
  if (i >= 0) list[i] = next; else list.push(next);
  S.by[entity].set(rec.id, next);
}
function refreshPhotos(box) {
  const [entity, id] = box.dataset.photos.split('|');
  box.outerHTML = photosHtml(entity, S.by[entity].get(id));
}
let photoTarget = null;
document.addEventListener('click', e => {
  const add = e.target.closest('[data-photo-add]'), del = e.target.closest('[data-photo-del]'), img = e.target.closest('img[data-photo]');
  const box = e.target.closest('.photos-box');
  if (add && box) { photoTarget = box.dataset.photos; $('#photoInput').click(); return; }
  if (del && box) {
    e.preventDefault();
    return guard(async () => {
      if (!(await confirmBox('ลบรูปนี้?', { ok: 'ลบรูป', danger: true }))) return;
      const [entity, id] = box.dataset.photos.split('|'), path = del.dataset.photoDel;
      await api('DELETE', `/api/${entity}/${encodeURIComponent(id)}/photos?path=${encodeURIComponent(path)}`);
      if (WEB) await WEBAUTH.cloud.removePhotos([path]).catch(err => console.warn(err)); else await api('DELETE', `/api/photos/file?path=${encodeURIComponent(path)}`).catch(err => console.warn(err));
      const rec = S.by[entity].get(id); putLocal(entity, { ...rec, photos: (rec.photos || []).filter(p => p.path !== path) });
      const live = document.querySelector(`.photos-box[data-photos="${CSS.escape(box.dataset.photos)}"]`); if (live) { refreshPhotos(live); hydratePhotos(document); }
      toast('ลบรูปแล้ว');
    })();
  }
  if (img && img.src) {
    const p = (S.by[box?.dataset.photos.split('|')[0]]?.get(box?.dataset.photos.split('|')[1])?.photos || []).find(x => x.path === img.dataset.photo);
    $('#photoBig').src = img.src;
    $('#photoMeta').textContent = [p?.by, whenTh(p?.at), p?.lat ? `พิกัด ${Number(p.lat).toFixed(6)}, ${Number(p.lon).toFixed(6)}` : ''].filter(Boolean).join(' · ');
    $('#photoView').showModal();
  }
});
$('#photoInput').addEventListener('change', guard(async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length || !photoTarget) return;
  const [entity, id] = photoTarget.split('|');
  toast(`กำลังส่งรูป ${files.length} รูป…`);
  for (const file of files) {
    const blob = await shrinkPhoto(file);
    const path = `${entity}/${id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    if (WEB) await WEBAUTH.cloud.uploadPhoto(path, blob);
    else await api('POST', '/api/photos/file', { path, data: await fileB64(blob), type: 'image/jpeg' });
    if (WEB) photoCache.set(path, Promise.resolve(URL.createObjectURL(blob)));
    const gps = map.gps;
    putLocal(entity, await api('POST', `/api/${entity}/${encodeURIComponent(id)}/photos`, { path, lat: gps?.lat, lon: gps?.lon }));
  }
  const live = document.querySelector(`.photos-box[data-photos="${CSS.escape(photoTarget)}"]`);
  if (live) { refreshPhotos(live); hydratePhotos(document); }
  toast(`เพิ่มรูปแล้ว ${files.length} รูป`);
}));

// ---------- survey state of a parcel (กำลังสำรวจ / ต้องกลับไปซ้ำ / สำรวจเสร็จ) ----------
// Progress over the parcels that have a land record.
function surveyProgress() {
  const sv = S.status?.summary?.survey || {};
  const total = sv.parcels || S.rec?.lands?.length || 0, done = (sv.ready || 0) + (sv.done || 0);
  return { total, done, pct: total ? Math.round(done / total * 1000) / 10 : 0, draft: sv.draft || 0, revisit: sv.revisit || 0, ready: sv.ready || 0, changed: sv.changed || 0 };
}
function surveyProgressHtml() {
  const p = surveyProgress();
  return `<div class="legend-progress" title="สำรวจเสร็จ ${p.done.toLocaleString()} จาก ${p.total.toLocaleString()} แปลง"><strong>สำรวจแล้ว ${p.done.toLocaleString()} / ${p.total.toLocaleString()} แปลง (${p.pct}%)</strong>
    <div class="bar"><div style="width:${Math.min(100, p.pct)}%"></div></div></div>`;
}
// Once "สำรวจเสร็จ", the parcel's edits wait for the office to put them into LTAX.
const whenTh = at => (at ? new Date(at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '');
function surveyPill(r) {
  const sv = r?.info?.survey;
  if (!sv?.state) return '';
  return `<span class="pill ${SURVEY_STYLE[sv.state][1]}" title="${esc(sv.by || '')} ${whenTh(sv.at)}${sv.note ? `\n${esc(sv.note)}` : ''}">${esc(SURVEY_STYLE[sv.state][0])}${sv.state === 'ready' ? ` ${sv.items} รายการ` : ''}</span>`;
}
// Small button for tables: sign off, or nothing once signed off.
function surveyButton(r) {
  if (!r?.code || !r.info?.landIds?.length) return '';
  const st = r.info?.survey?.state;
  return st === 'ready' || st === 'done' ? ''
    : `<button class="primary edit-only small" data-survey="${esc(r.code)}" data-state="done" title="ส่งข้อมูลที่แก้ของแปลงนี้กลับไปรอลง LTAX">✓ สำรวจเสร็จ${st === 'changed' ? ' (อีกครั้ง)' : ''}</button>`;
}
// Full box for the parcel panel.
function surveyBox(r) {
  if (!r?.code) return '';
  if (!r.info?.landIds?.length) return '<div class="survey-box"><b>การสำรวจ</b> <span class="muted">ยังไม่มีข้อมูลที่ดินของแปลงนี้ กด "สร้างข้อมูลที่ดินจากรูปนี้" ก่อน</span></div>';
  const sv = r.info.survey, st = sv?.state;
  const btn = (state, text, cls = '') => `<button class="${cls}${st === state || (state === 'done' && (st === 'ready' || st === 'done')) ? ' on' : ''}" data-survey="${esc(r.code)}" data-state="${state}">${text}</button>`;
  return `<div class="survey-box"><b>การสำรวจ:</b> ${surveyPill(r) || '<span class="pill">ยังไม่สำรวจ</span>'}
    ${sv ? `<span class="muted">${esc(sv.by || '')} ${whenTh(sv.at)}</span>` : ''}
    ${sv?.note ? `<div class="muted">หมายเหตุ: ${esc(sv.note)}</div>` : ''}
    <div class="row edit-only">${btn('draft', 'กำลังสำรวจ')}${btn('revisit', 'ต้องกลับไปซ้ำ…')}${btn('done', st === 'changed' ? '✓ สำรวจเสร็จ (อีกครั้ง)' : '✓ สำรวจเสร็จ', 'primary')}
      ${st ? `<button data-survey="${esc(r.code)}" data-state="" title="ล้างสถานะการสำรวจ">ล้าง</button>` : ''}</div></div>`;
}
async function markSurvey(code, state) {
  const r = S.statusBy?.get(code), old = r?.info?.survey;
  const noteBox = (label, v) => `<label class="note-in"><span>${label}</span><textarea id="surveyNote" rows="2">${esc(v || '')}</textarea></label>`;
  let note = '';
  if (state === 'done') {
    const todo = (r?.reasons || []).filter(x => x.level === 'fix' && !/สำรวจเสร็จ|สำรวจซ้ำ/.test(x.text));
    if (!(await confirmBox(`ยืนยันว่าสำรวจแปลง <b>${esc(code)}</b> เสร็จแล้ว?<br><span class="muted">ข้อมูลที่แก้ของแปลงนี้ (ที่ดิน อาคาร เจ้าของ) จะไปรอให้สำนักงานลง LTAX</span>`
      + (todo.length ? `<p>ระบบกลางยังแจ้งเรื่องเหล่านี้ไว้:</p><ul>${todo.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul><span class="muted">เรื่องเนื้อที่ การใช้ประโยชน์ และเจ้าของ จะถือว่าผู้สำรวจตรวจแล้ว ส่วนข้อผิดพลาดต้องแก้ก่อนจึงจะลง LTAX ได้</span>` : '')
      + noteBox('หมายเหตุ (ถ้ามี)', ''), { ok: 'สำรวจเสร็จ' }))) return;
    note = $('#surveyNote').value;
  } else if (state === 'revisit') {
    if (!(await confirmBox(`แปลง <b>${esc(code)}</b> ต้องกลับไปสำรวจซ้ำ${noteBox('เหตุผล / สิ่งที่ต้องทำ', old?.state === 'revisit' ? old.note : '')}`, { ok: 'บันทึก' }))) return;
    note = $('#surveyNote').value;
  } else if (state === 'draft') note = old?.state === 'draft' ? old.note : '';
  else if (!(await confirmBox(`ล้างสถานะการสำรวจของแปลง <b>${esc(code)}</b>?<br><span class="muted">แปลงนี้จะกลับเป็น "ยังไม่สำรวจ" และไม่อยู่ในรายการรอลง LTAX</span>`))) return;
  const res = await api('POST', `/api/parcels/${encodeURIComponent(code)}/survey`, { state, note });
  toast(!state ? `ล้างสถานะการสำรวจแปลง ${code} แล้ว` : state !== 'done' ? `แปลง ${code}: ${SURVEY_STYLE[state][0]}`
    : res.state === 'ready' ? `แปลง ${code} สำรวจเสร็จ รอลง LTAX ${res.items.length} รายการ` : `แปลง ${code} สำรวจเสร็จ (ไม่มีข้อมูลที่ต่างจาก LTAX)`);
  await loadStatuses();
  if ($('#mapColor').value === 'survey') refreshMap();
  renderActiveTab();
  if (activeTab === 'map' && map.selected) showFeature(map.selected);
}
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-survey]'); if (!b) return;
  e.stopPropagation();
  guard(() => markSurvey(b.dataset.survey, b.dataset.state || null))();
}, true);
const statusOfFeature = f => S.statusBy?.get(f.code ? f.code.toUpperCase() : `#${f.id}`) || null;
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
  await Promise.all([loadIssues(), loadStatuses()]);
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
  ({ map: () => map.resize(), status: renderStatus, registry: renderRegistry, checks: renderChecks, changes: renderChanges, ltax: renderLtax, data: renderData, settings: renderSettings }[activeTab]
    || WEBAUTH.survey?.render[activeTab] || (() => {}))();
}
const goTab = tab => $(`#tabs button[data-tab="${tab}"]`)?.click();

// ---------- map ----------
const map = new MapView($('#map'), {
  onSelect: hit => showFeature(hit?.feature || null),
  onMarker: m => (m.kind === 'sign' ? openEditor('signboards', m.data.id) : WEBAUTH.survey?.onMarker(m)),
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
// Survey teams (web): parcels given out, or a plan being drawn up (preview) before it is saved.
let PREVIEW = null;
const STYLE = {
  assign: f => {
    if (PREVIEW) {
      if (f.kind === 'building') return ['#555555', 'อาคาร'];
      const r = PREVIEW.rows.get(String(f.code || '').toUpperCase());
      return r ? PREVIEW.style(r) : ['#e3e7ec', 'ไม่อยู่ในแผนนี้'];
    }
    return WEBAUTH.survey?.on ? WEBAUTH.survey.styleOf(f) : ['#cfd6de', 'ยังไม่มีทีมสำรวจ'];
  },
  survey: f => {
    if (f.kind === 'building') return ['#555555', 'อาคาร'];
    const code = (f.code || '').toUpperCase();
    const st = statusOfFeature(f)?.info?.survey?.state || S.surveyBy?.get(code)?.state;
    if (st) return [SURVEY_STYLE[st][2], SURVEY_STYLE[st][0]];
    return S.landByCode.get(code) ? ['#bdbdbd', 'ยังไม่สำรวจ'] : ['#8d6e63', 'ยังไม่มีข้อมูลที่ดิน'];
  },
  status: f => {
    if (f.kind === 'building') return ['#555555', 'อาคาร'];
    const r = statusOfFeature(f);
    return r ? STATUS_STYLE[r.status] : ['#bbbbbb', 'ยังไม่มีผลตรวจจากระบบกลาง'];
  },
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
        const dash = mode === 'survey' && text === SURVEY_STYLE.revisit[0] ? [6, 4] : null;
        // On satellite imagery: faint fill, bright line with a dark halo so boundaries stay visible.
        if (map.basemap === 'satellite') return f.kind === 'building'
          ? { fill: hexA(color, 0.45), stroke: '#ffffff', halo: 'rgba(0,0,0,.65)', width: 1.2 }
          : { fill: hexA(color, 0.12), stroke: lighten(color, 0.45), halo: 'rgba(0,0,0,.6)', width: dash ? 2.6 : 1.8, dash };
        return { fill: hexA(color, f.kind === 'building' ? 0.75 : 0.35), stroke: f.kind === 'building' ? '#1d2733' : hexA(color, 1), width: f.kind === 'building' ? 0.8 : dash ? 2.2 : 1, dash };
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
  $('#mapLegend').innerHTML = (mode === 'survey' ? surveyProgressHtml() : '') + [...counts].map(([t, { color, n }]) => `<span><i style="background:${color}"></i>${esc(t)} <b>${n.toLocaleString()}</b></span>`).join('');
  $('#layerToggles').innerHTML = order.map(l => `<label><input type="checkbox" data-layer="${l.id}" ${map.layers.find(x => x.id === l.id)?.visible !== false ? 'checked' : ''}> ${esc(l.name)} (${l.count.toLocaleString()})</label>`).join('');
  if (fit && S.features.length && !refreshMap.fitted) { map.fit(S.features.filter(f => f.kind === 'parcel').length ? S.features.filter(f => f.kind === 'parcel') : S.features); refreshMap.fitted = true; }
  // Keep the multi-selection pointing at the freshly loaded shapes.
  if (map.multi?.size) { const ids = new Set([...map.multi].map(f => f.id)); map.multi = new Set(map.layers.flatMap(l => l.features).filter(f => ids.has(f.id))); }
  $('#mapSearchList').innerHTML = [...S.featByCode.keys()].slice(0, 5000).map(c => `<option value="${esc(c)}">`).join('');
  updateMarkers();
}
// Points over the shapes: signs placed on the map, and (for team leads) where the team is.
function updateMarkers() {
  const signs = (S.rec?.signboards || []).filter(s => Number.isFinite(Number(s.loc?.lat)) && Number.isFinite(Number(s.loc?.lon)))
    .map(s => ({ kind: 'sign', lon: Number(s.loc.lon), lat: Number(s.loc.lat), label: s.signboardName, data: s }));
  map.markers = [...signs, ...(WEBAUTH.survey?.markers() || [])];
  map.draw();
}
// Parcel codes a record belongs to (for the survey teams' locks).
function recordCodes(entity, rec) {
  if (!rec) return [];
  const up = c => String(c || '').toUpperCase();
  if (entity === 'lands') return [up(rec.parcelCode)];
  if (entity === 'buildings') return [...(rec.landIds || []).map(id => up(S.by.lands.get(id)?.parcelCode)), up(String(rec.buildingCode || '').split('-')[0])].filter(Boolean);
  if (entity === 'signboards') return [up(S.by.lands.get(rec.landId)?.parcelCode)].filter(Boolean);
  return [];
}
const lockHtml = lock => (lock ? `<div class="lock-box">🔒 <b>${esc(lock.reason)}</b><br><span>ดูข้อมูลได้ แต่แก้ไขไม่ได้ เพื่อไม่ให้ทำงานซ้ำซ้อน</span></div>` : '');
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

function statusHtml(f) {
  if (f.kind !== 'parcel') return '';
  const r = statusOfFeature(f);
  if (!r) {
    // No result from the central system yet: the survey can still record its work.
    const code = (f.code || '').toUpperCase(), land = code && S.landByCode.get(code), sv = S.surveyBy?.get(code);
    return code ? surveyBox({ code, info: { landIds: land ? [land.id] : [], survey: sv ? { state: sv.state, at: sv.at, by: sv.by, note: sv.note, items: sv.items.length } : null } }) : '';
  }
  const [, text, cls] = STATUS_STYLE[r.status];
  const todo = r.reasons.filter(x => x.level !== 'note');
  return `<div class="status-box ${cls}"><b>สถานะจากระบบกลาง: ${esc(text)}</b> <span class="muted">${esc(LINK_TH[r.link] || '')} · ${esc(LTAX_TH[r.ltax] || '')}</span>
    ${todo.length ? `<ul>${todo.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul>` : ''}
    </div>${surveyBox(r)}`;
}
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
      <dt>เจ้าของ</dt><dd>${ownerCards(rec.ownerIds)}</dd>
      <dt>เอกสารสิทธิ์</dt><dd>${esc(label(DOC_TYPES, rec.docType))} ${esc(rec.docNo)}</dd>
      <dt>เลขที่ดิน / หน้าสำรวจ</dt><dd>${esc(rec.parcelNo || '-')} / ${esc(rec.dealingFileNo || '-')}</dd>
      <dt>หมู่ / ตำบล</dt><dd>${esc(rec.villageNo || '-')} / ${esc(rec.district || '-')}</dd>
      <dt>เนื้อที่ตามเอกสาร</dt><dd>${formatRNW(rec.rai, rec.ngan, rec.wah)} (${formatNumber(toWah(rec.rai, rec.ngan, rec.wah))} ตร.ว.)</dd>
      <dt>การใช้ประโยชน์</dt><dd>${(rec.uses || []).map(u => `${esc(label(LAND_USE_TYPES, u.usedType))} ${formatRNW(u.rai, u.ngan, u.wah)}`).join('<br>') || '-'}</dd>
      <dt>ราคาประเมิน</dt><dd>${rec.pricePerWah ? `${formatNumber(rec.pricePerWah)} บาท/ตร.ว. · รวม ${formatNumber(landTotal(rec))} บาท` : '<span class="pill warn">ยังไม่มี</span>'}${rec.ltaxValues?.tax ? `<br>ภาษีตาม LTAX ${formatNumber(rec.ltaxValues.tax)} บาท` : ''}</dd>
      <dt>สิ่งปลูกสร้าง</dt><dd>${S.rec.buildings.filter(b => (b.landIds || []).includes(rec.id)).map(b => `<button class="link" data-goto-building="${esc(b.id)}" title="ไปที่อาคารนี้">${esc(b.buildingCode || b.addrNo || 'อาคาร')}</button>`).join(' ') || '-'}</dd>
      <dt>ป้าย</dt><dd>${(S.rec.signboards || []).filter(s => s.landId === rec.id).map(s => `<button class="link" data-open-sign="${esc(s.id)}">${esc(s.signboardName || s.signboardCode || 'ป้าย')}</button>`).join(' ') || '-'}</dd>
    </dl>`;
  } else if (rec) {
    recHtml = `<dl class="kv">
      <dt>เจ้าของ</dt><dd>${esc(ownerNames(rec.ownerIds)) || '-'}</dd>
      <dt>เลขที่ / หมู่</dt><dd>${esc(rec.addrNo || '-')} / ${esc(rec.villageNo || '-')}</dd>
      <dt>ประเภท</dt><dd>${esc(buildingTypeLabel(rec.buildingType)) || '-'}</dd>
      <dt>เจ้าของ (รายละเอียด)</dt><dd>${ownerCards(rec.ownerIds)}</dd>
      <dt>ชั้น / พื้นที่</dt><dd>${esc(rec.noFloor || '-')} ชั้น / ${formatNumber(rec.totalArea)} ตร.ม.</dd>
      <dt>สร้างเสร็จ</dt><dd>${esc(rec.since || '-')}</dd>
      <dt>ราคาประเมิน</dt><dd>${(() => { const v = buildingValue(rec, S.deprTable); return rec.pricePerMeter ? `${formatNumber(rec.pricePerMeter)} บาท/ตร.ม. · ทุนทรัพย์ ${formatNumber(v.gross)} · หักค่าเสื่อม ${v.deprPct ?? '-'}% · คงเหลือ ${formatNumber(v.net)} บาท` : '<span class="pill warn">ยังไม่มี</span>'; })()}</dd>
      <dt>การใช้ประโยชน์</dt><dd>${(rec.uses || []).map(u => esc(label(LAND_USE_TYPES, u.usedType))).join('<br>') || '-'}</dd>
      <dt>แปลงที่ตั้ง</dt><dd>${(rec.landIds || []).map(id => S.by.lands.get(id)).filter(Boolean).map(l => `<button class="link" data-goto-parcel="${esc(l.parcelCode)}">${esc(l.parcelCode)}</button>`).join(' ') || '-'}</dd>
    </dl>`;
  }
  side.classList.add('open');
  const pcode = String(f.code || '').toUpperCase().split(f.kind === 'building' ? '-' : '\u0000')[0];
  const lock = WEBAUTH.survey?.lockOf(pcode) || null;
  side.classList.toggle('locked', !!lock);
  side.innerHTML = `
    <div class="side-head"><h3>${esc(f.code || '(ไม่มีรหัส)')}</h3><button class="close" id="sideClose" title="ปิด">✕</button></div>
    ${lockHtml(lock)}${WEBAUTH.survey?.assignInfo(pcode) || ''}
    <div class="muted">${esc(layer?.name)} · FID ${f.fid}${f.areaM2 ? ` · พื้นที่ในแผนที่ ${formatNumber(f.areaM2 / 4)} ตร.ว. (${formatNumber(f.areaM2)} ตร.ม.)` : ''}</div>
    <div>${rec ? `<span class="pill" style="background:${pushState(entity, rec)[0]}33">${esc(pushState(entity, rec)[1])}</span>` : ''}${rec ? `<span class="pill ok">มีในทะเบียน</span>${rec.pending === 'create' ? '<span class="pill info">ยังไม่มีใน LTAX</span>' : rec.pending === 'update' ? '<span class="pill warn">แก้ไขแล้ว รอส่ง</span>' : '<span class="pill ok">ตรงกับ LTAX</span>'}` : '<span class="pill err">ไม่มีในทะเบียน</span>'}
      ${chk ? `<span class="pill ${chk.found ? 'ok' : 'err'}">${chk.found ? (chk.count > 1 ? `พบใน LTAX ${chk.count} รายการ` : 'พบใน LTAX') : 'ไม่พบใน LTAX'} · ตรวจ ${new Date(chk.at).toLocaleDateString('th-TH')}</span>` : ''}
      ${ov ? `<span class="pill ${ov.result === 'ตรงแปลง' || ov.result === 'แปลงซ้อนกัน' ? 'ok' : 'warn'}">${esc(ov.result)}${ov.foundParcels ? ` (${esc(ov.foundParcels)})` : ''}</span>` : ''}</div>
    ${statusHtml(f)}
    ${recHtml}
    ${rec ? photosHtml(entity, rec) : ''}
    ${f.code && f.kind !== 'other' ? '<div class="row"><button id="liveLtax" title="อ่านข้อมูลปัจจุบันจาก LTAX ONLINE มาแสดง ไม่บันทึกเก็บไว้">⟳ ดูข้อมูลสดจาก LTAX</button></div><div id="liveBox"></div>' : ''}
    ${issues.length ? `<ul class="issues">${issues.map(i => `<li class="${i.level}">${esc(i.message)}</li>`).join('')}</ul>` : ''}
    <div class="row">
      ${rec ? `<button class="primary" id="sideEdit">แก้ไขข้อมูลทะเบียน</button>` : f.kind !== 'other' ? `<button class="primary" id="sideCreate">สร้างข้อมูล${f.kind === 'parcel' ? 'ที่ดิน' : 'สิ่งปลูกสร้าง'}จากรูปนี้</button>` : ''}
    </div>
    <div class="row">${navLink(f)}${/Polygon/.test(f.geometry.type) ? '<button id="shapeEdit">✎ แก้ไขรูป</button>' : ''}
      ${f.kind === 'parcel' ? '<button id="shapeAddBuilding">▭ วาดอาคารในแปลงนี้</button>' : ''}<button class="danger" id="shapeDelete">ลบรูป</button></div>
    <h4>ข้อมูลรูปแปลง (แก้ไขได้)</h4>
    <div class="form-row"><label>รหัส${layer?.codeField ? ` (${esc(layer.codeField)})` : ''}</label><input id="featCode" value="${esc(f.code)}"></div>
    <table class="grid attrs">${Object.entries(full.attrs || {}).map(([k, v]) => `<tr><th>${esc(k)}</th><td><input data-attr="${esc(k)}" value="${esc(v ?? '')}"></td></tr>`).join('')}</table>
    <div class="row"><button id="featSave">บันทึกข้อมูลรูปแปลง</button></div>`;
  $('#sideEdit')?.addEventListener('click', () => openEditor(entity, rec.id));
  hydratePhotos(side);
  side.querySelectorAll('[data-open-owner]').forEach(b => b.addEventListener('click', () => openEditor('owners', b.dataset.openOwner)));
  side.querySelectorAll('[data-open-sign]').forEach(b => b.addEventListener('click', () => openEditor('signboards', b.dataset.openSign)));
  side.querySelectorAll('[data-goto-building], [data-goto-parcel]').forEach(b => b.addEventListener('click', () => {
    const bld = b.dataset.gotoBuilding && S.by.buildings.get(b.dataset.gotoBuilding);
    const code = bld ? bld.buildingCode : b.dataset.gotoParcel;
    const shape = code && map.layers.flatMap(l => l.features).find(x => x.code && x.code.toUpperCase() === String(code).toUpperCase());
    if (shape) { map.selected = shape; map.zoomTo(shape); showFeature(shape); }
    else if (bld) openEditor('buildings', bld.id);
    else toast('ไม่พบรูปบนแผนที่', true);
  }));
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
  lockOf: code => WEBAUTH.survey?.lockOf(code) || null,
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
    const lock = WEBAUTH.survey?.lockForCodes(recordCodes(entity, id ? S.by[entity].get(id) : rec)) || null;
    form.classList.toggle('locked', !!lock);
    form.innerHTML = `<div class="head"><h3>${id ? 'แก้ไข' : 'เพิ่ม'}${def.th}: ${esc(def.title(rec))}</h3>
        ${rec.ltaxId ? `<span class="pill">รหัสใน LTAX ${esc(rec.ltaxId)}</span>` : '<span class="pill info">ยังไม่มีใน LTAX</span>'}
        <button type="button" data-close>ปิด</button></div>
      <div class="body">${lockHtml(lock)}
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
        ${id ? photosHtml(entity, S.by[entity].get(id)) : ''}
      </div>
      <div class="foot">${id ? '<button type="button" class="danger" id="delRec">ลบในเครื่อง</button>' : ''}<span class="grow"></span>
        <button type="button" data-close>ยกเลิก</button><button type="button" class="primary" id="saveRec">บันทึก</button></div>`;
    if (def.uses) {
      const total = entity === 'lands' ? toWah(rec.rai, rec.ngan, rec.wah) : num(rec.totalArea) || 0;
      const used = entity === 'lands' ? (rec.uses || []).reduce((s, u) => s + toWah(u.rai, u.ngan, u.wah), 0) : (rec.uses || []).reduce((s, u) => s + (num(u.area) || 0), 0);
      $('#useSum').textContent = `ใช้แล้ว ${formatNumber(used)} จาก ${formatNumber(total)} ${entity === 'lands' ? 'ตร.ว.' : 'ตร.ม.'}`;
    }
    hydratePhotos(form);
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

// ---------- parcel status (central system → Supabase → survey) ----------
function statusSummaryHtml(sm) {
  if (!sm) return '';
  const top = Object.entries(sm.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return `<div class="status-sum"><b>สรุปการเชื่อมข้อมูล ${sm.total.toLocaleString()} แปลง</b>
    <span class="pill ok">ข้อมูลตรง ${sm.ok.toLocaleString()}</span><span class="pill err">ต้องปรับแก้ ${sm.fix.toLocaleString()}</span><span class="pill warn">รอ LTAX ${sm.send.toLocaleString()}</span>
    ${top.length ? `<ul>${top.map(([k, n]) => `<li>${esc(k)}: ${n.toLocaleString()}</li>`).join('')}</ul>` : ''}
    <span class="muted">${WEB ? '' : S.settings.cloud?.enabled ? 'ส่งสถานะแต่ละแปลงขึ้น Supabase ให้ระบบสำรวจแล้ว (ภายในไม่กี่วินาที)' : 'เปิดซิงก์ Supabase ในหน้าตั้งค่า เพื่อส่งสถานะให้ระบบสำรวจ'}</span></div>`;
}
let stView = 'fix', stPage = 0;
$('#stLink').innerHTML += Object.entries(LINK_TH).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
$('#stView').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  stView = b.dataset.v; stPage = 0; $$('#stView button').forEach(x => x.classList.toggle('on', x === b)); renderStatus();
});
$('#stLink').addEventListener('change', () => { stPage = 0; renderStatus(); });
$('#stSearch').addEventListener('input', () => { stPage = 0; renderStatus(); });
$('#stSummary').addEventListener('click', e => {
  const s = e.target.closest('[data-sv]');
  if (s) { $('#stSurvey').value = s.dataset.sv; stView = ''; $$('#stView button').forEach(x => x.classList.toggle('on', x.dataset.v === '')); stPage = 0; return renderStatus(); }
  const c = e.target.closest('[data-q]'); if (c) { $('#stSearch').value = c.dataset.q; stPage = 0; renderStatus(); }
});
$('#stSurvey').addEventListener('change', () => { stPage = 0; renderStatus(); });
function renderStatus() {
  const st = S.status;
  if (!st) return;
  const sm = st.summary;
  $('#stWhen').textContent = st.checkedAt ? `ระบบกลางตรวจล่าสุด ${new Date(st.checkedAt).toLocaleString('th-TH')}` : WEB ? 'ยังไม่มีผลตรวจจากระบบกลาง (เครื่องสำนักงานยังไม่ได้ส่งขึ้น)' : '';
  $('#stSummary').innerHTML = `<div class="card ok"><b>${sm.ok.toLocaleString()}</b>ข้อมูลตรง</div><div class="card err"><b>${sm.fix.toLocaleString()}</b>ต้องปรับแก้ในระบบสำรวจ</div><div class="card warn"><b>${sm.send.toLocaleString()}</b>รอดำเนินการใน LTAX</div>`
    + (() => { const p = surveyProgress(); return `<div class="card info click" data-sv="ready+done"><b>${p.pct}%</b>สำรวจแล้ว ${p.done.toLocaleString()} / ${p.total.toLocaleString()} แปลง<div class="bar"><div style="width:${Math.min(100, p.pct)}%"></div></div></div>`
      + `<div class="card click" data-sv="draft"><b>${p.draft.toLocaleString()}</b>กำลังสำรวจ</div><div class="card err click" data-sv="revisit"><b>${p.revisit.toLocaleString()}</b>ต้องกลับไปสำรวจซ้ำ</div>`
      + `<div class="card ok click" data-sv="ready"><b>${p.ready.toLocaleString()}</b>สำรวจเสร็จ รอลง LTAX</div>`
      + (p.changed ? `<div class="card warn click" data-sv="changed"><b>${p.changed.toLocaleString()}</b>แก้ไขหลังกดสำรวจเสร็จ</div>` : ''); })()
    + Object.entries(sm.reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `<div class="card click" data-q="${esc(k.split('…')[0].trim())}"><b>${n.toLocaleString()}</b>${esc(k)}</div>`).join('');
  const q = $('#stSearch').value.trim().toUpperCase(), lk = $('#stLink').value;
  const sq = $('#stSurvey').value, svOk = r => !sq || (sq === 'none' ? !r.survey && r.info?.landIds?.length : sq.split('+').includes(r.survey));
  const rows = st.rows.filter(r => (!stView || r.status === stView) && svOk(r) && (!lk || r.link === lk) && (!q || r.code.includes(q) || r.reasons.some(x => x.text.toUpperCase().includes(q))));
  stPage = Math.min(stPage, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
  const wah = v => (v === null || v === undefined ? '-' : formatNumber(v));
  $('#stTable').innerHTML = '<tr><th>รหัสแปลง</th><th>สถานะ</th><th>การเชื่อมโยง</th><th>LTAX</th><th>เนื้อที่ ตร.ว. (เอกสาร / แผนที่)</th><th>สิ่งที่ต้องทำ</th><th>การสำรวจ</th></tr>'
    + rows.slice(stPage * PAGE, stPage * PAGE + PAGE).map(r => `<tr class="click" data-id="${esc(r.id)}"><td>${esc(r.code || '(ไม่มีรหัส)')}</td>
      <td><span class="pill ${STATUS_STYLE[r.status][2]}">${esc(STATUS_STYLE[r.status][1])}</span></td><td>${esc(LINK_TH[r.link] || r.link)}</td><td>${esc(LTAX_TH[r.ltax] || r.ltax)}</td>
      <td class="num">${wah(r.info?.areaDocWah)} / ${wah(r.info?.areaMapWah)}</td>
      <td>${r.reasons.filter(x => x.level !== 'note').map(x => esc(x.text)).join('<br>') || '<span class="muted">-</span>'}</td>
      <td>${surveyPill(r)}${surveyButton(r)}</td></tr>`).join('');
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  $('#stPager').innerHTML = `<button ${stPage ? '' : 'disabled'} data-p="-1">‹</button> หน้า ${stPage + 1} / ${pages} · ${rows.length.toLocaleString()} แปลง <button ${stPage + 1 < pages ? '' : 'disabled'} data-p="1">›</button>`;
}
$('#stPager').addEventListener('click', e => { const b = e.target.closest('button[data-p]'); if (b) { stPage += Number(b.dataset.p); renderStatus(); } });
$('#stTable').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const r = S.statusBy.get(tr.dataset.id); if (!r) return;
  const f = (r.info?.featureIds || []).map(id => map.layers.flatMap(l => l.features).find(x => x.id === id)).find(Boolean);
  if (f) { $('#tabs button[data-tab="map"]').click(); map.selected = f; map.zoomTo(f); showFeature(f); }
  else if (r.info?.landIds?.[0]) openEditor('lands', r.info.landIds[0]);
});
$('#stPublish').addEventListener('click', guard(async () => {
  const r = await api('POST', '/api/parcel-status/publish');
  toast(`ส่งสถานะขึ้น Supabase แล้ว ${r.sent.toLocaleString()} แปลง`);
  await loadStatuses(); renderStatus();
}));

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
  let list = await api('GET', '/api/changes');
  const readyOf = new Map((S.survey || []).filter(s => s.state === 'ready').flatMap(s => s.items.map(it => [`${it.entity}:${it.recordId}`, s.code])));
  if (chgView === 'ready') list = list.filter(c => readyOf.has(`${c.entity}:${c.id}`));
  const errIds = new Set(S.issues.filter(i => i.level === 'error').map(i => i.id));
  const by = list.reduce((m, c) => ((m[`${c.entityTh}|${c.action}`] = (m[`${c.entityTh}|${c.action}`] || 0) + 1), m), {});
  $('#chgSummary').innerHTML = Object.entries(by).map(([k, n]) => { const [e, a] = k.split('|'); return `<div class="card ${a === 'create' ? '' : 'warn'}"><b>${n.toLocaleString()}</b>${esc(e)} ${a === 'create' ? 'ยังไม่มีใน LTAX' : 'แก้ไขแล้ว รอส่ง'}</div>`; }).join('')
    || (chgView === 'ready' ? '<div class="card"><b>0</b>ยังไม่มีแปลงที่สำรวจเสร็จและรอลง LTAX</div>' : '<div class="card ok"><b>0</b>ข้อมูลตรงกับ LTAX ทั้งหมด</div>');
  const shown = list.slice(0, 500);
  if (S.deletions.length) $('#chgSummary').insertAdjacentHTML('beforeend', `<div class="card err"><b>${S.deletions.length.toLocaleString()}</b>ลบในเครื่องแล้ว รอลบใน LTAX</div>`);
  const delHtml = S.deletions.length ? `<div class="item"><header><b>รอลบใน LTAX (${S.deletions.length})</b><span class="muted">L-LAN ไม่ลบใน LTAX ให้ ต้องลบในระบบเอง แล้วกด "ลบใน LTAX แล้ว"</span></header>
    <ul>${S.deletions.map(x => `<li>${esc(ENTITY_TH[x.entity])} ${esc(x.title)} (รหัสใน LTAX ${esc(x.ltaxId)}) <button data-deldone="${esc(x.id)}">ลบใน LTAX แล้ว</button></li>`).join('')}</ul></div>` : '';
  $('#chgList').innerHTML = delHtml + `<div class="row"><label class="check"><input type="checkbox" id="chgAll"> เลือกทั้งหมด (ไม่รวมรายการที่มีข้อผิดพลาด)</label><span class="muted">${list.length > 500 ? `แสดง 500 จาก ${list.length.toLocaleString()} รายการ` : ''}</span></div>`
    + shown.map(c => `<div class="item"><header><input type="checkbox" data-sel="${c.entity}:${c.id}" ${S.selected.has(`${c.entity}:${c.id}`) ? 'checked' : ''} ${errIds.has(c.id) ? 'disabled title="มีข้อผิดพลาด ต้องแก้ก่อนส่ง"' : ''}>
      <b>${esc(c.entityTh)} ${esc(c.title)}</b> ${readyOf.has(`${c.entity}:${c.id}`) ? `<span class="pill info">สำรวจเสร็จ แปลง ${esc(readyOf.get(`${c.entity}:${c.id}`))}</span>` : ''}<span class="pill ${c.action === 'create' ? 'info' : 'warn'}">${c.action === 'create' ? 'ยังไม่มีใน LTAX' : `แก้ ${c.changes.length} ช่อง`}</span>
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
  const ready = (S.survey || []).filter(s => s.state === 'ready');
  if ($('#jobType').value === 'check') {
    if (scope === 'survey-ready') return ready.map(s => ({ kind: 'parcel', code: s.code }));
    const shapes = S.features.filter(f => f.code && (scope === 'buildings-shapes' ? f.kind === 'building' : f.kind === 'parcel'));
    const pick = scope === 'parcels-unchecked' ? shapes.filter(f => !S.checks.has(`parcel:${f.code}`))
      : scope === 'parcels-unjoined' ? shapes.filter(f => !recordOfFeature(f))
        : scope === 'selected' ? [...S.selected].map(k => { const [e, id] = k.split(':'); const r = S.by[e]?.get(id); return r && { kind: e === 'buildings' ? 'building' : 'parcel', code: e === 'buildings' ? r.buildingCode : r.parcelCode }; }).filter(x => x && x.code)
          : shapes;
    return [...new Map(pick.map(f => [`${f.kind}:${f.code}`, { kind: f.kind, code: f.code }])).values()].slice(0, limit);
  }
  if (scope === 'selected') items = [...S.selected].map(k => { const [entity, recordId] = k.split(':'); return { entity, recordId }; });
  else if (scope === 'survey-ready') items = [...new Map(ready.flatMap(s => s.items).filter(it => !errIds.has(it.recordId)).map(it => [`${it.entity}:${it.recordId}`, it])).values()];
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
  if (currentJob.cloudWarning) toast(currentJob.cloudWarning, true);
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
function startEvents() { new EventSource('/api/ltax/events').onmessage = onEvent; }
const onEvent = e => {
  const ev = JSON.parse(e.data);
  // Changes made on the web arrived through the Supabase sync.
  if (ev.type === 'cloud') { if (ev.changed && !document.querySelector('dialog[open]') && !map.tool) reloadAll(); if (activeTab === 'settings') renderSettings(); return; }
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
    + statusSummaryHtml(r.status)
    + (r.report.problems.length ? `<details><summary>ข้อสังเกต ${r.report.problems.length} รายการ</summary><ul>${r.report.problems.slice(0, 300).map(p => `<li>${esc(p.sheet)} ${esc(p.row)}: ${esc(p.message)}</li>`).join('')}</ul></details>` : '');
  if (!preview) { toast('นำเข้า Excel แล้ว'); await reloadAll(); }
}
// ตารางแบบฟอร์ม LTAX: export, check, import; what changed waits for LTAX.
const TBL_TH = { owners: 'เจ้าของ', lands: 'ที่ดิน', buildings: 'สิ่งปลูกสร้าง', signboards: 'ป้าย' };
let tblItems = [];
$('#tblScope').addEventListener('change', e => { $('#tblExport').href = `/api/export/ltax-table?scope=${e.target.value}`; });
function tableReportHtml(r) {
  const c = r.counts;
  const rows = Object.entries(TBL_TH).map(([k, th]) => `<tr><td>${th}</td><td class="num">${c[k]?.create ?? 0}</td><td class="num">${c[k]?.update ?? 0}</td><td class="num">${c[k]?.same ?? 0}</td></tr>`).join('');
  const errs = r.problems.filter(p => p.level === 'error'), warns = r.problems.filter(p => p.level !== 'error');
  return `<p>${r.imported ? '<b>นำเข้าแล้ว</b>' : '<b>ผลตรวจไฟล์</b> (ยังไม่ได้บันทึก)'} · ชีตที่พบ: ${esc(r.sheets.join(', '))}</p>
    <table class="grid counts"><tr><th></th><th>เพิ่มใหม่</th><th>แก้ไข</th><th>ไม่เปลี่ยน</th></tr>${rows}</table>
    ${r.errorCount ? `<p class="pill warn">${r.errorCount.toLocaleString()} รายการยังมีข้อผิดพลาด บันทึกเข้า L-LAN ได้ แต่ส่ง LTAX ไม่ได้จนกว่าจะแก้</p>` : ''}
    ${errs.length ? `<details open><summary class="err">ค่าที่ใช้ไม่ได้ ${r.problemCount > r.problems.length ? `${r.problemCount.toLocaleString()} (แสดง ${r.problems.length})` : errs.length} รายการ: ช่องนั้นจะไม่ถูกเปลี่ยน</summary><ul>${errs.map(p => `<li>ชีต ${esc(p.sheet)} แถว ${p.row}: ${esc(p.message)}</li>`).join('')}</ul></details>` : ''}
    ${warns.length ? `<details><summary>ข้อสังเกต ${warns.length} รายการ</summary><ul>${warns.map(p => `<li>ชีต ${esc(p.sheet)} แถว ${p.row}: ${esc(p.message)}</li>`).join('')}</ul></details>` : ''}
    ${r.changeCount ? `<details${r.imported ? '' : ' open'}><summary>รายการที่${r.imported ? '' : 'จะ'}เปลี่ยน ${r.changeCount.toLocaleString()} รายการ${r.changeCount > r.changes.length ? ` (แสดง ${r.changes.length})` : ''}</summary><div class="list">${r.changes.map(x => `<div class="item"><header><b>${esc(TBL_TH[x.entity])} ${esc(x.title)}</b>
      <span class="pill ${x.action === 'create' ? 'info' : 'warn'}">${x.action === 'create' ? 'เพิ่มใหม่' : `แก้ ${x.changes.length} ช่อง`}</span>${x.errors.length ? `<span class="pill err">มีข้อผิดพลาด ${x.errors.length}</span>` : ''}</header>
      ${x.changes.length ? `<ul>${x.changes.map(d => `<li>${esc(d.th)}: <span class="from">${esc(d.from || '(ว่าง)')}</span> → <span class="to">${esc(d.to || '(ว่าง)')}</span></li>`).join('')}</ul>` : ''}
      ${x.errors.length ? `<ul class="issues">${x.errors.map(m => `<li class="error">${esc(m)}</li>`).join('')}</ul>` : ''}</div>`).join('')}</div></details>`
      : '<p class="muted">ไม่มีอะไรต่างจากข้อมูลใน L-LAN</p>'}
    ${r.imported && r.status && !WEB ? statusSummaryHtml(r.status) : ''}`;
}
async function postTable(apply) {
  const file = $('#tblFile').files[0];
  if (!file) throw new Error('เลือกไฟล์ Excel ก่อน');
  $('#tblResult').textContent = 'กำลังอ่านไฟล์…';
  $('#tblSend').hidden = true;
  const body = { name: file.name, file: await fileB64(file), preview: true };
  const check = await api('POST', '/api/import/ltax-table', body);
  $('#tblResult').innerHTML = tableReportHtml(check);
  if (!apply) return;
  if (!check.changeCount) return toast('ไฟล์นี้ไม่มีอะไรต่างจากข้อมูลใน L-LAN');
  const n = k => Object.values(check.counts).reduce((s, c) => s + c[k], 0);
  const bad = check.problems.filter(p => p.level === 'error').length;
  if (!(await confirmBox(`นำเข้าตารางแบบฟอร์ม LTAX?<br>เพิ่มใหม่ <b>${n('create').toLocaleString()}</b> · แก้ไข <b>${n('update').toLocaleString()}</b> รายการ`
    + (bad ? `<br><span class="muted">มีค่าที่ใช้ไม่ได้ ${bad.toLocaleString()} ช่อง ช่องเหล่านั้นจะไม่ถูกเปลี่ยน</span>` : '')
    + `<br><span class="muted">รายการที่เปลี่ยนจะไปรอส่งเข้า LTAX (ยังไม่ส่งเข้า LTAX ตอนนี้)</span>`, { ok: 'นำเข้า' }))) return;
  const done = await api('POST', '/api/import/ltax-table', { ...body, preview: false });
  tblItems = done.items || [];
  $('#tblResult').innerHTML = tableReportHtml(done);
  $('#tblSend').hidden = WEB || !tblItems.length;
  toast(`นำเข้าแล้ว ${tblItems.length.toLocaleString()} รายการ รอส่งเข้า LTAX`);
  await reloadAll();
}
$('#tblPreview').addEventListener('click', guard(() => postTable(false)));
$('#tblImport').addEventListener('click', guard(() => postTable(true)));
$('#tblSend').addEventListener('click', () => {
  S.selected = new Set(tblItems.map(it => `${it.entity}:${it.recordId}`));
  $('#jobScope').value = 'selected'; $('#jobType').value = 'push';
  $('#tabs button[data-tab="ltax"]').click();
  toast(`เลือก ${S.selected.size.toLocaleString()} รายการที่นำเข้าแล้ว เริ่มด้วยโหมดทดลองก่อน`);
});
$('#xlsxPreview').addEventListener('click', guard(() => postXlsx(true)));
$('#xlsxImport').addEventListener('click', guard(() => postXlsx(false)));
$('#shpImport').addEventListener('click', guard(async () => {
  const files = [...$('#shpFiles').files];
  const groups = new Map();
  for (const f of files) { const m = f.name.match(/^(.*)\.(shp|dbf|shx|prj|cpg)$/i); if (m) { if (!groups.has(m[1])) groups.set(m[1], {}); groups.get(m[1])[m[2].toLowerCase()] = f; } }
  if (!groups.size) throw new Error('เลือกไฟล์ .shp และ .dbf ก่อน');
  const out = [];
  let lastStatus = null;
  for (const [name, g] of groups) {
    if (!g.shp || !g.dbf) { out.push(`${name}: ขาดไฟล์ .shp หรือ .dbf`); continue; }
    $('#shpResult').textContent = `กำลังนำเข้า ${name}…`;
    const body = { name, kind: $('#shpKind').value, codeField: $('#shpCode').value.trim() || undefined, crs: $('#shpCrs').value };
    for (const ext of ['shp', 'dbf', 'shx', 'prj', 'cpg']) if (g[ext]) body[ext] = await fileB64(g[ext]);
    const r = await api('POST', '/api/import/shapefile', body);
    lastStatus = r.status;
    const j = r.join;
    out.push(`${name}: ${r.layer.count.toLocaleString()} รูป · ${r.layer.kind === 'parcel' ? 'แปลงที่ดิน' : r.layer.kind === 'building' ? 'สิ่งปลูกสร้าง' : 'อื่น ๆ'} · ${r.layer.crs} · ช่องรหัส ${r.layer.codeField || '-'}${j ? ` · จอยได้ ${j.joined.toLocaleString()} จอยไม่ได้ ${j.notJoined.toLocaleString()}` : ''}`);
  }
  $('#shpResult').innerHTML = out.map(esc).join('<br>') + statusSummaryHtml(lastStatus);
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
  const y = c.sync || {}, when = t => (t ? new Date(t).toLocaleString('th-TH') : '-');
  $('#cloudState').innerHTML = `${c.hasKey ? 'มี key แล้ว' : '<span class="pill warn">ยังไม่มี key</span>'} · ซิงก์อัตโนมัติ: <b>${c.enabled ? 'เปิด' : 'ปิด'}</b>`
    + ` · อัปโหลดทั้งหมดล่าสุด ${when(y.uploadedAt)} · ส่งล่าสุด ${when(y.lastPush)} · ดึงล่าสุด ${when(y.lastPull)}`
    + `${y.queued ? ` · <span class="pill warn">รอส่ง ${y.queued.toLocaleString()} รายการ</span>` : ''}${y.error ? ` · <span class="pill err">${esc(y.error)}</span>` : ''}`;
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
  if (!$('#cloudOn').checked) return toast('ติ๊ก "ซิงก์ข้อมูลกับ Supabase อัตโนมัติ" ก่อน', true);
  const n = Object.values(S.rec).reduce((a, l) => a + l.length, 0);
  if (!(await confirmBox(`อัปโหลดข้อมูลทั้งหมดขึ้น Supabase?<br>ทะเบียน ${n.toLocaleString()} รายการ (รวมชื่อ เลขบัตร ที่อยู่ของเจ้าของ) และรูป ${S.features.length.toLocaleString()} รูป<br><span class="muted">เฉพาะสมาชิกใน llan_members อ่านได้ การแก้ไขที่ทำบนเว็บแล้วจะถูกดึงมาก่อน ไม่ถูกทับ</span>`, { ok: 'อัปโหลด' }))) return;
  $('#cloudState').textContent = 'กำลังอัปโหลด… (อาจใช้หลายนาที)';
  const r = await api('POST', '/api/cloud/push');
  toast(`อัปโหลดแล้ว ทะเบียน ${r.records.toLocaleString()} รายการ · ${r.layers} ชั้น ${r.features.toLocaleString()} รูป`); await reloadAll(); renderSettings();
}));
$('#cloudPull').addEventListener('click', guard(async () => {
  await saveCloud();
  $('#cloudState').textContent = 'กำลังซิงก์…';
  const r = await api('POST', '/api/cloud/sync');
  const p = r.pulled || {};
  toast(`ส่งขึ้น ${r.sent || 0} รายการ · รับจากเว็บ: ทะเบียน ${p.records || 0} รูป ${p.features || 0} ลบ ${p.deleted || 0}`); await reloadAll(); renderSettings();
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
  if (WEB) return showWebSession();
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

// ---------- web mode: Supabase sign-in, data in Supabase, downloads ----------
const NAV_ICON = {
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/>',
  mywork: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 12l2 2 4-4"/>',
  status: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2c2.9.3 5.5 2.6 5.5 5.8"/>',
  summary: '<path d="M4 19h16M7 16V9M12 16V5M17 16v-4"/>',
  plan: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 15h3M13 15h3"/>',
  registry: '<path d="M5 4h11l3 3v13H5Z"/><path d="M9 10h6M9 14h6M9 18h4"/>',
  checks: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17v.5"/>',
  changes: '<path d="M4 20h4l11-11-4-4L4 16Z"/><path d="M13.5 6.5l4 4"/>',
  data: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
};
const SB = () => String(CONFIG?.url || '').replace(/\/$/, '');
const wsave = v => { try { v ? localStorage.setItem('llan.full.session', JSON.stringify(v)) : localStorage.removeItem('llan.full.session'); } catch { /* blocked */ } };
const wload = () => { try { return JSON.parse(localStorage.getItem('llan.full.session')); } catch { return null; } };
async function sbAuth(path, body) {
  const res = await fetch(SB() + '/auth/v1/' + path, { method: 'POST', headers: { apikey: CONFIG.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(/invalid/i.test(d.error_description || d.msg || '') ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : d.error_description || d.msg || 'เข้าสู่ระบบไม่สำเร็จ');
  return d;
}
function keepWeb(d) {
  WEBAUTH.session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, email: d.user?.email || WEBAUTH.session?.email };
  wsave(WEBAUTH.session);
}
async function webToken() {
  const ws = WEBAUTH.session;
  if (!ws) throw new Error('กรุณาเข้าสู่ระบบ');
  if (ws.expires_at - Date.now() < 60000) {
    try { keepWeb(await sbAuth('token?grant_type=refresh_token', { refresh_token: ws.refresh_token })); }
    catch (err) { webSignOut('หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่'); throw err; }
  }
  return WEBAUTH.session.access_token;
}
function webSignOut(msg = '') {
  clearInterval(webOpen.timer);
  WEBAUTH.survey?.stop(); WEBAUTH.survey = null;
  $('#surveyChips') && ($('#surveyChips').innerHTML = '');
  Object.assign(WEBAUTH, { session: null, dispatch: null, store: null, role: null }); wsave(null);
  S.session = { mode: 'none' }; showSession();
  $('#loginState').textContent = msg;
}
function showWebSession() {
  const s = S.session;
  $('#login').hidden = !!s.user;
  const ROLE = { viewer: 'ดูอย่างเดียว', editor: 'แก้ไขได้', admin: 'ผู้ดูแล' };
  $('#userChip').innerHTML = s.user ? esc(s.user.email) + '<br><span style="opacity:.8">' + (ROLE[s.user.role] || '') + ' · ข้อมูลออนไลน์</span><button id="logout">ออกจากระบบ</button>' : '';
  $('#logout')?.addEventListener('click', guard(async () => { if (await confirmBox('ออกจากระบบ?')) webSignOut(); }));
}
async function webOpen() {
  const [{ Cloud }, { CloudStore }, { coreRoutes, router }, surveyMod] = await Promise.all([import('./lib/cloud.mjs'), import('./lib/cloud-store.mjs'), import('./lib/core-api.mjs'), import('./survey.js')]);
  const cloud = new Cloud({ url: SB(), key: CONFIG.key, token: webToken });
  const email = WEBAUTH.session.email;
  // Survey teams: people without a team join with the key from their team lead.
  let me = await cloud.me(email);
  if (me.teams && (!me.role || (!me.team_id && me.role !== 'admin'))) {
    $('#loginState').textContent = '';
    const joined = await surveyMod.waitForTeam({ cloud, email, canSkip: !!me.role, esc });
    if (joined === 'logout') return webSignOut();
    if (joined) me = await cloud.me(email);
  }
  const role = me.role;
  if (!role) throw new Error('บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งาน: ใส่รหัสทีมจากหัวหน้าทีม หรือให้ผู้ดูแลเพิ่มอีเมลใน llan_members');
  $('#loginState').textContent = 'กำลังโหลดข้อมูล…';
  const store = await new CloudStore(cloud, { email }).open();
  const survey = await surveyMod.createSurvey({ cloud, email, me, ui: surveyUi() });
  Object.assign(WEBAUTH, { store, role, cloud, survey, dispatch: router(coreRoutes(store, { settings: () => ({ ...store.settings, cloud: {} }), state: () => ({ dataDir: 'Supabase (ออนไลน์)' }),
    statuses: () => ({ rows: store.list('statuses'), checkedAt: store.statusCheckedAt }),
    ...(survey.on ? { team: () => survey.me.team_id || null, locked: code => survey.lockOf(code), onWork: ev => survey.logWork(ev) } : {}) })) });
  document.body.classList.toggle('viewer', role === 'viewer');
  document.body.classList.toggle('lead', survey.on && survey.isLead());
  document.body.classList.toggle('teams', survey.on);
  S.session = { mode: 'web', user: { email, role } };
  showSession();
  // Surveyors start on their own work, colour by the work given out.
  if (survey.on && !refreshMap.fitted) $('#mapColor').value = 'assign';
  await reloadAll();
  survey.start();
  clearInterval(webOpen.timer);
  webOpen.timer = setInterval(() => webRefresh().catch(err => console.warn(err)), 30000);
}
// Others' changes, every 30 seconds, without disturbing an open form or drawing.
async function webRefresh() {
  if (!WEBAUTH.store || document.hidden || document.querySelector('dialog[open]') || map.tool) return;
  const n = await WEBAUTH.store.refresh();
  if (n) { await reloadAll(); toast('ข้อมูลอัปเดตจากผู้ใช้อื่น ' + n.toLocaleString() + ' รายการ'); }
}
function webStart() {
  document.body.classList.add('web');
  // Icons for the navigation (rail on wide screens, bottom bar on phones).
  for (const b of $$('#tabs button[data-tab]')) if (NAV_ICON[b.dataset.tab]) b.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24" aria-hidden="true">${NAV_ICON[b.dataset.tab]}</svg>`);
  $('#navMore')?.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24" aria-hidden="true">${NAV_ICON.more}</svg>`);
  $('#navMore')?.addEventListener('click', () => $('#tabs').classList.toggle('expanded'));
  $('#tabs').addEventListener('click', e => { if (e.target.closest('button[data-tab]')) $('#tabs').classList.remove('expanded'); });
  $('.login-box').innerHTML = '<img src="icon.svg" alt=""><h2>เข้าสู่ระบบ L-LAN</h2>'
    + '<p class="muted">ใช้อีเมลและรหัสผ่านของบัญชี L-LAN ข้อมูลอยู่ใน Supabase แก้ไขได้จากทุกที่ การส่งเข้า LTAX ทำที่เครื่องสำนักงาน</p>'
    + '<form id="webLogin"><input id="wEmail" type="email" placeholder="อีเมล" autocomplete="username" required>'
    + '<input id="wPass" type="password" placeholder="รหัสผ่าน" autocomplete="current-password" required>'
    + '<button class="primary big">เข้าสู่ระบบ</button></form><div id="loginState" class="state"></div>'
    + '<button type="button" class="link" id="showSignup">ยังไม่มีบัญชี? สมัครใช้งานด้วยรหัสทีม</button>'
    + '<form id="webSignup" hidden><input id="sEmail" type="email" placeholder="อีเมล" autocomplete="username" required>'
    + '<input id="sPass" type="password" placeholder="ตั้งรหัสผ่าน (อย่างน้อย 6 ตัว)" minlength="6" autocomplete="new-password" required>'
    + '<input id="sName" placeholder="ชื่อที่แสดงให้ทีมเห็น" required><input id="sKey" placeholder="รหัสทีม (จากหัวหน้าทีม)" required style="text-transform:uppercase">'
    + '<button class="primary big">สมัครและเข้าร่วมทีม</button></form>'
    + '<a class="link" href="map.html">เปิดแผนที่อย่างเดียว (เบากว่า)</a>';
  $('#showSignup').addEventListener('click', () => { $('#webSignup').hidden = !$('#webSignup').hidden; $('#webLogin').hidden = !$('#webSignup').hidden; $('#showSignup').textContent = $('#webSignup').hidden ? 'ยังไม่มีบัญชี? สมัครใช้งานด้วยรหัสทีม' : 'มีบัญชีแล้ว? เข้าสู่ระบบ'; });
  $('#webSignup').addEventListener('submit', guard(async e => {
    e.preventDefault();
    try { localStorage.setItem('llan.joinKey', $('#sKey').value.trim()); localStorage.setItem('llan.joinName', $('#sName').value.trim()); } catch { /* blocked */ }
    $('#loginState').textContent = 'กำลังสมัคร…';
    let d;
    try { d = await sbAuth('signup', { email: $('#sEmail').value.trim(), password: $('#sPass').value, data: { name: $('#sName').value.trim() } }); }
    catch (err) { $('#loginState').textContent = /already|registered/i.test(err.message) ? 'อีเมลนี้มีบัญชีแล้ว ให้เข้าสู่ระบบ แล้วใส่รหัสทีม' : err.message; return; }
    if (!d.access_token) { $('#loginState').textContent = 'สมัครแล้ว: เปิดอีเมลแล้วกดลิงก์ยืนยัน จากนั้นกลับมาเข้าสู่ระบบ ระบบจะใส่รหัสทีมให้'; return; }
    keepWeb(d);
    try { await webOpen(); } catch (err) { $('#loginState').textContent = err.message; }
  }));
  $('#webLogin').addEventListener('submit', guard(async e => {
    e.preventDefault();
    $('#loginState').textContent = 'กำลังเข้าสู่ระบบ…';
    try { keepWeb(await sbAuth('token?grant_type=password', { email: $('#wEmail').value.trim(), password: $('#wPass').value })); }
    catch (err) { $('#loginState').textContent = err.message; return; }
    try { await webOpen(); } catch (err) { $('#loginState').textContent = err.message; }
  }));
  WEBAUTH.session = wload();
  S.session = { mode: 'none' }; showSession();
  if (WEBAUTH.session) webOpen().catch(err => { $('#loginState').textContent = err.message; });
}
// Downloads (Excel, .shp) are made in the browser on the web.
if (WEB) document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="/api/"]');
  if (!a) return;
  e.preventDefault();
  guard(async () => {
    const out = await webApi('GET', a.getAttribute('href'));
    if (!out?.download) return;
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([out.bytes], { type: out.type })), download: out.download });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  })();
});

// What the survey-team pages (survey.js) may use of this page.
function surveyUi() {
  return { S, map, esc, toast, guard, confirmBox, $, ownerNames, showFeature, goTab, activeTab: () => activeTab,
    refreshMap: () => refreshMap(), updateMarkers, setColor: mode => { $('#mapColor').value = mode; refreshMap(); },
    flyTo: (lon, lat) => { map.center = toMercator(lon, lat); map.res = Math.min(map.res, 1.5); map.draw(); },
    fitCodes: codes => { const fs = map.layers.flatMap(l => l.features).filter(f => codes.has(String(f.code || '').toUpperCase())); if (fs.length) map.fit(fs, 60); },
    fitPeople: locs => {
      if (!locs.length) return toast('ยังไม่มีตำแหน่งของสมาชิก', true);
      const xs = locs.map(l => toMercator(l.lon, l.lat));
      map.center = [xs.reduce((s, p) => s + p[0], 0) / xs.length, xs.reduce((s, p) => s + p[1], 0) / xs.length];
      map.res = Math.max(1, Math.max(...xs.map(p => Math.abs(p[0] - map.center[0])), ...xs.map(p => Math.abs(p[1] - map.center[1]))) * 2.6 / Math.min(map.w, map.h));
      map.draw();
    },
    preview: (rows, style) => { PREVIEW = rows ? { rows, style } : null; if (rows) $('#mapColor').value = 'assign'; refreshMap(); } };
}
// The office machine is the monitoring centre of the survey teams: every team and every surveyor,
// through the office server (which reaches Supabase with the secret key).
async function officeTeams() {
  const cfg = S.settings.cloud || {};
  if (!cfg.url || !cfg.hasKey) return;
  const call = async (op, ...args) => (await api('POST', '/api/team/call', { op, args })).result;
  const proxy = { get: p => call('get', p), getAll: (...a) => call('getAll', ...a), upsertOn: (...a) => call('upsertOn', ...a), deleteWhere: (...a) => call('deleteWhere', ...a),
    insertRows: async () => {}, rpc: (name, args) => call('rpc', name, args) };
  const surveyMod = await import('./survey.js');
  const survey = await surveyMod.createSurvey({ cloud: proxy, email: 'office', me: { email: 'office', role: 'admin', team_id: null, team_role: 'lead', display_name: 'สำนักงาน', teams: true }, ui: surveyUi(), office: true });
  if (!survey.on) return;
  WEBAUTH.survey = survey;
  document.body.classList.add('teams', 'lead', 'office-teams');
  survey.start();
  refreshMap();
}

// ---------- start ----------
guard(async () => {
  if (WEB) return webStart();
  S.session = await api('GET', '/api/session');
  showSession();
  await reloadAll(); ltaxStatus(); setInterval(ltaxStatus, 15000); startEvents();
  officeTeams().catch(err => console.warn('ทีมสำรวจ:', err.message));
})();
