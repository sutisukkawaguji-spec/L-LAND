// Shapes in Supabase (PostgREST over fetch, no packages). Personal attributes never leave the machine:
// owner names, ID numbers, addresses and phone numbers are stripped before anything is sent.

const SENSITIVE = /own|owner|name|fname|lname|id_?card|psn|citizen|person|tel|phone|mobile|e_?mail|addr|birth|tax_?id/i;
export const isSensitiveField = name => SENSITIVE.test(String(name));
export const cleanAttrs = attrs => Object.fromEntries(Object.entries(attrs || {}).filter(([k]) => !isSensitiveField(k)));
export const cleanFields = fields => (fields || []).filter(f => !isSensitiveField(f.name));

const BATCH = 400;

export class Cloud {
  constructor(cfg = {}) {
    this.url = String(cfg.url || '').replace(/\/$/, '');
    this.key = cfg.key || '';
  }
  get configured() { return !!(this.url && this.key); }

  async #req(method, path, { body, prefer, range } = {}) {
    if (!this.configured) throw new Error('ยังไม่ได้ตั้งค่า Supabase (URL และ secret key)');
    const headers = { apikey: this.key, 'Content-Type': 'application/json' };
    // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys only need apikey.
    if (this.key.startsWith('eyJ')) headers.Authorization = `Bearer ${this.key}`;
    if (prefer) headers.Prefer = prefer;
    if (range) headers.Range = range;
    const res = await fetch(`${this.url}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = data?.message || data?.error || text || res.statusText;
      const err = new Error(/does not exist|42P01|PGRST205/.test(`${data?.code} ${msg}`) ? 'ยังไม่ได้สร้างตารางใน Supabase (รัน supabase/schema.sql ใน SQL Editor ก่อน)' : `Supabase: ${msg}`);
      err.status = res.status; err.code = data?.code;
      throw err;
    }
    return data;
  }

  async status() {
    const rows = await this.#req('GET', 'llan_layers?select=id,name,kind,count');
    return { ok: true, layers: rows.length, features: rows.reduce((s, l) => s + (l.count || 0), 0) };
  }

  static layerRow(l) {
    return { id: l.id, name: l.name, kind: l.kind, crs: l.crs, code_field: l.codeField || null, geometry_type: l.geometryType || null,
      fields: cleanFields(l.fields), count: l.count || 0, updated_at: new Date().toISOString() };
  }
  static featureRow(f, by) {
    return { id: f.id, layer_id: f.layerId, kind: f.kind, fid: f.fid ?? null, code: f.code || null, geojson: f.geometry, area_m2: f.areaM2 ?? null,
      attrs: cleanAttrs(f.attrs), drawn: !!f.drawn, reshaped: !!f.reshaped, updated_at: new Date().toISOString(), updated_by: by || null };
  }
  static fromLayerRow(r) {
    return { id: r.id, name: r.name, kind: r.kind, crs: r.crs, codeField: r.code_field || '', geometryType: r.geometry_type || 'Polygon',
      fields: r.fields || [], count: r.count || 0, importedAt: r.updated_at, encoding: 'utf-8', prj: '', fromCloud: true };
  }
  static fromFeatureRow(r) {
    return { id: r.id, layerId: r.layer_id, kind: r.kind, fid: r.fid, code: r.code || '', geometry: r.geojson, areaM2: Number(r.area_m2) || 0,
      attrs: r.attrs || {}, drawn: r.drawn, reshaped: r.reshaped };
  }

  upsertLayer(l) { return this.#req('POST', 'llan_layers?on_conflict=id', { body: [Cloud.layerRow(l)], prefer: 'resolution=merge-duplicates,return=minimal' }); }
  deleteLayer(id) { return this.#req('DELETE', `llan_layers?id=eq.${encodeURIComponent(id)}`); }

  async upsertFeatures(features, by) {
    for (let i = 0; i < features.length; i += BATCH)
      await this.#req('POST', 'llan_features?on_conflict=id', { body: features.slice(i, i + BATCH).map(f => Cloud.featureRow(f, by)), prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  deleteFeature(id) { return this.#req('DELETE', `llan_features?id=eq.${encodeURIComponent(id)}`); }
  deleteLayerFeatures(layerId) { return this.#req('DELETE', `llan_features?layer_id=eq.${encodeURIComponent(layerId)}`); }
  log(entry) { return this.#req('POST', 'llan_feature_log', { body: [entry], prefer: 'return=minimal' }); }

  async #all(table, select) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await this.#req('GET', `${table}?select=${select}&order=id`, { range: `${from}-${from + 999}` });
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
}
