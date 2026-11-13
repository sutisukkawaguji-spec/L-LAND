// A small in-memory stand-in for Supabase (Auth + PostgREST + the L-LAN SQL: stamps, deletion notes,
// llan_save merge, member roles). Tests only; never the real project.
import http from 'node:http';

export const SECRET = 'sb_secret_test';
export const PUBLISHABLE = 'sb_publishable_test';
export const PASSWORD = 'pass1234';
// Columns of tables whose rows the office builds itself (supabase/records.sql).
const COLUMNS = { llan_parcel_status: ['id', 'code', 'status', 'link', 'ltax', 'pending', 'reasons', 'info', 'rev', 'updated_at', 'updated_by'] };

export function fakeSupabase(members = { 'admin@test.local': 'admin', 'editor@test.local': 'editor', 'viewer@test.local': 'viewer' }, { teams = true } = {}) {
  const t = { llan_records: new Map(), llan_features: new Map(), llan_layers: new Map(), llan_deleted: new Map(), llan_change_log: new Map(), llan_config: new Map(), llan_feature_log: new Map(), llan_parcel_status: new Map(),
    llan_teams: new Map(), llan_locations: new Map(), llan_work_log: new Map(), llan_plans: new Map(), llan_assignments: new Map(), llan_user_codes: new Map() };
  // Team of each member (supabase/team.sql): email → { team_id, team_role, display_name }
  const info = new Map();
  // Personal user codes (table llan_user_codes, readable only with the secret key): email → { email, code, name, created_at }
  const codes = t.llan_user_codes;
  let keySeq = 0;
  const newKey = () => `KEY${String(++keySeq).padStart(2, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  let serial = 0, last = 0;
  const now = () => { let ms = Date.now(); if (ms <= last) ms = last + 1; last = ms; return new Date(ms).toISOString(); };
  const STAMPED = new Set(['llan_records', 'llan_features', 'llan_layers', 'llan_parcel_status']);
  const stamp = (table, old, row, email) => {
    if (!STAMPED.has(table)) return row;
    return { ...row, updated_at: now(), rev: old ? (old.rev || 1) + 1 : 1, updated_by: email || row.updated_by || null };
  };
  const state = { requests: 0, offline: false, files: new Map() };

  const server = http.createServer(async (req, res) => {
    state.requests++;
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type, range, prefer' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204);
    if (state.offline) { req.socket.destroy(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBytes = Buffer.concat(chunks);
    const isStorageUpload = url.pathname.startsWith('/storage/v1/object/') && req.method === 'POST';
    const body = !isStorageUpload && rawBytes.length ? JSON.parse(rawBytes.toString('utf8')) : null;
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const service = req.headers.apikey === SECRET;
    if (!service && req.headers.apikey !== PUBLISHABLE) return send(401, { message: 'Invalid API key' });

    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'refresh_token') return send(200, { access_token: `tok:${body.refresh_token.slice(4)}`, refresh_token: body.refresh_token, expires_in: 3600, user: { email: body.refresh_token.slice(4) } });
      return body.password === PASSWORD ? send(200, { access_token: `tok:${body.email}`, refresh_token: `ref:${body.email}`, expires_in: 3600, user: { email: body.email } })
        : send(400, { error_description: 'Invalid login credentials' });
    }
    if (url.pathname === '/auth/v1/user') return bearer.startsWith('tok:') ? send(200, { email: bearer.slice(4) }) : send(401, { msg: 'bad jwt' });

    const email = !service && bearer.startsWith('tok:') ? bearer.slice(4) : null;
    const role = service ? 'service' : email ? members[email] || null : null;
    const canWrite = role === 'service' || role === 'editor' || role === 'admin';
    const denied = () => send(403, { code: '42501', message: 'new row violates row-level security policy' });

    // Storage: the private photo bucket.
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const rest = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
      if (req.method === 'POST') {
        const p = rest.replace(/^llan-photos\//, '');
        if (!rest.startsWith('llan-photos/')) return send(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
        if (!canWrite) return send(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
        if (state.files.has(p)) return send(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        state.files.set(p, { type: req.headers['content-type'], bytes: rawBytes });
        return send(200, { Key: rest });
      }
      if (req.method === 'GET') {
        const p = rest.replace(/^(authenticated\/)?llan-photos\//, '');
        if (!role) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        const f = state.files.get(p);
        if (!f) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        res.writeHead(200, { 'Content-Type': f.type, 'Access-Control-Allow-Origin': '*' });
        return res.end(f.bytes);
      }
      if (req.method === 'DELETE') {
        if (!canWrite) return send(200, []);
        const gone = (body?.prefixes || []).filter(p => state.files.delete(p));
        return send(200, gone.map(name => ({ name })));
      }
    }
    const name = url.pathname.replace('/rest/v1/', '');

    if (name === 'rpc/llan_save') {
      if (!canWrite) return denied();
      const out = [];
      for (const it of body.items) {
        const old = t.llan_records.get(it.id);
        const data = { ...(old?.data || {}), ...(it.patch || {}) };
        for (const k of it.unset || []) delete data[k];
        const row = stamp('llan_records', old, { id: it.id, entity: it.entity, data, updated_by: it.by || null }, email);
        t.llan_records.set(it.id, row);
        out.push(row);
      }
      return send(200, out);
    }
    const myTeam = email ? info.get(email)?.team_id || null : null;
    const isLead = team => service || role === 'admin' || (!!team && myTeam === team && info.get(email)?.team_role === 'lead');
    const TEAM_TABLES = ['llan_teams', 'llan_locations', 'llan_work_log', 'llan_plans', 'llan_assignments'];
    if (!teams && (TEAM_TABLES.includes(name) || name.startsWith('rpc/llan_team') || ['rpc/llan_join_team', 'rpc/llan_member_set', 'rpc/llan_my_code', 'rpc/llan_add_by_code', 'rpc/llan_pending_users'].includes(name)))
      return send(404, { code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache` });
    const raise = (code, message) => send(400, { code, message });
    // The office (secret key) manages members directly.
    if (req.method === 'PATCH' && name === 'llan_members') {
      if (!service) return denied();
      const e = decodeURIComponent((url.searchParams.get('email') || '').replace(/^eq\./, '')).toLowerCase(), old = info.get(e) || {};
      if (body.role) members[e] = body.role;
      info.set(e, { team_id: 'team_id' in body ? body.team_id : old.team_id ?? null, team_role: body.team_role || old.team_role || 'member', display_name: body.display_name || old.display_name || null });
      return send(204);
    }
    if (req.method === 'POST' && name === 'llan_members') {
      if (!service) return denied();
      for (const r of Array.isArray(body) ? body : [body]) {
        const e = String(r.email).toLowerCase(), old = info.get(e) || {};
        if (r.role) members[e] = r.role; else if (!members[e]) members[e] = 'editor';
        info.set(e, { team_id: 'team_id' in r ? r.team_id : old.team_id ?? null, team_role: r.team_role || old.team_role || 'member', display_name: 'display_name' in r ? r.display_name : old.display_name ?? null });
      }
      return send(201);
    }
    if (name === 'llan_members') {
      const sel = url.searchParams.get('select') || '*';
      if (!teams && /team_id|team_role|display_name/.test(sel)) return send(400, { code: '42703', message: 'column llan_members.team_id does not exist' });
      const want = decodeURIComponent((url.searchParams.get('email') || '').replace(/^eq\./, ''));
      const row = e => ({ email: e, role: members[e], team_id: info.get(e)?.team_id || null, team_role: info.get(e)?.team_role || 'member', display_name: info.get(e)?.display_name || null });
      const visible = e => service || e === email || role === 'admin' || (myTeam && info.get(e)?.team_id === myTeam);
      const list = Object.keys(members).filter(e => (!want || e === want) && visible(e)).map(row);
      return send(200, sel === 'role' ? list.map(r => ({ role: r.role })) : list);
    }
    if (name === 'rpc/llan_join_team') {
      if (!email) return raise('P0001', 'กรุณาเข้าสู่ระบบก่อน');
      const team = [...t.llan_teams.values()].find(x => x.join_key.toUpperCase() === String(body.p_key || '').trim().toUpperCase());
      if (!team) return raise('22023', 'รหัสทีมไม่ถูกต้อง');
      if (!members[email]) members[email] = 'editor';
      const old = info.get(email);
      info.set(email, { team_id: team.id, team_role: old?.team_id === team.id ? old.team_role : 'member', display_name: String(body.p_name || '').trim() || old?.display_name || null });
      return send(200, [{ team_id: team.id, team_name: team.name, role: members[email], team_role: info.get(email).team_role }]);
    }
    if (name === 'rpc/llan_my_code') {
      if (!email) return raise('P0001', 'กรุณาเข้าสู่ระบบก่อน');
      if (!codes.has(email)) codes.set(email, { email, code: `U${String(codes.size + 1).padStart(3, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: String(body.p_name || '').trim() || null, created_at: now() });
      else if (String(body.p_name || '').trim()) codes.get(email).name = String(body.p_name).trim();
      return send(200, codes.get(email).code);
    }
    if (name === 'rpc/llan_add_by_code') {
      const hit = [...codes].find(([, c]) => c.code.toUpperCase() === String(body.p_code || '').trim().toUpperCase());
      if (!hit) return raise('22023', 'ไม่พบรหัสผู้ใช้นี้ ให้ผู้ใช้เปิดหน้าเว็บแล้วดูรหัสอีกครั้ง');
      if (!body.p_team_id) return raise('P0001', 'เลือกทีมก่อน');
      if (!isLead(body.p_team_id)) return raise('42501', 'เพิ่มสมาชิกได้เฉพาะผู้ดูแล หรือหัวหน้าของทีมนั้น');
      const admin = service || role === 'admin', [e, c] = hit, old = info.get(e);
      if (!admin && old?.team_id && old.team_id !== body.p_team_id) return raise('42501', 'ผู้ใช้นี้อยู่ในทีมอื่น ให้ผู้ดูแลเป็นผู้ย้ายทีม');
      if (!members[e]) members[e] = admin ? body.p_role || 'editor' : 'editor';
      else if (admin && body.p_role) members[e] = body.p_role;
      info.set(e, { team_id: body.p_team_id, team_role: admin ? body.p_team_role || 'member' : old?.team_role || 'member', display_name: old?.display_name || c.name });
      return send(200, [{ email: e, name: c.name }]);
    }
    if (name === 'rpc/llan_pending_users') {
      if (role !== 'admin') return send(200, []);
      return send(200, [...codes].filter(([e]) => !info.get(e)?.team_id).map(([e, c]) => ({ email: e, code: c.code, name: c.name, created_at: c.created_at })));
    }
    if (name === 'rpc/llan_team_save') {
      if (role !== 'admin') return raise('42501', 'เฉพาะผู้ดูแลระบบสร้างหรือแก้ทีมได้');
      const id = body.p_id || `team-${t.llan_teams.size + 1}`;
      const old = t.llan_teams.get(id);
      const row = { id, name: String(body.p_name).trim(), color: body.p_color || old?.color || '#2f80ed', join_key: old?.join_key || newKey(), created_at: old?.created_at || now(), created_by: email };
      t.llan_teams.set(id, row);
      return send(200, [row]);
    }
    if (name === 'rpc/llan_team_delete') { if (role !== 'admin') return raise('42501', 'เฉพาะผู้ดูแลระบบลบทีมได้'); t.llan_teams.delete(body.p_id); return send(200, null); }
    if (name === 'rpc/llan_team_keys') return send(200, [...t.llan_teams.values()].filter(x => isLead(x.id)).map(({ id, name: n, color, join_key }) => ({ id, name: n, color, join_key })));
    if (name === 'rpc/llan_team_new_key') {
      if (!isLead(body.p_id)) return raise('42501', 'เฉพาะผู้ดูแลหรือหัวหน้าทีมเปลี่ยนรหัสทีมได้');
      const tm = t.llan_teams.get(body.p_id); tm.join_key = newKey(); return send(200, tm.join_key);
    }
    if (name === 'rpc/llan_member_set') {
      if (role !== 'admin') return raise('42501', 'เฉพาะผู้ดูแลระบบจัดการสมาชิกได้');
      const e = String(body.p_email).toLowerCase(), old = info.get(e) || {};
      info.set(e, { team_id: body.p_team_id === '' ? null : body.p_team_id ?? old.team_id ?? null, team_role: body.p_team_role || old.team_role || 'member', display_name: body.p_name || old.display_name || null });
      if (body.p_role) members[e] = body.p_role;
      return send(200, null);
    }
    const table = t[name];
    if (!table) return send(404, { code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache` });

    const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'limit', 'on_conflict'].includes(k));
    const cmp = (a, b) => (/^\d{4}-\d\d-\d\dT/.test(String(b)) ? Date.parse(a) - Date.parse(b) : String(a).localeCompare(String(b)));
    const match = r => filters.every(([k, v]) => {
      if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
      if (v.startsWith('gt.')) return r[k] != null && cmp(r[k], v.slice(3)) > 0;
      if (v.startsWith('gte.')) return r[k] != null && cmp(r[k], v.slice(4)) >= 0;
      if (v.startsWith('lte.')) return r[k] != null && cmp(r[k], v.slice(4)) <= 0;
      if (v.startsWith('in.(')) return v.slice(4, -1).split(',').map(x => decodeURIComponent(x.replace(/^"|"$/g, ''))).includes(String(r[k]));
      return true;
    });

    // Row visibility of the team tables (as the policies in team.sql)
    const canSee = r => {
      if (name === 'llan_locations') return service || role === 'admin' || r.email === email || isLead(r.team_id);
      if (name === 'llan_work_log') return service || role === 'admin' || r.by_user === email || isLead(r.team_id);
      return true;
    };
    if (req.method === 'GET') {
      if (!role) return send(200, []);
      if (name === 'llan_config' && !service && !role) return send(200, []);
      if (name === 'llan_user_codes' && !service) return send(200, []);
      let rows = [...table.values()].filter(match).filter(canSee);
      if (name === 'llan_teams' && !service) rows = rows.map(({ join_key, ...r }) => r);
      const order = (url.searchParams.get('order') || 'id').split(',').map(o => o.split('.'));
      rows.sort((a, b) => { for (const [k, dir] of order) { const c = cmp(a[k] ?? '', b[k] ?? ''); if (c) return dir === 'desc' ? -c : c; } return 0; });
      if (url.searchParams.get('limit')) rows = rows.slice(0, Number(url.searchParams.get('limit')));
      const [from, to] = (req.headers.range || `0-${rows.length}`).split('-').map(Number);
      return send(200, rows.slice(from, to + 1));
    }
    if (req.method === 'POST' && name === 'llan_locations') {
      if (!role) return denied();
      const r = Array.isArray(body) ? body[0] : body;
      t.llan_locations.set(email, { ...r, email, team_id: myTeam, name: info.get(email)?.display_name || email, at: now() });
      return send(201);
    }
    if (req.method === 'POST' && name === 'llan_work_log') {
      if (!canWrite) return denied();
      for (const r of Array.isArray(body) ? body : [body]) { const id = ++serial; table.set(String(id), { ...r, id, by_user: email, team_id: myTeam, at: r.at && service ? r.at : now() }); }
      return send(201);
    }
    if (req.method === 'POST' && name === 'llan_teams') {
      if (!service) return denied();
      for (const r of Array.isArray(body) ? body : [body]) t.llan_teams.set(r.id, { ...(t.llan_teams.get(r.id) || { created_at: now() }), ...r });
      return send(201);
    }
    if (req.method === 'PATCH' && name === 'llan_teams') {
      if (!service) return denied();
      for (const r of t.llan_teams.values()) if (match(r)) Object.assign(r, body);
      return send(204);
    }
    if (req.method === 'DELETE' && name === 'llan_teams') {
      if (!service) return denied();
      for (const [k, r] of t.llan_teams) if (match(r)) { t.llan_teams.delete(k); for (const [e, i] of info) if (i.team_id === k) info.set(e, { ...i, team_id: null }); }
      return send(204);
    }
    if (req.method === 'POST' && (name === 'llan_plans' || name === 'llan_assignments')) {
      const list = Array.isArray(body) ? body : [body];
      const key = name === 'llan_plans' ? 'id' : 'code';
      for (const r of list) { const old = table.get(String(r[key])); if (!isLead(r.team_id) || (old && !isLead(old.team_id))) return denied(); }
      for (const r of list) table.set(String(r[key]), { ...(table.get(String(r[key])) || {}), ...r });
      return send(201);
    }
    if (req.method === 'DELETE' && (name === 'llan_plans' || name === 'llan_assignments')) {
      const gone = [...table.values()].filter(match);
      if (gone.some(r => !isLead(r.team_id))) return denied();
      for (const r of gone) {
        table.delete(String(name === 'llan_plans' ? r.id : r.code));
        if (name === 'llan_plans') for (const [k, a] of t.llan_assignments) if (a.plan_id === r.id) t.llan_assignments.delete(k);
      }
      return send(204);
    }
    if (req.method === 'POST') {
      if (['llan_config', 'llan_parcel_status'].includes(name) ? !service : !canWrite) return denied();
      const cols = COLUMNS[name];
      const extra = cols && (Array.isArray(body) ? body : [body]).flatMap(r => Object.keys(r)).find(k => !cols.includes(k));
      if (extra) return send(400, { code: 'PGRST204', message: `Could not find the '${extra}' column of '${name}' in the schema cache` });
      for (const r of Array.isArray(body) ? body : [body]) {
        if (name === 'llan_change_log' || name === 'llan_feature_log') { const id = ++serial; table.set(String(id), { id, at: r.at || now(), ...r }); continue; }
        const key = name === 'llan_config' ? r.key : String(r.id);
        const old = table.get(key);
        table.set(key, stamp(name, old, { ...(old || {}), ...r }, email));
      }
      return send(201);
    }
    if (req.method === 'DELETE') {
      if (!canWrite) return denied();
      for (const [k, r] of table) if (match(r)) {
        table.delete(k);
        if (STAMPED.has(name)) { const id = ++serial; t.llan_deleted.set(String(id), { id, tbl: name, row_id: String(r.id), by_user: email, at: now() }); }
        if (name === 'llan_layers') for (const [fk, f] of t.llan_features) if (f.layer_id === r.id) { t.llan_features.delete(fk); const id = ++serial; t.llan_deleted.set(String(id), { id, tbl: 'llan_features', row_id: String(f.id), by_user: email, at: now() }); }
      }
      return send(204);
    }
    send(405, { message: 'method' });
  });
  return { server, t, state, members, info, codes };
}

export const listen = (srv, host = '127.0.0.1') => new Promise(r => srv.listen(0, host, () => r(`http://${host}:${srv.address().port}`)));
