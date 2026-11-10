// Map layers: shapefile import (any supported CRS → WGS84), join with the registry by code,
// building-in-parcel overlay check, and shapefile export with joined attributes.
const randomUUID = () => globalThis.crypto.randomUUID();
import { readShapefile, writeShapefile } from './shapefile.mjs';
import { crsFromPrj, geomToWgs84, geomFromWgs84, areaM2, bboxOf, centroid, pointInGeom, prjFor } from '../public/shared/proj.mjs';
import { repairObject } from '../public/shared/thai-text.mjs';
import { label, DOC_TYPES, UTM_SHEETS, buildingTypeLabel, STRUCTURES, LAND_USE_TYPES } from '../public/shared/schema.mjs';

const CODE_FIELDS = {
  parcel: ['parcel_cod', 'parcel_code', 'pcl_code', 'l_pcode', 'parcelcode', 'land_code'],
  building: ['building_c', 'building_code', 'bldg_code', 'b_code', 'buildingco'],
};

export function guessKind(fields, geometryType) {
  const names = fields.map(f => f.name.toLowerCase());
  if (CODE_FIELDS.building.some(n => names.includes(n))) return 'building';
  if (CODE_FIELDS.parcel.some(n => names.includes(n))) return 'parcel';
  return geometryType === 'Polygon' ? 'parcel' : 'other';
}
export function guessCodeField(fields, kind) {
  const names = fields.map(f => f.name);
  return names.find(n => (CODE_FIELDS[kind] || []).includes(n.toLowerCase())) || '';
}
export const normCode = s => String(s ?? '').trim().toUpperCase();

// files: { shp, dbf, shx?, prj?, cpg? } as Uint8Array/strings. Returns { layer, features } ready for the store.
export function importShapefile(name, files, opts = {}) {
  const shp = readShapefile(files);
  const crs = opts.crs || crsFromPrj(shp.prj)?.id;
  if (!crs) throw new Error(`ไม่รู้จักระบบพิกัดของ ${name} (.prj) กรุณาเลือกระบบพิกัดเอง`);
  const kind = opts.kind || guessKind(shp.fields, shp.geometryType);
  const codeField = opts.codeField ?? guessCodeField(shp.fields, kind);
  const layerId = opts.layerId || randomUUID();
  const repaired = {};
  const features = shp.features.filter(f => f.geometry).map(f => {
    for (const k of repairObject(f.properties)) repaired[k] = (repaired[k] || 0) + 1;
    const geometry = geomToWgs84(f.geometry, crs);
    return {
      id: randomUUID(), layerId, kind, fid: f.id,
      code: codeField ? normCode(f.properties[codeField]) : '',
      geometry, bbox: bboxOf(geometry), areaM2: /Polygon/.test(geometry.type) ? Math.round(areaM2(geometry) * 100) / 100 : 0,
      attrs: f.properties,
    };
  });
  const layer = {
    id: layerId, name, kind, crs, codeField, geometryType: shp.geometryType, encoding: shp.encoding,
    fields: shp.fields, prj: shp.prj || prjFor(crs), count: features.length, skippedNull: shp.features.length - features.length,
    importedAt: new Date().toISOString(), repairedText: repaired,
  };
  return { layer, features };
}

