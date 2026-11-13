// Map editing UI: draw parcels and buildings, reshape and delete shapes, snapping, GPS.
// Every change to stored data asks for confirmation first.
import { DrawTool } from './draw.js';
import { areaM2, centroid, pointInGeom, fromWgs84, toMercator, fromMercator } from './shared/proj.mjs';
import { minRect, nextBuildingCode, nextParcelCode, selfIntersects, splitRing } from './shared/geom.mjs';
import { fromWah, formatNumber, formatRNW } from './shared/calc.mjs';

const $ = s => document.querySelector(s);
const MODE_TH = { parcel: 'วาดรูปแปลงที่ดิน', 'building-rect': 'วาดอาคารสี่เหลี่ยม (คลิก 2 มุมของด้านหนึ่ง แล้วคลิกด้านตรงข้าม)', 'building-poly': 'วาดอาคาร', edit: 'แก้ไขรูป: ลากจุดเพื่อย้าย แตะจุดเล็กกลางเส้นเพื่อเพิ่มจุด แตะจุดแล้วกด "ลบจุด"',
  measure: 'วัดระยะและพื้นที่: แตะทีละจุด (ไม่บันทึกอะไร)', split: 'แบ่งแปลง: แตะจุดเริ่มนอกแปลง แล้วแตะจุดจบอีกด้านของแปลง', sign: 'ปักหมุดป้าย: แตะตำแหน่งที่ติดตั้งป้าย' };

