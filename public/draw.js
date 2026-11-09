// Drawing and vertex editing on the MapView, in Web Mercator coordinates.
// Modes: 'parcel' and 'building-poly' (click points), 'building-rect' (3 clicks), 'edit' (move/insert/delete vertices).
import { fromMercator, toMercator } from './shared/proj.mjs';
import { dist, nearestOnSegment, rectFrom3, ringArea, selfIntersects } from './shared/geom.mjs';

const HANDLE = 14; // px: grab radius for vertices
const SNAP = 12;   // px: snap radius

export class DrawTool {
  constructor(map, { onFinish, onEditSave, onStatus }) {
    this.map = map; this.onFinish = onFinish; this.onEditSave = onEditSave; this.onStatus = onStatus;
    this.mode = null; this.snapOn = true;
    this.pts = []; this.history = [];
    this.cursor = null; this.snapHit = null; this.dragIndex = -1; this.selectedVertex = -1;
    map.drawOverlay = (ctx) => this.#paint(ctx);
  }

  get active() { return !!this.mode; }
  get dirty() { return this.mode === 'edit' ? this.history.length > 0 : this.pts.length > 0; }

  start(mode) {
    this.mode = mode; this.pts = []; this.history = []; this.cursor = null; this.selectedVertex = -1; this.feature = null;
    this.map.tool = this.#handlers();
    this.map.canvas.style.cursor = 'crosshair';
    this.#status();
    this.map.draw();
  }

  // Edit the outer ring of a polygon feature (largest part of a MultiPolygon; holes and other parts are kept).
  edit(feature) {
    const g = feature._mgeom;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let part = 0;
    polys.forEach((p, i) => { if (ringArea(p[0]) > ringArea(polys[part][0])) part = i; });
    const ring = polys[part][0].slice(0, -1).map(p => [...p]);
    this.start('edit');
    this.feature = feature; this.part = part; this.pts = ring;
    this.map.hidden = feature;
    this.#status();
    this.map.draw();
  }

  stop() {
    this.mode = null; this.pts = []; this.history = []; this.feature = null; this.snapHit = null;
    this.map.tool = null; this.map.hidden = null;
    this.map.canvas.style.cursor = '';
    this.onStatus?.(null);
    this.map.draw();
  }

  undo() {
    if (this.mode === 'edit') { if (this.history.length) this.pts = this.history.pop(); }
    else this.pts.pop();
    this.selectedVertex = -1;
    this.#status(); this.map.draw();
  }

  deleteSelectedVertex() {
    if (this.mode !== 'edit' || this.selectedVertex < 0 || this.pts.length <= 3) return false;
    this.#remember();
    this.pts.splice(this.selectedVertex, 1);
    this.selectedVertex = -1;
    this.#status(); this.map.draw();
    return true;
  }

  addPoint(lonlat) { // e.g. from GPS
    if (!this.mode || this.mode === 'edit') return;
    this.#add(toMercator(lonlat[0], lonlat[1]));
  }

  finish() {
    if (this.mode === 'edit') {
      if (this.pts.length < 3) return;
      this.onEditSave?.(this.feature, this.result());
      return;
    }
    const need = this.mode === 'building-rect' ? 4 : 3;
    if (this.pts.length < need) return;
    this.onFinish?.(this.mode, this.result());
  }

  // The drawn ring as a closed WGS84 GeoJSON Polygon (edit mode keeps the feature's other rings/parts).
  result() {
    const ring = [...this.pts, this.pts[0]].map(([x, y]) => fromMercator(x, y));
    if (this.mode !== 'edit') return { type: 'Polygon', coordinates: [ring] };
    const g = this.feature.geometry;
    if (g.type === 'Polygon') return { type: 'Polygon', coordinates: [ring, ...g.coordinates.slice(1)] };
    return { type: 'MultiPolygon', coordinates: g.coordinates.map((p, i) => (i === this.part ? [ring, ...p.slice(1)] : p)) };
  }

