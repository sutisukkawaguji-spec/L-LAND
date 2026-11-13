// Supabase over fetch (PostgREST, no packages). Works in Node (office machine, secret key) and in the
// browser (web page: publishable key + the member's sign-in token).
// Everything (shapes with all their .shp columns, the register with owners' details, parcel statuses) is
// readable only by members listed in llan_members (row-level security); the user chose this on 2026-11-10.

const BATCH = 400;

export class Cloud {
  constructor(cfg = {}) {
    this.url = String(cfg.url || '').replace(/\/$/, '');
    this.key = cfg.key || '';
    this.token = cfg.token || null; // a member's access token, or an async function returning one
  }
  get configured() { return !!(this.url && this.key); }

  async #req(method, path, { body, prefer, range } = {}) {
    if (!this.configured) throw new Error('ยังไม่ได้ตั้งค่า Supabase (URL และ secret key)');
    const headers = { apikey: this.key, 'Content-Type': 'application/json' };
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys only need apikey.
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (this.key.startsWith('eyJ')) headers.Authorization = `Bearer ${this.key}`;
    if (prefer) headers.Prefer = prefer;
    if (range) headers.Range = range;
    let res;
    try { res = await fetch(`${this.url}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (err) { throw Object.assign(new Error(`ติดต่อ Supabase ไม่ได้ (ตรวจอินเทอร์เน็ต): ${err.message}`), { offline: true }); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!res.ok) {
      const msg = data?.message || data?.error || text || res.statusText;
      const what = `${data?.code} ${msg}`;
      // Messages our own SQL functions raise are already in Thai.
      const err = new Error(/[฀-๿]/.test(msg) ? msg
        : /does not exist|42P01|42883|42703|PGRST205|PGRST202|PGRST204/.test(what) ? 'ยังไม่ได้สร้างตารางใน Supabase (ที่เครื่องสำนักงาน: ตั้งค่า → "คัดลอก SQL" แล้วรันใน SQL Editor)'
        : /row-level security|42501/.test(what) ? 'บัญชีนี้ไม่มีสิทธิ์แก้ไขข้อมูล' : `Supabase: ${msg}`);
      err.status = res.status; err.code = data?.code;
      throw err;
    }
    return data;
  }

  // ---------- photos (Supabase Storage, private bucket llan-photos: members see, editors add/remove) ----------
  async #storage(method, path, { body, type } = {}) {
    if (!this.configured) throw new Error('ยังไม่ได้ตั้งค่า Supabase (URL และ key)');
    const headers = { apikey: this.key };
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (this.key.startsWith('eyJ')) headers.Authorization = `Bearer ${this.key}`;
    if (type) headers['Content-Type'] = type;
    let res;
    try { res = await fetch(`${this.url}/storage/v1/${path}`, { method, headers, body }); }
    catch (err) { throw Object.assign(new Error(`ติดต่อ Supabase ไม่ได้ (ตรวจอินเทอร์เน็ต): ${err.message}`), { offline: true }); }
    if (!res.ok) {
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { message: text }; }
      const msg = data?.message || data?.error || text || res.statusText;
      const err = new Error(/bucket not found/i.test(msg) ? 'ยังไม่มีที่เก็บรูปใน Supabase (ที่เครื่องสำนักงาน: ตั้งค่า → "คัดลอก SQL" แล้วรันใน SQL Editor อีกครั้ง)'
        : /row-level security|unauthorized|403/i.test(`${msg} ${res.status}`) ? 'บัญชีนี้ไม่มีสิทธิ์เพิ่มหรือลบรูป' : res.status === 404 ? 'ไม่พบไฟล์รูป' : `Supabase: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }
  static PHOTO_BUCKET = 'llan-photos';
  static photoPath = p => String(p).split('/').map(encodeURIComponent).join('/');
  async uploadPhoto(path, bytes, type = 'image/jpeg') {
    await this.#storage('POST', `object/${Cloud.PHOTO_BUCKET}/${Cloud.photoPath(path)}`, { body: bytes, type });
    return path;
  }
  async photo(path) {
    const res = await this.#storage('GET', `object/authenticated/${Cloud.PHOTO_BUCKET}/${Cloud.photoPath(path)}`);
    return { type: res.headers.get('content-type') || 'image/jpeg', bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  async removePhotos(paths) {
    if (paths.length) await this.#storage('DELETE', `object/${Cloud.PHOTO_BUCKET}`, { body: JSON.stringify({ prefixes: paths }), type: 'application/json' });
  }

  async status() {
    const rows = await this.#req('GET', 'llan_layers?select=id,name,kind,count');
    return { ok: true, layers: rows.length, features: rows.reduce((s, l) => s + (l.count || 0), 0) };
  }

  static layerRow(l) {
    return { id: l.id, name: l.name, kind: l.kind, crs: l.crs, code_field: l.codeField || null, geometry_type: l.geometryType || null,
      fields: l.fields || [], count: l.count || 0, updated_at: new Date().toISOString() };
  }
  static featureRow(f, by) {
    return { id: f.id, layer_id: f.layerId, kind: f.kind, fid: f.fid ?? null, code: f.code || null, geojson: f.geometry, area_m2: f.areaM2 ?? null,
      attrs: f.attrs || {}, drawn: !!f.drawn, reshaped: !!f.reshaped, updated_at: new Date().toISOString(), updated_by: by || null };
  }
  static fromLayerRow(r) {
    return { id: r.id, name: r.name, kind: r.kind, crs: r.crs, codeField: r.code_field || '', geometryType: r.geometry_type || 'Polygon',
      fields: r.fields || [], count: r.count || 0, importedAt: r.updated_at, encoding: 'utf-8', prj: '', fromCloud: true };
  }
  static fromFeatureRow(r) {
    return { id: r.id, layerId: r.layer_id, kind: r.kind, fid: r.fid, code: r.code || '', geometry: r.geojson, areaM2: Number(r.area_m2) || 0,
      attrs: r.attrs || {}, drawn: r.drawn, reshaped: r.reshaped };
  }
  static FEATURE_COLUMNS = 'id,layer_id,kind,fid,code,geojson,area_m2,attrs,drawn,reshaped,updated_at,updated_by';

  upsertLayer(l) { return this.#req('POST', 'llan_layers?on_conflict=id', { body: [Cloud.layerRow(l)], prefer: 'resolution=merge-duplicates,return=minimal' }); }
  deleteLayer(id) { return this.#req('DELETE', `llan_layers?id=eq.${encodeURIComponent(id)}`); }

  async upsertFeatures(features, by) {
    for (let i = 0; i < features.length; i += BATCH)
      await this.#req('POST', 'llan_features?on_conflict=id', { body: features.slice(i, i + BATCH).map(f => Cloud.featureRow(f, by)), prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  deleteFeature(id) { return this.#req('DELETE', `llan_features?id=eq.${encodeURIComponent(id)}`); }
  deleteLayerFeatures(layerId) { return this.#req('DELETE', `llan_features?layer_id=eq.${encodeURIComponent(layerId)}`); }
  log(entry) { return this.#req('POST', 'llan_feature_log', { body: [entry], prefer: 'return=minimal' }); }

  async #all(table, select, filter = '', order = 'id') {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await this.#req('GET', `${table}?select=${select}${filter}&order=${order}`, { range: `${from}-${from + 999}` });
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }

  // Everything in the cloud, as L-LAN layers and features.
  async pullAll() {
    const layers = (await this.#all('llan_layers', '*')).map(Cloud.fromLayerRow);
    const features = (await this.#all('llan_features', 'id,layer_id,kind,fid,code,geojson,area_m2,attrs,drawn,reshaped')).map(Cloud.fromFeatureRow);
    return { layers, features };
  }

  // Upload every local layer and feature (personal attributes removed).
  async pushAll(layers, features, by) {
    for (const l of layers) await this.upsertLayer({ ...l, count: features.filter(f => f.layerId === l.id).length });
    await this.upsertFeatures(features, by);
    return { layers: layers.length, features: features.length };
  }

  // ---------- register (llan_records) ----------
  // items: [{ entity, id, patch, unset }] → the merged rows { id, entity, data, rev, updated_at, updated_by }.
  async saveRecords(items, by) {
    const out = [];
    for (let i = 0; i < items.length; i += 200)
      out.push(...(await this.#req('POST', 'rpc/llan_save', { body: { items: items.slice(i, i + 200).map(x => ({ ...x, by: by || null })) } })));
    return out;
  }
  allRecords() { return this.#all('llan_records', 'id,entity,data,rev,updated_at,updated_by'); }
  async deleteRows(table, ids) {
    for (let i = 0; i < ids.length; i += 100)
      await this.#req('DELETE', `${table}?id=in.(${ids.slice(i, i + 100).map(id => `"${encodeURIComponent(String(id))}"`).join(',')})`);
  }
  // Rows written after a moment (database clock), oldest first. No moment = all rows.
  changedSince(table, since, select = '*') {
    return this.#all(table, select, since ? `&updated_at=gt.${encodeURIComponent(since)}` : '', 'updated_at.asc,id.asc');
  }
  deletedSince(since) {
    return this.#all('llan_deleted', 'id,tbl,row_id,by_user,at', since ? `&at=gt.${encodeURIComponent(since)}` : '', 'at.asc,id.asc');
  }
  // Rows of a table keyed by id (e.g. llan_parcel_status), in batches.
  async upsertRows(table, rows) {
    for (let i = 0; i < rows.length; i += 500)
      await this.#req('POST', `${table}?on_conflict=id`, { body: rows.slice(i, i + 500), prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  async insertLog(entries) {
    for (let i = 0; i < entries.length; i += 300) await this.#req('POST', 'llan_change_log', { body: entries.slice(i, i + 300), prefer: 'return=minimal' });
  }
  readLog({ limit = 300, recordId } = {}) {
    return this.#req('GET', `llan_change_log?select=*&order=at.desc&limit=${Number(limit) || 300}${recordId ? `&record_id=eq.${encodeURIComponent(recordId)}` : ''}`);
  }
  // Small key/value settings the web page reads (llan_config).
  setConfig(key, value) { return this.#req('POST', 'llan_config?on_conflict=key', { body: [{ key, value, updated_at: new Date().toISOString() }], prefer: 'resolution=merge-duplicates,return=minimal' }); }
  async getConfig(key) { return (await this.#req('GET', `llan_config?select=value&key=eq.${encodeURIComponent(key)}`))[0]?.value ?? null; }
  async myRole(email) { return (await this.#req('GET', `llan_members?select=role&email=eq.${encodeURIComponent(email)}`))[0]?.role || null; }

  // ---------- survey teams (supabase/team.sql) ----------
  rpc(name, args = {}) { return this.#req('POST', `rpc/${name}`, { body: args }); }
  get(path) { return this.#req('GET', path); }
  // All rows of a query, page by page.
  getAll(table, select, filter = '', order = 'id.asc') { return this.#all(table, select, filter, order); }
  async upsertOn(table, rows, conflict) {
    for (let i = 0; i < rows.length; i += 500)
      await this.#req('POST', `${table}?on_conflict=${conflict}`, { body: rows.slice(i, i + 500), prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  async insertRows(table, rows) { if (rows.length) await this.#req('POST', table, { body: rows, prefer: 'return=minimal' }); }
  async patch(table, filter, body) { await this.#req('PATCH', `${table}?${filter}`, { body, prefer: 'return=minimal' }); }
  async deleteWhere(table, filter) { await this.#req('DELETE', `${table}?${filter}`); }
  // The signed-in member with team, or null. teams: false when the team tables are not made yet.
  async me(email) {
    try {
      const [m] = await this.#req('GET', `llan_members?select=email,role,team_id,team_role,display_name&email=eq.${encodeURIComponent(email)}`);
      return m ? { ...m, teams: true } : { email, role: null, teams: true };
    } catch (err) {
      if (!['42703', 'PGRST204', 'PGRST100'].includes(err.code) && !/ยังไม่ได้สร้างตาราง/.test(err.message)) throw err;
      const role = await this.myRole(email);
      return { email, role, teams: false };
    }
  }
}

// What changed between two versions of a record: keys whose value differs (JSON comparison).
export function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
}
// A patch for llan_save: the new values of the given keys, and the keys that are now gone.
export function patchOf(rec, keys) {
  const patch = {}, unset = [];
  for (const k of keys) {
    if (k === 'pending' || k === 'pendingCount') continue;
    if (rec[k] === undefined) unset.push(k); else patch[k] = rec[k];
  }
  return { patch, unset };
}
// Same record content? (ignores when it was saved)
export function sameRecord(a, b) {
  if (!a || !b) return false;
  const { updatedAt: _a, ...x } = a, { updatedAt: _b, ...y } = b;
  return changedKeys(x, y).length === 0;
}
// Same shape? (geometry, code, flags and attributes)
export function sameFeature(local, row) {
  return !!local && local.layerId === row.layerId && (local.code || '') === (row.code || '') && local.kind === row.kind
    && JSON.stringify(local.geometry) === JSON.stringify(row.geometry) && !!local.drawn === !!row.drawn && !!local.reshaped === !!row.reshaped
    && changedKeys(local.attrs || {}, row.attrs || {}).length === 0;
}