export function setupMapEditing({ map, S, api, esc, toast, guard, confirmBox, reloadAll, selectFeature, openEditor, ownerNames, onMultiTool, lockOf = () => null }) {
  const draw = new DrawTool(map, { onFinish: guard(finishShape), onEditSave: guard(saveReshape), onStatus: status });
  let splitTarget = null;

  // ---------- toolbar ----------
  const setTool = async tool => {
    if (draw.dirty && !(await confirmBox('มีรูปที่วาดหรือแก้ค้างอยู่ ต้องการทิ้งหรือไม่?', { ok: 'ทิ้งรูปที่ค้าง', danger: true }))) return false;
    draw.stop();
    if (tool === 'split') {
      const f = map.selected;
      if (!f || f.kind !== 'parcel') { toast('แตะเลือกแปลงที่จะแบ่งบนแผนที่ก่อน แล้วกด "แบ่งแปลง"', true); tool = 'select'; }
      else if (lockOf(f.code)) { toast(`แปลง ${f.code}: ${lockOf(f.code).reason} แบ่งไม่ได้`, true); tool = 'select'; }
      else splitTarget = f;
    }
    if (tool === 'multi') onMultiTool?.();
    else if (tool !== 'select') {
      if (!S.layers.length && !(await confirmBox('ยังไม่มีชั้นแผนที่ L-LAN จะสร้างชั้นใหม่ให้เมื่อบันทึกรูปแรก ทำต่อหรือไม่?'))) return false;
      draw.start(tool);
    }
    document.querySelectorAll('#mapBar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
    return true;
  };
  // After a successful save the drawing is finished: leave draw mode without the "discard?" question.
  const resetTool = () => {
    draw.stop();
    document.querySelectorAll('#mapBar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === 'select'));
  };
  $('#mapBar').addEventListener('click', guard(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) await setTool(b.dataset.tool);
    else if (b.id === 'snapBtn') { draw.snapOn = !draw.snapOn; b.classList.toggle('on', draw.snapOn); toast(draw.snapOn ? 'เปิด Snap: จุดจะดูดติดจุดและเส้นของรูปข้างเคียง' : 'ปิด Snap'); }
    else if (b.id === 'gpsBtn') toggleGps(b);
    else if (b.id === 'addMenuBtn') toggleAddMenu(b);
    else if (b.id === 'zoomIn') map.zoomBy(0.6);
    else if (b.id === 'zoomOut') map.zoomBy(1 / 0.6);
    else if (b.id === 'zoomFit') map.fit(S.features.filter(f => f.kind === 'parcel').length ? map.layers.flatMap(l => l.features).filter(f => f.kind === 'parcel') : map.layers.flatMap(l => l.features));
  }));

  function status(st) {
    const bar = $('#drawBar');
    bar.hidden = !st;
    if (!st) return;
    const area = st.areaM2 ? ` · พื้นที่ ${formatNumber(st.areaM2)} ตร.ม. (${formatRNW(...Object.values(fromWah(st.areaM2 / 4)))} ไร่-งาน-วา)` : '';
    const len = st.mode === 'measure' && st.points > 1 ? ` · ระยะ ${formatNumber(st.lengthM)} ม.${st.perimeterM ? ` · รอบรูป ${formatNumber(st.perimeterM)} ม.` : ''}` : '';
    $('#drawStatus').innerHTML = `<b>${esc(MODE_TH[st.mode])}</b><br>${st.points} จุด${len}${area}${st.crossing ? ' · <span class="pill err">เส้นตัดกัน</span>' : ''}`;
    $('#drawUndo').disabled = !st.canUndo;
    $('#drawFinish').disabled = !st.canFinish;
    $('#drawFinish').textContent = st.mode === 'edit' ? '✓ บันทึกรูป' : '✓ เสร็จ';
    $('#drawDelVertex').hidden = st.mode !== 'edit';
    $('#drawDelVertex').disabled = !st.vertexSelected;
    $('#drawGps').hidden = st.mode === 'edit';
  }
  $('#drawUndo').addEventListener('click', () => draw.undo());
  $('#drawDelVertex').addEventListener('click', () => { if (!draw.deleteSelectedVertex()) toast('รูปต้องมีอย่างน้อย 3 จุด', true); });
  $('#drawFinish').addEventListener('click', () => draw.finish());
  $('#drawCancel').addEventListener('click', guard(() => setTool('select')));
  $('#drawGps').addEventListener('click', guard(async () => {
    if (!map.gps) return toast('ยังไม่มีตำแหน่ง GPS กดปุ่ม GPS ก่อน', true);
    const fix = { ...map.gps };
    if (fix.accuracy > 15 && !(await confirmBox(`ความแม่นยำ GPS ตอนนี้ ±${Math.round(fix.accuracy)} ม. ใช้จุดนี้หรือไม่?`, { ok: 'ใช้จุดนี้' }))) return;
    draw.addPoint([fix.lon, fix.lat]);
  }));
  document.addEventListener('keydown', e => {
    if (!draw.active || e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === 'Escape') guard(() => setTool('select'))();
    else if (e.key === 'Enter') draw.finish();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); draw.undo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') draw.deleteSelectedVertex();
  });
  window.addEventListener('beforeunload', e => { if (draw.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- GPS ----------
  let watch = null, centred = false;
  function toggleGps(btn) {
    if (watch !== null) {
      navigator.geolocation.clearWatch(watch); watch = null; map.gps = null; btn.classList.remove('on'); map.draw(); return;
    }
    if (!('geolocation' in navigator)) return toast('อุปกรณ์นี้ไม่มี GPS', true);
    if (!window.isSecureContext) return toast('เบราว์เซอร์อนุญาต GPS เฉพาะ https หรือเปิดจากเครื่องนี้ (127.0.0.1) เท่านั้น', true);
    btn.classList.add('on'); centred = false;
    toast('กำลังหาตำแหน่ง…');
    watch = navigator.geolocation.watchPosition(pos => {
      map.gps = { lon: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy };
      if (!centred) { centred = true; map.center = toMercator(map.gps.lon, map.gps.lat); map.res = Math.min(map.res, 1); toast(`ตำแหน่งของฉัน ±${Math.round(pos.coords.accuracy)} ม.`); }
      map.draw();
    }, err => {
      toast(err.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง กรุณาอนุญาตในเบราว์เซอร์' : `หาตำแหน่งไม่ได้: ${err.message}`, true);
      navigator.geolocation.clearWatch(watch); watch = null; btn.classList.remove('on');
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }

  // ---------- new shapes ----------
  const allCodes = () => [...S.features.map(f => f.code), ...S.rec.lands.map(l => l.parcelCode), ...S.rec.buildings.map(b => b.buildingCode)].filter(Boolean).map(c => c.toUpperCase());
  const parcelAt = lonlat => S.features.find(f => f.kind === 'parcel' && lonlat[0] >= f.bbox[0] && lonlat[0] <= f.bbox[2] && lonlat[1] >= f.bbox[1] && lonlat[1] <= f.bbox[3] && pointInGeom(lonlat, f.geometry));
  const nearestParcel = (lonlat, withLand) => {
    let best = null, bd = Infinity;
    for (const f of S.features) {
      if (f.kind !== 'parcel' || !f.code || (withLand && !S.landByCode.get(f.code))) continue;
      const c = [(f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2];
      const d = Math.hypot(c[0] - lonlat[0], c[1] - lonlat[1]);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  };

  function shapeDialog(html) {
    return new Promise(resolve => {
      const d = $('#shapeBox'), form = $('#shapeForm');
      form.innerHTML = html;
      d.onclose = () => resolve(d.returnValue === 'save' ? Object.fromEntries([...form.elements].filter(el => el.name).map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value.trim()])) : null);
      d.returnValue = ''; d.showModal();
    });
  }

  async function finishShape(mode, geometry, info) {
    if (mode === 'measure') return measured(info);
    if (mode === 'split') return splitParcel(geometry);
    if (mode === 'sign') return placeSign(geometry);
    const ring = geometry.coordinates[0].slice(0, -1);
    if (selfIntersects(ring) && !(await confirmBox('เส้นของรูปตัดกันเอง พื้นที่อาจคำนวณผิด ต้องการใช้รูปนี้ต่อหรือไม่?', { ok: 'ใช้ต่อ', danger: true }))) return;
    const area = areaM2(geometry);
    const c = centroid(geometry);
    if (mode === 'parcel') await newParcel(geometry, area, c);
    else await newBuilding(geometry, area, c);
  }

  async function newParcel(geometry, area, c) {
    const near = nearestParcel(c, false), nearLand = nearestParcel(c, true);
    const land0 = nearLand && S.landByCode.get(nearLand.code);
    const suggestion = near ? nextParcelCode(near.code, allCodes()) : '';
    const noShape = S.rec.lands.filter(l => l.parcelCode && !S.featByCode.has(l.parcelCode.toUpperCase()));
    const rnw = fromWah(area / 4);
    const res = await shapeDialog(`<h3>รูปแปลงที่ดินใหม่</h3>
      <p>เนื้อที่ตามรูป <b>${formatNumber(area / 4)} ตร.ว.</b> (${formatRNW(rnw.rai, rnw.ngan, rnw.wah)} ไร่-งาน-วา · ${formatNumber(area)} ตร.ม.)</p>
      <div class="form-row"><label>รหัสแปลงที่ดิน</label><input name="code" list="dlNewParcel" value="${esc(suggestion)}" required></div>
      <datalist id="dlNewParcel">${suggestion ? `<option value="${esc(suggestion)}">รหัสใหม่ถัดไปในบล็อกข้างเคียง</option>` : ''}
        ${noShape.slice(0, 3000).map(l => `<option value="${esc(l.parcelCode)}">ในทะเบียน ยังไม่มีรูป · ${esc(ownerNames(l.ownerIds))}</option>`).join('')}</datalist>
      <p class="muted">เลือกรหัสของที่ดินในทะเบียนที่ยังไม่มีรูป (${noShape.length.toLocaleString()} แปลง) เพื่อผูกรูปนี้กับข้อมูลเดิม หรือใช้รหัสใหม่ที่แนะนำ${near ? ` (แปลงใกล้ที่สุด ${esc(near.code)})` : ''}</p>
      <label class="check"><input type="checkbox" name="create" checked> ถ้ายังไม่มีในทะเบียน ให้สร้างข้อมูลที่ดินใหม่ โดยดึงเนื้อที่จากรูป และหมู่/ตำบลจากแปลงข้างเคียง${land0 ? ` (${esc(land0.parcelCode)}: หมู่ ${esc(land0.villageNo || '-')} ต.${esc(land0.district || '-')})` : ''}</label>
      <div class="row end"><button value="cancel" formnovalidate>ยกเลิก</button><button value="save" class="primary">บันทึกรูปแปลง</button></div>`);
    if (!res) return;
    const code = res.code.toUpperCase();
    if (S.featByCode.has(code) && !(await confirmBox(`มีรูปแปลงรหัส <b>${esc(code)}</b> ในแผนที่แล้ว ต้องการบันทึกซ้ำหรือไม่?`, { ok: 'บันทึกซ้ำ', danger: true }))) return;
    const land = S.landByCode.get(code);
    if (!(await confirmBox(`บันทึกรูปแปลงใหม่ <b>${esc(code || '(ไม่มีรหัส)')}</b> เนื้อที่ ${formatNumber(area / 4)} ตร.ว.?${land ? `<br>จะผูกกับที่ดินในทะเบียนของ ${esc(ownerNames(land.ownerIds) || '-')}` : ''}`))) return;
    const f = await api('POST', '/api/features', { kind: 'parcel', code, geometry });
    if (f.cloudWarning) toast(f.cloudWarning, true);
    resetTool();
    await reloadAll(); selectFeature(f.id);
    if (land) toast(`ผูกรูปกับที่ดิน ${code} ในทะเบียนแล้ว`);
    else if (res.create) openEditor('lands', null, { parcelCode: code, rai: String(rnw.rai), ngan: String(rnw.ngan), wah: String(rnw.wah),
      amphur: land0?.amphur || S.settings.amphur || '', district: land0?.district || '', villageNo: land0?.villageNo || '', ownerIds: [], uses: [] });
    else toast('บันทึกรูปแปลงแล้ว');
  }

  async function newBuilding(geometry, area, c) {
    const parcel = parcelAt(c);
    const land = parcel && S.landByCode.get(parcel.code);
    const utm = geometry.coordinates[0].map(([lon, lat]) => fromWgs84(lon, lat, 'EPSG:32648'));
    const { width, length } = minRect(utm);
    const suggestion = parcel?.code ? nextBuildingCode(parcel.code, allCodes()) : '';
    const unplaced = parcel?.code ? S.rec.buildings.filter(b => String(b.buildingCode || '').toUpperCase().startsWith(`${parcel.code}-`) && !S.featByCode.has(b.buildingCode.toUpperCase())) : [];
    const res = await shapeDialog(`<h3>รูปอาคารใหม่</h3>
      <p>${parcel ? `อยู่ในแปลง <b>${esc(parcel.code)}</b>${land ? ` · เจ้าของ ${esc(ownerNames(land.ownerIds) || '-')}` : ' (ยังไม่มีในทะเบียน)'}` : '<span class="pill warn">ไม่อยู่ในรูปแปลงใด</span>'}</p>
      <p>ขนาดตามรูป <b>${width.toFixed(2)} × ${length.toFixed(2)} ม.</b> · พื้นที่ ${formatNumber(area)} ตร.ม.</p>
      <div class="form-row"><label>รหัสสิ่งปลูกสร้าง</label><input name="code" list="dlNewBuilding" value="${esc(unplaced[0]?.buildingCode || suggestion)}"></div>
      <datalist id="dlNewBuilding">${suggestion ? `<option value="${esc(suggestion)}">รหัสใหม่ถัดไปในแปลงนี้</option>` : ''}
        ${unplaced.map(b => `<option value="${esc(b.buildingCode)}">ในทะเบียน ยังไม่มีรูป · เลขที่ ${esc(b.addrNo || '-')}</option>`).join('')}</datalist>
      ${unplaced.length ? `<p class="muted">อาคารของแปลงนี้ในทะเบียนที่ยังไม่มีรูป: ${unplaced.map(b => esc(b.buildingCode)).join(', ')}</p>` : ''}
      <div class="form-row"><label>จำนวนชั้น</label><input name="floors" type="number" min="1" value="1"></div>
      <label class="check"><input type="checkbox" name="create" checked> ถ้ายังไม่มีในทะเบียน ให้สร้างข้อมูลสิ่งปลูกสร้าง โดยดึงแปลงที่ตั้ง เจ้าของ หมู่ และขนาดจากรูป</label>
      <div class="row end"><button value="cancel" formnovalidate>ยกเลิก</button><button value="save" class="primary">บันทึกรูปอาคาร</button></div>`);
    if (!res) return;
    const code = res.code.toUpperCase();
    const existing = S.buildingByCode.get(code);
    if (!(await confirmBox(`บันทึกรูปอาคาร <b>${esc(code || '(ไม่มีรหัส)')}</b> ขนาด ${width.toFixed(2)} × ${length.toFixed(2)} ม.?${existing ? '<br>จะผูกกับสิ่งปลูกสร้างในทะเบียนที่มีอยู่' : ''}`))) return;
    const f = await api('POST', '/api/features', { kind: 'building', code, geometry });
    if (f.cloudWarning) toast(f.cloudWarning, true);
    resetTool();
    await reloadAll(); selectFeature(f.id);
    const floors = Math.max(1, Number(res.floors) || 1);
    if (existing) toast(`ผูกรูปกับสิ่งปลูกสร้าง ${code} ในทะเบียนแล้ว`);
    else if (res.create) openEditor('buildings', null, { buildingCode: code, landIds: land ? [land.id] : [], ownerIds: land ? [...(land.ownerIds || [])] : [],
      villageNo: land?.villageNo || '', width: width.toFixed(2), length: length.toFixed(2), noFloor: String(floors),
      totalArea: (Math.round(width * length * floors * 100) / 100).toFixed(2), uses: [] });
    else toast('บันทึกรูปอาคารแล้ว');
  }

  // ---------- measure, split a parcel, place a sign ----------
  async function measured(info) {
    const rnw = fromWah((info.areaM2 || 0) / 4);
    await confirmBox(`<h3>ผลการวัด</h3><dl class="kv"><dt>ระยะตามเส้น</dt><dd><b>${formatNumber(info.lengthM)}</b> ม.</dd>
      ${info.areaM2 ? `<dt>รอบรูป</dt><dd>${formatNumber(info.perimeterM)} ม.</dd><dt>พื้นที่</dt><dd><b>${formatNumber(info.areaM2)}</b> ตร.ม. · ${formatNumber(info.areaM2 / 4)} ตร.ว. (${formatRNW(rnw.rai, rnw.ngan, rnw.wah)} ไร่-งาน-วา)</dd>` : ''}</dl>
      <span class="muted">วัดบนแผนที่ ใช้ประกอบการสำรวจ ไม่ใช่การรังวัด</span>`, { ok: 'ปิด' });
    resetTool();
  }

  async function splitParcel(line) {
    const f = splitTarget;
    if (!f) { resetTool(); return toast('แตะเลือกแปลงที่จะแบ่งก่อน', true); }
    const g = f._mgeom;
    if (g.type !== 'Polygon' || g.coordinates.length > 1) { resetTool(); return toast('แบ่งได้เฉพาะรูปแปลงชิ้นเดียวที่ไม่มีรูกลวง', true); }
    const r = splitRing(g.coordinates[0].slice(0, -1), line.mercator[0], line.mercator[1]);
    if (r.error) { draw.undo(); draw.undo(); return toast(`${r.error} ลองลากเส้นใหม่`, true); }
    const toGeo = part => ({ type: 'Polygon', coordinates: [[...part, part[0]].map(([x, y]) => fromMercator(x, y))] });
    let [A, B] = r.parts.map(toGeo), aA = areaM2(A), aB = areaM2(B);
    if (aB > aA) { [A, B] = [B, A]; [aA, aB] = [aB, aA]; }
    const suggestion = nextParcelCode(f.code, allCodes());
    const res = await shapeDialog(`<h3>แบ่งแปลง ${esc(f.code)}</h3>
      <p>ส่วนที่ใหญ่กว่า <b>${formatNumber(aA / 4)} ตร.ว.</b> ใช้รหัสเดิม <b>${esc(f.code)}</b></p>
      <p>ส่วนที่แบ่งออก <b>${formatNumber(aB / 4)} ตร.ว.</b></p>
      <div class="form-row"><label>รหัสแปลงของส่วนที่แบ่งออก</label><input name="code" value="${esc(suggestion)}" required></div>
      <label class="check"><input type="checkbox" name="create" checked> สร้างข้อมูลที่ดินของส่วนที่แบ่งออก (เจ้าของ หมู่ ตำบล จากแปลงเดิม เนื้อที่จากรูป)</label>
      <p class="muted">เนื้อที่ในทะเบียนของแปลงเดิมไม่เปลี่ยนเอง ให้แก้ตามเอกสารสิทธิ์</p>
      <div class="row end"><button value="cancel" formnovalidate>ยกเลิก</button><button value="save" class="primary">แบ่งแปลง</button></div>`);
    if (!res) return resetTool();
    const code = res.code.toUpperCase();
    if (!code) return toast('ใส่รหัสแปลงของส่วนที่แบ่งออก', true);
    if (S.featByCode.has(code) && !(await confirmBox(`มีรูปแปลงรหัส <b>${esc(code)}</b> แล้ว ต้องการบันทึกซ้ำหรือไม่?`, { ok: 'บันทึกซ้ำ', danger: true }))) return;
    await api('PUT', `/api/features/${f.id}`, { geometry: A });
    const nf = await api('POST', '/api/features', { kind: 'parcel', code, geometry: B, layerId: f.layerId });
    resetTool(); splitTarget = null;
    await reloadAll(); selectFeature(nf.id);
    const land0 = S.landByCode.get(String(f.code).toUpperCase()), rnw = fromWah(aB / 4);
    if (res.create && !S.landByCode.get(code)) openEditor('lands', null, { parcelCode: code, rai: String(rnw.rai), ngan: String(rnw.ngan), wah: String(rnw.wah),
      docType: land0?.docType || '', amphur: land0?.amphur || S.settings.amphur || '', district: land0?.district || '', villageNo: land0?.villageNo || '',
      ownerIds: [...(land0?.ownerIds || [])], uses: [] });
    else toast(`แบ่งแปลงแล้ว: ${f.code} และ ${code}`);
  }

  async function placeSign(point) {
    resetTool();
    const [lon, lat] = point.coordinates;
    const parcel = parcelAt([lon, lat]), land = parcel && S.landByCode.get(String(parcel.code).toUpperCase());
    if (parcel && lockOf(parcel.code)) return toast(`แปลง ${parcel.code}: ${lockOf(parcel.code).reason}`, true);
    openEditor('signboards', null, { loc: { lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7 }, landId: land?.id || '', ownerIds: [...(land?.ownerIds || [])],
      villageNo: land?.villageNo || '', noSide: '1', unit: '1' });
    toast(parcel ? `ป้ายในแปลง ${parcel.code}: กรอกข้อมูลป้ายแล้วกดบันทึก` : 'ป้ายนี้ไม่อยู่ในรูปแปลงใด กรอกข้อมูลป้ายแล้วกดบันทึก');
  }

  // Quick add: records without a shape.
  function toggleAddMenu(btn) {
    let m = $('#addMenu');
    if (m) { m.remove(); return; }
    m = Object.assign(document.createElement('div'), { id: 'addMenu', className: 'add-menu' });
    m.innerHTML = `<button data-add="owners">👤 เจ้าของทรัพย์สินใหม่</button><button data-add="lands">▦ ที่ดินใหม่ (ยังไม่มีรูป)</button>
      <button data-add="buildings">⌂ สิ่งปลูกสร้างใหม่ (ยังไม่มีรูป)</button><button data-add="sign">📍 ป้ายใหม่ (ปักหมุดบนแผนที่)</button>
      <button data-add="parcel">⬠ วาดแปลงใหม่</button><button data-add="building-rect">▭ วาดอาคารใหม่</button>`;
    btn.closest('.map-wrap').append(m);
    m.addEventListener('click', guard(async e => {
      const a = e.target.closest('[data-add]')?.dataset.add; if (!a) return;
      m.remove();
      if (a === 'owners') openEditor('owners', null, { personType: 'บุคคลธรรมดา' });
      else if (a === 'lands') openEditor('lands', null, { amphur: S.settings.amphur || '', ownerIds: [], uses: [] });
      else if (a === 'buildings') openEditor('buildings', null, { ownerIds: [], landIds: [], uses: [] });
      else await setTool(a);
    }));
  }

  // ---------- reshape / delete ----------
  async function saveReshape(feature, geometry) {
    const before = feature.areaM2 || 0, after = areaM2(geometry);
    const ring = (geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[draw.part][0]).slice(0, -1);
    const warn = selfIntersects(ring) ? '<br><span class="pill err">เส้นของรูปตัดกันเอง</span>' : '';
    if (!(await confirmBox(`บันทึกการแก้รูป <b>${esc(feature.code || '(ไม่มีรหัส)')}</b>?<br>พื้นที่ ${formatNumber(before)} → <b>${formatNumber(after)}</b> ตร.ม. (${formatNumber(before / 4)} → ${formatNumber(after / 4)} ตร.ว.)${warn}`, { ok: 'บันทึกรูป' }))) return;
    const saved = await api('PUT', `/api/features/${feature.id}`, { geometry });
    if (saved.cloudWarning) toast(saved.cloudWarning, true);
    resetTool();
    toast('บันทึกรูปแล้ว');
    await reloadAll(); selectFeature(feature.id);
  }

  return {
    draw,
    async editShape(f) {
      if (!/Polygon/.test(f.geometry.type)) return toast('แก้ได้เฉพาะรูปหลายเหลี่ยม', true);
      if (!(await setTool('select'))) return;
      document.querySelectorAll('#mapBar [data-tool]').forEach(b => b.classList.remove('on'));
      draw.edit(f);
    },
    async deleteShape(f) {
      if (!(await confirmBox(`ลบรูป <b>${esc(f.code || '(ไม่มีรหัส)')}</b> ออกจากแผนที่?<br><span class="muted">ข้อมูลทะเบียนไม่ถูกลบ ลบเฉพาะรูปใน L-LAN</span>`, { ok: 'ลบรูป', danger: true }))) return;
      const del = await api('DELETE', `/api/features/${f.id}`);
      if (del.cloudWarning) toast(del.cloudWarning, true);
      map.selected = null;
      toast('ลบรูปแล้ว');
      await reloadAll(); selectFeature(null);
    },
  };
}
