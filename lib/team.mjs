// Field survey teams: work plans split among the members, daily summaries, and which parcels a person may
// change (a parcel given to, or surveyed by, another team is locked). Browser-safe, no I/O.

// Thai calendar day (UTC+7, no daylight saving) of a moment.
const BKK = 7 * 3600 * 1000;
export const dayOf = iso => new Date(Date.parse(iso) + BKK).toISOString().slice(0, 10);
export const todayTh = (now = Date.now()) => new Date(now + BKK).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const weekday = day => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
export const WEEKDAY_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
export const DONE_STATES = new Set(['ready', 'done']);

// Working days from start to end (inclusive). days: weekdays worked, 0 = Sunday … 6 = Saturday.
export function workdays(start, end, days = [1, 2, 3, 4, 5, 6]) {
  const out = [];
  if (!/^\d{4}-\d\d-\d\d$/.test(start || '') || !/^\d{4}-\d\d-\d\d$/.test(end || '')) return out;
  for (let d = start; d <= end && out.length < 1000; d = addDays(d, 1)) if (days.includes(weekday(d))) out.push(d);
  return out;
}

// Hilbert-curve order: parcels next to each other in the list are next to each other on the ground, so
// cutting the list into pieces gives every member one compact area.
function hilbert(x, y, n = 1 << 16) {
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } [x, y] = [y, x]; }
  }
  return d;
}
export function spatialOrder(items) {
  if (items.length < 2) return [...items];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x); y1 = Math.max(y1, it.y); }
  const span = Math.max(x1 - x0, y1 - y0) || 1, k = 65535 / span;
  return items.map(it => ({ it, h: hilbert(Math.round((it.x - x0) * k), Math.round((it.y - y0) * k)) }))
    .sort((a, b) => a.h - b.h || String(a.it.code).localeCompare(String(b.it.code))).map(o => o.it);
}

// The lead gives `count` parcels to `members` between start and end. Each member gets one compact area
// of about the same size, worked through day by day.
// parcels: [{ code, x, y }] → { dates, total, perDayTeam, members: [{ email, codes, perDay, first, last }], rows: [{ code, email, due }] }
export function planAssignments({ parcels, count, members, start, end, days }) {
  if (!members?.length) throw new Error('เลือกลูกทีมอย่างน้อย 1 คน');
  if (!start || !end || end < start) throw new Error('วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด');
  const dates = workdays(start, end, days);
  if (!dates.length) throw new Error('ไม่มีวันทำงานในช่วงวันที่ที่เลือก');
  const n = Math.max(0, Math.min(Number.isFinite(count) ? count : parcels.length, parcels.length));
  if (!n) throw new Error('ไม่มีแปลงให้มอบหมาย');
  const take = spatialOrder(parcels).slice(0, n);
  const base = Math.floor(n / members.length), extra = n % members.length;
  const out = [], rows = [];
  let i = 0;
  members.forEach((email, k) => {
    const size = base + (k < extra ? 1 : 0);
    const codes = take.slice(i, i + size).map(p => p.code);
    i += size;
    const perDay = Math.max(1, Math.ceil(codes.length / dates.length));
    codes.forEach((code, j) => rows.push({ code, email, due: dates[Math.min(dates.length - 1, Math.floor(j / perDay))] }));
    const mine = rows.filter(r => r.email === email);
    out.push({ email, codes, perDay: codes.length ? perDay : 0, first: mine[0]?.due || null, last: mine.at(-1)?.due || null });
  });
  return { dates, total: n, perDayTeam: Math.ceil(n / dates.length), members: out, rows };
}

// ---------- locks ----------
// The team a parcel belongs to: its assignment, else the team that marked its survey.
export function parcelTeam(code, { assignments, surveys }) {
  return assignments?.get(code)?.team_id || surveys?.get(code)?.team || null;
}
// null when `me` may change the parcel; else why not. Admins may change everything.
export function lockOf(code, { me, assignments, surveys, teamName = () => '' }) {
  if (!code || !me || me.role === 'admin') return null;
  const team = parcelTeam(code, { assignments, surveys });
  if (!team || team === me.team_id) return null;
  const given = assignments?.get(code)?.team_id === team;
  return { team, name: teamName(team) || 'ทีมอื่น', reason: given ? `มอบหมายให้${teamName(team) || 'ทีมอื่น'}แล้ว` : `${teamName(team) || 'ทีมอื่น'}สำรวจแปลงนี้แล้ว` };
}

