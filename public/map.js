// Canvas map: Web Mercator view of WGS84 features, pan/zoom, click picking, labels, optional tile basemap.
import { toMercator, fromMercator, bboxOf, pointInGeom, centroid } from './shared/proj.mjs';

const TILE_SOURCES = {
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, credit: '© OpenStreetMap contributors' },
  // Esri has imagery to z18 in rural Udon Thani; z19 returns "Map data not yet available", so z18 is enlarged instead.
  satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 18, credit: 'ภาพ © Esri' },
};
const WORLD = 2 * Math.PI * 6378137;

export class MapView {
  constructor(canvas, { onSelect, onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layers = [];
    this.center = toMercator(102.15, 17.78);
    this.res = 20; // metres per CSS pixel
    this.basemap = 'none';
    this.tiles = new Map();
    this.selected = null;
    this.onSelect = onSelect; this.onHover = onHover;
    this.#bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${this.w}px`; this.canvas.style.height = `${this.h}px`;
    this.dpr = dpr;
    this.draw();
  }

  // layer: { id, features:[{id, geometry, code}], style(f) → {fill, stroke, width}, label(f) → text, visible }
  setLayer(layer) {
    for (const f of layer.features) if (!f._path) prepare(f);
    const i = this.layers.findIndex(l => l.id === layer.id);
    if (i >= 0) this.layers[i] = { ...this.layers[i], ...layer }; else this.layers.push({ visible: true, ...layer });
    this.draw();
  }
  removeLayer(id) { this.layers = this.layers.filter(l => l.id !== id); this.draw(); }
  setVisible(id, v) { const l = this.layers.find(x => x.id === id); if (l) { l.visible = v; this.draw(); } }
  setBasemap(name) { this.basemap = name; this.draw(); }

  fit(features, pad = 40) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of features) { const b = f._mbox || prepare(f)._mbox; box[0] = Math.min(box[0], b[0]); box[1] = Math.min(box[1], b[1]); box[2] = Math.max(box[2], b[2]); box[3] = Math.max(box[3], b[3]); }
    if (!isFinite(box[0])) return;
    this.center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    this.res = Math.max(0.05, Math.max((box[2] - box[0]) / Math.max(1, this.w - pad * 2), (box[3] - box[1]) / Math.max(1, this.h - pad * 2)));
    this.draw();
  }
  zoomTo(f, minRes = 0.25) {
    this.fit([f], 120);
    this.res = Math.max(this.res, minRes);
    this.draw();
  }

  toScreen([mx, my]) { return [(mx - this.center[0]) / this.res + this.w / 2, (this.center[1] - my) / this.res + this.h / 2]; }
  toMap([sx, sy]) { return [this.center[0] + (sx - this.w / 2) * this.res, this.center[1] - (sy - this.h / 2) * this.res]; }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.#render(); });
  }

  #render() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue('--map-bg') || '#eef1f4';
    ctx.fillRect(0, 0, this.w, this.h);
    if (this.basemap !== 'none') this.#drawTiles();
    const view = [...this.toMap([0, this.h]), ...this.toMap([this.w, 0])];
    const k = 1 / this.res;
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      ctx.setTransform(dpr * k, 0, 0, -dpr * k, dpr * (this.w / 2 - this.center[0] * k), dpr * (this.h / 2 + this.center[1] * k));
      for (const f of layer.features) {
        const b = f._mbox;
        if (b[2] < view[0] || b[0] > view[2] || b[3] < view[1] || b[1] > view[3]) continue;
        if (f === this.hidden) continue; // being edited: the draw tool paints it
        const s = layer.style(f);
        if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(f._path, 'evenodd'); }
        if (s.stroke) {
          // On imagery a dark halo under a bright line keeps boundaries readable.
          if (s.halo) { ctx.strokeStyle = s.halo; ctx.lineWidth = ((s.width || 1) + 2.5) * this.res; ctx.stroke(f._path); }
          ctx.strokeStyle = s.stroke; ctx.lineWidth = (s.width || 1) * this.res; ctx.stroke(f._path);
        }
      }
    }
    // Selection on top
    if (this.selected?._path && this.selected !== this.hidden) {
      ctx.strokeStyle = this.basemap === 'satellite' ? '#00e5ff' : '#ff2d55'; ctx.lineWidth = 3 * this.res; ctx.stroke(this.selected._path);
    }
    // Multi-selection outlines
    if (this.multi?.size) {
      ctx.strokeStyle = '#ff9800'; ctx.lineWidth = 3.5 * this.res;
      for (const f of this.multi) if (f._path) ctx.stroke(f._path);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#drawGps();
    this.drawOverlay?.(ctx, this);
    // Labels when zoomed in enough
    for (const layer of this.layers) {
      if (!layer.visible || !layer.label || this.res > (layer.labelRes || 1.2)) continue;
      ctx.font = `${layer.labelSize || 11}px "Leelawadee UI", Tahoma, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const f of layer.features) {
        const b = f._mbox;
        if (b[2] < view[0] || b[0] > view[2] || b[3] < view[1] || b[1] > view[3]) continue;
        const text = layer.label(f);
        if (!text) continue;
        const [x, y] = this.toScreen(f._mc);
        const dark = this.basemap === 'satellite';
        ctx.lineWidth = 3; ctx.strokeStyle = dark ? 'rgba(0,0,0,.8)' : 'rgba(255,255,255,.9)'; ctx.strokeText(text, x, y);
        ctx.fillStyle = dark ? '#fff' : '#1d2733'; ctx.fillText(text, x, y);
      }
    }
    this.#drawScale();
  }

  #drawTiles() {
    const src = TILE_SOURCES[this.basemap];
    if (!src) return;
    const z = Math.max(0, Math.min(src.max, Math.round(Math.log2(WORLD / 256 / this.res))));
    const n = 2 ** z, size = WORLD / n;
    const [x0, y0] = this.toMap([0, 0]), [x1, y1] = this.toMap([this.w, this.h]);
    const tx0 = Math.floor((x0 + WORLD / 2) / size), tx1 = Math.floor((x1 + WORLD / 2) / size);
    const ty0 = Math.floor((WORLD / 2 - y0) / size), ty1 = Math.floor((WORLD / 2 - y1) / size);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 120) return;
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= n) continue;
      const key = `${this.basemap}/${z}/${((tx % n) + n) % n}/${ty}`;
      let img = this.tiles.get(key);
      if (!img) {
        img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => this.draw();
        img.src = src.url.replace('{z}', z).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty);
        this.tiles.set(key, img);
        if (this.tiles.size > 600) this.tiles.delete(this.tiles.keys().next().value);
      }
      if (!img.complete || !img.naturalWidth) continue;
      const [sx, sy] = this.toScreen([tx * size - WORLD / 2, WORLD / 2 - ty * size]);
      const px = size / this.res;
      this.ctx.drawImage(img, sx, sy, px + 0.5, px + 0.5);
    }
    this.ctx.font = '10px Tahoma, sans-serif'; this.ctx.fillStyle = 'rgba(0,0,0,.6)'; this.ctx.textAlign = 'right';
    this.ctx.fillText(src.credit, this.w - 6, this.h - 6);
  }

  #drawGps() {
    if (!this.gps) return;
    const { ctx } = this;
    const [x, y] = this.toScreen(toMercator(this.gps.lon, this.gps.lat));
    const lat = this.gps.lat * Math.PI / 180;
    const r = Math.max(6, this.gps.accuracy / Math.cos(lat) / this.res);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(47,128,237,.15)'; ctx.fill();
    ctx.strokeStyle = 'rgba(47,128,237,.6)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = '#2f80ed'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
  }

  zoomBy(factor, at = [this.w / 2, this.h / 2]) {
    const before = this.toMap(at);
    this.res = Math.min(5000, Math.max(0.02, this.res * factor));
    const after = this.toMap(at);
    this.center = [this.center[0] + before[0] - after[0], this.center[1] + before[1] - after[1]];
    this.draw();
  }

  #drawScale() {
    const lat = fromMercator(...this.center)[1] * Math.PI / 180;
    const metres = this.res * 100 * Math.cos(lat);
    const nice = [1, 2, 5].flatMap(m => [1, 10, 100, 1000, 10000].map(p => m * p)).sort((a, b) => a - b).filter(v => v <= metres).pop() || 1;
    const px = nice / Math.cos(lat) / this.res;
    const { ctx } = this;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(10, this.h - 28, px + 50, 20);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(16, this.h - 14); ctx.lineTo(16 + px, this.h - 14); ctx.stroke();
    ctx.fillStyle = '#333'; ctx.font = '11px Tahoma, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} กม.` : `${nice} ม.`, 20 + px, this.h - 13);
  }

  pick(sx, sy) {
    const m = this.toMap([sx, sy]);
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (!layer.visible || layer.pickable === false) continue;
      for (let j = layer.features.length - 1; j >= 0; j--) {
        const f = layer.features[j], b = f._mbox;
        if (m[0] < b[0] || m[0] > b[2] || m[1] < b[1] || m[1] > b[3]) continue;
        if (pointInGeom(m, f._mgeom)) return { layer, feature: f };
      }
    }
    return null;
  }

  // A tool (drawing/editing) may set this.tool = { down(p, e) → true to own the drag, move(p, e), up(p, e),
  // click(p, e) → true when handled, hover(p, e) }. p is { screen:[x,y], map:[mx,my] }.
  #bind() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null, moved = false, pinch = null, owned = false;
    const at = e => { const r = c.getBoundingClientRect(); const s = [e.clientX - r.left, e.clientY - r.top]; return { screen: s, map: this.toMap(s) }; };
    const pinchState = () => {
      const [a, b] = [...pointers.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    };
    c.addEventListener('pointerdown', e => {
      try { c.setPointerCapture(e.pointerId); } catch { /* not every input source can be captured */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { // second finger: pinch zoom, cancel any drag
        const s = pinchState(), r = c.getBoundingClientRect();
        pinch = { ...s, res: this.res, anchor: this.toMap([s.cx - r.left, s.cy - r.top]) };
        drag = null; moved = true;
        if (owned) { this.tool?.cancelDrag?.(); owned = false; }
        return;
      }
      moved = false;
      owned = !!this.tool?.down?.(at(e), e);
      drag = owned ? null : { x: e.clientX, y: e.clientY, c: [...this.center] };
    });
    c.addEventListener('pointermove', e => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const s = pinchState(), r = c.getBoundingClientRect();
        this.res = Math.min(5000, Math.max(0.02, pinch.res * pinch.d / Math.max(1, s.d)));
        const sx = s.cx - r.left, sy = s.cy - r.top;
        this.center = [pinch.anchor[0] - (sx - this.w / 2) * this.res, pinch.anchor[1] + (sy - this.h / 2) * this.res];
        this.draw();
        return;
      }
      if (owned) { moved = true; this.tool.move?.(at(e), e); return; }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        if (moved) { this.center = [drag.c[0] - dx * this.res, drag.c[1] + dy * this.res]; this.draw(); }
      } else if (!pointers.size) {
        if (this.tool?.hover) this.tool.hover(at(e), e);
        else if (this.onHover) { const p = at(e); this.onHover(this.pick(...p.screen), e); }
      }
    });
    const end = e => {
      pointers.delete(e.pointerId);
      if (pinch) { if (pointers.size < 2) pinch = null; if (!pointers.size) { drag = null; owned = false; } return; }
      if (owned) { this.tool.up?.(at(e), e); owned = false; return; }
      if (drag && !moved && e.type === 'pointerup') {
        const p = at(e);
        if (!this.tool?.click?.(p, e)) {
          const hit = this.pick(...p.screen);
          this.selected = hit?.feature || null;
          this.draw();
          this.onSelect?.(hit);
        }
      }
      drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', e => { if (this.tool?.dblclick) { e.preventDefault(); this.tool.dblclick(at(e), e); } });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const p = [e.clientX - r.left, e.clientY - r.top];
      const before = this.toMap(p);
      this.res = Math.min(5000, Math.max(0.02, this.res * (e.deltaY > 0 ? 1.25 : 0.8)));
      const after = this.toMap(p);
      this.center = [this.center[0] + before[0] - after[0], this.center[1] + before[1] - after[1]];
      this.draw();
    }, { passive: false });
  }
}

// Mercator path, bbox and label point, cached on the feature.
function prepare(f) {
  const walk = c => (typeof c[0] === 'number' ? toMercator(c[0], c[1]) : c.map(walk));
  f._mgeom = { type: f.geometry.type, coordinates: walk(f.geometry.coordinates) };
  f._mbox = bboxOf(f._mgeom);
  f._mc = centroid(f._mgeom) || [(f._mbox[0] + f._mbox[2]) / 2, (f._mbox[1] + f._mbox[3]) / 2];
  const p = new Path2D();
  const ring = r => { r.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); };
  const g = f._mgeom;
  if (g.type === 'Polygon') g.coordinates.forEach(ring);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(ring));
  else if (g.type === 'LineString') g.coordinates.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  else if (g.type === 'MultiLineString') g.coordinates.forEach(l => l.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))));
  else if (g.type === 'Point') p.arc(g.coordinates[0], g.coordinates[1], 2, 0, Math.PI * 2);
  f._path = p;
  return f;
}
