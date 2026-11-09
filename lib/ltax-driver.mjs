// Drives the LTAX ONLINE pages (AST001 asset register) through a CDP Page.
// Field names and commands come from the live system, see docs/ltax-online-map.md.
// Nothing in here saves unless `save` is true; dry runs fill the form, read it back and leave.
import { ENTITIES, buildingTypeLabel, label, DOC_TYPES, UTM_SHEETS, MAP_SCALES, LAND_USE_TYPES, LAND_USED_FOR,
  AGRI_TYPES, STRUCTURES, BUILDING_USE_TYPES, BUILDING_USED_FOR } from '../public/shared/schema.mjs';

// ---------- page-side helpers (run inside the browser) ----------

function pageReadForm(prefixes) {
  const form = document.forms[0];
  if (!form) return null;
  const out = {};
  for (const el of form.elements) {
    if (!el.name || !prefixes.some(p => el.name === p || el.name.startsWith(p))) continue;
    if (el.tagName === 'SELECT') out[el.name] = { value: el.value, text: el.selectedIndex >= 0 ? el.options[el.selectedIndex].text.trim() : '' };
    else if (el.type === 'checkbox') out[el.name] = { value: el.checked ? el.value : '', checked: el.checked };
    else if (el.type !== 'button' && el.type !== 'file') out[el.name] = { value: el.value };
  }
  return out;
}

function pageSetFields(items) {
  const norm = s => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, '').trim();
  const form = document.forms[0];
  const result = [];
  for (const it of items) {
    const el = form && form.elements[it.name];
    if (!el) { result.push({ name: it.name, ok: false, error: 'ไม่พบช่องนี้ในฟอร์ม LTAX' }); continue; }
    const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    if (el.tagName === 'SELECT') {
      const want = norm(it.label);
      let opt = [...el.options].find(o => want && norm(o.text) === want);
      if (!opt && it.value !== undefined && it.value !== '') opt = [...el.options].find(o => o.value === String(it.value));
      if (!opt && (it.label ?? '') === '') opt = [...el.options].find(o => o.value === '');
      if (!opt) { result.push({ name: it.name, ok: false, error: `ไม่มีตัวเลือก "${it.label}"` }); continue; }
      el.value = opt.value; fire();
      result.push({ name: it.name, ok: true });
    } else if (el.type === 'checkbox') {
      const want = !!it.value;
      if (el.checked !== want) el.click();
      result.push({ name: it.name, ok: true });
    } else {
      el.value = it.value ?? ''; fire();
      result.push({ name: it.name, ok: true });
    }
  }
  return result;
}

function pageOptionsReady({ name, label }) {
  const el = document.forms[0] && document.forms[0].elements[name];
  if (!el) return false;
  const norm = s => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, '').trim();
  return [...el.options].some(o => norm(o.text) === norm(label));
}

// Rows of the result table that carry a goView link; cells as text.
function pageListRows() {
  const rows = [];
  for (const tr of document.querySelectorAll('tr')) {
    const view = [...tr.querySelectorAll('a[href^="javascript:doCmd(\'goView\'"]')][0];
    if (!view) continue;
    const m = view.getAttribute('href').match(/goView',\s*'?(\d+)/);
    rows.push({ index: Number(m[1]), cells: [...tr.cells].map(td => td.innerText.trim()) });
  }
  const total = (document.body.innerText.match(/จาก\s+([\d,]+)\s*$/m) || [])[1];
  return { rows, total: total ? Number(total.replace(/,/g, '')) : rows.length };
}

// Rows of a sub-table (owners / uses) identified by a header cell text.
function pageSubTable(headerText) {
  for (const table of document.querySelectorAll('table')) {
    const head = [...table.querySelectorAll('th, thead td, tr:first-child td')].map(c => c.innerText.trim());
    if (!head.some(h => h.startsWith(headerText))) continue;
    const rows = [...table.querySelectorAll('tr')].slice(1).map(tr => [...tr.cells].map(td => td.innerText.trim()))
      .filter(r => r.length > 1 && !r.join('').includes('ยังไม่พบข้อมูล'));
    return { head, rows };
  }
  return { head: [], rows: [] };
}

function pageMessages() {
  const out = [];
  for (const el of document.querySelectorAll('.swal2-title, .swal2-content, .swal2-html-container, .alert, .error, .errors, .message, .msg, [class*="alert-"], [id*="message"], [id*="error"]')) {
    if (!(el.offsetWidth || el.offsetHeight)) continue;
    const t = el.innerText.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  // LTAX prints server messages under the footer: "!\n[server][time]\n<message>"
  const m = document.body.innerText.match(/\n!\s*\n\[[^\]]+\]\[[^\]]+\]\s*\n([^\n]+)/);
  if (m && !out.includes(m[1].trim())) out.push(m[1].trim());
  return out;
}

