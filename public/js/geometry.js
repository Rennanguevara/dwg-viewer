// Converte o DwgDatabase (libredwg-web) em "objetos" desenháveis com geometria
// em coordenadas do mundo (WCS) e métricas (largura, altura, comprimento, área...).
import { Color, evaluateBSpline } from './libs.js';

const TAU = Math.PI * 2;
const MAX_DEPTH = 12;

// ---------------------------------------------------------------------------
// Matriz afim 2D [a, b, c, d, e, f] => x' = a*x + c*y + e ; y' = b*x + d*y + f
// ---------------------------------------------------------------------------
const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const rotate = (a) => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const isIdentity = (m) => m === IDENTITY;

// Entidades definidas em OCS: se a extrusão aponta para -Z o desenho é espelhado em X.
const OCS_TYPES = new Set(['ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE2D', 'TEXT', 'INSERT', 'SOLID', 'HATCH']);
const ocsMatrix = (e) =>
  OCS_TYPES.has(e.type) && e.extrusionDirection && e.extrusionDirection.z < -0.5 ? scale(-1, 1) : IDENTITY;

// ---------------------------------------------------------------------------
// Tesselação de curvas
// ---------------------------------------------------------------------------
function arcPoints(cx, cy, r, a0, a1, ccw = true) {
  let sweep = ccw ? a1 - a0 : a0 - a1;
  while (sweep <= 1e-12) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const n = Math.max(4, Math.ceil((sweep / TAU) * 96));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (ccw ? 1 : -1) * (sweep * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function ellipsePoints(cx, cy, mx, my, ratio, t0, t1, ccw = true) {
  let sweep = ccw ? t1 - t0 : t0 - t1;
  while (sweep <= 1e-12) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const n = Math.max(8, Math.ceil((sweep / TAU) * 128));
  const nx = -my * ratio, ny = mx * ratio; // eixo menor
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (ccw ? 1 : -1) * (sweep * i) / n;
    const c = Math.cos(t), s = Math.sin(t);
    pts.push([cx + mx * c + nx * s, cy + my * c + ny * s]);
  }
  return pts;
}

// Segmento com bulge (arco de polilinha). Retorna pontos intermediários + comprimento real do arco.
function bulgeSegment(x0, y0, x1, y1, bulge) {
  const chord = Math.hypot(x1 - x0, y1 - y0);
  if (!bulge || Math.abs(bulge) < 1e-9 || chord < 1e-12) return { pts: [], len: chord };
  const theta = 4 * Math.atan(bulge); // ângulo incluído (sinal = sentido)
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  // distância (com sinal) do centro à corda; negativa quando o arco passa de 180°
  const h = r * Math.cos(Math.abs(theta) / 2);
  // normal à corda (à esquerda da direção p0->p1)
  const nx = -(y1 - y0) / chord, ny = (x1 - x0) / chord;
  const sign = bulge > 0 ? 1 : -1;
  const cx = mx + nx * h * sign, cy = my + ny * h * sign;
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const n = Math.max(2, Math.ceil((Math.abs(theta) / TAU) * 96));
  const pts = [];
  for (let i = 1; i < n; i++) {
    const a = a0 + (theta * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return { pts, len: Math.abs(r * theta) };
}

function bulgePolyline(verts, closed) {
  const out = [];
  let length = 0;
  const n = verts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    out.push([a.x, a.y]);
    const s = bulgeSegment(a.x, a.y, b.x, b.y, a.bulge || 0);
    out.push(...s.pts);
    length += s.len;
  }
  if (n) {
    if (!closed) out.push([verts[n - 1].x, verts[n - 1].y]);
  }
  return { pts: out, length };
}

function splinePoints(sp) {
  const cps = (sp.controlPoints || []).map((p) => [p.x, p.y]);
  const deg = sp.degree || 3;
  const knots = sp.knots || [];
  if (cps.length > deg && knots.length === cps.length + deg + 1) {
    const w = sp.weights && sp.weights.length === cps.length ? sp.weights : undefined;
    const n = Math.min(2000, Math.max(32, cps.length * 16));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      try {
        pts.push(evaluateBSpline(i / n, deg, cps, knots, w));
      } catch {
        /* ignora ponto inválido */
      }
    }
    if (pts.length > 1) return pts;
  }
  const fit = (sp.fitPoints || []).map((p) => [p.x, p.y]);
  return fit.length > 1 ? fit : cps;
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------
const measureCtx = (() => {
  try {
    return (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas')).getContext('2d');
  } catch {
    return null;
  }
})();
if (measureCtx) measureCtx.font = '100px Arial, Helvetica, sans-serif';
const textWidth = (s, h) => (measureCtx ? (measureCtx.measureText(s).width / 100) * h : s.length * h * 0.6);

export function cleanMText(t) {
  return String(t || '')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\P/g, '\n')
    .replace(/\\[LOlo]/g, '')
    .replace(/\\[Ff][^;\\]*?(?:\|[^;\\]*)*;/g, '')
    .replace(/\\[KkCcHhWwTtAaQq][^;\\]*;?/g, '')
    .replace(/\\S([^;]*);/g, (_, s) => s.replace(/[#^]/g, '/'))
    .replace(/\\[a-zA-Z]+;?/g, '')
    .replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, 'Ø').replace(/%%%/g, '%')
    .replace(/\\\\/g, '\\')
    .replace(/\\~/g, ' ')
    .replace(/[{}]/g, '');
}

// Cria um "primitivo de texto" no mundo. local: anchor (x,y), altura h, rotação rot,
// fator de largura wf, alinhamento horizontal ha (left|center|right) e vertical va.
function makeText(m, x, y, h, rot, wf, ha, va, text) {
  const [wx, wy] = apply(m, x, y);
  const ux = m[0] * Math.cos(rot) + m[2] * Math.sin(rot);
  const uy = m[1] * Math.cos(rot) + m[3] * Math.sin(rot);
  const vx = -m[0] * Math.sin(rot) + m[2] * Math.cos(rot);
  const vy = -m[1] * Math.sin(rot) + m[3] * Math.cos(rot);
  const hs = h * Math.hypot(vx, vy);
  const wfs = (wf || 1) * (Math.hypot(ux, uy) / (Math.hypot(vx, vy) || 1));
  const angle = Math.atan2(uy, ux);
  const w = textWidth(text, hs) * wfs;
  const x0 = ha === 'center' ? -w / 2 : ha === 'right' ? -w : 0;
  const y0 = va === 'middle' ? -hs / 2 : va === 'top' ? -hs : va === 'bottom' ? 0 : -0.2 * hs;
  const y1 = va === 'middle' ? hs / 2 : va === 'top' ? 0 : hs;
  const c = Math.cos(angle), s = Math.sin(angle);
  const corners = [[x0, y0], [x0 + w, y0], [x0 + w, y1], [x0, y1]].map(([px, py]) => [wx + px * c - py * s, wy + px * s + py * c]);
  return { kind: 'text', x: wx, y: wy, h: hs, rot: angle, wf: wfs, ha, va, text, corners };
}

const HALIGN = ['left', 'center', 'right', 'left', 'center', 'left'];
const VALIGN = ['alphabetic', 'bottom', 'middle', 'top'];

function textPrims(m, t) {
  if (!t || !t.text) return [];
  const text = cleanMText(t.text);
  const h = t.textHeight || 1;
  const useAlign = (t.halign || 0) !== 0 || (t.valign || 0) !== 0;
  const p = useAlign && t.endPoint && t.halign !== 3 && t.halign !== 5 ? t.endPoint : t.startPoint;
  if (!p) return [];
  const ha = HALIGN[t.halign || 0] || 'left';
  const va = t.halign === 4 ? 'middle' : VALIGN[t.valign || 0] || 'alphabetic';
  return [makeText(m, p.x, p.y, h, t.rotation || 0, t.xScale || 1, ha, va, text)];
}

function mtextPrims(m, e) {
  const lines = cleanMText(e.text).split('\n').map((l) => l.trim()).filter((l) => l.length);
  if (!lines.length || !e.insertionPoint) return [];
  const h = e.textHeight || 1;
  const gap = h * (5 / 3) * (e.lineSpacing || 1);
  const ap = e.attachmentPoint || 1;
  const col = (ap - 1) % 3; // 0 esq, 1 centro, 2 dir
  const row = Math.floor((ap - 1) / 3); // 0 topo, 1 meio, 2 base
  const ha = ['left', 'center', 'right'][col];
  const n = lines.length;
  const blockH = h + (n - 1) * gap;
  let rot = e.rotation || 0;
  if (e.direction && (Math.abs(e.direction.x) > 1e-9 || Math.abs(e.direction.y) > 1e-9)) rot = Math.atan2(e.direction.y, e.direction.x);
  const c = Math.cos(rot), s = Math.sin(rot);
  return lines.map((line, i) => {
    const base = row === 0 ? -h - i * gap : row === 1 ? blockH / 2 - h - i * gap : (n - 1 - i) * gap;
    const x = e.insertionPoint.x - base * s;
    const y = e.insertionPoint.y + base * c;
    return makeText(m, x, y, h, rot, 1, ha, 'alphabetic', line);
  });
}

// ---------------------------------------------------------------------------
// Cores
// ---------------------------------------------------------------------------
function aciToRgb(i) {
  const c = new Color();
  c.colorIndex = i;
  return c.color;
}
const rgbCss = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');

function resolveColor(e, layerMap, parent) {
  const ci = e.colorIndex;
  let rgb;
  if (ci === 0) return parent; // ByBlock
  if (ci != null && ci > 0 && ci < 256) rgb = e.color != null && e.color > 0 && ci === 7 ? e.color : aciToRgb(ci);
  else if (ci == null && e.color != null) rgb = e.color;
  else {
    // ByLayer
    const layer = layerMap.get(e.layer);
    if (layer) {
      const lci = Math.abs(layer.colorIndex ?? 7);
      rgb = lci > 0 && lci < 256 ? aciToRgb(lci) : layer.color;
    }
  }
  if (rgb == null) rgb = 0xffffff;
  // Fundo escuro: preto/ACI 7 viram branco
  if ((rgb & 0xffffff) === 0) rgb = 0xffffff;
  return rgbCss(rgb);
}

// ---------------------------------------------------------------------------
// Construção dos primitivos de uma entidade
// ---------------------------------------------------------------------------
function poly(m, pts, closed = false, fill = false) {
  const out = isIdentity(m) ? pts : pts.map(([x, y]) => apply(m, x, y));
  return { kind: 'poly', pts: out, closed, fill };
}

class Builder {
  constructor(db) {
    this.db = db;
    this.layerMap = new Map((db.tables?.LAYER?.entries || []).map((l) => [l.name, l]));
    this.blocks = new Map();
    for (const b of db.tables?.BLOCK_RECORD?.entries || []) {
      this.blocks.set(b.name, b);
      this.blocks.set(String(b.name).toUpperCase(), b);
    }
    this.unsupported = {};
  }

  getBlock(name) {
    return this.blocks.get(name) || this.blocks.get(String(name).toUpperCase());
  }

  // Adiciona primitivos em `out` (cada primitivo recebe cor). `info` recebe métricas.
  entity(e, m, color, out, depth, info) {
    if (!e || e.isVisible === false) return;
    const ecolor = resolveColor(e, this.layerMap, color);
    m = mul(m, ocsMatrix(e));
    const push = (p) => { p.color = ecolor; out.push(p); return p; };
    switch (e.type) {
      case 'LINE': {
        push(poly(m, [[e.startPoint.x, e.startPoint.y], [e.endPoint.x, e.endPoint.y]]));
        if (info) {
          info.start = e.startPoint; info.end = e.endPoint;
          info.length = Math.hypot(e.endPoint.x - e.startPoint.x, e.endPoint.y - e.startPoint.y);
          info.angle = Math.atan2(e.endPoint.y - e.startPoint.y, e.endPoint.x - e.startPoint.x);
        }
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE2D':
      case 'POLYLINE3D': {
        if (e.type !== 'LWPOLYLINE' && e.flag & 64) { this.polyface(e, m, push); break; }
        const closed = e.type === 'LWPOLYLINE' ? !!(e.flag & 0x200) : !!(e.flag & 1);
        let verts = e.vertices || [];
        if (e.flag & 4) verts = verts.filter((v) => !(v.flag & 16));
        const { pts, length } = bulgePolyline(verts, closed);
        if (pts.length < 2) break;
        const p = push(poly(m, pts, closed));
        if (info) {
          info.vertices = verts.length; info.closed = closed; info.length = length;
          if (closed) info.area = Math.abs(signedArea(p.pts));
          const w = e.constantWidth || e.startWidth;
          if (w) info.polyWidth = w;
        }
        break;
      }
      case 'CIRCLE': {
        push(poly(m, arcPoints(e.center.x, e.center.y, e.radius, 0, TAU), true));
        if (info) { info.center = e.center; info.radius = e.radius; info.length = TAU * e.radius; info.area = Math.PI * e.radius ** 2; }
        break;
      }
      case 'ARC': {
        push(poly(m, arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle)));
        if (info) {
          let sweep = e.endAngle - e.startAngle;
          while (sweep <= 0) sweep += TAU;
          info.center = e.center; info.radius = e.radius; info.sweep = sweep; info.length = e.radius * sweep;
          info.startAngle = e.startAngle; info.endAngle = e.endAngle;
        }
        break;
      }
      case 'ELLIPSE': {
        const full = Math.abs(e.endAngle - e.startAngle) < 1e-9 || Math.abs(Math.abs(e.endAngle - e.startAngle) - TAU) < 1e-9;
        const pts = ellipsePoints(e.center.x, e.center.y, e.majorAxisEndPoint.x, e.majorAxisEndPoint.y, e.axisRatio, full ? 0 : e.startAngle, full ? TAU : e.endAngle);
        const p = push(poly(m, pts, full));
        if (info) {
          const a = Math.hypot(e.majorAxisEndPoint.x, e.majorAxisEndPoint.y);
          info.center = e.center; info.majorRadius = a; info.minorRadius = a * e.axisRatio;
          info.length = polyLength(p.pts, full);
          if (full) info.area = Math.PI * a * a * e.axisRatio;
        }
        break;
      }
      case 'SPLINE': {
        const pts = splinePoints(e);
        if (pts.length < 2) break;
        const closed = !!(e.flag & 1);
        const p = push(poly(m, pts, closed));
        if (info) { info.length = polyLength(p.pts, closed); info.controlPoints = (e.controlPoints || []).length; }
        break;
      }
      case 'SOLID':
      case 'TRACE': {
        const c = [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3].filter(Boolean).map((p) => [p.x, p.y]);
        const p = push(poly(m, c, true, true));
        p.alpha = 0.9;
        if (info) info.area = Math.abs(signedArea(p.pts));
        break;
      }
      case '3DFACE': {
        const c = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean).map((p) => [p.x, p.y]);
        push(poly(m, c, true));
        break;
      }
      case 'POINT': {
        const [x, y] = apply(m, e.position.x, e.position.y);
        push({ kind: 'point', pts: [[x, y]] });
        if (info) info.position = e.position;
        break;
      }
      case 'LEADER': {
        const pts = (e.vertices || []).map((v) => [v.x, v.y]);
        if (pts.length > 1) push(poly(m, pts));
        break;
      }
      case 'MLINE': {
        this.mline(e, m, push, info);
        break;
      }
      case 'HATCH': {
        this.hatch(e, m, push, info);
        break;
      }
      case 'TEXT': {
        for (const t of textPrims(m, e)) push(t);
        if (info) { info.text = cleanMText(e.text); info.textHeight = e.textHeight; }
        break;
      }
      case 'MTEXT': {
        for (const t of mtextPrims(m, e)) push(t);
        if (info) { info.text = cleanMText(e.text); info.textHeight = e.textHeight; }
        break;
      }
      case 'ATTRIB': {
        if (e.flags & 1) break;
        for (const t of textPrims(m, e.text)) push(t);
        if (info) { info.text = cleanMText(e.text?.text); info.textHeight = e.text?.textHeight; info.tag = e.tag; }
        break;
      }
      case 'ATTDEF':
      case 'VIEWPORT':
        break; // definições de atributo e viewports não são desenhados no modelo
      case 'INSERT': {
        if (depth > MAX_DEPTH) break;
        const block = this.getBlock(e.name);
        if (!block) break;
        const bp = block.basePoint || { x: 0, y: 0 };
        const rows = Math.max(1, e.rowCount || 1), cols = Math.max(1, e.columnCount || 1);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const im = [translate(e.insertionPoint.x, e.insertionPoint.y), rotate(e.rotation || 0),
              translate(c * (e.columnSpacing || 0), r * (e.rowSpacing || 0)),
              scale(e.xScale ?? 1, e.yScale ?? 1), translate(-bp.x, -bp.y)].reduce(mul);
            const bm = mul(m, im);
            for (const child of block.entities || []) this.safe(child, bm, ecolor, out, depth + 1);
          }
        }
        for (const a of e.attribs || []) {
          if (a.flags & 1) continue; // invisível
          for (const t of textPrims(m, a.text)) { t.color = ecolor; out.push(t); }
        }
        if (info) {
          info.blockName = e.name; info.insertionPoint = e.insertionPoint;
          info.xScale = e.xScale; info.yScale = e.yScale; info.rotation = e.rotation;
          const attrs = (e.attribs || []).filter((a) => a.text?.text).map((a) => `${a.tag}=${a.text.text}`);
          if (attrs.length) info.attributes = attrs.join('; ');
        }
        break;
      }
      case 'DIMENSION': {
        const block = e.name && this.getBlock(e.name);
        if (block && depth <= MAX_DEPTH) {
          for (const child of block.entities || []) this.safe(child, m, ecolor, out, depth + 1);
        }
        if (info) {
          if (e.measurement != null) info.measurement = e.measurement;
          if (e.text) info.text = cleanMText(e.text);
          info.dimType = ['Linear', 'Alinhada', 'Angular', 'Diâmetro', 'Raio', 'Angular 3 pontos', 'Ordenada'][e.dimensionType & 7];
        }
        break;
      }
      default:
        this.unsupported[e.type] = (this.unsupported[e.type] || 0) + 1;
    }
  }

  safe(e, m, color, out, depth, info) {
    try {
      this.entity(e, m, color, out, depth, info);
    } catch (err) {
      console.warn('Falha ao processar entidade', e?.type, e?.handle, err);
    }
  }

  polyface(e, m, push) {
    const verts = e.vertices || [];
    const pos = verts.filter((v) => !(v.flag & 128) || v.polyfaceIndex0 == null);
    const faces = verts.filter((v) => v.flag & 128 && v.polyfaceIndex0 != null);
    for (const f of faces) {
      const idx = [f.polyfaceIndex0, f.polyfaceIndex1, f.polyfaceIndex2, f.polyfaceIndex3].filter((i) => i).map((i) => Math.abs(i) - 1);
      const pts = idx.map((i) => pos[i]).filter(Boolean).map((v) => [v.x, v.y]);
      if (pts.length > 1) push(poly(m, pts, true));
    }
  }

  mline(e, m, push, info) {
    const vs = e.vertices || [];
    if (vs.length < 2) return;
    const nLines = e.numberOfLines || vs[0].lines?.length || 0;
    const offsets = [];
    for (let li = 0; li < nLines; li++) {
      const pts = vs.map((v) => {
        const off = v.lines?.[li]?.segmentParams?.[0] ?? 0;
        return [v.vertex.x + v.miterDirection.x * off, v.vertex.y + v.miterDirection.y * off];
      });
      offsets.push(vs[0].lines?.[li]?.segmentParams?.[0] ?? 0);
      push(poly(m, pts, !!(e.flags & 2)));
    }
    if (info) {
      let len = 0;
      for (let i = 1; i < vs.length; i++) len += Math.hypot(vs[i].vertex.x - vs[i - 1].vertex.x, vs[i].vertex.y - vs[i - 1].vertex.y);
      info.length = len;
      info.vertices = vs.length;
      if (offsets.length > 1) info.thickness = Math.max(...offsets) - Math.min(...offsets);
      info.mlineScale = e.scale;
    }
  }

  hatch(e, m, push, info) {
    const loops = [];
    for (const bp of e.boundaryPaths || []) {
      let pts = [];
      if (bp.vertices) {
        pts = bulgePolyline(bp.vertices, true).pts;
      } else if (bp.edges) {
        for (const ed of bp.edges) {
          let seg = [];
          if (ed.type === 1) seg = [[ed.start.x, ed.start.y], [ed.end.x, ed.end.y]];
          else if (ed.type === 2) {
            const ccw = ed.isCCW !== false;
            seg = ccw ? arcPoints(ed.center.x, ed.center.y, ed.radius, ed.startAngle, ed.endAngle, true)
              : arcPoints(ed.center.x, ed.center.y, ed.radius, -ed.startAngle, -ed.endAngle, false);
          } else if (ed.type === 3) {
            const a = Math.hypot(ed.end.x, ed.end.y) || 1;
            const ratio = ed.lengthOfMinorAxis > 1 ? ed.lengthOfMinorAxis / a : ed.lengthOfMinorAxis;
            const ccw = ed.isCCW !== false;
            seg = ccw ? ellipsePoints(ed.center.x, ed.center.y, ed.end.x, ed.end.y, ratio, ed.startAngle, ed.endAngle, true)
              : ellipsePoints(ed.center.x, ed.center.y, ed.end.x, ed.end.y, ratio, -ed.startAngle, -ed.endAngle, false);
          } else if (ed.type === 4) {
            seg = splinePoints({ controlPoints: ed.controlPoints, degree: ed.degree, knots: ed.knots, fitPoints: ed.fitDatum });
          }
          pts.push(...seg);
        }
      }
      if (pts.length > 2) loops.push(pts);
    }
    if (!loops.length) return;
    const prims = loops.map((l) => poly(m, l, true, true));
    for (const p of prims) {
      p.alpha = e.solidFill === 1 ? 0.55 : 0.15;
      p.group = 'hatch';
      push(p);
    }
    if (info) {
      // área com regra par-ímpar (furos subtraem)
      let area = 0;
      prims.forEach((p, i) => {
        const [px, py] = p.pts[0];
        const depth = prims.filter((q, j) => j !== i && pointInPoly(px, py, q.pts)).length;
        area += (depth % 2 === 0 ? 1 : -1) * Math.abs(signedArea(p.pts));
      });
      info.area = Math.abs(area);
      info.pattern = e.patternName;
      info.loops = loops.length;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilidades geométricas
// ---------------------------------------------------------------------------
export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function polyLength(pts, closed) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 2) l += Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]);
  return l;
}

