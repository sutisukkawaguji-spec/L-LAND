// L-LAN Web for field survey teams (web page only, data in Supabase):
// - join a team with the team key; admins make teams, choose team leads
// - live positions of the people in the field (admins see everyone, a lead sees the team)
// - งานของฉัน: the parcels given to me, what is due today, directions
// - สรุปงาน: daily summaries by day and by person, with filters, to Excel
// - แผนงาน: a lead gives N parcels and a date range; the parcels are split among the members by area
// - locks: a parcel given to, or surveyed by, another team cannot be changed here
import { planAssignments, lockOf as lockRule, summarize, progress, todayTh, dayOf, addDays, workdays, WEEKDAY_TH, DONE_STATES } from './lib/team.mjs';
import { fromMercator } from './shared/proj.mjs';

const PALETTE = ['#2f80ed', '#eb5757', '#27ae60', '#f2994a', '#9b51e0', '#00a3a3', '#c49000', '#e84393', '#6c5ce7', '#16a085', '#c0392b', '#34495e'];
const STATE_TH = { draft: 'กำลังสำรวจ', revisit: 'ต้องกลับไปซ้ำ', ready: 'สำรวจเสร็จ', done: 'สำรวจเสร็จ', changed: 'แก้หลังสำรวจเสร็จ' };
const ago = iso => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'เมื่อสักครู่' : s < 3600 ? `${Math.round(s / 60)} นาทีที่แล้ว` : s < 86400 ? `${Math.round(s / 3600)} ชม.ที่แล้ว` : `${Math.round(s / 86400)} วันที่แล้ว`;
};
const thDay = d => (d ? new Date(`${d}T12:00:00+07:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' }) : '-');
const thTime = iso => new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const startOf = day => new Date(`${day}T00:00:00+07:00`).toISOString();
const endOf = day => new Date(`${day}T23:59:59.999+07:00`).toISOString();
const initialsOf = name => { const s = String(name || '?').trim(); return /^[เแโใไ]/.test(s) ? s.slice(0, 2) : s.slice(0, 1); };
const distM = (a, b) => { const k = Math.PI / 180, x = (b.lon - a.lon) * k * Math.cos((a.lat + b.lat) / 2 * k), y = (b.lat - a.lat) * k; return Math.hypot(x, y) * 6371000; };
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* blocked */ } } };

// office: the office machine (monitoring centre): sees everything as an admin, shares no position.
export async function createSurvey({ cloud, email, me, ui, office = false }) {
  const { S, map, esc, toast, guard, confirmBox, $ } = ui;
  const T = { on: !!me.teams, me: { ...me }, teams: [], members: [], assign: new Map(), plans: [], keys: [], locations: [], timers: [],
    sharing: store.get('llan.share') !== 'off', pos: null, sent: null, watch: null, posError: null, showPeople: true, logQueue: [], mineToday: null, sum: null };
  const lc = s => String(s || '').toLowerCase();
  const isAdmin = () => T.me.role === 'admin';
  const isLead = () => isAdmin() || T.me.team_role === 'lead';
  const teamOf = id => T.teams.find(t => t.id === id) || null;
  const teamName = id => teamOf(id)?.name || '';
  const member = e => T.members.find(m => lc(m.email) === lc(e)) || null;
  const nameOf = e => member(e)?.display_name || String(e || '').split('@')[0] || '-';
  const teamMembers = team => T.members.filter(m => m.team_id === team).sort((a, b) => lc(a.email).localeCompare(lc(b.email)));
  const colorOf = e => { const m = member(e); const list = teamMembers(m?.team_id); const i = list.findIndex(x => lc(x.email) === lc(e)); return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]; };
  const stateOf = code => S.surveyBy?.get(code)?.state || null;
  const mine = () => [...T.assign.values()].filter(a => lc(a.email) === lc(email));
  const today = () => todayTh();

  // ---------- data ----------
  async function load() {
    if (!T.on) return;
    try {
      const [teams, members, assigns, plans] = await Promise.all([
        cloud.get('llan_teams?select=id,name,color&order=name'),
        cloud.get('llan_members?select=email,role,team_id,team_role,display_name'),
        cloud.getAll('llan_assignments', 'code,plan_id,team_id,email,due', '', 'code.asc'),
        cloud.get('llan_plans?select=*&order=start_date.desc'),
      ]);
      Object.assign(T, { teams, members, plans, assign: new Map(assigns.map(a => [String(a.code).toUpperCase(), a])) });
      const meRow = member(email);
      if (meRow) Object.assign(T.me, meRow);
      T.keys = isLead() ? await cloud.rpc('llan_team_keys').catch(() => []) : [];
    } catch (err) {
      if (/ยังไม่ได้สร้างตาราง/.test(err.message)) T.on = false; else throw err;
    }
  }
  async function loadMineToday() {
    try {
      const rows = await cloud.getAll('llan_work_log', 'at,by_user,team_id,code,action,state', `&by_user=eq.${encodeURIComponent(lc(email))}&at=gte.${encodeURIComponent(startOf(today()))}`, 'at.asc');
      T.mineToday = summarize(rows);
    } catch { T.mineToday = null; }
  }

  // ---------- work log (for the daily summaries) ----------
  function logWork(ev) {
    if (!T.on || T.me.role === 'viewer') return;
    T.logQueue.push({ action: ev.action, code: ev.code || null, state: ev.state || null, entity: ev.entity || null, record_id: ev.record_id || null, note: ev.note || null });
    clearTimeout(T.logTimer);
    T.logTimer = setTimeout(flushLog, 1500);
  }
  async function flushLog() {
    const rows = T.logQueue.splice(0);
    if (!rows.length) return;
    try { await cloud.insertRows('llan_work_log', rows); if (rows.some(r => r.action === 'survey')) { await loadMineToday(); chips(); } }
    catch (err) { console.warn('work log', err.message); if (err.offline) T.logQueue.unshift(...rows); }
  }

  // ---------- locks ----------
  const surveys = { get: code => { const s = S.landByCode?.get(code)?.survey; return s?.team ? s : null; } };
  function lockOf(code) {
    if (!T.on || !code) return null;
    return lockRule(String(code).toUpperCase(), { me: T.me, assignments: T.assign, surveys, teamName });
  }
  function assignInfo(code) {
    const a = T.assign.get(String(code || '').toUpperCase());
    if (!a) return '';
    const late = a.due && a.due < today() && !DONE_STATES.has(stateOf(a.code));
    return `<div class="assign-line"><span class="dot" style="background:${colorOf(a.email)}"></span>งานของ <b>${esc(nameOf(a.email))}</b>${a.team_id !== T.me.team_id ? ` (${esc(teamName(a.team_id))})` : ''}
      · กำหนด <span class="${late ? 'late' : ''}">${esc(thDay(a.due))}${late ? ' เลยกำหนด' : ''}</span></div>`;
  }

  // ---------- map: colours for the work given out, people ----------
  function styleOf(f) {
    if (f.kind === 'building') return ['#555555', 'อาคาร'];
    const code = String(f.code || '').toUpperCase(), a = T.assign.get(code), st = stateOf(code);
    if (DONE_STATES.has(st)) return ['#1e7a4f', 'สำรวจเสร็จแล้ว'];
    if (lockOf(code)) return ['#8a96a3', 'ทีมอื่น (แก้ไม่ได้)'];
    if (!a) return ['#d5dbe2', 'ยังไม่มอบหมาย'];
    if (lc(a.email) === lc(email)) {
      if (a.due && a.due < today()) return ['#d64545', 'งานของฉัน: เลยกำหนด'];
      if (a.due === today()) return ['#f2994a', 'งานของฉัน: วันนี้'];
      return ['#2f80ed', 'งานของฉัน: วันต่อไป'];
    }
    return isLead() ? [colorOf(a.email), nameOf(a.email)] : ['#b39ddb', 'งานของเพื่อนร่วมทีม'];
  }
  function markers() {
    if (!T.on || !isLead() || !T.showPeople) return [];
    return T.locations.map(l => {
      const stale = Date.now() - Date.parse(l.at) > 15 * 60 * 1000;
      return { kind: 'person', lon: l.lon, lat: l.lat, label: l.name || nameOf(l.email), sub: ago(l.at), initials: initialsOf(l.name || nameOf(l.email)),
        color: stale ? '#8a96a3' : isAdmin() ? teamOf(l.team_id)?.color || colorOf(l.email) : colorOf(l.email), faded: stale, data: l };
    });
  }
  function onMarker(m) {
    if (m.kind !== 'person') return;
    const l = m.data;
    toast(`${l.name || nameOf(l.email)} · ${teamName(l.team_id) || 'ไม่มีทีม'} · ${ago(l.at)}${l.accuracy ? ` · ±${Math.round(l.accuracy)} ม.` : ''}`);
  }
  async function loadLocations() {
    if (!T.on || !isLead()) return;
    try { T.locations = await cloud.get('llan_locations?select=*&order=at.desc'); ui.updateMarkers(); chips(); if (ui.activeTab() === 'team' && !document.querySelector('#tab-team :focus')) renderTeam(); } catch (err) { console.warn(err.message); }
  }

  // ---------- my position, shared with the team ----------
  function startSharing() {
    if (office || !T.on || !T.me.team_id || T.watch != null || !('geolocation' in navigator) || !window.isSecureContext) return;
    T.watch = navigator.geolocation.watchPosition(p => {
      T.pos = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed };
      T.posError = null; sendPos();
    }, err => { T.posError = err.code === 1 ? 'ไม่ได้อนุญาตให้ใช้ตำแหน่ง' : 'หาตำแหน่งไม่ได้'; chips(); }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 60000 });
  }
  async function sendPos(force = false) {
    if (!T.sharing || !T.pos) return chips();
    const moved = T.sent ? distM(T.sent, T.pos) : Infinity;
    if (!force && T.sent && Date.now() - T.sent.at < 30000 && moved < 25) return;
    T.sent = { ...T.pos, at: Date.now() };
    try {
      await cloud.upsertOn('llan_locations', [{ email: lc(email), lat: T.pos.lat, lon: T.pos.lon, accuracy: T.pos.accuracy ?? null, heading: T.pos.heading ?? null, speed: T.pos.speed ?? null }], 'email');
      T.posError = null;
    } catch (err) { T.posError = err.message; }
    chips();
  }
  async function setSharing(on) {
    T.sharing = on; store.set('llan.share', on ? null : 'off');
    if (on) { startSharing(); sendPos(true); }
    else await cloud.deleteWhere('llan_locations', `email=eq.${encodeURIComponent(lc(email))}`).catch(() => {});
    chips();
  }

  // ---------- top bar: team, today, sharing ----------
  function todayTarget() {
    const list = mine(), t = today();
    const due = list.filter(a => a.due === t || (a.due < t && !DONE_STATES.has(stateOf(a.code))));
    return { due: due.length, done: due.filter(a => DONE_STATES.has(stateOf(a.code))).length };
  }
  function chips() {
    const box = $('#surveyChips');
    if (!box) return;
    if (!T.on) { box.innerHTML = ''; return; }
    if (office) {
      const online = T.locations.filter(l => Date.now() - Date.parse(l.at) < 15 * 60 * 1000).length;
      box.innerHTML = `<button class="chip monitor" data-chip="team" title="ศูนย์ติดตามทีมสำรวจ"><i></i>ทีมสำรวจ: ออนไลน์ <b>${online}</b>/${T.members.filter(m => m.team_id).length} คน</button>`;
      return;
    }
    const team = teamOf(T.me.team_id), tt = todayTarget();
    box.innerHTML = `${team ? `<span class="chip team" style="--c:${team.color}"><i></i>${esc(team.name)}${T.me.team_role === 'lead' ? ' · หัวหน้าทีม' : ''}</span>` : isAdmin() ? '<span class="chip">ผู้ดูแลระบบ</span>' : '<button class="chip warn" data-chip="profile">ยังไม่มีทีม · ดูรหัสผู้ใช้ของฉัน</button>'}
      ${tt.due ? `<button class="chip today" data-chip="mywork" title="งานที่ถึงกำหนดวันนี้ (รวมที่ค้าง)">วันนี้ <b>${tt.done}/${tt.due}</b></button>` : ''}
      ${team ? `<button class="chip share ${T.sharing && !T.posError && T.sent ? 'on' : ''}" data-chip="share" title="${esc(T.posError || (T.sharing ? 'ส่งตำแหน่งให้หัวหน้าทีมเห็น แตะเพื่อหยุด' : 'ไม่ได้แชร์ตำแหน่ง แตะเพื่อเปิด'))}">
        <i></i>${T.sharing ? (T.posError ? 'ตำแหน่ง: ' + esc(T.posError) : T.sent ? 'แชร์ตำแหน่ง' : 'กำลังหาตำแหน่ง') : 'ไม่แชร์ตำแหน่ง'}</button>` : ''}`;
  }
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-chip]');
    if (!c) return;
    if (c.dataset.chip === 'share') guard(async () => {
      if (T.sharing && !(await confirmBox('หยุดแชร์ตำแหน่งกับทีม?<br><span class="muted">หัวหน้าทีมจะไม่เห็นตำแหน่งของคุณจนกว่าจะเปิดอีกครั้ง</span>', { ok: 'หยุดแชร์' }))) return;
      await setSharing(!T.sharing);
    })();
    if (c.dataset.chip === 'mywork') ui.goTab('mywork');
    if (c.dataset.chip === 'team') ui.goTab('team');
    if (c.dataset.chip === 'profile') ui.goTab('profile');
  });

  // ---------- pages ----------
  const page = (id, html) => { const el = $(`#tab-${id}`); if (el) el.innerHTML = `<div class="page">${html}</div>`; return el; };
  const kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const bar = pct => `<div class="bar"><div style="width:${Math.min(100, Math.max(0, pct))}%"></div></div>`;
  const notReady = () => `<div class="empty-state"><h3>ยังใช้งานทีมสำรวจไม่ได้</h3><p class="muted">ผู้ดูแลต้องรัน SQL ชุดล่าสุดใน Supabase ก่อน (เครื่องสำนักงาน: ตั้งค่า → "คัดลอก SQL สร้างตาราง" → SQL Editor → Run)</p></div>`;
  const goParcel = code => {
    const f = map.layers.flatMap(l => l.features).find(x => x.kind === 'parcel' && String(x.code).toUpperCase() === code);
    ui.goTab('map');
    if (f) { map.selected = f; map.zoomTo(f); ui.showFeature(f); } else toast(`ยังไม่มีรูปแปลง ${code} บนแผนที่`, true);
  };
  const navLink = code => {
    const f = S.featByCode?.get(code);
    if (!f?.bbox) return '';
    return `<a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${((f.bbox[1] + f.bbox[3]) / 2).toFixed(6)},${((f.bbox[0] + f.bbox[2]) / 2).toFixed(6)}">นำทาง</a>`;
  };

  // งานของฉัน
  let myView = 'today';
  async function renderMyWork() {
    if (!T.on) return page('mywork', notReady());
    await loadMineToday();
    const t = today(), list = mine();
    const p = progress(list, stateOf, { today: t });
    const tt = todayTarget();
    const done = T.mineToday?.total.done || 0;
    const center = T.pos || (map.gps ? { lat: map.gps.lat, lon: map.gps.lon } : null);
    const rows = list.map(a => {
      const f = S.featByCode?.get(a.code), st = stateOf(a.code);
      const d = center && f?.bbox ? distM(center, { lat: (f.bbox[1] + f.bbox[3]) / 2, lon: (f.bbox[0] + f.bbox[2]) / 2 }) : null;
      return { ...a, st, d, done: DONE_STATES.has(st), late: a.due < t && !DONE_STATES.has(st) };
    });
    const pick = { today: r => !r.done && r.due <= t, next: r => !r.done && r.due > t, done: r => r.done, all: () => true }[myView];
    const shown = rows.filter(pick).sort((a, b) => (a.late !== b.late ? (a.late ? -1 : 1) : a.due !== b.due ? String(a.due).localeCompare(String(b.due)) : (a.d ?? 1e9) - (b.d ?? 1e9)));
    const planNames = [...new Set(list.map(a => T.plans.find(pl => pl.id === a.plan_id)?.name).filter(Boolean))];
    page('mywork', `
      <div class="page-head"><div><h2>งานของฉัน</h2><p class="muted">${esc(nameOf(email))}${teamName(T.me.team_id) ? ` · ${esc(teamName(T.me.team_id))}` : ''}${planNames.length ? ` · แผน ${esc(planNames.join(', '))}` : ''}</p></div>
        <button class="primary" data-act="mywork-map">ดูงานของฉันบนแผนที่</button></div>
      ${list.length ? '' : `<div class="empty-state"><h3>ยังไม่มีแปลงที่มอบหมายให้คุณ</h3><p class="muted">${isLead() ? 'สร้างแผนงานในหน้า "แผนงาน" เพื่อแบ่งแปลงให้ลูกทีม' : 'หัวหน้าทีมจะกำหนดแปลงให้ในหน้าแผนงาน ระหว่างนี้สำรวจแปลงใดก็ได้ที่ไม่ล็อก'}</p></div>`}
      <div class="kpis">${kpi('งานวันนี้', `${tt.done}/${tt.due}`, 'ถึงกำหนดวันนี้ (รวมที่ค้าง)', tt.due && tt.done >= tt.due ? 'ok' : '')}
        ${kpi('สำรวจเสร็จวันนี้', done, 'นับจากที่กด "สำรวจเสร็จ"')}${kpi('เลยกำหนด', p.overdue, 'ยังไม่เสร็จ', p.overdue ? 'err' : '')}
        ${kpi('ทั้งแผน', `${p.done}/${p.total}`, `${p.pct}%`)}</div>
      ${list.length ? `<div class="panel"><div class="row"><div class="seg" data-seg="my">${[['today', `วันนี้และค้าง (${rows.filter(r => !r.done && r.due <= t).length})`], ['next', `วันต่อไป (${rows.filter(r => !r.done && r.due > t).length})`], ['done', `เสร็จแล้ว (${rows.filter(r => r.done).length})`], ['all', 'ทั้งหมด']]
          .map(([v, l]) => `<button data-v="${v}" class="${myView === v ? 'on' : ''}">${l}</button>`).join('')}</div><span class="grow"></span>${center ? '<span class="muted">เรียงตามกำหนด แล้วตามระยะจากตำแหน่งของคุณ</span>' : '<span class="muted">เปิดตำแหน่งเพื่อเรียงตามระยะทาง</span>'}</div>
        <div class="work-list">${shown.slice(0, 300).map(r => `<div class="work-item ${r.late ? 'late' : ''}">
          <div class="wi-main" data-go="${esc(r.code)}"><b>${esc(r.code)}</b><span class="muted">${esc(S.landByCode?.get(r.code) ? ui.ownerNames(S.landByCode.get(r.code).ownerIds) : 'ยังไม่มีข้อมูลที่ดิน')}</span></div>
          <div class="wi-meta"><span class="${r.late ? 'late' : ''}">${r.late ? 'เลยกำหนด ' : ''}${esc(thDay(r.due))}</span>${r.st ? `<span class="pill ${r.done ? 'ok' : r.st === 'revisit' ? 'err' : 'info'}">${esc(STATE_TH[r.st] || r.st)}</span>` : ''}${r.d != null ? `<span class="muted">${r.d < 1000 ? `${Math.round(r.d)} ม.` : `${(r.d / 1000).toFixed(1)} กม.`}</span>` : ''}</div>
          <div class="wi-act"><button class="small" data-go="${esc(r.code)}">ไปที่แปลง</button>${navLink(r.code)}</div></div>`).join('') || '<p class="muted">ไม่มีรายการ</p>'}</div></div>` : ''}`);
  }

  // ทีม
  async function renderTeam() {
    if (!T.on) return page('team', notReady());
    const t = today(), mineTeam = T.me.team_id;
    const teams = isAdmin() ? T.teams : T.teams.filter(x => x.id === mineTeam);
    const peopleOf = team => teamMembers(team);
    const loc = e => T.locations.find(l => lc(l.email) === lc(e));
    const prog = progress([...T.assign.values()], stateOf, { today: t });
    const keyBox = k => `<div class="key-box"><span class="muted">รหัสเข้าร่วม${esc(k.name)}</span><b>${esc(k.join_key)}</b>
      <button class="small" data-copy="${esc(k.join_key)}">คัดลอก</button><button class="small" data-newkey="${esc(k.id)}">สร้างรหัสใหม่</button></div>`;
    const personRow = m => {
      const l = loc(m.email), pm = prog.byMember.get(m.email) || prog.byMember.get(lc(m.email));
      const online = l && Date.now() - Date.parse(l.at) < 15 * 60 * 1000;
      return `<tr><td><span class="avatar" style="background:${colorOf(m.email)}">${esc(initialsOf(m.display_name || nameOf(m.email)))}</span> <b>${esc(m.display_name || nameOf(m.email))}</b><br><span class="muted">${esc(m.email)}</span></td>
        <td>${m.team_role === 'lead' ? '<span class="pill info">หัวหน้าทีม</span>' : 'ลูกทีม'}${m.role === 'admin' ? ' <span class="pill">ผู้ดูแล</span>' : m.role === 'viewer' ? ' <span class="pill">ดูอย่างเดียว</span>' : ''}</td>
        <td>${pm ? `${pm.done}/${pm.total}${pm.overdue ? ` <span class="pill err">ค้าง ${pm.overdue}</span>` : ''}` : '-'}</td>
        <td>${isLead() ? (l ? `<span class="dot ${online ? 'on' : ''}"></span>${esc(ago(l.at))}${l.accuracy ? ` · ±${Math.round(l.accuracy)} ม.` : ''} <button class="small" data-locate="${esc(m.email)}">ดูบนแผนที่</button>` : '<span class="muted">ยังไม่มีตำแหน่ง</span>') : '-'}</td>
        ${isAdmin() ? `<td><select data-mset="${esc(m.email)}" data-k="team">${['', ...T.teams.map(x => x.id)].map(id => `<option value="${esc(id)}" ${m.team_id === id || (!m.team_id && !id) ? 'selected' : ''}>${id ? esc(teamName(id)) : '— ไม่มีทีม —'}</option>`).join('')}</select>
          <select data-mset="${esc(m.email)}" data-k="trole"><option value="member" ${m.team_role !== 'lead' ? 'selected' : ''}>ลูกทีม</option><option value="lead" ${m.team_role === 'lead' ? 'selected' : ''}>หัวหน้าทีม</option></select>
          <select data-mset="${esc(m.email)}" data-k="role">${[['viewer', 'ดูอย่างเดียว'], ['editor', 'แก้ไขได้'], ['admin', 'ผู้ดูแล']].map(([v, l2]) => `<option value="${v}" ${m.role === v ? 'selected' : ''}>${l2}</option>`).join('')}</select></td>` : ''}</tr>`;
    };
    const noTeam = isAdmin() ? T.members.filter(m => !m.team_id) : [];
    // Monitoring: today across the teams this person may see.
    let todaySum = null, pending = [];
    if (isLead()) {
      todaySum = await cloud.getAll('llan_work_log', 'at,by_user,team_id,code,action,state', `&at=gte.${encodeURIComponent(startOf(t))}${isAdmin() ? '' : `&team_id=eq.${encodeURIComponent(mineTeam || '')}`}`, 'at.asc')
        .then(rows => summarize(rows)).catch(() => null);
      if (isAdmin()) pending = await cloud.rpc('llan_pending_users').catch(() => []);
    }
    if (!office && T.myCode === undefined) T.myCode = await cloud.rpc('llan_my_code', { p_name: '' }).catch(() => null);
    const visible = isAdmin() ? T.members.filter(m => m.team_id) : teamMembers(mineTeam);
    const online = visible.filter(m => { const l = loc(m.email); return l && Date.now() - Date.parse(l.at) < 15 * 60 * 1000; }).length;
    const teamProg = progress([...T.assign.values()], stateOf, { today: t, team: isAdmin() ? undefined : mineTeam });
    const addTeams = isAdmin() ? T.teams : T.teams.filter(x => x.id === mineTeam);
    page('team', `
      <div class="page-head"><div><h2>${office ? 'ศูนย์ติดตามทีมสำรวจ' : 'ทีมสำรวจ'}</h2><p class="muted">${isAdmin() ? `${T.teams.length} ทีม · สมาชิก ${T.members.length} คน` : teamName(mineTeam) ? esc(teamName(mineTeam)) : 'ยังไม่ได้อยู่ในทีม'}${T.myCode ? ` · รหัสผู้ใช้ของฉัน <b class="code">${esc(T.myCode)}</b>` : ''}</p></div>
        <div class="row">${isLead() ? `<label class="check"><input type="checkbox" id="showPeople" ${T.showPeople ? 'checked' : ''}> แสดงตำแหน่งทีมบนแผนที่</label><button data-act="people-map">ดูตำแหน่งทั้งหมดบนแผนที่</button>` : ''}
          ${office ? '' : `<button class="${T.sharing ? '' : 'primary'}" data-chip="share">${T.sharing ? 'หยุดแชร์ตำแหน่งของฉัน' : 'แชร์ตำแหน่งของฉัน'}</button>`}</div></div>
      ${isLead() ? `<div class="kpis">${kpi('ออนไลน์ตอนนี้', `${online}/${visible.length}`, 'ส่งตำแหน่งใน 15 นาที', online ? 'ok' : '')}
        ${kpi('สำรวจเสร็จวันนี้', (todaySum?.total.done ?? 0).toLocaleString(), 'แปลง')}${kpi('ต้องกลับไปซ้ำวันนี้', (todaySum?.total.revisit ?? 0).toLocaleString(), 'แปลง', todaySum?.total.revisit ? 'err' : '')}
        ${kpi('งานวันนี้ตามแผน', teamProg.dueToday.toLocaleString(), 'แปลงที่ถึงกำหนดวันนี้')}${kpi('ค้างตามแผน', teamProg.overdue.toLocaleString(), 'แปลง', teamProg.overdue ? 'warn' : '')}</div>
      <div class="panel"><h3>เพิ่มสมาชิกด้วยรหัสผู้ใช้</h3>
        <form class="row" id="addByCode"><input name="code" required placeholder="รหัสผู้ใช้ เช่น K7Q2-9M4A" style="text-transform:uppercase;width:180px">
          <select name="team">${addTeams.map(x => `<option value="${esc(x.id)}" ${x.id === mineTeam ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          ${isAdmin() ? '<select name="trole"><option value="member">ลูกทีม</option><option value="lead">หัวหน้าทีม</option></select>' : ''}
          <button class="primary">เพิ่มเข้าทีม</button></form>
        <p class="muted">ผู้ใช้เปิดหน้าเว็บสำรวจแล้วสมัคร/เข้าสู่ระบบ จะเห็นรหัสผู้ใช้ของตัวเอง ให้ส่งรหัสนั้นมา${isAdmin() ? '' : ' (หัวหน้าทีมเพิ่มได้เฉพาะลูกทีมในทีมตัวเอง)'}</p>
        ${pending.length ? `<h4>รอเข้าทีม ${pending.length} คน</h4><div class="table-wrap"><table class="grid"><tr><th>ชื่อ</th><th>อีเมล</th><th>รหัสผู้ใช้</th><th>สมัครเมื่อ</th><th></th></tr>
          ${pending.map(u => `<tr><td>${esc(u.name || '-')}</td><td>${esc(u.email)}</td><td><b class="code">${esc(u.code)}</b></td><td class="muted">${esc(ago(u.created_at))}</td>
            <td><button class="small" data-fill-code="${esc(u.code)}">ใช้รหัสนี้</button></td></tr>`).join('')}</table></div>` : ''}</div>` : ''}
      ${isAdmin() ? `<div class="panel"><h3>สร้างทีมใหม่</h3><form class="row" id="teamNew"><input name="name" placeholder="ชื่อทีม เช่น ทีมสำรวจหมู่ 1-3" required>
        <input name="color" type="color" value="${PALETTE[T.teams.length % PALETTE.length]}" title="สีทีม"><button class="primary">สร้างทีม</button></form>
        <p class="muted">สร้างทีมแล้วเพิ่มลูกทีมด้วย "เพิ่มสมาชิกด้วยรหัสผู้ใช้" (ลูกทีมสมัครที่หน้าเว็บนี้ แล้วดูรหัสที่ ตั้งค่าส่วนตัว) ตั้งหัวหน้าทีมได้ในตารางสมาชิก</p></div>` : ''}
      ${teams.map(team => `<div class="panel team-card" style="--c:${team.color}">
        <div class="row"><h3><i class="team-dot"></i>${esc(team.name)}</h3><span class="muted">${peopleOf(team.id).length} คน</span><span class="grow"></span>
          ${(() => { const tp = progress([...T.assign.values()], stateOf, { today: t, team: team.id }); return tp.total ? `<span class="muted">งานที่มอบหมาย ${tp.done}/${tp.total} (${tp.pct}%)</span>` : ''; })()}
          ${isAdmin() ? `<button class="small" data-team-edit="${esc(team.id)}">แก้ชื่อ/สี</button><button class="small danger" data-team-del="${esc(team.id)}">ลบทีม</button>` : ''}</div>
        ${T.keys.filter(k => k.id === team.id).map(keyBox).join('')}
        <div class="table-wrap"><table class="grid"><tr><th>สมาชิก</th><th>บทบาท</th><th>งาน (เสร็จ/ทั้งหมด)</th><th>ตำแหน่งล่าสุด</th>${isAdmin() ? '<th>จัดการ (ผู้ดูแล)</th>' : ''}</tr>
          ${peopleOf(team.id).map(personRow).join('') || '<tr><td colspan="5" class="muted">ยังไม่มีสมาชิก ส่งรหัสเข้าร่วมให้ลูกทีม</td></tr>'}</table></div></div>`).join('')}
      ${noTeam.length ? `<div class="panel"><h3>สมาชิกที่ยังไม่มีทีม</h3><div class="table-wrap"><table class="grid"><tr><th>สมาชิก</th><th>บทบาท</th><th>งาน</th><th>ตำแหน่งล่าสุด</th><th>จัดการ (ผู้ดูแล)</th></tr>${noTeam.map(personRow).join('')}</table></div></div>` : ''}`);
  }

  // สรุปงาน
  const SUM = { range: 'today', from: null, to: null, team: '', person: '', day: '' };
  async function renderSummary() {
    if (!T.on) return page('summary', notReady());
    const t = today();
    const from = SUM.range === 'today' ? t : SUM.range === '7' ? addDays(t, -6) : SUM.range === '30' ? addDays(t, -29) : SUM.from || addDays(t, -6);
    const to = SUM.range === 'custom' ? SUM.to || t : t;
    if (!isLead()) SUM.person = lc(email);
    const team = isAdmin() ? SUM.team : isLead() ? T.me.team_id : '';
    let rows = [];
    try {
      rows = await cloud.getAll('llan_work_log', 'at,by_user,team_id,code,action,state',
        `&at=gte.${encodeURIComponent(startOf(from))}&at=lte.${encodeURIComponent(endOf(to))}${team ? `&team_id=eq.${encodeURIComponent(team)}` : ''}`, 'at.asc');
    } catch (err) { toast(err.message, true); }
    const s = summarize(rows, { person: SUM.person || undefined });
    T.sum = { s, from, to };
    const people = isAdmin() ? T.members.filter(m => !team || m.team_id === team) : isLead() ? teamMembers(T.me.team_id) : [member(email) || { email }];
    const maxDone = Math.max(1, ...s.days.map(d => d.done));
    const surveyed = S.status?.summary?.survey || {};
    const prog = progress([...T.assign.values()], stateOf, { today: t, team: team || undefined, email: SUM.person || undefined });
    const parcels = s.parcels.filter(p => !SUM.day || p.day === SUM.day);
    page('summary', `
      <div class="page-head"><div><h2>สรุปงานสำรวจ</h2><p class="muted">${esc(thDay(from))}${from !== to ? ` – ${esc(thDay(to))}` : ''}${SUM.person ? ` · ${esc(nameOf(SUM.person))}` : ''}${team ? ` · ${esc(teamName(team))}` : ''}</p></div>
        <button data-act="sum-xlsx">ส่งออก Excel</button></div>
      <div class="panel filters"><div class="seg" data-seg="range">${[['today', 'วันนี้'], ['7', '7 วัน'], ['30', '30 วัน'], ['custom', 'กำหนดเอง']].map(([v, l]) => `<button data-v="${v}" class="${SUM.range === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${SUM.range === 'custom' ? `<input type="date" data-sum="from" value="${esc(from)}"> ถึง <input type="date" data-sum="to" value="${esc(to)}">` : ''}
        ${isAdmin() ? `<select data-sum="team"><option value="">ทุกทีม</option>${T.teams.map(x => `<option value="${esc(x.id)}" ${SUM.team === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
        ${isLead() ? `<select data-sum="person"><option value="">ทุกคน</option>${people.map(m => `<option value="${esc(lc(m.email))}" ${SUM.person === lc(m.email) ? 'selected' : ''}>${esc(m.display_name || nameOf(m.email))}</option>`).join('')}</select>` : ''}
        ${SUM.day ? `<button class="small" data-act="sum-day-clear">วันที่ ${esc(thDay(SUM.day))} ✕</button>` : ''}</div>
      <div class="kpis">${kpi('สำรวจเสร็จ', s.total.done.toLocaleString(), 'แปลง ในช่วงที่เลือก', 'ok')}${kpi('ต้องกลับไปซ้ำ', s.total.revisit.toLocaleString(), 'แปลง', s.total.revisit ? 'err' : '')}
        ${kpi('แก้ไขข้อมูล', s.total.edit.toLocaleString(), 'ครั้ง')}${kpi('รูปถ่าย', s.total.photo.toLocaleString(), 'รูป')}${kpi('คนที่ทำงาน', s.total.people, 'คน')}
        ${prog.total ? kpi('ตามแผนงาน', `${prog.done}/${prog.total}`, `${prog.pct}% · ค้าง ${prog.overdue}`, prog.overdue ? 'warn' : '') : kpi('สำรวจแล้วทั้งหมด', ((surveyed.ready || 0) + (surveyed.done || 0)).toLocaleString(), `จาก ${(surveyed.parcels || 0).toLocaleString()} แปลง`)}</div>
      <div class="cols2">
        <div class="panel"><h3>รายวัน</h3><div class="table-wrap"><table class="grid daily"><tr><th>วันที่</th><th>สำรวจเสร็จ</th><th></th><th>กลับไปซ้ำ</th><th>แก้ไข</th><th>รูป</th><th>คน</th></tr>
          ${s.days.map(d => `<tr class="click ${SUM.day === d.day ? 'sel' : ''}" data-day="${d.day}"><td>${esc(thDay(d.day))}</td><td class="num"><b>${d.done}</b></td><td class="barcell">${bar(d.done / maxDone * 100)}</td>
            <td class="num">${d.revisit || ''}</td><td class="num">${d.edit || ''}</td><td class="num">${d.photo || ''}</td><td class="num">${d.people}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">ไม่มีงานในช่วงนี้</td></tr>'}</table></div></div>
        <div class="panel"><h3>รายบุคคล</h3><div class="table-wrap"><table class="grid"><tr><th>ชื่อ</th><th>เสร็จ</th><th>ซ้ำ</th><th>แก้ไข</th><th>รูป</th><th>ตามแผน</th><th>ล่าสุด</th></tr>
          ${s.people.map(p => { const pm = prog.byMember.get(p.email); return `<tr class="click ${SUM.person === p.email ? 'sel' : ''}" data-person="${esc(p.email)}"><td><span class="avatar sm" style="background:${colorOf(p.email)}">${esc(initialsOf(nameOf(p.email)))}</span> ${esc(nameOf(p.email))}<br><span class="muted">${esc(teamName(p.team_id))}</span></td>
            <td class="num"><b>${p.done}</b></td><td class="num">${p.revisit || ''}</td><td class="num">${p.edit || ''}</td><td class="num">${p.photo || ''}</td><td>${pm ? `${pm.done}/${pm.total}${pm.overdue ? ` <span class="pill err">ค้าง ${pm.overdue}</span>` : ''}` : '-'}</td><td class="muted">${p.last ? esc(ago(p.last)) : ''}</td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">-</td></tr>'}</table></div></div>
      </div>
      <div class="panel"><h3>แปลงที่บันทึกการสำรวจ ${parcels.length.toLocaleString()} แปลง${SUM.day ? ` (${esc(thDay(SUM.day))})` : ''}</h3>
        <div class="table-wrap"><table class="grid"><tr><th>แปลง</th><th>ผล</th><th>โดย</th><th>เวลา</th><th></th></tr>
        ${parcels.slice(0, 500).map(p => `<tr><td><b>${esc(p.code)}</b></td><td><span class="pill ${p.state === 'done' ? 'ok' : p.state === 'revisit' ? 'err' : 'info'}">${p.state === 'done' ? 'สำรวจเสร็จ' : p.state === 'revisit' ? 'ต้องกลับไปซ้ำ' : 'กำลังสำรวจ'}</span></td>
          <td>${esc(nameOf(p.by))}</td><td>${esc(thTime(p.at))}</td><td><button class="small" data-go="${esc(p.code)}">ดูแปลง</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">-</td></tr>'}</table></div></div>`);
  }
  async function summaryXlsx() {
    if (!T.sum) return;
    const { writeXlsx } = await import('./lib/xlsx.mjs');
    const { s, from, to } = T.sum;
    const bytes = writeXlsx([
      { name: 'รายวัน', columns: [{ header: 'วันที่', key: 'day' }, { header: 'สำรวจเสร็จ (แปลง)', key: 'done' }, { header: 'ต้องกลับไปซ้ำ', key: 'revisit' }, { header: 'แก้ไขข้อมูล (ครั้ง)', key: 'edit' }, { header: 'รูปถ่าย', key: 'photo' }, { header: 'จำนวนคน', key: 'people' }], rows: s.days },
      { name: 'รายบุคคล', columns: [{ header: 'ชื่อ', key: 'name' }, { header: 'อีเมล', key: 'email' }, { header: 'ทีม', key: 'team' }, { header: 'สำรวจเสร็จ', key: 'done' }, { header: 'ต้องกลับไปซ้ำ', key: 'revisit' }, { header: 'แก้ไข', key: 'edit' }, { header: 'รูปถ่าย', key: 'photo' }, { header: 'วันที่ทำงาน', key: 'days' }],
        rows: s.people.map(p => ({ ...p, name: nameOf(p.email), team: teamName(p.team_id) })) },
      { name: 'แปลง', columns: [{ header: 'รหัสแปลง', key: 'code' }, { header: 'ผล', key: 'state' }, { header: 'โดย', key: 'by' }, { header: 'ทีม', key: 'team' }, { header: 'เวลา', key: 'time' }],
        rows: s.parcels.map(p => ({ code: p.code, state: p.state === 'done' ? 'สำรวจเสร็จ' : p.state === 'revisit' ? 'ต้องกลับไปซ้ำ' : 'กำลังสำรวจ', by: nameOf(p.by), team: teamName(p.team_id), time: thTime(p.at) })) },
    ]);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), download: `สรุปงานสำรวจ_${from}_${to}.xlsx` });
    document.body.append(a); a.click(); a.remove();
  }

  // แผนงาน
  const PLAN = { source: 'view', village: '', count: '', start: null, end: null, days: [1, 2, 3, 4, 5, 6], members: null, team: null, name: '', preview: null };
  function candidates() {
    const team = PLAN.team || T.me.team_id;
    let feats = S.features.filter(f => f.kind === 'parcel' && f.code);
    if (PLAN.source === 'view') {
      const [w, s] = fromMercator(...map.toMap([0, map.h])), [e, n] = fromMercator(...map.toMap([map.w, 0]));
      feats = feats.filter(f => { const x = (f.bbox[0] + f.bbox[2]) / 2, y = (f.bbox[1] + f.bbox[3]) / 2; return x >= w && x <= e && y >= s && y <= n; });
    } else if (PLAN.source === 'selected') {
      const ids = new Set([...(map.multi || [])].map(f => f.id));
      feats = feats.filter(f => ids.has(f.id));
    } else if (PLAN.source === 'village') {
      const codes = new Set(S.rec.lands.filter(l => String(l.villageNo || '') === PLAN.village).map(l => String(l.parcelCode || '').toUpperCase()));
      feats = feats.filter(f => codes.has(String(f.code).toUpperCase()));
    }
    const seen = new Set();
    return feats.map(f => ({ code: String(f.code).toUpperCase(), x: (f.bbox[0] + f.bbox[2]) / 2, y: (f.bbox[1] + f.bbox[3]) / 2 }))
      .filter(p => !seen.has(p.code) && seen.add(p.code) && !DONE_STATES.has(stateOf(p.code)) && !T.assign.has(p.code) && !lockRule(p.code, { me: { ...T.me, team_id: team, role: 'editor' }, assignments: T.assign, surveys, teamName }));
  }
  function renderPlan() {
    if (!T.on) return page('plan', notReady());
    if (!isLead()) return page('plan', '<div class="empty-state"><h3>แผนงานสำหรับหัวหน้าทีม</h3><p class="muted">ดูงานที่ได้รับมอบหมายในหน้า "งานของฉัน"</p></div>');
    const t = today();
    PLAN.team = PLAN.team || T.me.team_id || T.teams[0]?.id || null;
    PLAN.start = PLAN.start || t; PLAN.end = PLAN.end || addDays(t, 6);
    const people = teamMembers(PLAN.team);
    if (!PLAN.members) PLAN.members = people.filter(m => m.team_role !== 'lead').map(m => lc(m.email));
    if (!PLAN.members.length && people.length) PLAN.members = people.map(m => lc(m.email));
    const cand = candidates(), days = workdays(PLAN.start, PLAN.end, PLAN.days);
    const villages = [...new Set(S.rec.lands.map(l => String(l.villageNo || '')).filter(Boolean))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    const n = Math.min(Number(PLAN.count) || cand.length, cand.length), m = PLAN.members.length;
    const pv = PLAN.preview;
    const planRow = pl => {
      const rows = [...T.assign.values()].filter(a => a.plan_id === pl.id), pg = progress(rows, stateOf, { today: t });
      return `<div class="plan-item"><div><b>${esc(pl.name)}</b> <span class="muted">${esc(teamName(pl.team_id))} · ${esc(thDay(pl.start_date))} – ${esc(thDay(pl.end_date))} · ${(pl.members || []).length} คน</span>
        ${bar(pg.pct)}<span class="muted">เสร็จ ${pg.done}/${pg.total} (${pg.pct}%)${pg.overdue ? ` · <span class="late">ค้าง ${pg.overdue}</span>` : ''}${pg.dueToday ? ` · วันนี้ ${pg.dueToday}` : ''}</span></div>
        <div class="row"><button class="small" data-plan-map="${esc(pl.id)}">ดูบนแผนที่</button>${isLead() ? `<button class="small danger" data-plan-del="${esc(pl.id)}">ลบแผน</button>` : ''}</div></div>`;
    };
    page('plan', `
      <div class="page-head"><div><h2>แผนงาน</h2><p class="muted">กำหนดจำนวนแปลงและวันทำงาน ระบบแบ่งให้ลูกทีมเอง: แต่ละคนได้แปลงที่อยู่ติดกันเป็นกลุ่ม และเป้าหมายรายวัน</p></div></div>
      <div class="cols2">
      <div class="panel plan-form"><h3>สร้างแผนงานใหม่</h3>
        <label>ชื่อแผน<input data-plan="name" value="${esc(PLAN.name)}" placeholder="เช่น สำรวจหมู่ 3 สัปดาห์ที่ 1"></label>
        ${isAdmin() ? `<label>ทีม<select data-plan="team">${T.teams.map(x => `<option value="${esc(x.id)}" ${PLAN.team === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
        <label>แปลงที่จะมอบหมาย<select data-plan="source">
          <option value="view" ${PLAN.source === 'view' ? 'selected' : ''}>แปลงที่เห็นบนแผนที่ตอนนี้ (เลื่อน/ซูมแผนที่ไปพื้นที่ที่ต้องการ)</option>
          <option value="selected" ${PLAN.source === 'selected' ? 'selected' : ''}>แปลงที่เลือกด้วยเครื่องมือ "เลือกหลายแปลง" (${(map.multi?.size || 0).toLocaleString()})</option>
          <option value="village" ${PLAN.source === 'village' ? 'selected' : ''}>ตามหมู่ที่</option>
          <option value="all" ${PLAN.source === 'all' ? 'selected' : ''}>ทั้งหมดที่ยังไม่สำรวจ</option></select></label>
        ${PLAN.source === 'village' ? `<label>หมู่ที่<select data-plan="village"><option value="">เลือก</option>${villages.map(v => `<option ${PLAN.village === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>` : ''}
        <p class="avail">มีแปลงให้มอบหมาย <b>${cand.length.toLocaleString()}</b> แปลง <span class="muted">(ไม่นับแปลงที่สำรวจเสร็จ มอบหมายแล้ว หรือเป็นของทีมอื่น)</span></p>
        <label>จำนวนแปลง<input type="number" min="1" max="${cand.length}" data-plan="count" value="${esc(PLAN.count || cand.length || '')}"></label>
        <div class="row"><label>วันที่เริ่ม<input type="date" data-plan="start" value="${esc(PLAN.start)}"></label><label>วันที่สิ้นสุด<input type="date" data-plan="end" value="${esc(PLAN.end)}"></label></div>
        <div class="days">วันทำงาน ${WEEKDAY_TH.map((d, i) => `<label class="day ${PLAN.days.includes(i) ? 'on' : ''}"><input type="checkbox" data-day="${i}" ${PLAN.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')} <span class="muted">= ${days.length} วัน</span></div>
        <div class="members"><span>ลูกทีม (${m} คน)</span>${people.map(p => `<label class="check"><input type="checkbox" data-member="${esc(lc(p.email))}" ${PLAN.members.includes(lc(p.email)) ? 'checked' : ''}>
          <span class="avatar sm" style="background:${colorOf(p.email)}">${esc(initialsOf(p.display_name || nameOf(p.email)))}</span>${esc(p.display_name || nameOf(p.email))}${p.team_role === 'lead' ? ' (หัวหน้า)' : ''}</label>`).join('') || '<span class="muted">ทีมนี้ยังไม่มีสมาชิก</span>'}</div>
        <div class="calc">${n && m && days.length ? `${n.toLocaleString()} แปลง ÷ ${m} คน = ~${Math.ceil(n / m).toLocaleString()} แปลง/คน · ${days.length} วันทำงาน = ~<b>${Math.ceil(n / m / days.length)}</b> แปลง/คน/วัน (ทั้งทีม ~${Math.ceil(n / days.length)} แปลง/วัน)` : 'เลือกแปลง วันทำงาน และลูกทีม'}</div>
        <div class="row"><button class="primary" data-act="plan-calc" ${n && m && days.length ? '' : 'disabled'}>คำนวณการแบ่งงาน</button></div>
        ${pv ? `<div class="preview"><h4>ผลการแบ่งงาน</h4><table class="grid"><tr><th>ลูกทีม</th><th>แปลง</th><th>ต่อวัน</th><th>ช่วงวันที่</th></tr>
          ${pv.members.map(x => `<tr><td><span class="avatar sm" style="background:${colorOf(x.email)}">${esc(initialsOf(nameOf(x.email)))}</span> ${esc(nameOf(x.email))}</td><td class="num">${x.codes.length}</td><td class="num">${x.perDay}</td><td>${esc(thDay(x.first))} – ${esc(thDay(x.last))}</td></tr>`).join('')}</table>
          <div class="row"><button data-act="plan-preview-map">ดูการแบ่งบนแผนที่</button><span class="grow"></span><button class="primary" data-act="plan-save">บันทึกแผนงาน (${pv.total.toLocaleString()} แปลง)</button></div></div>` : ''}
      </div>
      <div class="panel"><h3>แผนงานทั้งหมด</h3>${T.plans.filter(pl => isAdmin() || pl.team_id === T.me.team_id).map(planRow).join('') || '<p class="muted">ยังไม่มีแผนงาน</p>'}</div>
      </div>`);
  }

  // ตั้งค่าส่วนตัว: my code for the team lead, my name, my team, position sharing, password, sign out.
  const ROLE_TH = { viewer: 'ดูอย่างเดียว', editor: 'แก้ไขได้', admin: 'ผู้ดูแลระบบ' };
  async function renderProfile() {
    if (T.on && !T.profile) T.profile = (await cloud.rpc('llan_my_profile').catch(() => []))[0] || null;
    // The name given when signing up goes with the code the first time.
    const signupName = store.get('llan.joinName');
    if (T.profile && !T.profile.name && !T.me.display_name && signupName) {
      await cloud.rpc('llan_set_my_name', { p_name: signupName }).then(() => { T.profile.name = signupName; }).catch(() => {});
    }
    const code = T.profile?.code || '', team = teamOf(T.me.team_id);
    const name = T.me.display_name || T.profile?.name || store.get('llan.joinName') || '';
    const waiting = T.on && !T.me.team_id && !isAdmin();
    page('profile', `
      <div class="page-head"><div><h2>ตั้งค่าส่วนตัว</h2><p class="muted">${esc(email)}</p></div></div>
      ${waiting ? `<div class="notice"><b>ยังไม่ได้อยู่ในทีม</b> ส่ง<b>รหัสผู้ใช้</b>ด้านล่างให้หัวหน้าทีมหรือผู้ดูแล เพื่อเพิ่มคุณเข้าทีม
        เมื่อได้รับการเพิ่มแล้ว หน้าเว็บจะโหลดใหม่ให้เอง แล้วจะเห็นสถานะแปลง งานของทีม และงานของคุณ</div>` : ''}
      <div class="cols2">
        <div class="panel profile-card">
          <div class="who"><span class="avatar lg" style="background:${team?.color || '#1f6f5c'}">${esc(initialsOf(name || email))}</span>
            <div><b>${esc(name || 'ยังไม่ได้ตั้งชื่อ')}</b><br><span class="muted">${T.me.role ? esc(ROLE_TH[T.me.role] || T.me.role) : 'ยังไม่ได้รับสิทธิ์'}${team ? ` · ${esc(team.name)}${T.me.team_role === 'lead' ? ' (หัวหน้าทีม)' : ''}` : ''}</span></div></div>
          ${T.on ? `<h3>รหัสผู้ใช้ของฉัน</h3>
          <div class="my-code"><b id="myCode">${esc(code || '-')}</b><button class="small" data-copy="${esc(code)}">คัดลอก</button>${navigator.share ? '<button class="small" data-act="share-code">ส่งต่อ</button>' : ''}</div>
          <p class="muted">หัวหน้าทีมหรือผู้ดูแลใส่รหัสนี้ที่หน้า "ทีม" → "เพิ่มสมาชิกด้วยรหัสผู้ใช้" รหัสนี้ใช้เพิ่มคุณเข้าทีมเท่านั้น ไม่ใช่รหัสผ่าน</p>` : ''}
          <form id="nameForm" class="stack"><label>ชื่อที่แสดงให้ทีมเห็น<input name="name" value="${esc(name)}" placeholder="เช่น สมชาย (ช่างสำรวจ)" required></label>
            <button class="primary">บันทึกชื่อ</button></form>
        </div>
        <div class="panel">
          <h3>ทีมของฉัน</h3>
          ${team ? `<p><span class="team-dot" style="--c:${team.color};background:${team.color}"></span> <b>${esc(team.name)}</b> · ${T.me.team_role === 'lead' ? 'หัวหน้าทีม' : 'ลูกทีม'}</p>`
            : `<p class="muted">${isAdmin() ? 'ผู้ดูแลระบบไม่ต้องอยู่ในทีม' : 'ยังไม่มีทีม'}</p>`}
          ${T.on && !team ? `<details class="team-key"><summary>มีรหัสทีมจากหัวหน้าทีม? เข้าร่วมด้วยรหัสทีม</summary>
            <form id="joinForm" class="row"><input name="key" required autocomplete="off" placeholder="รหัสทีม เช่น A1B2-C3D4" style="text-transform:uppercase"><button class="primary">เข้าร่วมทีม</button></form></details>` : ''}
          ${team ? `<h3>ตำแหน่งของฉัน</h3><p class="muted">ส่งตำแหน่งให้หัวหน้าทีมเห็นขณะเปิดหน้าเว็บ</p>
            <button class="${T.sharing ? '' : 'primary'}" data-chip="share">${T.sharing ? 'หยุดแชร์ตำแหน่ง' : 'แชร์ตำแหน่ง'}</button>` : ''}
          <h3>เปลี่ยนรหัสผ่าน</h3>
          <form id="pwForm" class="row"><input name="pw" type="password" minlength="6" placeholder="รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)" autocomplete="new-password" required><button>เปลี่ยนรหัสผ่าน</button></form>
          <h3>ออกจากระบบ</h3><button class="danger" data-act="sign-out">ออกจากระบบ</button>
        </div>
      </div>`);
  }
  document.addEventListener('submit', e => {
    const f = e.target;
    if (!['nameForm', 'joinForm', 'pwForm'].includes(f.id) || !f.closest('#tab-profile')) return;
    e.preventDefault();
    guard(async () => {
      if (f.id === 'nameForm') {
        const n = f.name.value.trim();
        store.set('llan.joinName', n);
        if (T.on) await cloud.rpc('llan_set_my_name', { p_name: n });
        T.me.display_name = n; T.profile = { ...(T.profile || {}), name: n };
        await load(); renderProfile(); return toast('บันทึกชื่อแล้ว');
      }
      if (f.id === 'joinForm') {
        await cloud.rpc('llan_join_team', { p_key: f.key.value.trim(), p_name: T.me.display_name || T.profile?.name || store.get('llan.joinName') || '' });
        toast('เข้าร่วมทีมแล้ว กำลังโหลดข้อมูลของทีม…');
        return setTimeout(() => location.reload(), 600);
      }
      if (f.id === 'pwForm') { await ui.changePassword(f.pw.value); f.reset(); return toast('เปลี่ยนรหัสผ่านแล้ว'); }
    })();
  });

  // ---------- page events ----------
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-go],[data-act],[data-seg] button,[data-day],[data-person],[data-copy],[data-fill-code],[data-newkey],[data-locate],[data-plan-map],[data-plan-del],[data-team-edit],[data-team-del]');
    if (!el || !el.closest('.page')) return;
    guard(async () => {
      if (el.dataset.go) return goParcel(el.dataset.go);
      const seg = el.closest('[data-seg]');
      if (seg && el.dataset.v) {
        if (seg.dataset.seg === 'my') { myView = el.dataset.v; return renderMyWork(); }
        if (seg.dataset.seg === 'range') { SUM.range = el.dataset.v; SUM.day = ''; return renderSummary(); }
      }
      if (el.dataset.day !== undefined && el.closest('table.daily')) { SUM.day = SUM.day === el.dataset.day ? '' : el.dataset.day; return renderSummary(); }
      if (el.dataset.person) { SUM.person = SUM.person === el.dataset.person ? '' : el.dataset.person; return renderSummary(); }
      if (el.dataset.copy) { await navigator.clipboard?.writeText(el.dataset.copy).catch(() => {}); return toast(`คัดลอกรหัส ${el.dataset.copy} แล้ว`); }
      if (el.dataset.fillCode) { const f = $('#addByCode'); f.code.value = el.dataset.fillCode; f.code.focus(); return; }
      if (el.dataset.newkey) {
        if (!(await confirmBox('สร้างรหัสเข้าร่วมทีมใหม่?<br><span class="muted">รหัสเดิมจะใช้ไม่ได้ สมาชิกที่อยู่ในทีมแล้วไม่ได้รับผลกระทบ</span>', { ok: 'สร้างรหัสใหม่' }))) return;
        const k = await cloud.rpc('llan_team_new_key', { p_id: el.dataset.newkey }); await load(); renderTeam(); return toast(`รหัสใหม่: ${k}`);
      }
      if (el.dataset.locate) {
        const l = T.locations.find(x => lc(x.email) === lc(el.dataset.locate));
        if (!l) return;
        ui.goTab('map'); T.showPeople = true; ui.updateMarkers(); ui.flyTo(l.lon, l.lat); return;
      }
      if (el.dataset.planMap) { ui.setColor('assign'); ui.goTab('map'); const codes = new Set([...T.assign.values()].filter(a => a.plan_id === el.dataset.planMap).map(a => a.code)); ui.fitCodes(codes); return; }
      if (el.dataset.planDel) {
        const pl = T.plans.find(x => x.id === el.dataset.planDel);
        if (!(await confirmBox(`ลบแผนงาน <b>${esc(pl?.name || '')}</b>?<br><span class="muted">แปลงในแผนจะกลับเป็น "ยังไม่มอบหมาย" ผลการสำรวจที่บันทึกแล้วยังอยู่</span>`, { ok: 'ลบแผน', danger: true }))) return;
        await cloud.deleteWhere('llan_plans', `id=eq.${encodeURIComponent(el.dataset.planDel)}`);
        await cloud.deleteWhere('llan_assignments', `plan_id=eq.${encodeURIComponent(el.dataset.planDel)}`).catch(() => {});
        await load(); ui.refreshMap(); renderPlan(); return toast('ลบแผนงานแล้ว');
      }
      if (el.dataset.teamEdit) {
        const tm = teamOf(el.dataset.teamEdit), name = prompt('ชื่อทีม', tm?.name || '');
        if (!name) return;
        await cloud.rpc('llan_team_save', { p_id: tm.id, p_name: name, p_color: tm.color }); await load(); return renderTeam();
      }
      if (el.dataset.teamDel) {
        const tm = teamOf(el.dataset.teamDel);
        if (!(await confirmBox(`ลบ <b>${esc(tm?.name || '')}</b>?<br><span class="muted">สมาชิกจะกลายเป็นไม่มีทีม แผนงานของทีมถูกลบ</span>`, { ok: 'ลบทีม', danger: true }))) return;
        await cloud.rpc('llan_team_delete', { p_id: tm.id }); await load(); ui.refreshMap(); return renderTeam();
      }
      const act = el.dataset.act;
      if (act === 'share-code') { const code = T.profile?.code; if (code) await navigator.share({ title: 'รหัสผู้ใช้ L-LAN', text: `รหัสผู้ใช้ L-LAN ของ ${T.me.display_name || T.profile?.name || email}: ${code}` }).catch(() => {}); }
      if (act === 'sign-out') { if (await confirmBox('ออกจากระบบ?')) ui.signOut(); }
      if (act === 'mywork-map') { ui.setColor('assign'); ui.goTab('map'); ui.fitCodes(new Set(mine().map(a => a.code))); }
      if (act === 'people-map') { T.showPeople = true; ui.goTab('map'); ui.updateMarkers(); ui.fitPeople(T.locations); }
      if (act === 'sum-xlsx') await summaryXlsx();
      if (act === 'sum-day-clear') { SUM.day = ''; renderSummary(); }
      if (act === 'plan-calc') {
        const cand = candidates();
        PLAN.preview = planAssignments({ parcels: cand, count: Math.min(Number(PLAN.count) || cand.length, cand.length), members: PLAN.members, start: PLAN.start, end: PLAN.end, days: PLAN.days });
        renderPlan();
      }
      if (act === 'plan-preview-map') {
        const pv = PLAN.preview; if (!pv) return;
        ui.preview(new Map(pv.rows.map(r => [r.code, r])), x => [colorOf(x.email), nameOf(x.email)]);
        ui.goTab('map'); ui.fitCodes(new Set(pv.rows.map(r => r.code)));
        toast('สีบนแผนที่คือการแบ่งงานที่ยังไม่บันทึก กลับไปหน้าแผนงานเพื่อบันทึก');
      }
      if (act === 'plan-save') {
        const pv = PLAN.preview; if (!pv) return;
        const team = PLAN.team || T.me.team_id;
        if (!team) throw new Error('เลือกทีมก่อน');
        if (!(await confirmBox(`บันทึกแผนงาน <b>${esc(PLAN.name || 'แผนงานใหม่')}</b>?<br>${pv.total.toLocaleString()} แปลง · ${pv.members.length} คน · ${esc(thDay(PLAN.start))} – ${esc(thDay(PLAN.end))}<br><span class="muted">ลูกทีมจะเห็นงานของตัวเองในหน้า "งานของฉัน" ทันที</span>`, { ok: 'บันทึกแผนงาน' }))) return;
        const plan = { id: globalThis.crypto.randomUUID(), team_id: team, name: PLAN.name.trim() || `แผน ${thDay(PLAN.start)}`, start_date: PLAN.start, end_date: PLAN.end,
          workdays: PLAN.days, total: pv.total, members: PLAN.members, created_by: lc(email) };
        await cloud.upsertOn('llan_plans', [plan], 'id');
        await cloud.upsertOn('llan_assignments', pv.rows.map(r => ({ code: r.code, plan_id: plan.id, team_id: team, email: r.email, due: r.due })), 'code');
        Object.assign(PLAN, { preview: null, name: '', count: '' });
        ui.preview(null);
        await load(); ui.setColor('assign'); ui.refreshMap(); renderPlan();
        toast(`บันทึกแผนงานแล้ว ${pv.total.toLocaleString()} แปลง`);
      }
    })();
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (!el.closest('.page')) return;
    guard(async () => {
      if (el.id === 'showPeople') { T.showPeople = el.checked; ui.updateMarkers(); return; }
      if (el.dataset.sum) { SUM[el.dataset.sum] = el.value; SUM.day = ''; return renderSummary(); }
      if (el.dataset.mset) {
        const m = member(el.dataset.mset), k = el.dataset.k;
        await cloud.rpc('llan_member_set', { p_email: m.email, p_team_id: k === 'team' ? el.value : m.team_id || '', p_team_role: k === 'trole' ? el.value : m.team_role, p_role: k === 'role' ? el.value : m.role, p_name: m.display_name || '' });
        await load(); renderTeam(); return toast('บันทึกแล้ว');
      }
      if (el.dataset.plan) { PLAN[el.dataset.plan] = el.value; PLAN.preview = null; if (el.dataset.plan === 'team') PLAN.members = null; return renderPlan(); }
      if (el.dataset.day !== undefined && el.closest('.days')) { const d = Number(el.dataset.day); PLAN.days = el.checked ? [...new Set([...PLAN.days, d])].sort() : PLAN.days.filter(x => x !== d); PLAN.preview = null; return renderPlan(); }
      if (el.dataset.member) { PLAN.members = el.checked ? [...new Set([...PLAN.members, el.dataset.member])] : PLAN.members.filter(x => x !== el.dataset.member); PLAN.preview = null; return renderPlan(); }
    })();
  });
  document.addEventListener('submit', e => {
    if (e.target.id === 'addByCode') {
      e.preventDefault();
      const f = e.target;
      return guard(async () => {
        const [u] = await cloud.rpc('llan_add_by_code', { p_code: f.code.value.trim(), p_team_id: f.team.value, p_team_role: f.trole?.value || 'member', p_role: 'editor' });
        await load(); chips(); renderTeam(); ui.refreshMap();
        toast(`เพิ่ม ${u?.name || u?.email || 'ผู้ใช้'} เข้า${teamName(f.team.value)}แล้ว`);
      })();
    }
    if (e.target.id !== 'teamNew') return;
    e.preventDefault();
    guard(async () => {
      const f = e.target;
      const [tm] = await cloud.rpc('llan_team_save', { p_id: null, p_name: f.name.value, p_color: f.color.value });
      await load(); renderTeam();
      toast(`สร้าง ${tm.name} แล้ว รหัสเข้าร่วม ${tm.join_key}`);
    })();
  });

  // ---------- start / stop ----------
  await load();
  return {
    get on() { return T.on; }, get me() { return T.me; }, isLead, isAdmin, office,
    lockOf, assignInfo, logWork, styleOf, markers, onMarker, chips,
    lockForCodes: codes => codes.map(lockOf).find(Boolean) || null,
    render: { mywork: renderMyWork, team: renderTeam, summary: renderSummary, plan: renderPlan, profile: renderProfile },
    get inTeam() { return !!T.me.team_id; },
    start() {
      chips();
      if (!T.on) return;
      if (T.sharing) startSharing();
      loadLocations();
      T.timers.push(setInterval(() => { if (!document.hidden) loadLocations(); }, 20000));
      T.timers.push(setInterval(() => { if (!document.hidden) { if (T.pos && T.sent && Date.now() - T.sent.at > 60000) sendPos(true); load().then(() => { chips(); ui.updateMarkers(); }).catch(() => {}); } }, 60000));
      loadMineToday().then(chips);
      // Not in a team yet: look every few seconds; once a lead adds this person, reload with the team's data.
      if (!office && !T.me.team_id && !isAdmin()) T.timers.push(setInterval(async () => {
        const m = await cloud.me(email).catch(() => null);
        if (m?.team_id) { toast(`ได้รับการเพิ่มเข้า${teamName(m.team_id) || 'ทีม'}แล้ว กำลังโหลดงานของทีม…`); setTimeout(() => location.reload(), 900); }
      }, ui.teamPoll || 6000));
    },
    async refresh() { await load(); chips(); },
    stop() {
      for (const t of T.timers) clearInterval(t);
      T.timers = [];
      if (T.watch != null) navigator.geolocation.clearWatch(T.watch);
      T.watch = null;
      flushLog();
    },
  };
}