function pageSwal() {
  const pop = document.querySelector('.swal2-popup');
  if (!pop || !(pop.offsetWidth || pop.offsetHeight)) return null;
  return { text: pop.innerText.trim(), hasConfirm: !!document.querySelector('.swal2-confirm') };
}

// ---------- driver ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class LtaxDriver {
  constructor(page, { baseUrl = 'https://ltax.dla.go.th', log = () => {} } = {}) {
    this.page = page; this.base = baseUrl.replace(/\/$/, ''); this.log = log;
  }

  async loggedIn() {
    const url = await this.page.url();
    if (!url.startsWith(this.base) || /login\.do/i.test(url)) return false;
    return this.page.eval(`/ออกจากระบบ/.test(document.body.innerText)`);
  }

  // After SSO login the user lands on the SSO home; follow its LTAX ONLINE link.
  async enterLtaxFromSso() {
    const href = await this.page.eval(`([...document.querySelectorAll('a[href*="cmd=jump"]')].find(a => /LTAX/.test(a.innerText)) || {}).href || ''`);
    if (!href) return false;
    await this.page.goto(href);
    return this.loggedIn();
  }

  async cmd(command, index) {
    const arg = index === undefined ? '' : `, ${typeof index === 'number' ? index : JSON.stringify(index)}`;
    await this.page.navigateBy(() => this.page.eval(`doCmd(${JSON.stringify(command)}${arg})`));
    await this.assertNotLoggedOut();
  }

  async assertNotLoggedOut() {
    const url = await this.page.url();
    if (!url.startsWith(this.base) || /login/i.test(url)) throw new Error(`หลุดออกจากระบบ LTAX กรุณาเข้าสู่ระบบใหม่ (หน้า ${url})`);
  }

  async openMode(mode) {
    await this.page.goto(`${this.base}/asset/assetRegis.do`);
    await this.assertNotLoggedOut();
    if (mode !== 'assetOwner') await this.cmd('goAsset', mode);
  }

  async setFields(items) {
    const res = await this.page.call(pageSetFields, items);
    const bad = res.filter(r => !r.ok);
    if (bad.length) throw new Error(bad.map(b => `${b.name}: ${b.error}`).join('; '));
  }

  // Chained selects (province → amphur → district) reload their options after a change.
  async setChained(items) {
    for (const it of items) {
      if (!it.label) continue;
      for (let i = 0; i < 40 && !(await this.page.call(pageOptionsReady, it)); i++) await sleep(250);
      await this.setFields([it]);
      await sleep(400);
    }
  }

  async search(mode, field, value) {
    await this.openMode(mode);
    await this.setFields([{ name: `searchCondition.${field}`, value }]);
    await this.cmd(mode === 'assetOwner' ? 'listAsset' : 'listAsset');
    return this.page.call(pageListRows);
  }

  readForm(prefixes) { return this.page.call(pageReadForm, prefixes); }
  messages() { return this.page.call(pageMessages); }
  subTable(header) { return this.page.call(pageSubTable, header); }

  // Press the form's own save command. LTAX may ask "ยืนยันการแก้ไขข้อมูลปีภาษี ..." in a SweetAlert.
  save(command = 'doSave') { return this.submit(`doCmd(${JSON.stringify(command)})`); }

  // Run a page expression that submits the form; wait for the new page, answering LTAX's
  // "ยืนยันการแก้ไข" prompt and failing on any other prompt, alert or timeout.
  async submit(expression) {
    const p = this.page;
    const mark = `s${Date.now()}`;
    await p.eval(`window.__llan = ${JSON.stringify(mark)}`);
    p.dialogs.length = 0;
    await p.eval(expression);
    let confirmed = false;
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      let state;
      try { state = await p.eval(`[window.__llan === ${JSON.stringify(mark)}, document.readyState]`); } catch { continue; }
      if (!state[0] && state[1] === 'complete') break;
      if (p.dialogs.length) throw new Error(`LTAX แจ้ง: ${p.dialogs.map(d => d.message).join(' / ')}`);
      const swal = await p.call(pageSwal).catch(() => null);
      if (swal && swal.hasConfirm && !confirmed && /ยืนยันการแก้ไข/.test(swal.text)) {
        await p.eval(`document.querySelector('.swal2-confirm').click()`);
        confirmed = true;
      } else if (swal && !/ยืนยันการแก้ไข/.test(swal.text)) {
        throw new Error(`LTAX แจ้ง: ${swal.text}`);
      }
      if (i === 239) throw new Error('กดบันทึกแล้ว LTAX ไม่ตอบกลับ');
    }
    await this.assertNotLoggedOut();
    return this.messages();
  }
}

