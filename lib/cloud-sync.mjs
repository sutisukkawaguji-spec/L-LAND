// Office machine ↔ Supabase. Supabase is the shared copy the web page reads and edits; the office keeps a
// full local copy for LTAX work.
// - Every local change is queued (survives restarts) and sent a moment later. Register records go up as
//   field-level patches, so an office edit and a web edit to different fields of one record both survive.
// - Changes made on the web come down every minute, on demand, and before every LTAX job.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Cloud, changedKeys, patchOf, sameRecord, sameFeature } from './cloud.mjs';
import { strip } from './store.mjs';
import { bboxOf } from '../public/shared/proj.mjs';

export const SYNCED_RECORDS = ['owners', 'lands', 'buildings', 'signboards', 'deletions'];
// Pulls re-read a few minutes back, because a slow write can land with an earlier database time.
const OVERLAP_MS = 5 * 60 * 1000;
const back = iso => (iso ? new Date(Date.parse(iso) - OVERLAP_MS).toISOString() : null);
const later = (a, b) => (!a || (b && Date.parse(b) > Date.parse(a)) ? b : a);
const FROM_WEB = 'แก้ไขจากเว็บ (Supabase)';

export class CloudSync extends EventEmitter {
  // cloud(): a Cloud client when syncing is switched on, else null. who(): name for the office's changes.
  constructor(store, dir, { cloud, who = () => 'office' }) {
    super();
    this.store = store;
    this.file = path.join(dir, 'cloud-sync.json');
    this.cloud = cloud;
    this.who = who;
    this.st = { queue: {}, logs: [], cursor: {}, lastPush: null, lastPull: null, error: null, uploadedAt: null };
    this.seq = Date.now();
    this.chain = Promise.resolve();
    this.saving = Promise.resolve();
    this.timer = null;
  }

