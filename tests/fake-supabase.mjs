// A small in-memory stand-in for Supabase (Auth + PostgREST + the L-LAN SQL: stamps, deletion notes,
// llan_save merge, member roles). Tests only; never the real project.
import http from 'node:http';

export const SECRET = 'sb_secret_test';
export const PUBLISHABLE = 'sb_publishable_test';
export const PASSWORD = 'pass1234';
// Columns of tables whose rows the office builds itself (supabase/records.sql).
const COLUMNS = { llan_parcel_status: ['id', 'code', 'status', 'link', 'ltax', 'pending', 'reasons', 'info', 'rev', 'updated_at', 'updated_by'] };

export function fakeSupabase(members = { 'admin@test.local': 'admin', 'editor@test.local': 'editor', 'viewer@test.local': 'viewer' }) {
  const t = { llan_records: new Map(), llan_features: new Map(), llan_layers: new Map(), llan_deleted: new Map(), llan_change_log: new Map(), llan_config: new Map(), llan_feature_log: new Map(), llan_parcel_status: new Map() };
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
    if (name === 'llan_members') {
      const want = decodeURIComponent((url.searchParams.get('email') || '').replace(/^eq\./, ''));
      const visible = service || want === email || role === 'admin';
      return send(200, visible && members[want] ? [{ role: members[want] }] : []);
    }
    const table = t[name];
    if (!table) return send(404, { code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache` });

    const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'limit', 'on_conflict'].includes(k));
    const cmp = (a, b) => (/^\d{4}-\d\d-\d\dT/.test(String(b)) ? Date.parse(a) - Date.parse(b) : String(a).localeCompare(String(b)));
    const match = r => filters.every(([k, v]) => {
      if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
      if (v.startsWith('gt.')) return r[k] != null && cmp(r[k], v.slice(3)) > 0;
      if (v.startsWith('in.(')) return v.slice(4, -1).split(',').map(x => decodeURIComponent(x.replace(/^"|"$/g, ''))).includes(String(r[k]));
      return true;
    });

    if (req.method === 'GET') {
      if (!role) return send(200, []);
      if (name === 'llan_config' && !service && !role) return send(200, []);
      let rows = [...table.values()].filter(match);
      const order = (url.searchParams.get('order') || 'id').split(',').map(o => o.split('.'));
      rows.sort((a, b) => { for (const [k, dir] of order) { const c = cmp(a[k] ?? '', b[k] ?? ''); if (c) return dir === 'desc' ? -c : c; } return 0; });
      if (url.searchParams.get('limit')) rows = rows.slice(0, Number(url.searchParams.get('limit')));
      const [from, to] = (req.headers.range || `0-${rows.length}`).split('-').map(Number);
      return send(200, rows.slice(from, to + 1));
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
  return { server, t, state, members };
}

export const listen = (srv, host = '127.0.0.1') => new Promise(r => srv.listen(0, host, () => r(`http://${host}:${srv.address().port}`)));
