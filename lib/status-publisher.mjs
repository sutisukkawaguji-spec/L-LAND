// Office machine → Supabase: the parcel statuses (llan_parcel_status) for the survey web page.
// Recomputed a few seconds after any change; only rows whose content changed are sent.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

export class StatusPublisher {
  // cloud(): a Cloud client when syncing is on, else null. compute(): the current status rows.
  constructor(dir, { cloud, compute }) {
    this.file = path.join(dir, 'status-sent.json');
    this.cloud = cloud;
    this.compute = compute;
    this.st = { sent: {}, lastAt: null, error: null };
    this.chain = Promise.resolve();
    this.timer = null;
  }
  async load() {
    if (existsSync(this.file)) this.st = { ...this.st, ...JSON.parse(await fs.readFile(this.file, 'utf8')) };
    return this;
  }
  status() { return { lastAt: this.st.lastAt, error: this.st.error, rows: Object.keys(this.st.sent).length }; }

  later(ms = 4000) {
    if (!this.cloud()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.publish().catch(() => {}), ms);
    this.timer.unref?.();
  }

  // all: send every row again (first upload, or after the table was emptied by hand).
  publish({ all = false } = {}) {
    const run = this.chain.then(async () => {
      const c = this.cloud();
      if (!c) return { sent: 0, removed: 0 };
      const rows = this.compute();
      const now = new Map(rows.map(r => [r.id, JSON.stringify(r)]));
      const changed = rows.filter(r => all || this.st.sent[r.id] !== now.get(r.id));
      const gone = Object.keys(this.st.sent).filter(id => !now.has(id));
      try {
        if (changed.length) await c.upsertRows('llan_parcel_status', changed.map(({ survey, ...r }) => ({ ...r, updated_by: 'สำนักงาน' })));
        if (gone.length) await c.deleteRows('llan_parcel_status', gone);
        if (changed.length || gone.length || !this.st.lastAt) await c.setConfig('status_checked', new Date().toISOString());
        this.st = { sent: Object.fromEntries(now), lastAt: new Date().toISOString(), error: null };
      } catch (err) {
        this.st.error = err.message;
        this.later(60000);
        throw err;
      } finally {
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.st), 'utf8');
        await fs.rename(tmp, this.file);
      }
      return { sent: changed.length, removed: gone.length };
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