  // Ground metres for a Mercator length at the drawing's latitude.
  groundScale() {
    const y = this.pts[0]?.[1] ?? this.map.center[1];
    return Math.cos(fromMercator(0, y)[1] * Math.PI / 180);
  }
  info() {
    const k = this.groundScale();
    const closed = this.mode === 'building-rect' ? this.pts.length === 4 : this.pts.length >= 3;
    return { points: this.pts.length, areaM2: closed ? ringArea(this.pts) * k * k : 0, crossing: this.pts.length > 3 && selfIntersects(this.pts) };
  }

  // ---------- internals ----------

  #remember() { this.history.push(this.pts.map(p => [...p])); if (this.history.length > 100) this.history.shift(); }

  #add(p) {
    if (this.mode === 'building-rect') {
      if (this.pts.length === 2) { this.pts = rectFrom3(this.pts[0], this.pts[1], p) || this.pts; this.#status(); this.map.draw(); this.finish(); return; }
      if (this.pts.length >= 4) return;
    }
    this.pts.push(p);
    this.#status(); this.map.draw();
  }

  #status() {
    if (!this.mode) return;
    this.onStatus?.({ mode: this.mode, ...this.info(), canFinish: this.mode === 'building-rect' ? this.pts.length === 4 : this.pts.length >= 3,
      canUndo: this.mode === 'edit' ? this.history.length > 0 : this.pts.length > 0, vertexSelected: this.selectedVertex >= 0 });
  }

  #snap(p) {
    this.snapHit = null;
    if (!this.snapOn) return p;
    const tol = SNAP * this.map.res;
    let best = null;
    const consider = (q, kind) => { const d = dist(p, q); if (d <= tol && (!best || (kind === 'vertex' && best.kind !== 'vertex') || (kind === best.kind && d < best.d))) best = { q, d, kind }; };
    // Own vertices (close the ring, square corners)
    this.pts.forEach((q, i) => { if (i !== this.dragIndex) consider(q, 'vertex'); });
    if (this.map.gps) consider(toMercator(this.map.gps.lon, this.map.gps.lat), 'vertex');
    for (const layer of this.map.layers) {
      if (!layer.visible) continue;
      for (const f of layer.features) {
        if (f === this.feature) continue;
        const b = f._mbox;
        if (p[0] < b[0] - tol || p[0] > b[2] + tol || p[1] < b[1] - tol || p[1] > b[3] + tol) continue;
        const polys = f._mgeom.type === 'Polygon' ? [f._mgeom.coordinates] : f._mgeom.type === 'MultiPolygon' ? f._mgeom.coordinates : [];
        for (const poly of polys) for (const ring of poly) {
          for (let i = 0; i < ring.length - 1; i++) {
            consider(ring[i], 'vertex');
            consider(nearestOnSegment(p, ring[i], ring[i + 1]), 'edge');
          }
        }
      }
    }
    if (best) { this.snapHit = best; return [...best.q]; }
    return p;
  }

  #vertexAt(screen) {
    let found = -1, bd = HANDLE;
    this.pts.forEach((q, i) => { const s = this.map.toScreen(q); const d = Math.hypot(s[0] - screen[0], s[1] - screen[1]); if (d < bd) { bd = d; found = i; } });
    return found;
  }
  #midAt(screen) {
    if (this.mode !== 'edit') return -1;
    for (let i = 0; i < this.pts.length; i++) {
      const a = this.pts[i], b = this.pts[(i + 1) % this.pts.length];
      const s = this.map.toScreen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      if (Math.hypot(s[0] - screen[0], s[1] - screen[1]) < HANDLE - 2) return i;
    }
    return -1;
  }

  #handlers() {
    return {
      down: (p) => {
        const v = this.#vertexAt(p.screen);
        if (v >= 0 && (this.mode === 'edit' || this.mode === 'parcel' || this.mode === 'building-poly')) {
          if (this.mode === 'edit') this.#remember();
          this.dragIndex = v; this.selectedVertex = v; this.#status();
          return true;
        }
        const m = this.#midAt(p.screen);
        if (m >= 0) {
          this.#remember();
          this.pts.splice(m + 1, 0, p.map);
          this.dragIndex = m + 1; this.selectedVertex = m + 1;
          return true;
        }
        return false;
      },
      move: (p) => {
        if (this.dragIndex < 0) return;
        this.pts[this.dragIndex] = this.#snap(p.map);
        this.cursor = null; this.#status(); this.map.draw();
      },
      up: () => { this.dragIndex = -1; this.snapHit = null; this.#status(); this.map.draw(); },
      cancelDrag: () => { if (this.mode === 'edit' && this.history.length) this.pts = this.history.pop(); this.dragIndex = -1; this.map.draw(); },
      click: (p) => {
        if (this.mode === 'edit') {
          this.selectedVertex = this.#vertexAt(p.screen);
          this.#status(); this.map.draw();
          return true;
        }
        // Tapping the first point closes the shape.
        if (this.pts.length >= 3 && this.mode !== 'building-rect' && this.#vertexAt(p.screen) === 0) { this.finish(); return true; }
        this.#add(this.#snap(p.map));
        return true;
      },
      dblclick: () => { if (this.mode !== 'edit' && this.mode !== 'building-rect') { this.pts.pop(); this.finish(); } },
      hover: (p) => { this.cursor = this.#snap(p.map); this.map.draw(); },
    };
  }

  #paint(ctx) {
    if (!this.mode) return;
    const m = this.map;
    const sp = this.pts.map(q => m.toScreen(q));
    const sat = m.basemap === 'satellite';
    let ghost = [...sp];
    if (this.cursor && this.mode !== 'edit' && this.dragIndex < 0) {
      const c = m.toScreen(this.cursor);
      if (this.mode === 'building-rect' && this.pts.length === 2) ghost = rectFrom3(sp[0], sp[1], c) || ghost;
      else ghost.push(c);
    }
    if (ghost.length >= 2) {
      ctx.beginPath();
      ghost.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (ghost.length >= 3) ctx.closePath();
      ctx.fillStyle = this.info().crossing ? 'rgba(214,69,69,.25)' : 'rgba(0,229,255,.18)';
      if (ghost.length >= 3) ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = sat ? '#00e5ff' : '#0b7285'; ctx.setLineDash([]); ctx.stroke();
      // Length of the segment being drawn
      if (this.cursor && sp.length && this.mode !== 'edit') {
        const a = this.pts.at(-1), b = this.cursor, len = dist(a, b) * this.groundScale();
        const [x, y] = m.toScreen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        ctx.font = '12px Tahoma, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(`${len.toFixed(2)} ม.`, x, y - 8);
        ctx.fillStyle = '#fff'; ctx.fillText(`${len.toFixed(2)} ม.`, x, y - 8);
      }
    }
    // Midpoint handles (insert) and vertex handles
    if (this.mode === 'edit') {
      for (let i = 0; i < sp.length; i++) {
        const a = sp[i], b = sp[(i + 1) % sp.length];
        ctx.beginPath(); ctx.arc((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fill(); ctx.strokeStyle = '#0b7285'; ctx.lineWidth = 1; ctx.stroke();
      }
    }
    sp.forEach(([x, y], i) => {
      ctx.beginPath(); ctx.arc(x, y, i === this.selectedVertex ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = i === this.selectedVertex ? '#ff2d55' : i === 0 && this.mode !== 'edit' ? '#f5c451' : '#fff';
      ctx.fill(); ctx.strokeStyle = '#1d2733'; ctx.lineWidth = 1.5; ctx.stroke();
    });
    if (this.snapHit) {
      const [x, y] = m.toScreen(this.snapHit.q);
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.strokeStyle = '#ff00c8'; ctx.lineWidth = 2.5; ctx.stroke();
    }
  }
}
