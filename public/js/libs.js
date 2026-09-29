// Bibliotecas de terceiros carregadas via CDN (sem etapa de build).
// libredwg-web: LibreDWG (GNU) compilado para WebAssembly — lê arquivos DWG no navegador.
export const LIBREDWG_VERSION = '0.7.14';
export const LIBREDWG_BASE = `https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@${LIBREDWG_VERSION}`;

export { LibreDwg, Dwg_File_Type } from 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.7.14/dist/libredwg-web.js';
// Tabela de cores ACI (AutoCAD Color Index) e avaliador de B-splines da mesma biblioteca
export { Color } from 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.7.14/lib/svg/color.js';
export { evaluateBSpline } from 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.7.14/lib/svg/bspline.js';