  async load() {
    if (existsSync(this.file)) this.st = { ...this.st, ...JSON.parse(await fs.readFile(this.file, 'utf8')) };
    return this;
  }
  #save() {
    const json = JSON.stringify(this.st);
    this.saving = this.saving.then(async () => { const tmp = `${this.file}.tmp`; await fs.writeFile(tmp, json, 'utf8'); await fs.rename(tmp, this.file); }).catch(err => console.error(err));
    return this.saving;
  }
  // One sync step at a time (sending, pulling, uploading everything).
  #lock(fn) { const run = this.chain.then(fn, fn); this.chain = run.catch(() => {}); return run; }

  get enabled() { return !!this.cloud(); }
  status() {
    const { queue, logs, lastPush, lastPull, error, uploadedAt } = this.st;
    return { enabled: this.enabled, queued: Object.keys(queue).length, logs: logs.length, lastPush, lastPull, error, uploadedAt };
  }

  attach() { this.store.onChange(ev => this.#note(ev)); return this; }

  #note({ c, before, after, by, reason, origin, bulk }) {
    if (origin === 'cloud') return;
    const id = (after || before)?.id;
    if (!id) return;
    let key, entry;
    if (SYNCED_RECORDS.includes(c)) {
      key = `r:${id}`;
      entry = this.st.queue[key] || { t: 'r', entity: c, id, keys: [] };
      entry.entity = c;
      if (!after) { entry.del = true; entry.keys = []; }
      else { entry.del = false; entry.keys = [...new Set([...entry.keys, ...changedKeys(before, after)])]; }
    } else if (c === 'features' || c === 'layers') {
      key = `${c === 'features' ? 'f' : 'l'}:${id}`;
      entry = { t: key[0], id, del: !after };
    } else return;
    entry.v = ++this.seq;
    this.st.queue[key] = entry;
    if (!bulk) this.st.logs.push({ at: new Date().toISOString(), by_user: by && by !== 'user' ? by : this.who(), entity: c, record_id: id,
      action: !after ? 'delete' : before ? 'update' : 'create', reason: reason || null, before: strip(before), after: strip(after) });
    this.#save();
    this.#later();
  }

  #later(ms = 1500) {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(() => {}), ms);
    this.timer.unref?.();
  }

  start(everyMs = 60000) {
    this.#later(500);
    this.interval = setInterval(() => { if (this.enabled) this.sync().catch(() => {}); }, everyMs);
    this.interval.unref?.();
    return this;
  }
  stop() { clearTimeout(this.timer); clearInterval(this.interval); }

  flush() { return this.#lock(() => this.#flush()); }
  pull() { return this.#lock(() => this.#pull()); }
  sync() { return this.#lock(async () => ({ ...(await this.#flush()), ...(await this.#pull()) })); }
  uploadAll() { return this.#lock(() => this.#uploadAll()); }

  #client() {
    const c = this.cloud();
    if (!c) throw new Error('ยังไม่ได้เปิดซิงก์กับ Supabase (ตั้งค่า → Supabase)');
    return c;
  }
  async #fail(err) {
    this.st.error = err.message;
    await this.#save();
    this.emit('change', this.status());
    this.#later(30000);
    throw err;
  }

  async #flush() {
    const c = this.#client();
    const entries = Object.entries(this.st.queue);
    const logs = this.st.logs.slice(0, 2000);
    if (!entries.length && !logs.length) return { sent: 0 };
    const by = this.who();
    const of = t => entries.map(([, e]) => e).filter(e => e.t === t);
    try {
      const features = this.store.list('features');
      for (const e of of('l').filter(e => !e.del)) {
        const l = this.store.get('layers', e.id);
        if (l) await c.upsertLayer({ ...l, count: features.filter(f => f.layerId === l.id).length });
      }
      await c.upsertFeatures(of('f').filter(e => !e.del).map(e => this.store.get('features', e.id)).filter(Boolean), by);
      const saves = [], gone = [];
      for (const e of of('r')) {
        const rec = !e.del && this.store.get(e.entity, e.id);
        if (!rec) { gone.push(e.id); continue; }
        saves.push({ entity: e.entity, id: e.id, ...patchOf(rec, e.keys.length ? e.keys : Object.keys(rec)) });
      }
      const merged = await c.saveRecords(saves, by);
      if (gone.length) await c.deleteRows('llan_records', gone);
      const goneF = of('f').filter(e => e.del || !this.store.get('features', e.id)).map(e => e.id);
      if (goneF.length) await c.deleteRows('llan_features', goneF);
      const goneL = of('l').filter(e => e.del || !this.store.get('layers', e.id)).map(e => e.id);
      if (goneL.length) await c.deleteRows('llan_layers', goneL);
      try { if (logs.length) await c.insertLog(logs); this.st.logs.splice(0, logs.length); } catch (err) { console.error('ส่งประวัติขึ้น Supabase ไม่ได้:', err.message); }
      const sentV = new Map(entries.map(([k, e]) => [k, e.v]));
      for (const [k, v] of sentV) if (this.st.queue[k]?.v === v) delete this.st.queue[k];
      // Someone may have changed other fields of the same records on the web: keep the merged copy,
      // unless the record changed here again while it was being sent (that goes up next time).
      const take = merged.filter(row => !this.st.queue[`r:${row.id}`] && !sameRecord(this.store.get(row.entity, row.id), row.data));
      for (const entity of SYNCED_RECORDS) {
        const rows = take.filter(r => r.entity === entity);
        if (rows.length) await this.store.upsertMany(entity, rows.map(r => ({ ...r.data, id: r.id })), { by: 'Supabase', reason: 'รวมกับการแก้ไขจากเว็บ', origin: 'cloud' });
      }
      this.st.lastPush = new Date().toISOString();
      this.st.error = null;
      await this.#save();
      this.emit('change', this.status());
      return { sent: entries.length, merged: take.length };
    } catch (err) { return this.#fail(err); }
  }

  async #pull() {
    const c = this.#client();
    if (Object.keys(this.st.queue).length || this.st.logs.length) await this.#flush();
    const cur = this.st.cursor;
    const counts = { records: 0, features: 0, layers: 0, deleted: 0 };
    try {
      // Deletions first, so a record deleted and made again ends up existing.
      const gone = await c.deletedSince(back(cur.deleted));
      const drop = { features: [], layers: [] };
      const dropRec = Object.fromEntries(SYNCED_RECORDS.map(e => [e, []]));
      const newer = (rec, at) => rec?.updatedAt && Date.parse(rec.updatedAt) > Date.parse(at);
      for (const d of gone) {
        cur.deleted = later(cur.deleted, d.at);
        if (d.tbl === 'llan_records') {
          for (const e of SYNCED_RECORDS) { const r = this.store.get(e, d.row_id); if (r && !newer(r, d.at) && !this.st.queue[`r:${d.row_id}`]) dropRec[e].push(d.row_id); }
        } else if (d.tbl === 'llan_features') {
          const f = this.store.get('features', d.row_id);
          if (f && !newer(f, d.at) && !this.st.queue[`f:${d.row_id}`]) drop.features.push(d.row_id);
        } else if (d.tbl === 'llan_layers' && this.store.get('layers', d.row_id) && !this.st.queue[`l:${d.row_id}`]) drop.layers.push(d.row_id);
      }
      for (const [e, ids] of Object.entries(dropRec)) counts.deleted += await this.store.removeMany(e, ids, { by: 'เว็บ', origin: 'cloud' });
      if (drop.layers.length) {
        const ls = new Set(drop.layers);
        drop.features.push(...this.store.list('features').filter(f => ls.has(f.layerId)).map(f => f.id));
        counts.deleted += await this.store.removeMany('layers', drop.layers, { by: 'เว็บ', origin: 'cloud' });
      }
      counts.deleted += await this.store.removeMany('features', [...new Set(drop.features)], { by: 'เว็บ', origin: 'cloud' });

      const layers = [];
      for (const row of await c.changedSince('llan_layers', back(cur.layers))) {
        cur.layers = later(cur.layers, row.updated_at);
        if (this.st.queue[`l:${row.id}`]) continue;
        const local = this.store.get('layers', row.id), l = Cloud.fromLayerRow(row);
        if (local && local.name === l.name && local.kind === l.kind && (local.codeField || '') === l.codeField) continue;
        layers.push(local ? { ...local, name: l.name, kind: l.kind, codeField: l.codeField } : l);
      }
      counts.layers = (await this.store.upsertMany('layers', layers, { by: 'เว็บ', reason: FROM_WEB, origin: 'cloud' })).length;

      const feats = [];
      for (const row of await c.changedSince('llan_features', back(cur.features), Cloud.FEATURE_COLUMNS)) {
        cur.features = later(cur.features, row.updated_at);
        if (this.st.queue[`f:${row.id}`]) continue;
        const f = Cloud.fromFeatureRow(row), local = this.store.get('features', row.id);
        if (sameFeature(local, f)) continue;
        // The cloud copy has no personal shapefile columns: keep the ones this machine has.
        feats.push({ ...(local || {}), ...f, attrs: { ...(local?.attrs || {}), ...f.attrs }, bbox: bboxOf(f.geometry), updatedAt: row.updated_at });
      }
      counts.features = (await this.store.upsertMany('features', feats, { by: 'เว็บ', reason: FROM_WEB, origin: 'cloud' })).length;

      const recs = Object.fromEntries(SYNCED_RECORDS.map(e => [e, []]));
      for (const row of await c.changedSince('llan_records', back(cur.records), 'id,entity,data,updated_at,updated_by')) {
        cur.records = later(cur.records, row.updated_at);
        if (this.st.queue[`r:${row.id}`] || !recs[row.entity]) continue;
        if (sameRecord(this.store.get(row.entity, row.id), row.data)) continue;
        recs[row.entity].push({ ...row.data, id: row.id, _by: row.updated_by });
      }
      for (const [e, list] of Object.entries(recs)) {
        // One log line per record, named after whoever changed it on the web.
        const byWho = new Map();
        for (const { _by, ...r } of list) { const k = _by || 'เว็บ'; if (!byWho.has(k)) byWho.set(k, []); byWho.get(k).push(r); }
        for (const [who, rs] of byWho) counts.records += (await this.store.upsertMany(e, rs, { by: who, reason: FROM_WEB, origin: 'cloud' })).length;
      }
      this.st.lastPull = new Date().toISOString();
      this.st.error = null;
      await this.#save();
      const changed = counts.records + counts.features + counts.layers + counts.deleted;
      this.emit('change', { ...this.status(), pulled: counts, changed });
      return { pulled: counts, changed };
    } catch (err) { return this.#fail(err); }
  }

  // First upload (or a full refresh) of everything on this machine. Changes already made on the web
  // are pulled in first, so nothing made there is overwritten.
  async #uploadAll() {
    const c = this.#client();
    const before = await this.#pull();
    const snapshot = new Map(Object.entries(this.st.queue).map(([k, e]) => [k, e.v]));
    const by = this.who();
    try {
      const out = { layers: 0, features: 0, records: 0, pulled: before.pulled };
      const features = this.store.list('features');
      for (const l of this.store.list('layers')) { await c.upsertLayer({ ...l, count: features.filter(f => f.layerId === l.id).length }); out.layers++; }
      await c.upsertFeatures(features, by);
      out.features = features.length;
      for (const e of SYNCED_RECORDS) {
        const rows = await c.saveRecords(this.store.list(e).map(r => ({ entity: e, id: r.id, ...patchOf(r, Object.keys(r)) })), by);
        out.records += rows.length;
        for (const r of rows) this.st.cursor.records = later(this.st.cursor.records, r.updated_at);
      }
      for (const [k, v] of snapshot) if (this.st.queue[k]?.v === v) delete this.st.queue[k];
      this.st.uploadedAt = this.st.lastPush = new Date().toISOString();
      this.st.error = null;
      await this.#save();
      this.emit('change', this.status());
      return out;
    } catch (err) { return this.#fail(err); }
  }
}
