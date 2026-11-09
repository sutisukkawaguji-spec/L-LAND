// Operations on several records at once, shared by the registry tab and the map selection:
// LTAX jobs in batches (with "continue from where it stopped"), checks, filling prices, deleting.
import { ENTITIES } from './shared/schema.mjs';
import { validateRecord } from './shared/validate.mjs';
import { formatNumber } from './shared/calc.mjs';

const $ = s => document.querySelector(s);
const JOB_TH = { check: 'ตรวจว่ามีใน LTAX (ค้นหาอย่างเดียว)', pull: 'ดึงข้อมูลจาก LTAX', 'push-dry': 'ทดลองกรอก LTAX (ไม่บันทึก)', 'push-real': 'บันทึกเข้า LTAX จริง' };

// Batch progress per list of records, kept in the browser so a later run continues where the last stopped.
const planKey = (type, mode, items) => `llan.plan.${type}.${mode}.${items.length}.${items.slice(0, 3).map(i => i.recordId || i.code).join(',')}`;
const loadPlan = key => { try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; } };
const savePlan = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ } };

export function createOps({ S, api, esc, toast, confirmBox, reloadAll, db, onJobStarted }) {
  function dialog(html) {
    return new Promise(resolve => {
      const d = $('#opsBox'), form = $('#opsForm');
      form.innerHTML = html;
      d.onclose = () => resolve(d.returnValue === 'ok' ? Object.fromEntries([...form.elements].filter(el => el.name).map(el => [el.name, el.type === 'checkbox' ? el.checked : el.type === 'radio' ? (el.checked ? el.value : undefined) : el.value]).filter(([, v]) => v !== undefined)) : null);
      d.returnValue = ''; d.showModal();
    });
  }

  // items: [{ entity, recordId }] or for checks [{ kind, code }]
  async function runJob(type, mode, items) {
    if (!items.length) return toast('ไม่มีรายการให้ทำ', true);
    if (S.session.mode !== 'ltax') return toast('ต้องเข้าสู่ระบบด้วย DLA SSO ก่อน (ตอนนี้ใช้งานแบบออฟไลน์)', true);
    const key = planKey(type, mode, items);
    const plan = loadPlan(key);
    const from = plan && plan.next <= items.length ? plan.next : 1;
    const res = await dialog(`<h3>${JOB_TH[type === 'push' ? `push-${mode}` : type]}</h3>
      <p>ทั้งหมด <b>${items.length.toLocaleString()}</b> รายการ${plan ? ` · ครั้งก่อนทำถึงลำดับ ${(plan.next - 1).toLocaleString()}` : ''}</p>
      <div class="form-row"><label>เริ่มที่ลำดับ</label><input name="from" type="number" min="1" max="${items.length}" value="${from}"></div>
      <div class="form-row"><label>จำนวนต่อรอบ</label><input name="count" type="number" min="1" value="${Math.min(20, items.length)}"></div>
      ${type === 'push' && mode === 'real' ? '<p class="pill err">ระบบจะกดบันทึกใน LTAX ONLINE จริงด้วยบัญชีที่เข้าสู่ระบบอยู่ และอ่านค่ากลับมาตรวจทุกรายการ</p>' : ''}
      <div class="row end"><button value="cancel" formnovalidate>ยกเลิก</button><button value="ok" class="${type === 'push' && mode === 'real' ? 'danger-fill' : 'primary'}">เริ่มงาน</button></div>`);
    if (!res) return;
    const start = Math.max(1, Math.min(items.length, Number(res.from) || 1)), count = Math.max(1, Number(res.count) || 20);
    const slice = items.slice(start - 1, start - 1 + count);
    const job = await api('POST', '/api/ltax/jobs', { type, mode, items: slice });
    savePlan(key, { next: start + slice.length, total: items.length, at: new Date().toISOString() });
    toast(`เริ่มงานลำดับ ${start}–${start + slice.length - 1} จาก ${items.length}`);
    onJobStarted?.(job);
  }

  function checkRecords(entity, ids) {
    const all = db();
    const rows = ids.map(id => S.by[entity].get(id)).filter(Boolean).map(r => ({ r, issues: validateRecord(entity, r, all, { areaTolerance: (S.settings.areaTolerance ?? 10) / 100 }) }));
    const errs = rows.filter(x => x.issues.some(i => i.level === 'error')).length, warns = rows.filter(x => x.issues.length && !x.issues.some(i => i.level === 'error')).length;
    return dialog(`<h3>ผลตรวจ ${rows.length.toLocaleString()} รายการ</h3>
      <div class="cards"><div class="card ok"><b>${(rows.length - errs - warns).toLocaleString()}</b>ผ่าน</div><div class="card warn"><b>${warns.toLocaleString()}</b>มีคำเตือน</div><div class="card err"><b>${errs.toLocaleString()}</b>ผิดพลาด (ส่งเข้า LTAX ไม่ได้)</div></div>
      <div class="scroll">${rows.filter(x => x.issues.length).slice(0, 300).map(x => `<p><b>${esc(ENTITIES[entity].title(x.r))}</b></p><ul class="issues">${x.issues.map(i => `<li class="${i.level}">${esc(i.message)}</li>`).join('')}</ul>`).join('') || '<p>ไม่มีปัญหา</p>'}</div>
      <div class="row end"><button value="cancel">ปิด</button></div>`);
  }

  async function fillPrices(entity, ids) {
    const preview = await api('POST', '/api/prices/fill', { entity, ids });
    if (!preview.rows.length) return toast('รายการที่เลือกมีราคาประเมินครบแล้ว');
    const can = preview.rows.filter(r => r.suggested !== null);
    const unit = entity === 'lands' ? 'บาท/ตร.ว.' : 'บาท/ตร.ม.';
    const res = await dialog(`<h3>เติมราคาประเมินที่ยังไม่มี</h3>
      <p>ยังไม่มีราคา ${preview.rows.length.toLocaleString()} รายการ · แนะนำได้ ${can.length.toLocaleString()} รายการ</p>
      <p class="muted">ราคาแนะนำมาจากราคาที่ใช้บ่อยที่สุดของ${entity === 'lands' ? 'แปลงในบล็อกเดียวกันที่เอกสารสิทธิ์ประเภทเดียวกัน' : 'อาคารประเภทเดียวกัน'}ในข้อมูล LTAX เดิม ควรตรวจกับบัญชีราคาประเมินของกรมธนารักษ์ก่อนบันทึกเข้า LTAX</p>
      <div class="scroll"><table class="grid"><tr><th>รายการ</th><th>ราคาแนะนำ (${unit})</th><th>ที่มา</th></tr>
        ${preview.rows.slice(0, 500).map(r => `<tr><td>${esc(r.title)}</td><td class="num">${r.suggested === null ? '-' : formatNumber(r.suggested)}</td><td>${esc(r.basis)}</td></tr>`).join('')}</table></div>
      <div class="row end"><button value="cancel" formnovalidate>ยกเลิก</button><button value="ok" class="primary" ${can.length ? '' : 'disabled'}>เติมราคา ${can.length.toLocaleString()} รายการ</button></div>`);
    if (!res) return;
    if (!(await confirmBox(`บันทึกราคาแนะนำให้ ${can.length.toLocaleString()} รายการ?<br><span class="muted">แก้ไขทีหลังได้ทุกรายการ และจะขึ้นเป็น "แก้ไขแล้ว รอส่ง"</span>`, { ok: 'เติมราคา' }))) return;
    const r = await api('POST', '/api/prices/fill', { entity, ids, apply: true });
    toast(`เติมราคาแล้ว ${r.applied.toLocaleString()} รายการ`);
    await reloadAll();
  }

  async function deleteOwner(id) {
    const o = S.by.owners.get(id);
    const rel = await api('GET', `/api/owners/${id}/related`);
    const list = (title, xs) => xs.length ? `<p><b>${title}</b> (${xs.length})</p><ul>${xs.slice(0, 50).map(x => `<li>${esc(x.title)}${x.shared ? ' <span class="pill">มีเจ้าของร่วม: ตัดเฉพาะชื่อนี้</span>' : ''}${x.ltaxId ? ' <span class="pill info">มีใน LTAX</span>' : ''}</li>`).join('')}</ul>` : '';
    const res = await dialog(`<h3>ลบเจ้าของทรัพย์สิน: ${esc(ENTITIES.owners.title(o))}</h3>
      ${list('ที่ดิน', rel.lands)}${list('สิ่งปลูกสร้าง', rel.buildings)}${list('ป้าย', rel.signboards)}${list('สิ่งปลูกสร้างของคนอื่นบนที่ดินที่จะลบ', rel.buildingsOnLand)}
      ${!rel.lands.length && !rel.buildings.length && !rel.signboards.length ? '<p class="muted">ไม่มีทรัพย์สินที่ผูกกับเจ้าของนี้</p>' : ''}
      <label class="check"><input type="radio" name="scope" value="owner" checked> ลบเฉพาะเจ้าของ (ทรัพย์สินยังอยู่ แค่ตัดชื่อเจ้าของออก)</label>
      <label class="check"><input type="radio" name="scope" value="all"> ลบเจ้าของพร้อมทรัพย์สินที่เป็นเจ้าของคนเดียว และอาคาร/ป้ายบนที่ดินนั้น</label>
      <label class="check"><input type="checkbox" name="withShapes"> ลบรูปแปลง/อาคารในแผนที่ของรายการที่ถูกลบด้วย</label>
      <p class="muted">ลบเฉพาะใน L-LAN เท่านั้น รายการที่มีใน LTAX จะไปอยู่ใน "รอลบใน LTAX" ที่หน้าสรุปการแก้ไข เพื่อให้ไปลบในระบบเอง</p>
      <label class="check warn"><input type="checkbox" name="sure" required> ฉันตรวจรายการข้างบนแล้ว และต้องการลบ</label>
      <div class="row end"><button value="cancel" formnovalidate>ยกเลิก</button><button value="ok" class="danger-fill">ลบ</button></div>`);
    if (!res) return false;
    const r = await api('POST', `/api/owners/${id}/delete`, { withAssets: res.scope === 'all', withShapes: !!res.withShapes });
    toast(`ลบแล้ว: เจ้าของ ${r.owners} · ที่ดิน ${r.lands} · สิ่งปลูกสร้าง ${r.buildings} · ป้าย ${r.signboards}${r.shapes ? ` · รูป ${r.shapes}` : ''}${r.unlinked ? ` · ตัดการเชื่อมโยง ${r.unlinked}` : ''}`);
    await reloadAll();
    return true;
  }

  async function deleteMany(entity, ids) {
    if (entity === 'owners' && ids.length === 1) return deleteOwner(ids[0]);
    const recs = ids.map(id => S.by[entity].get(id)).filter(Boolean);
    const inLtax = recs.filter(r => r.ltaxId).length;
    const res = await dialog(`<h3>ลบ${ENTITIES[entity].th} ${recs.length.toLocaleString()} รายการ</h3>
      <ul>${recs.slice(0, 30).map(r => `<li>${esc(ENTITIES[entity].title(r))}</li>`).join('')}${recs.length > 30 ? `<li>… อีก ${recs.length - 30} รายการ</li>` : ''}</ul>
      ${entity === 'owners' ? '<label class="check"><input type="checkbox" name="withAssets"> ลบทรัพย์สินที่เป็นเจ้าของคนเดียวด้วย</label>' : ''}
      ${['lands', 'buildings', 'owners'].includes(entity) ? '<label class="check"><input type="checkbox" name="withShapes"> ลบรูปในแผนที่ของรายการที่ถูกลบด้วย</label>' : ''}
      <p class="muted">ลบเฉพาะใน L-LAN${inLtax ? ` · ${inLtax} รายการมีใน LTAX จะไปอยู่ใน "รอลบใน LTAX"` : ''}</p>
      <label class="check warn"><input type="checkbox" name="sure" required> ฉันตรวจรายการแล้ว และต้องการลบ</label>
      <div class="row end"><button value="cancel" formnovalidate>ยกเลิก</button><button value="ok" class="danger-fill">ลบ ${recs.length.toLocaleString()} รายการ</button></div>`);
    if (!res) return false;
    const r = await api('POST', '/api/bulk/delete', { entity, ids, withAssets: !!res.withAssets, withShapes: !!res.withShapes });
    toast(`ลบแล้ว: ${Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${{ owners: 'เจ้าของ', lands: 'ที่ดิน', buildings: 'สิ่งปลูกสร้าง', signboards: 'ป้าย', shapes: 'รูป', unlinked: 'ตัดการเชื่อมโยง' }[k]} ${v}`).join(' · ')}`);
    await reloadAll();
    return true;
  }

  return { runJob, checkRecords, fillPrices, deleteOwner, deleteMany };
}
