# DWG Viewer

Visualizador web de arquivos **DWG (AutoCAD)**. Ele desenha a planta no navegador, permite zoom e pan e mostra as dimensões de cada objeto numa tabela auxiliar: largura, altura, comprimento, espessura, área, raio, etc.

O arquivo é lido **no próprio navegador**, via WebAssembly, e nunca é enviado a um servidor. Por isso a aplicação é 100% estática e roda na Vercel sem backend nem limite de upload.

## Funcionalidades

- Upload de **um arquivo `.dwg`**: botão *Abrir DWG* ou arrastar e soltar.
- **Zoom**: roda do mouse (centrado no cursor), botões + / − / ajustar, pinça no celular e duplo clique para ajustar.
- **Pan**: arrastar com o mouse ou com o dedo.
- **Seleção de objetos** com clique (Shift+clique soma à seleção). A aba **Dimensões** mostra:
  - Largura (X) e altura (Y) da caixa envolvente;
  - Comprimento e largura/espessura **orientados** (retângulo mínimo, útil para paredes inclinadas) e o ângulo;
  - Comprimento de linha / perímetro, área (polilinhas fechadas, círculos, elipses, hachuras com furos), raio/diâmetro, espessura de multilinhas (MLINE);
  - Dados de blocos (nome, escala, rotação, atributos), textos e cotas (valor medido);
  - Para vários objetos: dimensões totais do conjunto, soma de comprimentos e de áreas.
- Aba **Objetos**: tabela com todos os objetos (tipo, camada, largura, altura, comprimento, área). Tem busca, filtros, ordenação e **exportação CSV**. Clicar numa linha seleciona o objeto e aproxima.
- Aba **Camadas**: mostrar/ocultar camadas.
- Ferramenta **Medir** (tecla M): distância, ΔX, ΔY e ângulo entre dois pontos, com encaixe nos vértices.
- **Unidades**: lidas do cabeçalho do DWG (`INSUNITS`). Dá para corrigir a unidade do desenho e converter a exibição (mm, cm, m, pol, pés…), além de escolher as casas decimais.

Atalhos: `F` ajusta, `+`/`-` zoom, `M` medir, `Esc` limpa a seleção.

## Bibliotecas reutilizadas

| Biblioteca | Uso |
|---|---|
| [`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web) 0.7.14 (LibreDWG → WebAssembly) | Leitura e decodificação do DWG (R13 até 2018+), tabela de cores ACI e avaliação de B-splines |
| Canvas 2D (nativo do navegador) | Renderização, zoom e seleção |

As bibliotecas são carregadas do CDN jsDelivr, com versão fixa. Não há etapa de build nem `npm install`.

## Estrutura

```
public/            ← tudo o que é publicado
  index.html
  css/style.css
  js/libs.js       ← imports das bibliotecas (CDN)
  js/geometry.js   ← DWG → geometria + cálculo das dimensões
  js/viewer.js     ← canvas: desenho, zoom/pan, seleção, medição
  js/app.js        ← interface (tabelas, camadas, unidades, upload)
  samples/exemplo.dwg
server.py          ← servidor local (Python)
start-local.ps1    ← atalho para Windows
vercel.json        ← configuração da Vercel
```

## Executar localmente

Qualquer servidor HTTP estático serve. Abrir o `index.html` direto do disco (`file://`) **não** funciona, porque módulos ES e WebAssembly exigem HTTP.

**Com Python (recomendado no Windows):**

```bash
python server.py          # abre http://localhost:3000
```

ou `powershell -ExecutionPolicy Bypass -File .\start-local.ps1`

**Com Node.js:**

```bash
npm run dev               # npx serve public -l 3000
```

É preciso acesso à internet, pois as bibliotecas vêm do CDN. Clique em **Abrir exemplo** para testar com o DWG de amostra.

## Publicar na Vercel

**Opção 1: pelo Git (recomendada)**

1. Envie este repositório para o GitHub.
2. Em <https://vercel.com/new>, importe o repositório.
3. Mantenha *Framework Preset* = **Other**. O `vercel.json` já define `outputDirectory: public` e não há build.
4. Clique em **Deploy**.

**Opção 2: pela CLI**

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # produção
```

## Limitações conhecidas

- Mostra o **espaço do modelo** (model space). Layouts/paper space não são exibidos.
- Hachuras com padrão aparecem como preenchimento translúcido (sem as linhas do padrão). Textos usam fonte Arial em vez das fontes SHX.
- Entidades ainda não desenhadas: XLINE/RAY, WIPEOUT, IMAGE, 3DSOLID, TOLERANCE, ACAD_TABLE, MULTILEADER. A barra de status lista o que foi ignorado em cada arquivo.
- Arquivos muito grandes (centenas de MB) podem esgotar a memória do WebAssembly do navegador.

## Licença

GPL-3.0, pois o projeto depende do LibreDWG (GPL-3.0). O arquivo de exemplo vem do repositório de testes do LibreDWG.
