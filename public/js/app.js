import { LibreDwg, Dwg_File_Type, LIBREDWG_BASE } from './libs.js';
import { buildScene, orientedBox, allPoints, INSUNITS } from './geometry.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- unidades
const UNITS = {
  un: { label: 'unidades', short: 'un', m: null },
  mm: { label: 'milímetros', short: 'mm', m: 0.001 },
  cm: { label: 'centímetros', short: 'cm', m: 0.01 },
  dm: { label: 'decímetros', short: 'dm', m: 0.1 },
  m: { label: 'metros', short: 'm', m: 1 },
  km: { label: 'quilômetros', short: 'km', m: 1000 },
  in: { label: 'polegadas', short: 'in', m: 0.0254 },
  ft: { label: 'pés', short: 'ft', m: 0.3048 },
  yd: { label: 'jardas', short: 'yd', m: 0.9144 },
  mi: { label: 'milhas', short: 'mi', m: 1609.344 }
};

const state = {
  scene: null,
  fileName: '',
  src: 'mm',
  dst: 'same',
  precision: 2,
  sort: { key: 'id', dir: 1 },
  libPromise: null
};

function unitFactor() {
  if (state.dst === 'same') return 1;
  const s = UNITS[state.src], d = UNITS[state.dst];
  if (!s.m || !d.m) return 1;
  return s.m / d.m;
}
function unitShort() {
  return state.dst === 'same' ? UNITS[state.src].short : UNITS[state.dst].short;
}
const nf = () => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: state.precision, maximumFractionDigits: state.precision });
const num = (v) => (v == null || !Number.isFinite(v) ? '—' : nf().format(v));
const len = (v) => (v == null || !Number.isFinite(v) ? '—' : `${num(v * unitFactor())} ${unitShort()}`);
const area = (v) => (v == null || !Number.isFinite(v) ? '—' : `${num(v * unitFactor() ** 2)} ${unitShort()}²`);
const deg = (r) => (r == null || !Number.isFinite(r) ? '—' : `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(((r * 180) / Math.PI + 360) % 360)}°`);
const pt = (p) => (p ? `(${num(p.x * unitFactor())}; ${num(p.y * unitFactor())})` : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------- viewer
const viewer = new Viewer($('canvas'), {
  formatLen: (v) => len(v),
  onClick: ({ object, additive, measure }) => {
    if (measure) return renderMeasure(measure);
    if (!object) { if (!additive) setSelection([]); return; }
    if (additive) {
      const s = new Set(viewer.selection);
      s.has(object) ? s.delete(object) : s.add(object);
      setSelection([...s]);
    } else setSelection([object]);
  },
  onCursor: (x, y) => { $('stCursor').textContent = `X ${num(x * unitFactor())} · Y ${num(y * unitFactor())} ${unitShort()}`; },
  onViewChange: (v) => { $('stZoom').textContent = `Zoom ${formatScale(v.s)}`; }
});

function formatScale(s) {
  const ex = state.scene?.extents;
  if (!ex) return '';
  const base = Math.min((viewer.W * 0.9) / Math.max(ex.maxX - ex.minX, 1e-9), (viewer.H * 0.9) / Math.max(ex.maxY - ex.minY, 1e-9));
  const z = s / base;
  return `${z >= 10 ? Math.round(z) : z.toFixed(z < 1 ? 2 : 1)}×`;
}

// ---------------------------------------------------------------- carregamento
function loadLibrary() {
  if (!state.libPromise) {
    state.libPromise = LibreDwg.create(`${LIBREDWG_BASE}/wasm`).catch((err) => {
      state.libPromise = null;
      throw err;
    });
  }
  return state.libPromise;
}

function showLoading(text) {
  $('loading').hidden = !text;
  if (text) $('loadingText').textContent = text;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function openBuffer(buffer, name) {
  try {
    showLoading('Carregando o leitor de DWG (LibreDWG/WebAssembly)…');
    const lib = await loadLibrary();
    showLoading(`Lendo ${name}…`);
    await nextFrame();
    const t0 = performance.now();
    const ptr = lib.dwg_read_data(buffer, Dwg_File_Type.DWG);
    if (!ptr) throw new Error('O arquivo não pôde ser lido. Verifique se é um DWG válido.');
    let version = '';
    try {
      const v = lib.dwg_get_version_type(ptr);
      version = typeof v === 'string' ? v : v?.name || '';
    } catch { /* opcional */ }
    const db = lib.convert(ptr);
    lib.dwg_free(ptr);
    showLoading('Montando a geometria…');
    await nextFrame();
    const scene = buildScene(db);
    if (!scene.objects.length) throw new Error('Nenhum objeto desenhável foi encontrado no espaço do modelo.');
    scene.version = version;
    scene.insunits = db.header?.INSUNITS ?? 0;
    scene.ms = Math.round(performance.now() - t0);
    setScene(scene, name);
  } catch (err) {
    console.error(err);
    alert(`Não foi possível abrir o arquivo.\n\n${err.message || err}`);
  } finally {
    showLoading(null);
  }
}

async function openFile(file) {
  if (!file) return;
  if (!/\.dwg$/i.test(file.name)) {
    alert('Selecione um arquivo com extensão .dwg');
    return;
  }
  openBuffer(await file.arrayBuffer(), file.name);
}

async function openUrl(url) {
  showLoading('Baixando arquivo…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await openBuffer(await res.arrayBuffer(), decodeURIComponent(url.split('/').pop()));
  } catch (err) {
    showLoading(null);
    alert(`Falha ao baixar ${url}: ${err.message}`);
  }
}

function setScene(scene, name) {
  state.scene = scene;
  state.fileName = name;
  const u = INSUNITS[scene.insunits];
  state.src = u && UNITS[u.key] ? u.key : 'un';
  $('srcUnit').value = state.src;
  $('fileName').textContent = name;
  $('empty').hidden = true;
  $('hint').hidden = false;
  for (const id of ['zoomIn', 'zoomOut', 'zoomFit', 'measureBtn']) $(id).disabled = false;
  viewer.hidden = new Set(scene.layers.filter((l) => !l.visible).map((l) => l.name));
  viewer.setScene(scene);
  $('objCount').textContent = scene.objects.length;
  fillFilters();
  renderLayers();
  renderList();
  setSelection([]);
  const unsup = Object.entries(scene.unsupported);
  $('stInfo').textContent = `${scene.objects.length} objetos · ${scene.layers.length} camadas${scene.version ? ' · ' + scene.version : ''} · ${scene.ms} ms` +
    (unsup.length ? ` · não exibidos: ${unsup.map(([k, v]) => `${k}(${v})`).join(', ')}` : '');
  document.title = `${name} · DWG Viewer`;
}

// ---------------------------------------------------------------- seleção
function setSelection(objs) {
  viewer.selection = new Set(objs);
  viewer.requestDraw();
  renderSelection();
  for (const tr of $('listBody').children) tr.classList.toggle('selected', viewer.selection.has(state.scene?.objects[+tr.dataset.id]));
}

function rows(list) {
  return list
    .filter((r) => r && (r.section || (r[1] != null && r[1] !== '—' && r[1] !== '')))
    .map((r) => (r.section ? `<tr class="section"><th colspan="2">${esc(r.section)}</th></tr>` : `<tr class="${r[2] ? 'key' : ''}"><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`))
    .join('');
}

function objectRows(o) {
  const i = o.info;
  const closedShape = i.closed || o.type === 'CIRCLE' || (o.type === 'ELLIPSE' && i.area != null);
  return [
    { section: 'Dimensões' },
    ['Largura (eixo X)', len(o.width), true],
    ['Altura (eixo Y)', len(o.height), true],
    ['Comprimento (orientado)', o.obox.width > 0 || o.obox.length > 0 ? len(o.obox.length) : null],
    ['Largura / espessura (orientada)', o.obox.length > 0 ? len(o.obox.width) : null],
    ['Ângulo do eixo principal', o.obox.length > 0 ? deg(o.obox.angle) : null],
    [closedShape ? 'Perímetro' : 'Comprimento da linha', i.length != null ? len(i.length) : null, true],
    ['Área', i.area != null ? area(i.area) : null, true],
    ['Raio', i.radius != null ? len(i.radius) : null],
    ['Diâmetro', i.radius != null ? len(i.radius * 2) : null],
    ['Semi-eixo maior', i.majorRadius != null ? len(i.majorRadius) : null],
    ['Semi-eixo menor', i.minorRadius != null ? len(i.minorRadius) : null],
    ['Espessura da multilinha', i.thickness != null ? len(i.thickness) : null],
    ['Largura da polilinha', i.polyWidth != null ? len(i.polyWidth) : null],
    ['Medida da cota', i.measurement != null ? (i.dimType?.startsWith('Angular') ? deg(i.measurement) : len(i.measurement)) : null, true],
    { section: 'Geometria' },
    ['Início', i.start ? pt(i.start) : null],
    ['Fim', i.end ? pt(i.end) : null],
    ['Ângulo', i.angle != null ? deg(i.angle) : null],
    ['Centro', i.center ? pt(i.center) : null],
    ['Ângulo inicial', i.startAngle != null ? deg(i.startAngle) : null],
    ['Ângulo final', i.endAngle != null ? deg(i.endAngle) : null],
    ['Ângulo de varredura', i.sweep != null ? deg(i.sweep) : null],
    ['Vértices', i.vertices != null ? String(i.vertices) : null],
    ['Fechada', i.closed != null ? (i.closed ? 'Sim' : 'Não') : null],
    ['Posição', i.position ? pt(i.position) : null],
    ['Bloco', i.blockName],
    ['Ponto de inserção', i.insertionPoint ? pt(i.insertionPoint) : null],
    ['Escala X / Y', i.xScale != null ? `${num(i.xScale)} / ${num(i.yScale)}` : null],
    ['Rotação', i.rotation != null ? deg(i.rotation) : null],
    ['Atributos', i.attributes],
    ['Tipo de cota', i.dimType],
    ['Texto', i.text],
    ['Altura do texto', i.textHeight != null ? len(i.textHeight) : null],
    ['Padrão da hachura', i.pattern],
    ['Contornos', i.loops != null ? String(i.loops) : null],
    ['Mínimo (X; Y)', `(${num(o.bbox.minX * unitFactor())}; ${num(o.bbox.minY * unitFactor())})`],
    ['Máximo (X; Y)', `(${num(o.bbox.maxX * unitFactor())}; ${num(o.bbox.maxY * unitFactor())})`]
  ];
}

function renderSelection() {
  const sel = [...viewer.selection];
  $('selEmpty').hidden = sel.length > 0;
  $('selContent').hidden = sel.length === 0;
  if (!sel.length) return;
  if (sel.length === 1) {
    const o = sel[0];
    $('selSwatch').style.background = o.color;
    $('selTitle').textContent = o.typeLabel + (o.info.blockName ? ` “${o.info.blockName}”` : '');
    $('selSub').textContent = `Camada ${o.layer} · handle ${o.handle} · ${o.type}`;
    $('selTable').innerHTML = rows(objectRows(o));
  } else {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, L = 0, A = 0, hasA = false;
    for (const o of sel) {
      minX = Math.min(minX, o.bbox.minX); minY = Math.min(minY, o.bbox.minY);
      maxX = Math.max(maxX, o.bbox.maxX); maxY = Math.max(maxY, o.bbox.maxY);
      L += o.info.length || 0;
      if (o.info.area != null) { A += o.info.area; hasA = true; }
    }
    const ob = orientedBox(allPoints(sel));
    const types = {};
    sel.forEach((o) => (types[o.typeLabel] = (types[o.typeLabel] || 0) + 1));
    $('selSwatch').style.background = 'var(--accent)';
    $('selTitle').textContent = `${sel.length} objetos selecionados`;
    $('selSub').textContent = Object.entries(types).map(([k, v]) => `${v} ${k}`).join(', ');
    $('selTable').innerHTML = rows([
      { section: 'Conjunto selecionado' },
      ['Largura total (eixo X)', len(maxX - minX), true],
      ['Altura total (eixo Y)', len(maxY - minY), true],
      ['Comprimento (orientado)', len(ob.length)],
      ['Largura / espessura (orientada)', len(ob.width)],
      ['Ângulo do eixo principal', deg(ob.angle)],
      ['Soma dos comprimentos', L ? len(L) : null],
      ['Soma das áreas', hasA ? area(A) : null],
      ['Mínimo (X; Y)', `(${num(minX * unitFactor())}; ${num(minY * unitFactor())})`],
      ['Máximo (X; Y)', `(${num(maxX * unitFactor())}; ${num(maxY * unitFactor())})`]
    ]);
  }
}

function renderMeasure(points) {
  activateTab('sel');
  $('selEmpty').hidden = true;
  $('selContent').hidden = false;
  $('selSwatch').style.background = '#ff5c8a';
  $('selTitle').textContent = 'Medição';
  if (!points.length) {
    $('selSub').textContent = 'Clique no primeiro ponto (encaixa nos vértices)';
    $('selTable').innerHTML = '';
    return;
  }
  if (points.length < 2) {
    $('selSub').textContent = 'Clique no segundo ponto';
    $('selTable').innerHTML = rows([['Ponto 1', pt({ x: points[0][0], y: points[0][1] })]]);
    return;
  }
  const [a, b] = points;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  $('selSub').textContent = 'Clique novamente para medir outra distância';
  $('selTable').innerHTML = rows([
    { section: 'Distância' },
    ['Distância', len(Math.hypot(dx, dy)), true],
    ['Δ X (horizontal)', len(Math.abs(dx)), true],
    ['Δ Y (vertical)', len(Math.abs(dy)), true],
    ['Ângulo', deg(Math.atan2(dy, dx))],
    ['Ponto 1', pt({ x: a[0], y: a[1] })],
    ['Ponto 2', pt({ x: b[0], y: b[1] })]
  ]);
}

// ---------------------------------------------------------------- tabela de objetos
function fillFilters() {
  const s = state.scene;
  const types = [...new Set(s.objects.map((o) => o.typeLabel))].sort();
  $('typeFilter').innerHTML = '<option value="">Todos os tipos</option>' + types.map((t) => `<option>${esc(t)}</option>`).join('');
  $('layerFilter').innerHTML = '<option value="">Todas as camadas</option>' + s.layers.map((l) => `<option>${esc(l.name)}</option>`).join('');
}

const sortValue = (o, key) => (key === 'length' ? o.info.length ?? -1 : key === 'area' ? o.info.area ?? -1 : o[key]);

function filteredObjects() {
  if (!state.scene) return [];
  const q = $('search').value.trim().toLowerCase();
  const t = $('typeFilter').value, l = $('layerFilter').value;
  const list = state.scene.objects.filter((o) => {
    if (t && o.typeLabel !== t) return false;
    if (l && o.layer !== l) return false;
    if (!q) return true;
    return [o.typeLabel, o.type, o.layer, o.handle, o.info.text, o.info.blockName].some((v) => v && String(v).toLowerCase().includes(q));
  });
  const { key, dir } = state.sort;
  return list.sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key);
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
}

const MAX_ROWS = 1500;
function renderList() {
  const list = filteredObjects();
  const f = unitFactor();
  const n = (v) => (v == null ? '' : num(v * f));
  $('listBody').innerHTML = list.slice(0, MAX_ROWS).map((o) => `<tr data-id="${o.id}" class="${viewer.selection.has(o) ? 'selected' : ''}">
      <td>${o.id + 1}</td><td title="${esc(o.type)}">${esc(o.typeLabel)}</td><td title="${esc(o.layer)}">${esc(o.layer)}</td>
      <td class="num">${n(o.width)}</td><td class="num">${n(o.height)}</td>
      <td class="num">${n(o.info.length)}</td><td class="num">${o.info.area == null ? '' : num(o.info.area * f * f)}</td></tr>`).join('');
  $('listFoot').textContent = `${list.length} objeto(s)` + (list.length > MAX_ROWS ? ` — mostrando os primeiros ${MAX_ROWS}; refine a busca` : '') + ` · medidas em ${unitShort()} (área em ${unitShort()}²)`;
  document.querySelectorAll('.grid th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.classList.toggle('desc', th.dataset.sort === state.sort.key && state.sort.dir < 0);
  });
}