// ---------- record mapping ----------

const LTAX_SELECT_LISTS = {
  'land.docType': DOC_TYPES, 'land.utm2': UTM_SHEETS, 'land.scale': MAP_SCALES,
  'landUsed.usedType': LAND_USE_TYPES, 'landUsed.usedFor': LAND_USED_FOR, 'landUsed.agriType': AGRI_TYPES,
  'building.structure': STRUCTURES, 'buildingUsed.usedType': BUILDING_USE_TYPES, 'buildingUsed.usedFor': BUILDING_USED_FOR,
};
const numText = v => (v === '' || v === null || v === undefined ? '' : String(Number(String(v).replace(/,/g, ''))));

// What to put in an LTAX field for one L-LAN field definition.
export function ltaxItem(def, value) {
  if (def.key === 'buildingType') return { name: def.ltax, value, label: buildingTypeLabel(value) };
  if (def.ltaxSelect) return { name: def.ltax, label: value || '' };
  if (def.type === 'select') {
    const list = LTAX_SELECT_LISTS[def.ltax] || def.list;
    return { name: def.ltax, value, label: label(list, value) || value || '' };
  }
  if (def.type === 'checkbox') return { name: def.ltax, value: !!value };
  return { name: def.ltax, value: def.type === 'number' ? numText(value) : value ?? '' };
}

// LTAX form values → L-LAN record values for the given field definitions.
export function fromLtaxForm(defs, form) {
  const out = {};
  for (const d of defs) {
    const f = form[d.ltax];
    if (!f) continue;
    if (d.key === 'buildingType') out[d.key] = f.value || '';
    else if (d.ltaxSelect) out[d.key] = (f.text || '').replace(/\*/g, '').replace(/^กรุณาเลือก$/, '');
    else if (d.type === 'select') {
      const list = LTAX_SELECT_LISTS[d.ltax] || d.list;
      const t = (f.text || '').replace(/^กรุณาเลือก$/, '');
      out[d.key] = (list.find(([, l]) => l.replace(/\s+/g, '') === t.replace(/\s+/g, '')) || [f.value && list.some(([v]) => v === f.value) ? f.value : t])[0];
    } else if (d.type === 'checkbox') out[d.key] = !!f.checked;
    else if (d.type === 'number') out[d.key] = f.value === '' ? '' : numText(f.value);
    else out[d.key] = f.value ?? '';
  }
  return out;
}

export const sameValue = (a, b) => String(a ?? '').replace(/,/g, '').trim() === String(b ?? '').replace(/,/g, '').trim()
  || (a !== '' && b !== '' && Number(String(a).replace(/,/g, '')) === Number(String(b).replace(/,/g, '')));

export function fieldDiffs(defs, want, have) {
  return defs.filter(d => d.ltax && !sameValue(want[d.key], have[d.key]))
    .map(d => ({ field: d.key, th: d.th, ltax: have[d.key] ?? '', local: want[d.key] ?? '' }));
}

export const ENTITY_LTAX = {
  lands: { mode: 'land', searchField: 'parcelCode', key: 'parcelCode', prefixes: ['land.', 'amphurId', 'districtId'], idField: 'land.id', usesCmd: 'LandUsed', back: 'goBackLandForm', usePrefix: 'landUsed.', useSave: null },
  buildings: { mode: 'building', searchField: 'buildingCode', key: 'buildingCode', prefixes: ['building.'], idField: 'building.id', usesCmd: 'BuildingUsed', back: 'goBackBuildingForm', usePrefix: 'buildingUsed.', useSave: 'doSaveBuildingUsed' },
  owners: { mode: 'assetOwner', searchField: 'psnId', key: 'psnId', prefixes: ['assetOwner.', 'provinceId', 'amphurId', 'districtId', 'currProvinceId', 'currAmphurId', 'currDistrictId'], idField: 'assetOwner.id' },
};

export { pageListRows, pageSubTable };
export const defsFor = entity => ENTITIES[entity].fields.filter(d => d.ltax);
export const useDefsFor = entity => (ENTITIES[entity].uses || []).filter(d => d.ltax);
