// Runs jobs against LTAX ONLINE through a separate Chrome the user logs into (SSO + OTP by hand).
// push: send local records to LTAX (dry = fill and compare only, real = save and read back)
// pull: read records from LTAX into L-LAN.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchChrome, listTargets, isUp, Page } from './cdp.mjs';
import { LtaxDriver, ENTITY_LTAX, defsFor, useDefsFor, fromLtaxForm, fieldDiffs, ltaxItem, sameValue } from './ltax-driver.mjs';
import { ENTITIES, label, LAND_USE_TYPES } from '../public/shared/schema.mjs';
import { syncFields, pendingState } from '../public/shared/diff.mjs';
import { validateRecord } from '../public/shared/validate.mjs';

export const DEFAULT_LTAX = {
  ssoUrl: 'https://lsso.dla.go.th/login.do',
  baseUrl: 'https://ltax.dla.go.th',
  port: 9444,
  delayMs: 1200,
  realModeEnabled: false,
};

const ORDER = { owners: 0, lands: 1, buildings: 2 };
// Address selects that reload their options when the one above changes; set by #setChained.
const CHAINED = new Set(['addrProvince', 'addrAmphur', 'addrDistrict', 'currProvince', 'currAmphur', 'currDistrict', 'amphur', 'district']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class LtaxEngine extends EventEmitter {
  constructor(store, dataDir) {
    super();
    this.store = store;
    this.dataDir = dataDir;
    this.page = null;
    this.running = null;
  }

  get cfg() { return { ...DEFAULT_LTAX, ...(this.store.settings.ltax || {}) }; }

  async status() {
    const c = this.cfg;
    const up = await isUp(c.port);
    let url = '', loggedIn = false, user = null;
    if (up) {
      try {
        const page = await this.#page();
        url = await page.url();
        loggedIn = await new LtaxDriver(page, { baseUrl: c.baseUrl }).loggedIn();
        // LTAX header: "ยินดีต้อนรับ : <name> / สังกัด : <org>"
        if (loggedIn) {
          const m = await page.call(() => (document.body.innerText.match(/ยินดีต้อนรับ\s*:\s*([^\n/]+?)\s*\/\s*สังกัด\s*:\s*([^\n]+)/) || []).slice(1));
          user = { name: (m[0] || '').trim(), org: (m[1] || '').replace(/ออกจากระบบ.*$/, '').trim() };
        }
      } catch { /* page busy or closed */ }
    }
    return { browser: up, url, loggedIn, user, realModeEnabled: !!c.realModeEnabled, running: this.running ? this.running.id : null };
  }

  async openBrowser() {
    const c = this.cfg;
    if (!(await isUp(c.port))) await launchChrome({ chromePath: c.chromePath, port: c.port, profileDir: path.join(this.dataDir, 'chrome-profile'), url: c.ssoUrl, headless: !!c.headless });
    return this.status();
  }

  // Follow the LTAX ONLINE link on the SSO home page after the user has logged in.
  async enterLtax() {
    const page = await this.#page();
    const d = new LtaxDriver(page, { baseUrl: this.cfg.baseUrl });
    if (await d.loggedIn()) return true;
    return d.enterLtaxFromSso();
  }

  async #page() {
    if (this.page && !this.page.closed) return this.page;
    const c = this.cfg;
    const targets = await listTargets(c.port);
    const host = new URL(c.baseUrl).host, sso = new URL(c.ssoUrl).host;
    const t = targets.find(x => x.url.includes(host)) || targets.find(x => x.url.includes(sso)) || targets[0];
    if (!t) throw new Error('ไม่พบหน้าต่าง Chrome ของ L-LAN');
    this.page = await Page.attach(t);
    return this.page;
  }

  listJobs() { return this.store.list('jobs').map(({ items, ...j }) => ({ ...j, total: items.length })).reverse(); }

  // items: [{ entity, recordId }], or for type 'check' [{ kind: 'parcel'|'building', code }].
  // Returns the job (it runs in the background).
  async startJob({ type, mode = 'dry', items, resumeOf }) {
    if (this.running) throw new Error('มีงานกำลังทำอยู่ รอให้เสร็จหรือกดหยุดก่อน');
    if (resumeOf) {
      const prev = this.store.get('jobs', resumeOf);
      if (!prev) throw new Error('ไม่พบงานเดิม');
      ({ type, mode } = prev);
      items = prev.items.filter(it => it.status !== 'done').map(it => (type === 'check' ? { kind: it.kind, code: it.code } : { entity: it.entity, recordId: it.recordId }));
      if (!items.length) throw new Error('งานเดิมทำครบทุกรายการแล้ว');
    }
    if (type === 'push' && mode === 'real' && !this.cfg.realModeEnabled) throw new Error('ยังไม่ได้เปิดโหมดบันทึกจริงในหน้าตั้งค่า');
    const db = this.store.data;
    const list = type === 'check' ? items.map(it => {
      const code = String(it.code || '').trim().toUpperCase();
      return code && { entity: it.kind === 'building' ? 'buildings' : 'lands', kind: it.kind === 'building' ? 'building' : 'parcel', code, label: code, status: 'waiting', message: '', changes: [], manual: [] };
    }).filter(Boolean) : items.map(it => {
      const rec = this.store.get(it.entity, it.recordId);
      return rec && { entity: it.entity, recordId: rec.id, label: ENTITIES[it.entity].title(rec), status: 'waiting', message: '', changes: [], manual: [] };
    }).filter(Boolean).sort((a, b) => ORDER[a.entity] - ORDER[b.entity]);
    // Records with blocking errors never go to LTAX.
    if (type === 'push') for (const it of list) {
      const errs = validateRecord(it.entity, this.store.get(it.entity, it.recordId), db).filter(i => i.level === 'error');
      if (errs.length) { it.status = 'skipped'; it.message = `ข้อมูลยังไม่ผ่านการตรวจ: ${errs.map(e => e.message).join('; ')}`; }
    }
    const job = { id: randomUUID(), type, mode, createdAt: new Date().toISOString(), status: 'running', items: list, summary: {}, resumeOf: resumeOf || null };
    await this.store.upsert('jobs', job);
    this.running = { id: job.id, stop: false };
    this.#run(job).catch(err => this.emit('event', { jobId: job.id, type: 'error', message: err.message }));
    return job;
  }

  stop(jobId) { if (this.running && this.running.id === jobId) this.running.stop = true; }

  async #run(job) {
    const c = this.cfg;
    const shotDir = path.join(this.dataDir, 'jobs', job.id);
    mkdirSync(shotDir, { recursive: true });
    try {
      const page = await this.#page();
      const d = new LtaxDriver(page, { baseUrl: c.baseUrl });
      if (!(await d.loggedIn()) && !(await d.enterLtaxFromSso())) throw new Error('ยังไม่ได้เข้าสู่ระบบ LTAX ในหน้าต่าง Chrome ของ L-LAN');
      for (let i = 0; i < job.items.length; i++) {
        const it = job.items[i];
        if (it.status === 'skipped') continue;
        if (this.running.stop) { it.status = 'cancelled'; it.message = 'หยุดโดยผู้ใช้'; continue; }
        it.status = 'running'; it.startedAt = new Date().toISOString();
        this.emit('event', { jobId: job.id, type: 'item', index: i, item: it });
        try {
          let res;
          if (job.type === 'check') res = await this.#check(d, it);
          else {
            const rec = this.store.get(it.entity, it.recordId);
            if (!rec) throw new Error('ไม่พบรายการนี้ในเครื่องแล้ว');
            res = job.type === 'pull' ? await this.#pull(d, it.entity, rec) : await this.#push(d, it.entity, rec, job.mode === 'real');
          }
          Object.assign(it, res);
        } catch (err) {
          it.status = 'error'; it.message = err.message;
          try { writeFileSync(path.join(shotDir, `${i + 1}.jpg`), await page.screenshot()); it.screenshot = `${i + 1}.jpg`; } catch { /* page gone */ }
        }
        it.finishedAt = new Date().toISOString();
        if (job.type === 'push' && ['done', 'error'].includes(it.status))
          await this.store.upsert('pushes', { id: `${it.entity}:${it.recordId}`, entity: it.entity, recordId: it.recordId, mode: job.mode, status: it.status, message: it.message, at: it.finishedAt, jobId: job.id });
        this.emit('event', { jobId: job.id, type: 'item', index: i, item: it });
        await this.store.upsert('jobs', job);
        if (i < job.items.length - 1) await sleep(c.delayMs);
      }
      job.status = this.running.stop ? 'stopped' : 'done';
    } catch (err) {
      job.status = 'error'; job.error = err.message;
      for (const it of job.items) if (it.status === 'waiting' || it.status === 'running') { it.status = 'cancelled'; it.message = err.message; }
    } finally {
      job.finishedAt = new Date().toISOString();
      job.summary = job.items.reduce((s, x) => ({ ...s, [x.status]: (s[x.status] || 0) + 1 }), {});
      await this.store.upsert('jobs', job);
      this.running = null;
      this.emit('event', { jobId: job.id, type: 'done', job: { ...job, items: undefined } });
    }
  }

  // ---------- does a code exist in LTAX (search only, nothing opened or changed) ----------

  async #check(d, it) {
    const spec = ENTITY_LTAX[it.entity];
    const { rows } = await d.search(spec.mode, spec.searchField, it.code);
    const hits = rows.filter(r => r.cells.some(c => c.toUpperCase() === it.code));
    await this.store.upsert('checks', { id: `${it.kind}:${it.code}`, kind: it.kind, code: it.code, found: hits.length > 0, count: hits.length, cells: hits[0]?.cells || [], at: new Date().toISOString() });
    return { status: 'done', message: hits.length === 1 ? 'พบใน LTAX' : hits.length ? `พบใน LTAX ${hits.length} รายการ (รหัสซ้ำ)` : 'ไม่พบใน LTAX' };
  }

  // ---------- reading one record from LTAX ----------

  async #find(d, entity, rec) {
    const spec = ENTITY_LTAX[entity];
    const key = String(rec[spec.key] || '').trim();
    if (!key) throw new Error(`ไม่มี${ENTITIES[entity].fields.find(f => f.key === spec.key).th} ใช้ค้นหาใน LTAX ไม่ได้`);
    const { rows } = await d.search(spec.mode, spec.searchField, key);
    const hits = rows.filter(r => r.cells.some(c => c.toUpperCase() === key.toUpperCase()));
    if (hits.length > 1) throw new Error(`พบ "${key}" ใน LTAX ${hits.length} รายการ ต้องตรวจในระบบเอง`);
    return hits[0] || null;
  }

  async #readOpen(d, entity) {
    const spec = ENTITY_LTAX[entity];
    const form = await d.readForm(spec.prefixes);
    const values = fromLtaxForm(defsFor(entity), form);
    values.ltaxId = form[spec.idField]?.value || '';
    if (spec.usesCmd) {
      const header = entity === 'lands' ? 'ประเภทการใช้ประโยชน์ที่ดิน' : 'ประเภทการใช้ประโยชน์';
      const table = await d.subTable(header);
      values.uses = [];
      for (let i = 0; i < table.rows.length; i++) {
        await d.cmd(`doUpdate${spec.usesCmd}`, i);
        values.uses.push(fromLtaxForm(useDefsFor(entity), await d.readForm([spec.usePrefix, 'fullArea'])));
        await d.cmd(spec.back);
      }
      const owners = await d.subTable('ชื่อ - นามสกุล');
      values.ownerRows = owners.rows.map(r => ({ name: r[1] || '', psnId: r[2] || '' }));
    }
    return values;
  }

  async #openForUpdate(d, entity, row) {
    await d.cmd('goUpdate', row.index);
    if (entity === 'owners') await d.cmd('doUpdateOwner'); // owner goUpdate shows the owner page first
  }

  async #pull(d, entity, rec) {
    const row = await this.#find(d, entity, rec);
    if (!row) return { status: 'error', message: 'ไม่พบใน LTAX' };
    await this.#openForUpdate(d, entity, row);
    const values = await this.#readOpen(d, entity);
    const ownerRows = values.ownerRows; delete values.ownerRows;
    const fresh = { ...rec, ...values };
    if (ownerRows) {
      const byPsn = new Map(this.store.list('owners').filter(o => o.psnId).map(o => [o.psnId, o.id]));
      const ids = ownerRows.map(o => byPsn.get(o.psnId)).filter(Boolean);
      if (ids.length === ownerRows.length) fresh.ownerIds = ids;
    }
    const synced = syncFields(entity, fresh);
    const local = pendingState(entity, rec);
    const next = local.action === 'update' ? { ...rec, ltaxId: values.ltaxId, synced } : { ...fresh, synced };
    await this.store.upsert(entity, next, { by: 'ltax-pull', reason: 'ดึงข้อมูลจาก LTAX' });
    return { status: 'done', message: local.action === 'update' ? 'ดึงแล้ว (เก็บค่าที่แก้ในเครื่องไว้)' : 'ดึงแล้ว' };
  }

  // ---------- sending one record to LTAX ----------

  async #push(d, entity, rec, real) {
    if (entity === 'signboards') return { status: 'skipped', message: 'การส่งป้ายยังไม่รองรับในรอบนี้' };
    const row = await this.#find(d, entity, rec);
    const manual = [];
    if (row) await this.#openForUpdate(d, entity, row);
    else if (entity === 'owners') { await d.openMode('assetOwner'); await d.cmd('goCreate'); }
    else if (entity === 'lands') await this.#openNewUnderOwner(d, rec, 'land');
    else return { status: 'skipped', message: 'สิ่งปลูกสร้างใหม่ต้องเลือกแปลงที่ดินใน LTAX ซึ่งยังไม่รองรับ ให้เพิ่มในระบบเองก่อน แล้วค่อยส่งการแก้ไข' };

    const before = row ? await this.#readOpen(d, entity) : { uses: [] };
    const ownerRows = before.ownerRows || [];
    const defs = defsFor(entity);
    const changes = fieldDiffs(defs, rec, before);

    // Uses first: each use editor is a round trip that posts the whole form.
    const useChanges = [];
    if (ENTITY_LTAX[entity].usesCmd) {
      const spec = ENTITY_LTAX[entity], udefs = useDefsFor(entity);
      const want = rec.uses || [], have = before.uses || [];
      for (let i = 0; i < Math.max(want.length, have.length); i++) {
        const name = `การใช้ประโยชน์ลำดับ ${i + 1}`;
        if (!want[i]) { manual.push(`${name} มีใน LTAX แต่ไม่มีในเครื่อง ต้องลบในระบบเอง`); continue; }
        const diffs = have[i] ? fieldDiffs(udefs, want[i], have[i]) : udefs.map(u => ({ field: u.key, th: u.th, ltax: '', local: want[i][u.key] ?? '' })).filter(x => x.local !== '');
        if (!diffs.length) continue;
        useChanges.push(...diffs.map(x => ({ ...x, th: `${name}: ${x.th}` })));
        await d.setFields(this.#items(defs, rec, changes));
        await d.cmd(have[i] ? `doUpdate${spec.usesCmd}` : `goAdd${spec.usesCmd}`, have[i] ? i : undefined);
        if (!(await d.page.eval(`!!document.forms[0]?.elements[${JSON.stringify(spec.usePrefix + 'usedType')}]`))) {
          // LTAX refused to open the editor, e.g. "ใช้ประโยชน์เต็มพื้นที่แล้ว" while an earlier row is not shrunk yet.
          const msgs = await d.messages();
          if (real) throw new Error(`เพิ่ม${name}ไม่ได้: ${msgs.join(' / ') || 'LTAX ไม่เปิดหน้าการใช้ประโยชน์'}`);
          manual.push(`ทดลองเปิด${name}ไม่ได้ (${msgs.join(' / ') || 'LTAX ไม่เปิดหน้า'}) ในโหมดทดลองแถวก่อนหน้ายังไม่ถูกบันทึก ตอนบันทึกจริงจะทำต่อกัน`);
          continue;
        }
        await d.setFields(udefs.filter(u => diffs.some(x => x.field === u.key)).map(u => ltaxItem(u, want[i][u.key])));
        if (real) await this.#confirmUse(d, entity);
        else await d.cmd(spec.back);
      }
    }

    // Owners are linked through LTAX popups, which are not automated yet.
    if (entity !== 'owners' && row) {
      const want = (rec.ownerIds || []).map(id => this.store.get('owners', id)).filter(Boolean);
      const wantPsn = want.map(o => o.psnId).filter(Boolean).sort().join(','), havePsn = ownerRows.map(o => o.psnId).filter(Boolean).sort().join(',');
      if (wantPsn !== havePsn) manual.push(`เจ้าของใน LTAX (${ownerRows.map(o => o.name).join(', ') || '-'}) ไม่ตรงกับในเครื่อง ต้องแก้ในระบบเอง`);
    }

    const all = [...changes, ...useChanges];
    if (row && !all.length) return { status: 'done', message: 'ข้อมูลตรงกับ LTAX แล้ว ไม่ต้องส่ง', changes: [], manual };

    await d.setFields(this.#items(defs, rec, row ? changes : defs.map(x => ({ field: x.key })).filter(x => (rec[x.field] ?? '') !== '')));
    await this.#setChained(d, entity, rec);
    if (!real) {
      const check = fieldDiffs(defs, rec, fromLtaxForm(defs, await d.readForm(ENTITY_LTAX[entity].prefixes)));
      await d.openMode(ENTITY_LTAX[entity].mode); // leave the form without saving
      return { status: 'done', message: check.length ? `ทดลองกรอกแล้ว แต่ใส่ไม่ได้ ${check.length} ช่อง: ${check.map(x => x.th).join(', ')}` : `ทดลองกรอกได้ครบ (${row ? 'แก้ไข' : 'เพิ่มใหม่'} ${all.length} ช่อง) ยังไม่ได้บันทึก`, changes: all, manual };
    }

    const msgs = await d.save(entity === 'owners' ? 'doSaveOwner' : 'doSave');
    // Read back what LTAX now holds and compare.
    const again = await this.#find(d, entity, rec);
    if (!again) throw new Error(`กดบันทึกแล้วแต่ค้นหาไม่พบใน LTAX${msgs.length ? ` (LTAX แจ้ง: ${msgs.join(' / ')})` : ''}`);
    await this.#openForUpdate(d, entity, again);
    const after = await this.#readOpen(d, entity);
    await d.openMode(ENTITY_LTAX[entity].mode);
    const left = fieldDiffs(defs, rec, after);
    const synced = syncFields(entity, { ...rec, ...after, ownerIds: rec.ownerIds });
    await this.store.upsert(entity, { ...rec, ltaxId: after.ltaxId || rec.ltaxId, synced }, { by: 'ltax-push', reason: 'บันทึกเข้า LTAX' });
    if (left.length) return { status: 'error', message: `บันทึกแล้วแต่ LTAX ยังไม่ตรง ${left.length} ช่อง: ${left.map(x => x.th).join(', ')}`, changes: all, manual };
    return { status: 'done', message: `บันทึกเข้า LTAX แล้ว (${row ? 'แก้ไข' : 'เพิ่มใหม่'} ${all.length} ช่อง) ตรวจซ้ำตรงกัน${msgs.length ? ` · LTAX แจ้ง: ${msgs.join(' / ')}` : ''}`, changes: all, manual };
  }

  #items(defs, rec, changes) {
    const keys = new Set(changes.map(c => c.field));
    return defs.filter(x => keys.has(x.key) && !CHAINED.has(x.key)).map(x => ltaxItem(x, rec[x.key]));
  }

  async #setChained(d, entity, rec) {
    const defs = defsFor(entity).filter(x => x.ltaxSelect);
    const groups = entity === 'owners'
      ? [['addrProvince', 'addrAmphur', 'addrDistrict'], ['currProvince', 'currAmphur', 'currDistrict']]
      : [['amphur', 'district']];
    for (const g of groups) await d.setChained(g.map(k => ltaxItem(defs.find(x => x.key === k), rec[k])));
  }

  // New land is created from its owner's page so LTAX links the owner itself.
  async #openNewUnderOwner(d, rec, kind) {
    const owner = (rec.ownerIds || []).map(id => this.store.get('owners', id)).find(o => o && o.psnId);
    if (!owner) throw new Error('แปลงใหม่ต้องมีเจ้าของที่มีเลขประจำตัว เพื่อเพิ่มจากหน้าเจ้าของใน LTAX');
    const row = await this.#find(d, 'owners', owner);
    if (!row) throw new Error(`ยังไม่มีเจ้าของ ${ENTITIES.owners.title(owner)} ใน LTAX ส่งข้อมูลเจ้าของก่อน`);
    await d.cmd('goUpdate', row.index);
    await d.cmd('doAddNewAsset', kind);
  }

  async #confirmUse(d, entity) {
    if (entity === 'buildings') return d.save('doSaveBuildingUsed');
    // Land use "ตกลง" runs checkArea(), which submits the use editor.
    const msgs = await d.submit(`if (validateForm(document.forms[0])) checkArea()`);
    const bad = msgs.find(m => /เกิน|ไม่ถูกต้อง|กรุณา|เต็มพื้นที่/.test(m));
    if (bad) throw new Error(`LTAX แจ้ง: ${bad}`);
  }
}

export const describeUse = u => `${label(LAND_USE_TYPES, u.usedType)} ${[u.rai, u.ngan, u.wah].join('-')}`;
export { sameValue };
