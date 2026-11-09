// Local data store: one JSON file per collection in the data folder, kept in memory,
// written atomically (temp file + rename). Every change is appended to changes.jsonl.
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const COLLECTIONS = ['owners', 'lands', 'buildings', 'signboards', 'features', 'layers', 'jobs', 'checks', 'pushes', 'deletions'];
// Bookkeeping collections that do not go into the change log.
const UNLOGGED = new Set(['jobs', 'checks', 'pushes']);

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.data = Object.fromEntries(COLLECTIONS.map(c => [c, []]));
    this.settings = {};
    this.writing = new Map();
  }

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

  async log(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
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

  async upsert(c, rec, { by = 'user', reason } = {}) {
    const list = this.data[c];
    const i = rec.id ? list.findIndex(r => r.id === rec.id) : -1;
    const before = i >= 0 ? list[i] : null;
    const after = { ...rec, id: rec.id || randomUUID(), updatedAt: new Date().toISOString() };
    if (i >= 0) list[i] = after; else list.push(after);
    await this.#write(`${c}.json`, list);
    if (!UNLOGGED.has(c)) await this.log({ by, reason, entity: c, recordId: after.id, action: before ? 'update' : 'create', before: strip(before), after: strip(after) });
    return after;
  }

  async remove(c, id, { by = 'user' } = {}) {
    const list = this.data[c];
    const i = list.findIndex(r => r.id === id);
    if (i < 0) return false;
    const [before] = list.splice(i, 1);
    await this.#write(`${c}.json`, list);
    if (!UNLOGGED.has(c)) await this.log({ by, entity: c, recordId: id, action: 'delete', before: strip(before), after: null });
    return true;
  }

  // Bulk replace without per-record log lines (imports log one summary line instead).
  async replaceAll(c, records, logEntry) {
    this.data[c] = records;
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
function strip(rec) {
  if (!rec) return null;
  const { geometry, synced, ...rest } = rec;
  return rest;
}