// ---------- daily summaries ----------
const KIND = r => (r.action === 'survey' ? (r.state === 'done' ? 'done' : r.state === 'revisit' ? 'revisit' : r.state ? 'draft' : 'clear') : r.action === 'photo' ? 'photo' : 'edit');
// rows: llan_work_log rows { at, by_user, team_id, code, action, state }. Survey sign-offs are counted once
// per parcel per person per day; a whole range counts each parcel once per person.
export function summarize(rows, { from, to, person, team } = {}) {
  const days = new Map(), people = new Map(), latest = new Map();
  const dayRow = d => { if (!days.has(d)) days.set(d, { day: d, done: new Set(), revisit: new Set(), draft: new Set(), edit: 0, photo: 0, people: new Set() }); return days.get(d); };
  const personRow = p => { if (!people.has(p.email)) people.set(p.email, { email: p.email, team_id: p.team_id, done: new Set(), revisit: new Set(), draft: new Set(), edit: 0, photo: 0, days: new Set(), last: null }); return people.get(p.email); };
  for (const r of rows) {
    const day = dayOf(r.at);
    if ((from && day < from) || (to && day > to) || (person && r.by_user !== person) || (team && r.team_id !== team)) continue;
    const kind = KIND(r), d = dayRow(day), p = personRow({ email: r.by_user || '-', team_id: r.team_id });
    d.people.add(p.email); p.days.add(day);
    if (!p.last || r.at > p.last) p.last = r.at;
    if (kind === 'done' || kind === 'revisit' || kind === 'draft') {
      d[kind].add(`${p.email}|${r.code}`); p[kind].add(r.code);
      const prev = latest.get(r.code);
      if (!prev || r.at > prev.at) latest.set(r.code, { code: r.code, at: r.at, day, by: p.email, team_id: r.team_id, state: kind });
    } else if (kind === 'edit' || kind === 'photo') { d[kind]++; p[kind]++; }
  }
  const count = s => s.size;
  const dayList = [...days.values()].sort((a, b) => b.day.localeCompare(a.day))
    .map(d => ({ day: d.day, done: count(d.done), revisit: count(d.revisit), draft: count(d.draft), edit: d.edit, photo: d.photo, people: d.people.size }));
  const personList = [...people.values()].map(p => ({ email: p.email, team_id: p.team_id, done: count(p.done), revisit: count(p.revisit), draft: count(p.draft),
    edit: p.edit, photo: p.photo, days: p.days.size, last: p.last })).sort((a, b) => b.done - a.done || a.email.localeCompare(b.email));
  const parcels = [...latest.values()].sort((a, b) => b.at.localeCompare(a.at));
  const total = { done: parcels.filter(p => p.state === 'done').length, revisit: parcels.filter(p => p.state === 'revisit').length,
    edit: personList.reduce((s, p) => s + p.edit, 0), photo: personList.reduce((s, p) => s + p.photo, 0), people: personList.length };
  return { days: dayList, people: personList, parcels, total };
}

// Progress of the parcels given out. state(code) → survey state of the parcel (or null).
export function progress(assignments, state, { today = todayTh(), email, team } = {}) {
  const out = { total: 0, done: 0, revisit: 0, remaining: 0, dueToday: 0, overdue: 0, byMember: new Map() };
  for (const a of assignments) {
    if ((email && a.email !== email) || (team && a.team_id !== team)) continue;
    const st = state(a.code), done = DONE_STATES.has(st);
    const m = out.byMember.get(a.email) || { email: a.email, total: 0, done: 0, revisit: 0, dueToday: 0, overdue: 0 };
    out.total++; m.total++;
    if (done) { out.done++; m.done++; }
    else {
      out.remaining++;
      if (st === 'revisit') { out.revisit++; m.revisit++; }
      if (a.due === today) { out.dueToday++; m.dueToday++; }
      if (a.due && a.due < today) { out.overdue++; m.overdue++; }
    }
    out.byMember.set(a.email, m);
  }
  out.pct = out.total ? Math.round(out.done / out.total * 1000) / 10 : 0;
  return out;
}
