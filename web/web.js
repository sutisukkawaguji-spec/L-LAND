// L-LAN Web: shapes in Supabase, signed in with Supabase Auth. No personal data is read or stored here.
import CONFIG from './config.js';
import { MapView } from './map.js';
import { DrawTool } from './draw.js';
import { areaM2, centroid, pointInGeom, fromWgs84, toMercator, bboxOf } from './shared/proj.mjs';
import { minRect, nextBuildingCode, nextParcelCode, selfIntersects } from './shared/geom.mjs';
import { fromWah, formatNumber, formatRNW } from './shared/calc.mjs';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const URL0 = String(CONFIG.url || '').replace(/\/$/, ''), KEY = CONFIG.key;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); console.error(e); } };
function confirmBox(html, { ok = 'ยืนยัน', danger = false } = {}) {
  return new Promise(resolve => {
    const d = $('#confirmBox'); $('#confirmText').innerHTML = html;
    const yes = d.querySelector('button[value="yes"]'); yes.textContent = ok; yes.className = danger ? 'danger-fill' : 'primary';
    d.onclose = () => resolve(d.returnValue === 'yes'); d.returnValue = ''; d.showModal();
  });
}
const store = { get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } }, del: k => { try { localStorage.removeItem(k); } catch { /* blocked */ } } };