// Join features to registry records by code and report what did not join, like the office's join reports.
export function joinReport(db) {
  const out = { parcel: null, building: null };
  for (const [kind, entity, key] of [['parcel', 'lands', 'parcelCode'], ['building', 'buildings', 'buildingCode']]) {
    const feats = db.features.filter(f => f.kind === kind);
    if (!feats.length) continue;
    const recs = db[entity];
    const featByCode = new Map(), recByCode = new Map();
    for (const f of feats) if (f.code) featByCode.set(f.code, [...(featByCode.get(f.code) || []), f]);
    for (const r of recs) { const c = normCode(r[key]); if (c) recByCode.set(c, [...(recByCode.get(c) || []), r]); }
    const rows = feats.map(f => {
      const hits = f.code ? recByCode.get(f.code) || [] : [];
      const dupShape = f.code && featByCode.get(f.code).length > 1;
      return { featureId: f.id, fid: f.fid, code: f.code, status: !f.code ? 'ไม่มีรหัส' : hits.length ? 'จอยได้' : 'จอยไม่ได้',
        note: [dupShape && 'รหัสซ้ำในแผนที่', hits.length > 1 && 'รหัสซ้ำในทะเบียน'].filter(Boolean).join(', '), recordIds: hits.map(r => r.id) };
    });
    const missingShape = recs.filter(r => r[key] && !featByCode.has(normCode(r[key]))).map(r => ({ recordId: r.id, code: normCode(r[key]) }));
    out[kind] = {
      features: rows, recordsWithoutShape: missingShape,
      summary: { features: feats.length, joined: rows.filter(r => r.status === 'จอยได้').length, notJoined: rows.filter(r => r.status === 'จอยไม่ได้').length,
        noCode: rows.filter(r => r.status === 'ไม่มีรหัส').length, duplicateCodes: [...featByCode.values()].filter(v => v.length > 1).length,
        records: recs.length, recordsWithoutShape: missingShape.length },
    };
  }
  return out;
}

// Which parcel each building shape sits in, compared with the parcel code inside the building code.
export function overlayReport(db) {
  const parcels = db.features.filter(f => f.kind === 'parcel' && /Polygon/.test(f.geometry?.type));
  const rows = [];
  for (const b of db.features.filter(f => f.kind === 'building')) {
    const c = centroid(b.geometry);
    const inside = parcels.filter(p => c[0] >= p.bbox[0] && c[0] <= p.bbox[2] && c[1] >= p.bbox[1] && c[1] <= p.bbox[3] && pointInGeom(c, p.geometry));
    const expected = (b.code.match(/^([0-9]{2}[A-Z][0-9]{3})-/) || [])[1] || '';
    const at = inside.map(p => p.code).filter(Boolean);
    // Same wording as the office's overlay report (sp_check).
    let result;
    if (!expected) result = 'ไม่มีรหัส';
    else if (!inside.length) result = 'อยู่นอกแปลง';
    else if (at.includes(expected)) result = inside.length > 1 ? 'แปลงซ้อนกัน' : 'ตรงแปลง';
    else result = 'ไม่ตรงแปลง';
    rows.push({ featureId: b.id, fid: b.fid, code: b.code, expectedParcel: expected, foundParcels: at.join(', '), result, lon: c[0], lat: c[1] });
  }
  const summary = {};
  for (const r of rows) summary[r.result] = (summary[r.result] || 0) + 1;
  return { rows, summary };
}

