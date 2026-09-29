// Renderizador 2D em <canvas> com zoom/pan, seleção (picking) e sobreposições.
import { pointInPoly } from './geometry.js';

const HIGHLIGHT = '#35b6ff';
const HOVER = '#ffd54a';
const MEASURE = '#ff5c8a';

export class Viewer {
  constructor(canvas, { onClick, onHover, onViewChange, onCursor, formatLen } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = { onClick, onHover, onViewChange, onCursor };
    this.formatLen = formatLen || ((v) => v.toFixed(2));
    this.scene = null;
    this.view = { cx: 0, cy: 0, s: 1 };
    this.hidden = new Set();
    this.selection = new Set();
    this.hover = null;
    this.measure = { active: false, points: [], cursor: null, snap: null };
    this.pointers = new Map();
    this.dpr = window.devicePixelRatio || 1;
    this._raf = 0;
    this._bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  // ------------------------------------------------------------------ cena
  setScene(scene) {
    this.scene = scene;
    const ex = scene.extents;
    this.origin = [(ex.minX + ex.maxX) / 2, (ex.minY + ex.maxY) / 2];
    const [ox, oy] = this.origin;
    for (const o of scene.objects) {
      const groups = new Map();
      o.texts = [];
      o.points = [];
      for (const p of o.prims) {
        if (p.kind === 'text') { o.texts.push(p); continue; }
        if (p.kind === 'point') { o.points.push({ ...p }); continue; }
        const key = p.color + '|' + (p.fill ? 'f' + (p.alpha ?? 1) : 's');
        let g = groups.get(key);
        if (!g) { g = { color: p.color, fill: !!p.fill, alpha: p.alpha ?? 1, path: new Path2D() }; groups.set(key, g); }
        const pts = p.pts;
        g.path.moveTo(pts[0][0] - ox, pts[0][1] - oy);
        for (let i = 1; i < pts.length; i++) g.path.lineTo(pts[i][0] - ox, pts[i][1] - oy);
        if (p.closed) g.path.closePath();
      }
      o.groups = [...groups.values()].sort((a, b) => b.fill - a.fill);
      // contorno para destaque (todas as polilinhas, sem preenchimento)
      const hp = new Path2D();
      for (const p of o.prims) {
        if (p.kind !== 'poly') continue;
        hp.moveTo(p.pts[0][0] - ox, p.pts[0][1] - oy);
        for (let i = 1; i < p.pts.length; i++) hp.lineTo(p.pts[i][0] - ox, p.pts[i][1] - oy);
        if (p.closed) hp.closePath();
      }
      o.highlightPath = hp;
    }
    this._buildIndex();
    this.selection.clear();
    this.hover = null;
    this.measure.points = [];
    this.fit();
  }

  _buildIndex() {
    const objs = this.scene.objects;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of objs) {
      minX = Math.min(minX, o.bbox.minX); minY = Math.min(minY, o.bbox.minY);
      maxX = Math.max(maxX, o.bbox.maxX); maxY = Math.max(maxY, o.bbox.maxY);
    }
    const n = Math.max(8, Math.min(256, Math.ceil(Math.sqrt(objs.length))));
    const w = Math.max(maxX - minX, 1e-9), h = Math.max(maxY - minY, 1e-9);
    const idx = { minX, minY, n, cw: w / n, ch: h / n, cells: new Map(), big: [] };
    for (const o of objs) {
      const [i0, j0] = this._cell(idx, o.bbox.minX, o.bbox.minY);
      const [i1, j1] = this._cell(idx, o.bbox.maxX, o.bbox.maxY);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) { idx.big.push(o); continue; }
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = i * 1024 + j;
        let c = idx.cells.get(k);
        if (!c) idx.cells.set(k, (c = []));
        c.push(o);
      }
    }
    this.index = idx;
  }

  _cell(idx, x, y) {
    const clamp = (v) => Math.max(0, Math.min(idx.n - 1, v));
    return [clamp(Math.floor((x - idx.minX) / idx.cw)), clamp(Math.floor((y - idx.minY) / idx.ch))];
  }

  _candidates(x0, y0, x1, y1) {
    const idx = this.index;
    const set = new Set(idx.big);
    const [i0, j0] = this._cell(idx, x0, y0);
    const [i1, j1] = this._cell(idx, x1, y1);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const c = idx.cells.get(i * 1024 + j);
      if (c) for (const o of c) set.add(o);
    }
    return set;
  }

  isVisible(o) {
    return !this.hidden.has(o.layer);
  }

  // ------------------------------------------------------------------ view
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.requestDraw();
  }

  fit(bbox) {
    const b = bbox || this.scene?.extents;
    if (!b) return;
    const w = Math.max(b.maxX - b.minX, 1e-9), h = Math.max(b.maxY - b.minY, 1e-9);
    const s = Math.min((this.W * 0.9) / w, (this.H * 0.9) / h);
    this.view = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, s: Number.isFinite(s) && s > 0 ? s : 1 };
    this._changed();
  }

  zoomTo(bbox) {
    const pad = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.6 || 1;
    this.fit({ minX: bbox.minX - pad, minY: bbox.minY - pad, maxX: bbox.maxX + pad, maxY: bbox.maxY + pad });
  }

  zoomAt(factor, sx = this.W / 2, sy = this.H / 2) {
    const [wx, wy] = this.toWorld(sx, sy);
    const s = Math.min(1e12, Math.max(1e-12, this.view.s * factor));
    this.view.s = s;
    this.view.cx = wx - (sx - this.W / 2) / s;
    this.view.cy = wy + (sy - this.H / 2) / s;
    this._changed();
  }

  toWorld(sx, sy) {
    return [this.view.cx + (sx - this.W / 2) / this.view.s, this.view.cy - (sy - this.H / 2) / this.view.s];
  }

  toScreen(wx, wy) {
    return [(wx - this.view.cx) * this.view.s + this.W / 2, this.H / 2 - (wy - this.view.cy) * this.view.s];
  }

  _changed() {
    this.requestDraw();
    this.cb.onViewChange?.(this.view);
  }

  // ------------------------------------------------------------------ picking
  pick(sx, sy, tolPx = 7) {
    if (!this.scene) return null;
    const [x, y] = this.toWorld(sx, sy);
    const tol = tolPx / this.view.s;
    let best = null;
    for (const o of this._candidates(x - tol, y - tol, x + tol, y + tol)) {
      if (!this.isVisible(o)) continue;
      const b = o.bbox;
      if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) continue;
      const d = this._distance(o, x, y, tol);
      if (d > tol) continue;
      const area = (b.maxX - b.minX) * (b.maxY - b.minY);
      if (!best || d < best.d - tol * 0.15 || (Math.abs(d - best.d) <= tol * 0.15 && area < best.area)) best = { o, d, area };
    }
    return best?.o || null;
  }

  _distance(o, x, y, tol) {
    let best = Infinity;
    for (const p of o.prims) {
      if (p.kind === 'text') { if (pointInPoly(x, y, p.corners)) return 0; continue; }
      const pts = p.pts;
      if (p.kind === 'point') { best = Math.min(best, Math.hypot(pts[0][0] - x, pts[0][1] - y)); continue; }
      const n = pts.length;
      const segs = p.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const d = segDist(x, y, a[0], a[1], b[0], b[1]);
        if (d < best) best = d;
      }
      if (p.closed && n > 2 && best > tol * 0.5 && pointInPoly(x, y, pts)) best = Math.min(best, p.fill ? 0 : tol * 0.9);
    }
    return best;
  }

  snapPoint(sx, sy, tolPx = 10) {
    const [x, y] = this.toWorld(sx, sy);
    const tol = tolPx / this.view.s;
    let best = null;
    for (const o of this._candidates(x - tol, y - tol, x + tol, y + tol)) {
      if (!this.isVisible(o)) continue;
      for (const p of o.prims) {
        if (p.kind === 'text') continue;
        for (const q of p.pts) {
          const d = Math.hypot(q[0] - x, q[1] - y);
          if (d <= tol && (!best || d < best.d)) best = { d, pt: q };
        }
      }
    }
    return best ? best.pt : null;
  }

  // ------------------------------------------------------------------ desenho
  requestDraw() {
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  _worldTransform() {
    const { cx, cy, s } = this.view;
    const d = this.dpr;
    const [ox, oy] = this.origin || [0, 0];
    this.ctx.setTransform(d * s, 0, 0, -d * s, d * ((ox - cx) * s + this.W / 2), d * (this.H / 2 - (oy - cy) * s));
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue('--canvas-bg').trim() || '#1b1f24';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.scene) return;
    const { s } = this.view;
    const [vx0, vy1] = this.toWorld(0, 0);
    const [vx1, vy0] = this.toWorld(this.W, this.H);
    const minPx = 0.4 / s;
    const visible = [];
    for (const o of this.scene.objects) {
      if (!this.isVisible(o)) continue;
      const b = o.bbox;
      if (b.maxX < vx0 || b.minX > vx1 || b.maxY < vy0 || b.minY > vy1) continue;
      visible.push(o);
    }

    this._worldTransform();
    ctx.lineWidth = 1 / s;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const o of visible) {
      const b = o.bbox;
      if (b.maxX - b.minX < minPx && b.maxY - b.minY < minPx && !o.points.length) continue;
      for (const g of o.groups) {
        if (g.fill) {
          ctx.globalAlpha = g.alpha;
          ctx.fillStyle = g.color;
          ctx.fill(g.path, 'evenodd');
          ctx.globalAlpha = 1;
          if (g.alpha < 0.5) { ctx.strokeStyle = g.color; ctx.stroke(g.path); }
        } else {
          ctx.strokeStyle = g.color;
          ctx.stroke(g.path);
        }
      }
    }

    // pontos e textos em espaço de tela
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    for (const o of visible) {
      for (const p of o.points) {
        const [sx, sy] = this.toScreen(p.pts[0][0], p.pts[0][1]);
        ctx.fillStyle = p.color;
        ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
      }
      for (const t of o.texts) this._drawText(t, t.color);
    }

    // hover e seleção
    this._worldTransform();
    if (this.hover && !this.selection.has(this.hover) && this.isVisible(this.hover)) this._drawHighlight(this.hover, HOVER, 2);
    for (const o of this.selection) this._drawHighlight(o, HIGHLIGHT, 3);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    if (this.selection.size) this._drawSelectionBox();
    this._drawMeasure();
  }

  _drawText(t, color) {
    const px = t.h * this.view.s;
    if (px < 1.5) return;
    const [sx, sy] = this.toScreen(t.x, t.y);
    if (sx < -px * 50 || sx > this.W + px * 50 || sy < -px * 50 || sy > this.H + px * 50) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-t.rot);
    ctx.scale((t.wf * px) / 100, px / 100);
    ctx.font = '100px Arial, Helvetica, sans-serif';
    ctx.textAlign = t.ha;
    ctx.textBaseline = t.va;
    ctx.fillStyle = color;
    ctx.fillText(t.text, 0, 0);
    ctx.restore();
  }

  _drawHighlight(o, color, w) {
    const ctx = this.ctx;
    ctx.lineWidth = w / this.view.s;
    ctx.strokeStyle = color;
    ctx.stroke(o.highlightPath);
    if (o.texts.length || o.points.length) {
      ctx.save();
      const d = this.dpr;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      for (const t of o.texts) this._drawText(t, color);
      for (const p of o.points) {
        const [sx, sy] = this.toScreen(p.pts[0][0], p.pts[0][1]);
        ctx.fillStyle = color;
        ctx.fillRect(sx - 3, sy - 3, 6, 6);
      }
      ctx.restore();
    }
  }

  _drawSelectionBox() {
    const ctx = this.ctx;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of this.selection) {
      minX = Math.min(minX, o.bbox.minX); minY = Math.min(minY, o.bbox.minY);
      maxX = Math.max(maxX, o.bbox.maxX); maxY = Math.max(maxY, o.bbox.maxY);
    }
    const [x0, y0] = this.toScreen(minX, maxY);
    const [x1, y1] = this.toScreen(maxX, minY);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = HIGHLIGHT;
    ctx.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
    ctx.setLineDash([]);
    if (x1 - x0 > 30 || y1 - y0 > 30) {
      label(ctx, `L ${this.formatLen(maxX - minX)}`, (x0 + x1) / 2, y0 - 12);
      label(ctx, `A ${this.formatLen(maxY - minY)}`, x1 + 8, (y0 + y1) / 2, 'left');
    }
    ctx.restore();
  }

  _drawMeasure() {
    const m = this.measure;
    if (!m.active) return;
    const ctx = this.ctx;
    const pts = [...m.points];
    if (pts.length === 1 && m.cursor) pts.push(m.cursor);
    ctx.save();
    ctx.strokeStyle = MEASURE;
    ctx.fillStyle = MEASURE;
    ctx.lineWidth = 2;
    const sp = pts.map((p) => this.toScreen(p[0], p[1]));
    if (sp.length === 2) {
      ctx.beginPath(); ctx.moveTo(...sp[0]); ctx.lineTo(...sp[1]); ctx.stroke();
      const dist = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      label(ctx, this.formatLen(dist), (sp[0][0] + sp[1][0]) / 2, (sp[0][1] + sp[1][1]) / 2 - 14, 'center', MEASURE);
    }
    for (const [x, y] of sp) { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); }
    if (m.snap) {
      const [x, y] = this.toScreen(m.snap[0], m.snap[1]);
      ctx.strokeStyle = '#7CFC9A';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 6, y - 6, 12, 12);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ eventos
  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(Math.exp(-delta * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const r = c.getBoundingClientRect();
      this.pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
      if (this.pointers.size === 1) this._drag = { x: e.clientX, y: e.clientY, moved: false, cx: this.view.cx, cy: this.view.cy };
      else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.view.s };
        if (this._drag) this._drag.moved = true;
      }
    });

    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: sx, y: sy });
      if (this.pointers.size === 2 && this._pinch) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const f = (this._pinch.s * (d / this._pinch.d)) / this.view.s;
        this.zoomAt(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      const drag = this._drag;
      if (drag && this.pointers.size === 1) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; c.classList.add('panning'); }
        if (drag.moved) {
          this.view.cx = drag.cx - dx / this.view.s;
          this.view.cy = drag.cy + dy / this.view.s;
          this._changed();
          return;
        }
      }
      const [wx, wy] = this.toWorld(sx, sy);
      this.cb.onCursor?.(wx, wy);
      if (this.measure.active) {
        this.measure.snap = this.snapPoint(sx, sy);
        this.measure.cursor = this.measure.snap || [wx, wy];
        this.requestDraw();
        return;
      }
      if (!this._hoverPending) {
        this._hoverPending = true;
        requestAnimationFrame(() => {
          this._hoverPending = false;
          const o = this.pick(sx, sy);
          if (o !== this.hover) {
            this.hover = o;
            c.style.cursor = o ? 'pointer' : '';
            this.cb.onHover?.(o);
            this.requestDraw();
          }
        });
      }
    });

    const end = (e) => {
      const r = c.getBoundingClientRect();
      const wasDrag = this._drag?.moved;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this._pinch = null;
      if (this.pointers.size === 0) {
        c.classList.remove('panning');
        this._drag = null;
        if (!wasDrag && e.type === 'pointerup' && e.button === 0) {
          const sx = e.clientX - r.left, sy = e.clientY - r.top;
          if (this.measure.active) {
            const pt = this.snapPoint(sx, sy) || this.toWorld(sx, sy);
            if (this.measure.points.length >= 2) this.measure.points = [];
            this.measure.points.push(pt);
            this.cb.onClick?.({ measure: this.measure.points.slice() });
            this.requestDraw();
          } else {
            this.cb.onClick?.({ object: this.pick(sx, sy), additive: e.shiftKey || e.ctrlKey || e.metaKey });
          }
        }
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.requestDraw(); } });
    c.addEventListener('dblclick', () => this.fit());
  }
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function label(ctx, text, x, y, align = 'center', bg = HIGHLIGHT) {
  ctx.font = '600 12px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 10;
  const bx = align === 'left' ? x : x - w / 2;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(bx, y - 9, w, 18, 4) : ctx.rect(bx, y - 9, w, 18);
  ctx.fill();
  ctx.fillStyle = '#0b1220';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 5, y + 0.5);
}
