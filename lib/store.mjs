// Local data store: one JSON file per collection in the data folder, kept in memory,
// written atomically (temp file + rename). Every change is appended to changes.jsonl.
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const randomUUID = () => globalThis.crypto.randomUUID();

export const COLLECTIONS = ['owners', 'lands', 'buildings', 'signboards', 'features', 'layers', 'jobs', 'checks', 'pushes', 'deletions'];
// Bookkeeping collections that do not go into the change log.
const UNLOGGED = new Set(['jobs', 'checks', 'pushes']);

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.data = Object.fromEntries(COLLECTIONS.map(c => [c, []]));
    this.settings = {};
    this.writing = new Map();
    this.watchers = [];
  }

  // Every change, for the Supabase sync: { c, before, after, by, reason, origin }. origin 'cloud' = came from Supabase.
  onChange(fn) { this.watchers.push(fn); }
  #emit(ev) { for (const fn of this.watchers) { try { fn(ev); } catch (err) { console.error(err); } } }

  async open() {
    mkdirSync(this.dir, { recursive: true });
    for (const c of COLLECTIONS) this.data[c] = await this.#read(`${c}.json`, []);
    this.settings = await this.#read('settings.json', {});
    return this;
  }

  async #read(name, fallback) {
    const file = path.join(this.dir, name);
    if (!existsSync(file)) return fallback;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }

  // Writes are serialized per file so a slow write never lands after a newer one.
  async #write(name, value) {
    const prev = this.writing.get(name) || Promise.resolve();
    const next = prev.then(async () => {
      const file = path.join(this.dir, name);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
      await fs.rename(tmp, file);
    });
    this.writing.set(name, next.catch(() => {}));
    return next;
  }

  async flush() { await Promise.all([...this.writing.values()]); }

  list(c) { return this.data[c]; }
  get(c, id) { return this.data[c].find(r => r.id === id) || null; }

  async log(entry) { return this.logMany([entry]); }
  async logMany(entries) {
    if (!entries.length) return;
    const at = new Date().toISOString();
    const line = entries.map(e => JSON.stringify({ at, ...e })).join('\n') + '\n';
    const prev = this.writing.get('changes.jsonl') || Promise.resolve();
    const next = prev.then(() => fs.appendFile(path.join(this.dir, 'changes.jsonl'), line, 'utf8'));
    this.writing.set('changes.jsonl', next.catch(() => {}));
    return next;
  }

  async readLog({ limit = 500, recordId } = {}) {
    const file = path.join(this.dir, 'changes.jsonl');
    if (!existsSync(file)) return [];
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const picked = recordId ? lines.filter(l => l.recordId === recordId) : lines;
    return picked.slice(-limit).reverse();
  }

  async upsert(c, rec, { by = 'user', reason, origin } = {}) {
    const list = this.data[c];
    const i = rec.id ? list.findIndex(r => r.id === rec.id) : -1;
    const before = i >= 0 ? list[i] : null;
    const after = { ...rec, id: rec.id || randomUUID(), updatedAt: new Date().toISOString() };
    if (i >= 0) list[i] = after; else list.push(after);
    const done = this.#write(`${c}.json`, list);
    this.#emit({ c, before, after, by, reason, origin });
    await done;
    if (!UNLOGGED.has(c)) await this.log({ by, reason, entity: c, recordId: after.id, action: before ? 'update' : 'create', before: strip(before), after: strip(after), ...(origin ? { origin } : {}) });
    return after;
  }

  async remove(c, id, { by = 'user', origin } = {}) {
    const list = this.data[c];
    const i = list.findIndex(r => r.id === id);
    if (i < 0) return false;
    const [before] = list.splice(i, 1);
    const done = this.#write(`${c}.json`, list);
    this.#emit({ c, before, after: null, by, origin });
    await done;
    if (!UNLOGGED.has(c)) await this.log({ by, entity: c, recordId: id, action: 'delete', before: strip(before), after: null, ...(origin ? { origin } : {}) });
    return true;
  }

  // Many records at once (changes pulled from Supabase): one file write, one log line each.
  // Records keep the updatedAt they arrive with.
  async upsertMany(c, recs, { by = 'user', reason, origin } = {}) {
    if (!recs.length) return [];
    const list = this.data[c];
    const index = new Map(list.map((r, i) => [r.id, i]));
    const lines = [], out = [];
    for (const rec of recs) {
      const id = rec.id || randomUUID();
      const i = index.get(id);
      const before = i === undefined ? null : list[i];
      const after = { ...rec, id, updatedAt: rec.updatedAt || new Date().toISOString() };
      if (i === undefined) { index.set(id, list.length); list.push(after); } else list[i] = after;
      this.#emit({ c, before, after, by, reason, origin });
      if (!UNLOGGED.has(c)) lines.push({ by, reason, entity: c, recordId: id, action: before ? 'update' : 'create', before: strip(before), after: strip(after), ...(origin ? { origin } : {}) });
      out.push(after);
    }
    await this.#write(`${c}.json`, list);
    await this.logMany(lines);
    return out;
  }

  async removeMany(c, ids, { by = 'user', origin } = {}) {
    const gone = new Set(ids);
    const removed = this.data[c].filter(r => gone.has(r.id));
    if (!removed.length) return 0;
    this.data[c] = this.data[c].filter(r => !gone.has(r.id));
    for (const before of removed) this.#emit({ c, before, after: null, by, origin });
    await this.#write(`${c}.json`, this.data[c]);
    if (!UNLOGGED.has(c)) await this.logMany(removed.map(before => ({ by, entity: c, recordId: before.id, action: 'delete', before: strip(before), after: null, ...(origin ? { origin } : {}) })));
    return removed.length;
  }

  // Bulk replace without per-record log lines (imports log one summary line instead).
  async replaceAll(c, records, logEntry, { origin } = {}) {
    const old = new Map(this.data[c].map(r => [r.id, r]));
    this.data[c] = records;
    if (this.watchers.length) {
      const now = new Set();
      for (const r of records) {
        now.add(r.id);
        const before = old.get(r.id) || null;
        if (before !== r && JSON.stringify(before) !== JSON.stringify(r)) this.#emit({ c, before, after: r, by: logEntry?.by, origin, bulk: true });
      }
      for (const [id, before] of old) if (!now.has(id)) this.#emit({ c, before, after: null, by: logEntry?.by, origin, bulk: true });
    }
    await this.#write(`${c}.json`, records);
    if (logEntry) await this.log({ entity: c, ...logEntry });
  }

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    await this.#write('settings.json', this.settings);
    return this.settings;
  }
}

// Geometry and sync snapshots would bloat the change log.
export function strip(rec) {
  if (!rec) return null;
  const { geometry, synced, ...rest } = rec;
  return rest;
}
