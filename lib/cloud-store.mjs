// The web page's data store: the register and shapes in Supabase, held in memory while the page is open.
// Same interface as the office Store (list/get/upsert/remove/replaceAll/readLog), so the shared API in
// core-api.mjs runs unchanged in the browser. Every write goes straight to Supabase; register records are
// saved field by field (llan_save), so edits by different people to different fields all survive.
import { Cloud, changedKeys, patchOf, sameRecord, sameFeature } from './cloud.mjs';
import { bboxOf } from '../public/shared/proj.mjs';

export const RECORD_SETS = ['owners', 'lands', 'buildings', 'signboards', 'deletions'];
const COLLECTIONS = [...RECORD_SETS, 'features', 'layers', 'jobs', 'checks', 'pushes', 'statuses'];
const UNLOGGED = new Set(['jobs', 'checks', 'pushes']);
const TABLE = { features: 'llan_features', layers: 'llan_layers', ...Object.fromEntries(RECORD_SETS.map(c => [c, 'llan_records'])) };
const OVERLAP_MS = 5 * 60 * 1000;
const back = iso => (iso ? new Date(Date.parse(iso) - OVERLAP_MS).toISOString() : null);
const later = (a, b) => (!a || (b && Date.parse(b) > Date.parse(a)) ? b : a);
const strip = rec => { if (!rec) return null; const { geometry, synced, ...rest } = rec; return rest; };
// Parcel statuses are written by the office only; the page just reads them.
const statusOf = r => ({ id: r.id, code: r.code || '', status: r.status, link: r.link, ltax: r.ltax, pending: r.pending, survey: r.info?.survey?.state || null, reasons: r.reasons || [], info: r.info || {}, updatedAt: r.updated_at });
const featureOf = row => { const f = Cloud.fromFeatureRow(row); return { ...f, bbox: bboxOf(f.geometry), updatedAt: row.updated_at }; };

export class CloudStore {
  constructor(cloud, { email }) {
    this.cloud = cloud;
    this.email = email;
    this.data = Object.fromEntries(COLLECTIONS.map(c => [c, []]));
    this.settings = {};
    this.cursor = {};
    this.logging = Promise.resolve();
  }

  async open() {
    const c = this.cloud;
    const [rows, layers, features, settings, statuses, checked] = await Promise.all([
      c.changedSince('llan_records', null, 'id,entity,data,updated_at'), c.changedSince('llan_layers', null),
      c.changedSince('llan_features', null, Cloud.FEATURE_COLUMNS), c.getConfig('settings').catch(() => null),
      c.changedSince('llan_parcel_status', null).catch(() => []), c.getConfig('status_checked').catch(() => null)]);
    this.data.statuses = statuses.map(statusOf);
    for (const r of statuses) this.cursor.statuses = later(this.cursor.statuses, r.updated_at);
    this.statusCheckedAt = checked;
    for (const r of rows) if (this.data[r.entity]) { this.data[r.entity].push({ ...r.data, id: r.id }); this.cursor.records = later(this.cursor.records, r.updated_at); }
    this.data.layers = layers.map(Cloud.fromLayerRow);
    for (const l of layers) this.cursor.layers = later(this.cursor.layers, l.updated_at);
    this.data.features = features.map(featureOf);
    for (const f of features) this.cursor.features = later(this.cursor.features, f.updated_at);
    // Deletions made after the newest row seen are still to come (database clock, not this computer's).
    this.cursor.deleted = [this.cursor.records, this.cursor.layers, this.cursor.features, this.cursor.statuses].reduce(later, null);
    try { this.settings = JSON.parse(settings || '{}') || {}; } catch { this.settings = {}; }
    return this;
  }

  list(c) { return this.data[c] || []; }
  get(c, id) { return this.list(c).find(r => r.id === id) || null; }
  #put(c, rec) { const list = this.data[c]; const i = list.findIndex(r => r.id === rec.id); if (i >= 0) list[i] = rec; else list.push(rec); }