// Shapefile export of one layer, in its source CRS, with the joined registry fields appended.
export function exportLayer(layer, db, { crs = layer.crs, encoding = 'utf-8' } = {}) {
  const feats = db.features.filter(f => f.layerId === layer.id);
  const base = layer.fields.map(f => ({ name: f.name, type: f.type === 'N' || f.type === 'F' ? 'N' : f.type === 'D' ? 'D' : f.type === 'L' ? 'L' : 'C', length: Math.min(f.length || 80, 254), decimals: f.decimals || 0 }));
  const extra = layer.kind === 'parcel' ? [
    ['l_ltaxid', 'C', 12], ['doc_type', 'C', 16], ['doc_no', 'C', 20], ['rawang', 'C', 20], ['l_landno', 'C', 10], ['l_survey', 'C', 12],
    ['moo', 'C', 4], ['tambon', 'C', 40], ['rai', 'N', 5], ['ngan', 'N', 3], ['wa', 'N', 8, 2], ['area_wa', 'N', 10, 2],
    ['map_wa', 'N', 10, 2], ['land_use', 'C', 120], ['owner', 'C', 120], ['join_stat', 'C', 20], ['pending', 'C', 10],
  ] : layer.kind === 'building' ? [
    ['b_ltaxid', 'C', 12], ['house_no', 'C', 20], ['moo', 'C', 4], ['b_type', 'C', 120], ['b_struct', 'C', 20], ['floors', 'N', 4],
    ['width_m', 'N', 8, 2], ['length_m', 'N', 8, 2], ['area_sqm', 'N', 10, 2], ['built_yr', 'N', 5], ['b_use', 'C', 120],
    ['parcel_cd', 'C', 10], ['owner', 'C', 120], ['join_stat', 'C', 20], ['pending', 'C', 10],
  ] : [];
  const taken = new Set(base.map(f => f.name.toLowerCase()));
  const extraFields = extra.filter(([n]) => !taken.has(n)).map(([name, type, length, decimals = 0]) => ({ name, type, length, decimals }));
  const owners = new Map(db.owners.map(o => [o.id, o]));
  const ownerNames = ids => (ids || []).map(id => owners.get(id)).filter(Boolean).map(o => [o.prefixName, o.firstName, o.lastName].filter(Boolean).join(' ')).join(', ');
  const lands = new Map(db.lands.map(l => [normCode(l.parcelCode), l]));
  const buildings = new Map(db.buildings.map(b => [normCode(b.buildingCode), b]));
  const features = feats.map(f => {
    const props = { ...f.attrs };
    if (layer.kind === 'parcel') {
      const l = lands.get(f.code);
      Object.assign(props, {
        l_ltaxid: l?.ltaxId || '', doc_type: l ? label(DOC_TYPES, l.docType) : '', doc_no: l?.docNo || '',
        rawang: l ? [l.utm1, label(UTM_SHEETS, l.utm2), l.utm3, l.utm4].filter(Boolean).join(' ') : '', l_landno: l?.parcelNo || '',
        l_survey: l?.dealingFileNo || '', moo: l?.villageNo || '', tambon: l?.district || '', rai: l?.rai || null, ngan: l?.ngan || null,
        wa: l?.wah || null, area_wa: l ? Number(l.rai || 0) * 400 + Number(l.ngan || 0) * 100 + Number(l.wah || 0) : null,
        map_wa: Math.round(f.areaM2 / 4 * 100) / 100, land_use: l ? (l.uses || []).map(u => label(LAND_USE_TYPES, u.usedType)).join(' / ') : '',
        owner: l ? ownerNames(l.ownerIds) : '', join_stat: l ? 'จอยได้' : f.code ? 'จอยไม่ได้' : 'ไม่มีรหัส', pending: l && l.pending ? l.pending : '',
      });
    } else if (layer.kind === 'building') {
      const b = buildings.get(f.code);
      Object.assign(props, {
        b_ltaxid: b?.ltaxId || '', house_no: b?.addrNo || '', moo: b?.villageNo || '', b_type: b ? buildingTypeLabel(b.buildingType) : '',
        b_struct: b ? label(STRUCTURES, b.structure) : '', floors: b?.noFloor || null, width_m: b?.width || null, length_m: b?.length || null,
        area_sqm: b?.totalArea || null, built_yr: b?.since || null, b_use: b ? (b.uses || []).map(u => label(LAND_USE_TYPES, u.usedType)).join(' / ') : '',
        parcel_cd: (f.code.match(/^([0-9]{2}[A-Z][0-9]{3})-/) || [])[1] || '', owner: b ? ownerNames(b.ownerIds) : '',
        join_stat: b ? 'จอยได้' : f.code ? 'จอยไม่ได้' : 'ไม่มีรหัส', pending: b && b.pending ? b.pending : '',
      });
    }
    return { geometry: geomFromWgs84(f.geometry, crs), properties: props };
  });
  const gt = /Polygon/.test(layer.geometryType) ? 'Polygon' : /Line/.test(layer.geometryType) ? 'LineString' : layer.geometryType === 'MultiPoint' ? 'MultiPoint' : 'Point';
  return writeShapefile({ geometryType: gt, fields: [...base, ...extraFields], features, prj: prjFor(crs) || layer.prj, encoding });
}