export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Retângulo orientado de menor área (rotating calipers simplificado sobre o fecho convexo).
export function orientedBox(points) {
  if (points.length > 20000) {
    const step = Math.ceil(points.length / 20000);
    points = points.filter((_, i) => i % step === 0);
  }
  const hull = convexHull(points);
  if (hull.length < 2) return { length: 0, width: 0, angle: 0 };
  if (hull.length === 2) {
    const [a, b] = hull;
    return { length: Math.hypot(b[0] - a[0], b[1] - a[1]), width: 0, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c + y * s, v = -x * s + y * c;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const w = maxU - minU, h = maxV - minV;
    if (!best || w * h < best.area - 1e-12) best = { area: w * h, w, h, ang };
  }
  const long = Math.max(best.w, best.h), short = Math.min(best.w, best.h);
  let angle = best.w >= best.h ? best.ang : best.ang + Math.PI / 2;
  angle = ((angle % Math.PI) + Math.PI) % Math.PI; // 0..180°
  return { length: long, width: short, angle };
}

function primPoints(p) {
  return p.kind === 'text' ? p.corners : p.pts;
}

export function computeBBox(prims) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of prims) {
    for (const [x, y] of primPoints(p)) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

export function allPoints(objs) {
  const pts = [];
  for (const o of objs) for (const p of o.prims) for (const q of primPoints(p)) if (Number.isFinite(q[0]) && Number.isFinite(q[1])) pts.push(q);
  return pts;
}

// ---------------------------------------------------------------------------
// Rótulos em português
// ---------------------------------------------------------------------------
export const TYPE_LABELS = {
  LINE: 'Linha', LWPOLYLINE: 'Polilinha', POLYLINE2D: 'Polilinha 2D', POLYLINE3D: 'Polilinha 3D', CIRCLE: 'Círculo',
  ARC: 'Arco', ELLIPSE: 'Elipse', SPLINE: 'Spline', SOLID: 'Sólido 2D', TRACE: 'Trace', '3DFACE': 'Face 3D', POINT: 'Ponto',
  LEADER: 'Chamada', MLINE: 'Multilinha', HATCH: 'Hachura', TEXT: 'Texto', MTEXT: 'Texto múltiplo', INSERT: 'Bloco',
  DIMENSION: 'Cota', ATTRIB: 'Atributo'
};

export const INSUNITS = {
  0: { key: 'un', label: 'sem unidade' }, 1: { key: 'in', label: 'polegadas' }, 2: { key: 'ft', label: 'pés' },
  3: { key: 'mi', label: 'milhas' }, 4: { key: 'mm', label: 'milímetros' }, 5: { key: 'cm', label: 'centímetros' },
  6: { key: 'm', label: 'metros' }, 7: { key: 'km', label: 'quilômetros' }, 10: { key: 'yd', label: 'jardas' },
  14: { key: 'dm', label: 'decímetros' }
};

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------
export function buildScene(db) {
  const b = new Builder(db);
  const objects = [];
  const entities = (db.entities || []).filter((e) => !e.isInPaperSpace);
  let id = 0;
  for (const e of entities) {
    const prims = [];
    const info = {};
    b.safe(e, IDENTITY, '#ffffff', prims, 0, info);
    if (!prims.length) continue;
    const bbox = computeBBox(prims);
    if (!bbox) continue;
    const obox = orientedBox(allPoints([{ prims }]));
    objects.push({
      id: id++,
      handle: e.handle,
      type: e.type,
      typeLabel: TYPE_LABELS[e.type] || e.type,
      layer: e.layer || '0',
      color: prims[0].color,
      prims,
      bbox,
      width: bbox.maxX - bbox.minX,
      height: bbox.maxY - bbox.minY,
      obox,
      info
    });
  }

  // Extensão total robusta: ignora objetos muito distantes (ex.: lixo em coordenadas enormes)
  const extents = robustExtents(objects);

  const layers = (db.tables?.LAYER?.entries || []).map((l) => ({
    name: l.name,
    color: resolveColor({ colorIndex: 256, layer: l.name }, b.layerMap, '#ffffff'),
    visible: !l.off && !l.frozen && (l.colorIndex ?? 1) >= 0,
    count: 0
  }));
  const layerByName = new Map(layers.map((l) => [l.name, l]));
  for (const o of objects) {
    let l = layerByName.get(o.layer);
    if (!l) { l = { name: o.layer, color: '#ffffff', visible: true, count: 0 }; layers.push(l); layerByName.set(o.layer, l); }
    l.count++;
  }
  return { objects, extents, layers: layers.filter((l) => l.count > 0), unsupported: b.unsupported };
}

function robustExtents(objects) {
  if (!objects.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  const cx = objects.map((o) => (o.bbox.minX + o.bbox.maxX) / 2).sort((a, b) => a - b);
  const cy = objects.map((o) => (o.bbox.minY + o.bbox.maxY) / 2).sort((a, b) => a - b);
  const q = (arr, t) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(t * (arr.length - 1))))];
  const x1 = q(cx, 0.02), x2 = q(cx, 0.98), y1 = q(cy, 0.02), y2 = q(cy, 0.98);
  const span = Math.max(x2 - x1, y2 - y1, 1e-9) * 5;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objects) {
    const ox = (o.bbox.minX + o.bbox.maxX) / 2, oy = (o.bbox.minY + o.bbox.maxY) / 2;
    if (ox < x1 - span || ox > x2 + span || oy < y1 - span || oy > y2 + span) continue;
    minX = Math.min(minX, o.bbox.minX); minY = Math.min(minY, o.bbox.minY);
    maxX = Math.max(maxX, o.bbox.maxX); maxY = Math.max(maxY, o.bbox.maxY);
  }
  if (!(minX <= maxX)) return objects[0].bbox;
  return { minX, minY, maxX, maxY };
}