// ---------- Supabase Auth + REST over fetch ----------
let session = store.get('llan.web.session');
async function authCall(path, body) {
  const res = await fetch(`${URL0}/auth/v1/${path}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || 'เข้าสู่ระบบไม่สำเร็จ');
  return data;
}
function keep(data) {
  session = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000, email: data.user?.email || session?.email };
  store.set('llan.web.session', session);
}
async function token() {
  if (!session) throw new Error('ยังไม่ได้เข้าสู่ระบบ');
  if (session.expires_at - Date.now() < 60000) keep(await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token }));
  return session.access_token;
}
async function rest(method, path, body, prefer) {
  const headers = { apikey: KEY, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL0}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) { signOut(); throw new Error('หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่'); }
  if (!res.ok) throw new Error(data?.message || `ผิดพลาด ${res.status}`);
  return data;
}
async function restAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await rest('GET', `${path}&limit=1000&offset=${from}`);
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
function signOut() { session = null; store.del('llan.web.session'); showLogin(); }

// ---------- state + map ----------
const S = { role: null, layers: [], features: [], byCode: new Map() };
const canEdit = () => ['editor', 'admin'].includes(S.role);
const map = new MapView($('#map'), { onSelect: hit => showFeature(hit?.feature || null) });
map.setBasemap('satellite');

const COLORS = { parcel: '#f5c451', building: '#ffffff', drawn: '#00e5ff', reshaped: '#ff9800' };
function style(f) {
  const tag = f.reshaped ? 'reshaped' : f.drawn ? 'drawn' : f.kind;
  const color = COLORS[tag] || '#cccccc';
  const sat = map.basemap === 'satellite';
  return f.kind === 'building'
    ? { fill: sat ? 'rgba(255,255,255,.35)' : 'rgba(47,128,237,.55)', stroke: sat ? color : '#1d2733', halo: sat ? 'rgba(0,0,0,.65)' : null, width: 1.2 }
    : { fill: sat ? 'rgba(245,196,81,.10)' : 'rgba(46,157,106,.25)', stroke: sat ? color : '#2e9d6a', halo: sat ? 'rgba(0,0,0,.6)' : null, width: 1.8 };
}
function render(fit) {
  for (const id of map.layers.map(l => l.id)) if (!S.layers.some(l => l.id === id)) map.removeLayer(id);
  for (const l of [...S.layers].sort((a, b) => (a.kind === 'building') - (b.kind === 'building')))
    map.setLayer({ id: l.id, name: l.name, features: S.features.filter(f => f.layerId === l.id), style, label: f => f.code, labelRes: l.kind === 'building' ? 0.25 : 1.5 });
  S.byCode = new Map(S.features.filter(f => f.code).map(f => [f.code, f]));
  $('#mapSearchList').innerHTML = [...S.byCode.keys()].slice(0, 6000).map(c => `<option value="${esc(c)}">`).join('');
  const n = k => S.features.filter(f => f.kind === k).length;
  $('#mapLegend').innerHTML = `<span><i style="background:${COLORS.parcel}"></i>แปลง <b>${n('parcel').toLocaleString()}</b></span><span><i style="background:#fff"></i>อาคาร <b>${n('building').toLocaleString()}</b></span>
    <span><i style="background:${COLORS.drawn}"></i>วาดใหม่ <b>${S.features.filter(f => f.drawn && !f.reshaped).length}</b></span><span><i style="background:${COLORS.reshaped}"></i>แก้รูปแล้ว <b>${S.features.filter(f => f.reshaped).length}</b></span>`;
  if (fit && S.features.length) map.fit(S.features.filter(f => f.kind === 'parcel').length ? S.features.filter(f => f.kind === 'parcel') : S.features);
  map.draw();
}
const toFeature = r => ({ id: r.id, layerId: r.layer_id, kind: r.kind, fid: r.fid, code: r.code || '', geometry: r.geojson, areaM2: Number(r.area_m2) || 0, attrs: r.attrs || {}, drawn: r.drawn, reshaped: r.reshaped, updatedAt: r.updated_at, updatedBy: r.updated_by, bbox: bboxOf(r.geojson) });
async function load(fit = false) {
  S.layers = await rest('GET', 'llan_layers?select=*');
  S.features = (await restAll('llan_features?select=id,layer_id,kind,fid,code,geojson,area_m2,attrs,drawn,reshaped,updated_at,updated_by&order=id')).map(toFeature);
  render(fit);
}

// ---------- side panel ----------
async function showFeature(f) {
  const side = $('#mapSide');
  if (!f) { side.classList.remove('open'); side.innerHTML = '<div class="empty">แตะรูปแปลงหรืออาคารเพื่อดูข้อมูล</div>'; return; }
  const rnw = fromWah((f.areaM2 || 0) / 4);
  side.classList.add('open');
  side.innerHTML = `<div class="side-head"><h3>${esc(f.code || '(ไม่มีรหัส)')}</h3><button class="close" id="sideClose">✕</button></div>
    <dl class="kv"><dt>ชนิด</dt><dd>${f.kind === 'building' ? 'อาคาร' : 'แปลงที่ดิน'}</dd>
      <dt>พื้นที่ตามรูป</dt><dd>${formatNumber(f.areaM2)} ตร.ม. · ${formatNumber(f.areaM2 / 4)} ตร.ว. (${formatRNW(rnw.rai, rnw.ngan, rnw.wah)})</dd>
      ${Object.entries(f.attrs).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
      <dt>แก้ไขล่าสุด</dt><dd>${f.updatedAt ? new Date(f.updatedAt).toLocaleString('th-TH') : '-'} ${esc(f.updatedBy || '')}</dd></dl>
    ${canEdit() ? `<div class="row"><button id="shapeEdit">✎ แก้ไขรูป</button>${f.kind === 'parcel' ? '<button id="shapeAddBuilding">▭ วาดอาคารในแปลงนี้</button>' : ''}<button class="danger" id="shapeDelete">ลบรูป</button></div>` : ''}
    <p class="muted">ข้อมูลเจ้าของและทะเบียนไม่เก็บบนเว็บ ดูได้จาก L-LAN ที่สำนักงาน (ดึงสดจาก LTAX)</p>
    <h4>ประวัติการแก้ไข</h4><div id="history" class="muted">กำลังโหลด…</div>`;
  $('#sideClose').onclick = () => { map.selected = null; map.draw(); showFeature(null); };
  $('#shapeEdit')?.addEventListener('click', guard(async () => { if (await setTool('select')) draw.edit(f); }));
  $('#shapeDelete')?.addEventListener('click', guard(() => deleteShape(f)));
  $('#shapeAddBuilding')?.addEventListener('click', () => { map.zoomTo(f, 0.15); setTool('building-rect'); });
  const log = await rest('GET', `llan_feature_log?select=action,area_before,area_after,by_user,at&feature_id=eq.${f.id}&order=at.desc&limit=20`).catch(() => []);
  const TH = { create: 'สร้าง', reshape: 'แก้รูป', update: 'แก้ข้อมูล', delete: 'ลบ' };
  $('#history').innerHTML = log.length ? log.map(l => `${new Date(l.at).toLocaleString('th-TH')} · ${TH[l.action] || l.action}${l.area_after ? ` · ${formatNumber(l.area_before)} → ${formatNumber(l.area_after)} ตร.ม.` : ''} · ${esc(l.by_user || '')}`).join('<br>') : 'ยังไม่มีประวัติ';
}
const selectById = id => { const f = map.layers.flatMap(l => l.features).find(x => x.id === id); map.selected = f || null; map.draw(); showFeature(f || null); };

// ---------- drawing ----------
const MODE_TH = { parcel: 'วาดรูปแปลงที่ดิน', 'building-rect': 'วาดอาคารสี่เหลี่ยม: คลิก 2 มุมของด้านหนึ่ง แล้วคลิกด้านตรงข้าม', 'building-poly': 'วาดอาคาร', edit: 'แก้ไขรูป: ลากจุดเพื่อย้าย แตะจุดเล็กกลางเส้นเพื่อเพิ่มจุด' };
const draw = new DrawTool(map, { onFinish: guard(finishShape), onEditSave: guard(saveReshape), onStatus: status });
async function setTool(tool) {
  if (draw.dirty && !(await confirmBox('มีรูปที่วาดหรือแก้ค้างอยู่ ต้องการทิ้งหรือไม่?', { ok: 'ทิ้งรูปที่ค้าง', danger: true }))) return false;
  draw.stop();
  if (tool !== 'select') draw.start(tool);
  $$('#mapBar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
  return true;
}
function status(st) {
  $('#drawBar').hidden = !st;
  if (!st) return;
  $('#drawStatus').innerHTML = `<b>${esc(MODE_TH[st.mode])}</b><br>${st.points} จุด${st.areaM2 ? ` · ${formatNumber(st.areaM2)} ตร.ม.` : ''}${st.crossing ? ' · <span class="pill err">เส้นตัดกัน</span>' : ''}`;
  $('#drawUndo').disabled = !st.canUndo; $('#drawFinish').disabled = !st.canFinish;
  $('#drawFinish').textContent = st.mode === 'edit' ? '✓ บันทึกรูป' : '✓ เสร็จ';
  $('#drawDelVertex').hidden = st.mode !== 'edit'; $('#drawDelVertex').disabled = !st.vertexSelected; $('#drawGps').hidden = st.mode === 'edit';
}
$('#drawUndo').onclick = () => draw.undo();
$('#drawDelVertex').onclick = () => { if (!draw.deleteSelectedVertex()) toast('รูปต้องมีอย่างน้อย 3 จุด', true); };
$('#drawFinish').onclick = () => draw.finish();
$('#drawCancel').onclick = guard(() => setTool('select'));
$('#drawGps').onclick = () => (map.gps ? draw.addPoint([map.gps.lon, map.gps.lat]) : toast('ยังไม่มีตำแหน่ง GPS กดปุ่ม GPS ก่อน', true));
$('#mapBar').addEventListener('click', guard(async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tool) await setTool(b.dataset.tool);
  else if (b.id === 'snapBtn') { draw.snapOn = !draw.snapOn; b.classList.toggle('on', draw.snapOn); }
  else if (b.id === 'gpsBtn') toggleGps(b);
  else if (b.id === 'zoomIn') map.zoomBy(0.6);
  else if (b.id === 'zoomOut') map.zoomBy(1 / 0.6);
  else if (b.id === 'zoomFit') render(true);
}));
let watch = null;
function toggleGps(btn) {
  if (watch !== null) { navigator.geolocation.clearWatch(watch); watch = null; map.gps = null; btn.classList.remove('on'); map.draw(); return; }
  if (!navigator.geolocation) return toast('อุปกรณ์นี้ไม่มี GPS', true);
  let first = true;
  btn.classList.add('on');
  watch = navigator.geolocation.watchPosition(p => {
    map.gps = { lon: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy };
    if (first) { first = false; map.center = toMercator(map.gps.lon, map.gps.lat); map.res = Math.min(map.res, 1); toast(`ตำแหน่งของฉัน ±${Math.round(p.coords.accuracy)} ม.`); }
    map.draw();
  }, err => { toast(err.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง' : `หาตำแหน่งไม่ได้: ${err.message}`, true); navigator.geolocation.clearWatch(watch); watch = null; btn.classList.remove('on'); },
  { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

async function layerFor(kind) {
  let l = S.layers.find(x => x.kind === kind);
  if (l) return l;
  const codeField = kind === 'parcel' ? 'parcel_cod' : 'building_c';
  [l] = await rest('POST', 'llan_layers', [{ id: crypto.randomUUID(), name: kind === 'parcel' ? 'แปลงที่วาดใหม่' : 'อาคารที่วาดใหม่', kind, crs: 'EPSG:32648', code_field: codeField,
    geometry_type: 'Polygon', fields: [{ name: codeField, type: 'C', length: 20 }], count: 0 }], 'return=representation');
  S.layers.push(l);
  return l;
}
const logChange = entry => rest('POST', 'llan_feature_log', [{ ...entry, by_user: session.email }], 'return=minimal').catch(() => {});

function shapeDialog(html) {
  return new Promise(resolve => {
    const d = $('#shapeBox'), form = $('#shapeForm');
    form.innerHTML = html;
    d.onclose = () => resolve(d.returnValue === 'save' ? Object.fromEntries([...form.elements].filter(el => el.name).map(el => [el.name, el.value.trim()])) : null);
    d.returnValue = ''; d.showModal();
  });
}
async function finishShape(mode, geometry) {
  if (selfIntersects(geometry.coordinates[0].slice(0, -1)) && !(await confirmBox('เส้นของรูปตัดกันเอง ต้องการใช้รูปนี้ต่อหรือไม่?', { ok: 'ใช้ต่อ', danger: true }))) return;
  const kind = mode === 'parcel' ? 'parcel' : 'building';
  const area = areaM2(geometry), c = centroid(geometry), codes = S.features.map(f => f.code).filter(Boolean);
  let suggestion = '', info = '';
  if (kind === 'building') {
    const parcel = S.features.find(f => f.kind === 'parcel' && pointInGeom(c, f.geometry));
    const { width, length } = minRect(geometry.coordinates[0].map(([x, y]) => fromWgs84(x, y, 'EPSG:32648')));
    suggestion = parcel?.code ? nextBuildingCode(parcel.code, codes) : '';
    info = `${parcel ? `อยู่ในแปลง <b>${esc(parcel.code)}</b>` : '<span class="pill warn">ไม่อยู่ในรูปแปลงใด</span>'} · ขนาด ${width.toFixed(2)} × ${length.toFixed(2)} ม. · ${formatNumber(area)} ตร.ม.`;
  } else {
    let near = null, bd = Infinity;
    for (const f of S.features) if (f.kind === 'parcel' && f.code) { const d = Math.hypot((f.bbox[0] + f.bbox[2]) / 2 - c[0], (f.bbox[1] + f.bbox[3]) / 2 - c[1]); if (d < bd) { bd = d; near = f; } }
    suggestion = near ? nextParcelCode(near.code, codes) : '';
    const r = fromWah(area / 4);
    info = `เนื้อที่ตามรูป ${formatNumber(area / 4)} ตร.ว. (${formatRNW(r.rai, r.ngan, r.wah)} ไร่-งาน-วา)`;
  }
  const res = await shapeDialog(`<h3>${kind === 'parcel' ? 'รูปแปลงใหม่' : 'รูปอาคารใหม่'}</h3><p>${info}</p>
    <div class="form-row"><label>${kind === 'parcel' ? 'รหัสแปลงที่ดิน' : 'รหัสสิ่งปลูกสร้าง'}</label><input name="code" value="${esc(suggestion)}"></div>
    <div class="row end"><button value="cancel" formnovalidate>ยกเลิก</button><button value="save" class="primary">บันทึก</button></div>`);
  if (!res) return;
  const code = res.code.toUpperCase();
  if (S.byCode.has(code) && !(await confirmBox(`มีรูปรหัส <b>${esc(code)}</b> อยู่แล้ว ต้องการบันทึกซ้ำหรือไม่?`, { ok: 'บันทึกซ้ำ', danger: true }))) return;
  if (!(await confirmBox(`บันทึก${kind === 'parcel' ? 'รูปแปลง' : 'รูปอาคาร'} <b>${esc(code || '(ไม่มีรหัส)')}</b> ขึ้น Supabase?`))) return;
  const layer = await layerFor(kind);
  const id = crypto.randomUUID();
  await rest('POST', 'llan_features', [{ id, layer_id: layer.id, kind, fid: null, code, geojson: geometry, area_m2: Math.round(area * 100) / 100,
    attrs: { [layer.code_field || 'code']: code }, drawn: true, updated_by: session.email }], 'return=minimal');
  await logChange({ feature_id: id, code, action: 'create', area_after: Math.round(area * 100) / 100 });
  draw.stop(); $$('#mapBar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === 'select'));
  toast('บันทึกแล้ว'); await load(); selectById(id);
}
async function saveReshape(f, geometry) {
  const after = Math.round(areaM2(geometry) * 100) / 100;
  if (!(await confirmBox(`บันทึกการแก้รูป <b>${esc(f.code)}</b>?<br>พื้นที่ ${formatNumber(f.areaM2)} → <b>${formatNumber(after)}</b> ตร.ม.`, { ok: 'บันทึกรูป' }))) return;
  await rest('PATCH', `llan_features?id=eq.${f.id}`, { geojson: geometry, area_m2: after, reshaped: true, updated_at: new Date().toISOString(), updated_by: session.email }, 'return=minimal');
  await logChange({ feature_id: f.id, code: f.code, action: 'reshape', area_before: f.areaM2, area_after: after });
  draw.stop(); $$('#mapBar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === 'select'));
  toast('บันทึกรูปแล้ว'); await load(); selectById(f.id);
}
async function deleteShape(f) {
  if (!(await confirmBox(`ลบรูป <b>${esc(f.code || '(ไม่มีรหัส)')}</b> ออกจาก Supabase?<br><span class="muted">ทุกคนที่ใช้ L-LAN Web จะไม่เห็นรูปนี้อีก</span>`, { ok: 'ลบรูป', danger: true }))) return;
  await rest('DELETE', `llan_features?id=eq.${f.id}`);
  await logChange({ feature_id: f.id, code: f.code, action: 'delete', area_before: f.areaM2 });
  map.selected = null; toast('ลบรูปแล้ว'); await load(); showFeature(null);
}

// ---------- page wiring ----------
$('#mapBase').onchange = e => { map.setBasemap(e.target.value); map.draw(); };
$('#reload').onclick = guard(() => load());
$('#toolsToggle').onclick = () => $('#mapTools').classList.toggle('collapsed');
if (window.matchMedia('(max-width: 700px)').matches) $('#mapTools').classList.add('collapsed');
$('#mapSearch').addEventListener('change', e => {
  const f = S.byCode.get(e.target.value.trim().toUpperCase());
  if (!f) return toast('ไม่พบรหัสนี้', true);
  const mf = map.layers.flatMap(l => l.features).find(x => x.id === f.id);
  map.selected = mf; map.zoomTo(mf); showFeature(mf);
});
window.addEventListener('beforeunload', e => { if (draw.dirty) { e.preventDefault(); e.returnValue = ''; } });

function showLogin(msg = '') { $('#login').hidden = false; $('#loginState').textContent = msg; $('#userChip').innerHTML = ''; }
async function start() {
  const [m] = await rest('GET', `llan_members?select=role&email=eq.${encodeURIComponent(session.email)}`);
  if (!m) { signOut(); return showLogin('บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งาน ติดต่อผู้ดูแลให้เพิ่มอีเมลในรายชื่อ'); }
  S.role = m.role;
  $('#login').hidden = true;
  document.body.classList.toggle('viewer', !canEdit());
  $('#userChip').innerHTML = `${esc(session.email)}<br><span style="opacity:.8">${{ viewer: 'ดูอย่างเดียว', editor: 'แก้ไขได้', admin: 'ผู้ดูแล' }[S.role]}</span><button id="logout">ออกจากระบบ</button>`;
  $('#logout').onclick = guard(async () => { if (await confirmBox('ออกจากระบบ?')) signOut(); });
  await load(true);
}
$('#loginForm').addEventListener('submit', guard(async e => {
  e.preventDefault();
  $('#loginState').textContent = 'กำลังเข้าสู่ระบบ…';
  try { keep(await authCall('token?grant_type=password', { email: $('#loginEmail').value.trim(), password: $('#loginPass').value })); }
  catch (err) { $('#loginState').textContent = /invalid/i.test(err.message) ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : err.message; return; }
  await start();
}));
$('#forgot').onclick = guard(async () => {
  const email = $('#loginEmail').value.trim();
  if (!email) return toast('ใส่อีเมลก่อน แล้วกดลืมรหัสผ่าน', true);
  await authCall('recover', { email });
  toast('ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว');
});

// Links from Supabase e-mails (invite / reset password) arrive with the session in the URL hash.
async function fromEmailLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.get('access_token') || !['invite', 'recovery', 'signup', 'magiclink'].includes(h.get('type'))) return false;
  history.replaceState(null, '', location.pathname);
  session = { access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_at: Date.now() + Number(h.get('expires_in') || 3600) * 1000 };
  const u = await (await fetch(`${URL0}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${session.access_token}` } })).json();
  session.email = u.email; store.set('llan.web.session', session);
  if (h.get('type') === 'invite' || h.get('type') === 'recovery') {
    $('#login').hidden = false;
    $('#loginForm').innerHTML = `<img src="icon.svg" alt=""><h2>ตั้งรหัสผ่าน</h2><p class="muted">${esc(u.email)}</p>
      <input id="newPass" type="password" placeholder="รหัสผ่านใหม่ อย่างน้อย 8 ตัว" minlength="8" autocomplete="new-password" required>
      <input id="newPass2" type="password" placeholder="ยืนยันรหัสผ่าน" minlength="8" autocomplete="new-password" required>
      <button class="primary big">บันทึกรหัสผ่าน</button><div id="loginState" class="state"></div>`;
    await new Promise(done => {
      $('#loginForm').onsubmit = guard(async e => {
        e.preventDefault();
        if ($('#newPass').value !== $('#newPass2').value) return ($('#loginState').textContent = 'รหัสผ่านสองช่องไม่ตรงกัน');
        const res = await fetch(`${URL0}/auth/v1/user`, { method: 'PUT', headers: { apikey: KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#newPass').value }) });
        if (!res.ok) return ($('#loginState').textContent = 'ตั้งรหัสผ่านไม่สำเร็จ ลองใหม่อีกครั้ง');
        toast('ตั้งรหัสผ่านแล้ว'); done();
      });
    });
  }
  return true;
}

(async () => {
  if (!URL0 || !KEY) return showLogin('ยังไม่ได้ตั้งค่า Supabase ใน config.js');
  if (await fromEmailLink().catch(() => false)) return guard(start)();
  if (session) return guard(start)();
  showLogin();
})();