  #log(entries) {
    const rows = entries.map(e => ({ by_user: this.email, at: new Date().toISOString(), ...e }));
    this.logging = this.logging.then(() => this.cloud.insertLog(rows)).catch(err => console.warn('บันทึกประวัติไม่ได้', err.message));
    return this.logging;
  }

  async upsert(c, rec, { reason } = {}) {
    const before = rec.id ? this.get(c, rec.id) : null;
    let after = { ...rec, id: rec.id || globalThis.crypto.randomUUID(), updatedAt: new Date().toISOString() };
    if (RECORD_SETS.includes(c)) {
      const [row] = await this.cloud.saveRecords([{ entity: c, id: after.id, ...patchOf(after, changedKeys(before, after)) }], this.email);
      after = { ...row.data, id: row.id }; // may hold other people's newer fields too
      this.cursor.records = later(this.cursor.records, row.updated_at);
    } else if (c === 'features') await this.cloud.upsertFeatures([after], this.email);
    else if (c === 'layers') await this.cloud.upsertLayer(after);
    this.#put(c, after);
    if (!UNLOGGED.has(c)) this.#log([{ entity: c, record_id: after.id, action: before ? 'update' : 'create', reason: reason || null, before: strip(before), after: strip(after) }]);
    return after;
  }

  async remove(c, id) {
    const before = this.get(c, id);
    if (!before) return false;
    if (TABLE[c]) await this.cloud.deleteRows(TABLE[c], [id]);
    this.data[c] = this.data[c].filter(r => r.id !== id);
    if (!UNLOGGED.has(c)) this.#log([{ entity: c, record_id: id, action: 'delete', before: strip(before), after: null }]);
    return true;
  }

  async replaceAll(c, records, logEntry) {
    const old = new Map(this.list(c).map(r => [r.id, r]));
    const keep = new Set(records.map(r => r.id));
    const changed = records.filter(r => { const b = old.get(r.id); return b !== r && JSON.stringify(b) !== JSON.stringify(r); });
    const gone = [...old.keys()].filter(id => !keep.has(id));
    let list = records;
    if (RECORD_SETS.includes(c)) {
      const rows = await this.cloud.saveRecords(changed.map(r => ({ entity: c, id: r.id, ...patchOf(r, changedKeys(old.get(r.id), r)) })), this.email);
      const merged = new Map(rows.map(r => [r.id, { ...r.data, id: r.id }]));
      list = records.map(r => merged.get(r.id) || r);
    } else if (c === 'features') await this.cloud.upsertFeatures(changed, this.email);
    else if (c === 'layers') for (const l of changed) await this.cloud.upsertLayer(l);
    if (gone.length && TABLE[c]) await this.cloud.deleteRows(TABLE[c], gone);
    this.data[c] = list;
    if (logEntry) this.#log([{ entity: c, record_id: logEntry.recordId || null, action: logEntry.action || 'bulk', reason: logEntry.reason || null, before: null, after: logEntry.after || null }]);
  }

  async log(entry) { await this.#log([{ entity: entry.entity, record_id: entry.recordId || null, action: entry.action, reason: entry.reason || null, before: entry.before || null, after: entry.after || null }]); }
  async readLog({ limit = 300, recordId } = {}) {
    await this.logging;
    return (await this.cloud.readLog({ limit, recordId })).map(r => ({ at: r.at, by: r.by_user, entity: r.entity, recordId: r.record_id, action: r.action, reason: r.reason, before: r.before, after: r.after }));
  }
  async saveSettings() { throw Object.assign(new Error('ตั้งค่าได้ที่เครื่องสำนักงาน'), { code: 403 }); }
  async flush() { await this.logging; }

  // Take in what others changed since the last look. Returns how many items changed here.
  async refresh() {
    const c = this.cloud;
    let n = 0;
    const newer = (rec, at) => rec?.updatedAt && Date.parse(rec.updatedAt) > Date.parse(at);
    for (const d of await c.deletedSince(back(this.cursor.deleted))) {
      this.cursor.deleted = later(this.cursor.deleted, d.at);
      const sets = d.tbl === 'llan_records' ? RECORD_SETS : d.tbl === 'llan_features' ? ['features'] : d.tbl === 'llan_layers' ? ['layers'] : d.tbl === 'llan_parcel_status' ? ['statuses'] : [];
      for (const s of sets) {
        const r = this.get(s, d.row_id);
        if (!r || newer(r, d.at)) continue;
        this.data[s] = this.data[s].filter(x => x.id !== d.row_id);
        if (s === 'layers') this.data.features = this.data.features.filter(f => f.layerId !== d.row_id);
        n++;
      }
    }
    for (const row of await c.changedSince('llan_layers', back(this.cursor.layers))) {
      this.cursor.layers = later(this.cursor.layers, row.updated_at);
      const l = Cloud.fromLayerRow(row), local = this.get('layers', row.id);
      if (local && JSON.stringify({ ...local, importedAt: 0 }) === JSON.stringify({ ...l, importedAt: 0 })) continue;
      this.#put('layers', l); n++;
    }
    for (const row of await c.changedSince('llan_features', back(this.cursor.features), Cloud.FEATURE_COLUMNS)) {
      this.cursor.features = later(this.cursor.features, row.updated_at);
      const f = featureOf(row);
      if (sameFeature(this.get('features', row.id), f)) continue;
      this.#put('features', f); n++;
    }
    for (const row of await c.changedSince('llan_records', back(this.cursor.records), 'id,entity,data,updated_at')) {
      this.cursor.records = later(this.cursor.records, row.updated_at);
      if (!this.data[row.entity] || sameRecord(this.get(row.entity, row.id), row.data)) continue;
      this.#put(row.entity, { ...row.data, id: row.id }); n++;
    }
    for (const row of await c.changedSince('llan_parcel_status', back(this.cursor.statuses)).catch(() => [])) {
      this.cursor.statuses = later(this.cursor.statuses, row.updated_at);
      const st = statusOf(row), local = this.get('statuses', row.id);
      if (local && JSON.stringify({ ...local, updatedAt: 0 }) === JSON.stringify({ ...st, updatedAt: 0 })) continue;
      this.#put('statuses', st); n++;
    }
    this.statusCheckedAt = (await c.getConfig('status_checked').catch(() => null)) || this.statusCheckedAt;
    return n;
  }
}