function exportCsv() {
  const list = filteredObjects();
  const f = unitFactor();
  const u = unitShort();
  const header = ['id', 'handle', 'tipo', 'camada', `largura_${u}`, `altura_${u}`, `comprimento_orientado_${u}`, `largura_orientada_${u}`,
    `comprimento_linha_${u}`, `area_${u}2`, `raio_${u}`, 'bloco', 'texto', 'min_x', 'min_y', 'max_x', 'max_y'];
  const c = (v) => (v == null ? '' : typeof v === 'number' ? String(+v.toFixed(6)).replace('.', ',') : `"${String(v).replace(/"/g, '""')}"`);
  const lines = [header.join(';')].concat(list.map((o) => [o.id + 1, o.handle, o.typeLabel, o.layer, o.width * f, o.height * f, o.obox.length * f, o.obox.width * f,
    o.info.length != null ? o.info.length * f : null, o.info.area != null ? o.info.area * f * f : null, o.info.radius != null ? o.info.radius * f : null,
    o.info.blockName, o.info.text, o.bbox.minX * f, o.bbox.minY * f, o.bbox.maxX * f, o.bbox.maxY * f].map(c).join(';')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.fileName || 'desenho').replace(/\.dwg$/i, '') + '-dimensoes.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- camadas
function renderLayers() {
  const s = state.scene;
  $('layerList').innerHTML = s.layers.map((l, i) => `<li><label>
      <input type="checkbox" data-layer="${i}" ${viewer.hidden.has(l.name) ? '' : 'checked'} />
      <span class="swatch" style="background:${l.color}"></span><span class="lname" title="${esc(l.name)}">${esc(l.name)}</span></label>
      <span class="lcount">${l.count}</span></li>`).join('');
}

// ---------------------------------------------------------------- UI
function activateTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
}

function setMeasure(on) {
  viewer.measure.active = on;
  viewer.measure.points = [];
  viewer.measure.snap = null;
  $('measureBtn').classList.toggle('active', on);
  $('stage').classList.toggle('measuring', on);
  if (on) {
    viewer.selection.clear();
    renderMeasure([]);
  } else renderSelection();
  viewer.requestDraw();
}

function refreshUnits() {
  renderSelection();
  renderList();
  viewer.requestDraw();
}

function init() {
  const unitOpts = Object.entries(UNITS).map(([k, u]) => `<option value="${k}">${u.label}</option>`).join('');
  $('srcUnit').innerHTML = unitOpts;
  $('dstUnit').innerHTML = '<option value="same">mesma do desenho</option>' + Object.entries(UNITS).filter(([k]) => k !== 'un').map(([k, u]) => `<option value="${k}">${u.label}</option>`).join('');
  $('srcUnit').value = state.src;
  $('srcUnit').onchange = (e) => { state.src = e.target.value; refreshUnits(); };
  $('dstUnit').onchange = (e) => { state.dst = e.target.value; refreshUnits(); };
  $('precision').onchange = (e) => { state.precision = +e.target.value; refreshUnits(); };

  for (const id of ['fileInput', 'fileInput2']) $(id).addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  $('sampleBtn').onclick = () => openUrl('samples/exemplo.dwg');
  $('zoomIn').onclick = () => viewer.zoomAt(1.5);
  $('zoomOut').onclick = () => viewer.zoomAt(1 / 1.5);
  $('zoomFit').onclick = () => viewer.fit();
  $('measureBtn').onclick = () => setMeasure(!viewer.measure.active);
  $('clearSel').onclick = () => (viewer.measure.active ? setMeasure(false) : setSelection([]));
  $('zoomSel').onclick = () => {
    const sel = [...viewer.selection];
    if (!sel.length) return;
    viewer.zoomTo({
      minX: Math.min(...sel.map((o) => o.bbox.minX)), minY: Math.min(...sel.map((o) => o.bbox.minY)),
      maxX: Math.max(...sel.map((o) => o.bbox.maxX)), maxY: Math.max(...sel.map((o) => o.bbox.maxY))
    });
  };

  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => activateTab(t.dataset.tab)));
  $('search').oninput = renderList;
  $('typeFilter').onchange = renderList;
  $('layerFilter').onchange = renderList;
  $('exportCsv').onclick = exportCsv;
  document.querySelectorAll('.grid th').forEach((th) => (th.onclick = () => {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === 'id' || key === 'typeLabel' || key === 'layer' ? 1 : -1 };
    renderList();
  }));
  $('listBody').onclick = (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const o = state.scene.objects[+tr.dataset.id];
    if (viewer.hidden.has(o.layer)) { viewer.hidden.delete(o.layer); renderLayers(); }
    setSelection([o]);
    viewer.zoomTo(o.bbox);
  };

  $('layerList').onchange = (e) => {
    const l = state.scene.layers[+e.target.dataset.layer];
    e.target.checked ? viewer.hidden.delete(l.name) : viewer.hidden.add(l.name);
    viewer.requestDraw();
  };
  $('layersAll').onclick = () => { viewer.hidden.clear(); renderLayers(); viewer.requestDraw(); };
  $('layersNone').onclick = () => { viewer.hidden = new Set(state.scene.layers.map((l) => l.name)); renderLayers(); viewer.requestDraw(); };

  // arrastar e soltar
  const stage = $('stage');
  let depth = 0;
  stage.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; stage.classList.add('dragover'); });
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; stage.classList.remove('dragover'); } });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    stage.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 1) alert('Envie apenas um arquivo DWG por vez. O primeiro será aberto.');
    openFile(files[0]);
  });

  // teclado
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || !state.scene) return;
    if (e.key === 'Escape') { viewer.measure.active ? setMeasure(false) : setSelection([]); }
    else if (e.key === 'f' || e.key === 'F') viewer.fit();
    else if (e.key === '+' || e.key === '=') viewer.zoomAt(1.5);
    else if (e.key === '-') viewer.zoomAt(1 / 1.5);
    else if (e.key === 'm' || e.key === 'M') setMeasure(!viewer.measure.active);
  });

  // pré-carrega o leitor WASM em segundo plano
  loadLibrary().catch((err) => console.warn('Pré-carregamento do LibreDWG falhou', err));

  // ?file=url abre automaticamente um arquivo (útil para testes / links)
  const f = new URLSearchParams(location.search).get('file');
  if (f) openUrl(f);
}

init();
