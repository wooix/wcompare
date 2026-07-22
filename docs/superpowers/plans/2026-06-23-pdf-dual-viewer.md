# PDF 동기 스크롤 듀얼 뷰어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 동일 format PDF 2개를 좌/우에 띄우고 한쪽을 스크롤하면 다른 쪽도 비율 기반으로 같이 움직이는 동기 스크롤 뷰어 모드를 wcompare에 추가한다.

**Architecture:** pdf.js(`pdfjs-dist` 6.x) 프리빌트 `PDFViewer`를 양쪽에 하나씩 얹고, 두 스크롤 컨테이너를 비율로 묶는 얇은 글루(`syncScroll`)를 추가한다. 전역 `mode('diff'|'pdf')`로 기존 Monaco diff 뷰와 신규 PDF 뷰를 show/hide 전환한다.

**Tech Stack:** Electron, pdfjs-dist 6.x(`build/pdf.mjs`·`build/pdf.worker.mjs`·`web/pdf_viewer.mjs`+`.css`), esbuild, node:test, @playwright/test(`_electron`).

**참고 설계:** `docs/superpowers/specs/2026-06-23-pdf-dual-viewer-design.md`

## Global Constraints

- pdfjs-dist 버전: `^6.0`(Node ≥22.13 요구, 현재 Node 26.3 충족). `package.json`에 하한 고정.
- 워커는 `app://bundle/pdf.worker.js`(번들 자산)로 로드. `worker-src 'self' blob:`(기존 CSP) 충족 — **새 CSP 지시문 추가 금지**.
- pdf.js 문서 로드 옵션은 항상 `isEvalSupported:false`(CSP `script-src 'self'` 준수).
- PDF는 **읽기 전용**(write IPC 미사용). 바이트는 화이트리스트 IPC(`file:readBytes`)로만.
- 스크롤 동기는 **비율 기반**(`scrollTop/(scrollHeight-clientHeight)`), 양방향, 에코 차단(`syncing` 플래그 + rAF).
- 보안 기준선 불변: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`.
- 각 태스크 끝에 1커밋. 순수 모듈은 TDD(실패 테스트 → 구현 → 통과).

---

## File Structure

| 파일 | 책임 | 신규/수정 |
|---|---|---|
| `src/renderer/syncScroll.js` | 비율 동기 목표 scrollTop 계산 (순수) | 신규 |
| `src/renderer/pdfEnv.js` | pdf.js 워커 경로 + 문서 로드 옵션 | 신규 |
| `src/renderer/pdfViewer.js` | 한 side용 PDFViewer 래퍼 | 신규 |
| `src/renderer/pdfDualView.js` | 두 뷰어 + 동기 스크롤/줌/페이지/토글 | 신규 |
| `src/main/fileService.js` | `readBytes(path)` 추가 | 수정 |
| `src/main/ipc.js` | `file:readBytes` 핸들러 | 수정 |
| `src/preload/preload.js` | `readBytes` 노출 | 수정 |
| `esbuild.mjs` | pdf.worker 엔트리 + pdf_viewer.css 복사 | 수정 |
| `src/renderer/index.html` | `#pdfview`, pdf 컨트롤/상태바, css link | 수정 |
| `src/renderer/app.js` | mode 매니저 + 확장자 라우팅 + pdf 툴바 배선 | 수정 |
| `test/helpers/makePdf.js` | 유효 멀티페이지 PDF 바이트 생성(픽스처) | 신규 |
| `test/syncScroll.test.js` | 순수 단위테스트 | 신규 |
| `test/e2e/pdf-dual.spec.js` | 렌더/동기/줌/토글/페이지/회귀 E2E | 신규 |

---

## Phase 0 — 메인 readBytes + pdf.js 스파이크 (blocker 먼저 실증)

### Task 0.1: 메인 바이너리 읽기 (fileService.readBytes + IPC + preload)

**Files:**
- Modify: `src/main/fileService.js`, `src/main/ipc.js`, `src/preload/preload.js`
- Test: `test/fileService.test.js`(케이스 추가)

**Interfaces:**
- Produces: `readBytes(path) → { bytes:Buffer, byteSize:number }`(fileService), IPC `file:readBytes` → `{ path, ext, bytes:Uint8Array, byteSize }`, `window.wcompare.readBytes(path) → Promise<{path,ext,bytes,byteSize}>`

- [ ] **Step 1: 실패 테스트 추가 (fileService.readBytes)**

`test/fileService.test.js` 끝에 추가:
```js
test('readBytes: 파일 바이트와 크기 반환', () => {
  const p = path.join(os.tmpdir(), 'wc-bytes-' + Date.now() + '.bin');
  fs.writeFileSync(p, Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF
  const { readBytes } = require('../src/main/fileService.js');
  const r = readBytes(p);
  assert.equal(r.byteSize, 4);
  assert.ok(Buffer.isBuffer(r.bytes));
  assert.equal(r.bytes[0], 0x25);
  fs.unlinkSync(p);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/fileService.test.js`
Expected: FAIL — `readBytes is not a function`

- [ ] **Step 3: fileService.readBytes 구현**

`src/main/fileService.js`에 함수 추가하고 export에 포함:
```js
function readBytes(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { bytes, byteSize: bytes.length };
}
```
`module.exports`에 `readBytes` 추가: `module.exports = { readFile, writeFile, detectEol, isBinary, readBytes };`

- [ ] **Step 4: 통과 확인**

Run: `node --test test/fileService.test.js`
Expected: PASS

- [ ] **Step 5: IPC + preload 배선**

`src/main/ipc.js`: `require`에 `readBytes` 추가하고 핸들러 등록. 상단 require 수정:
```js
const { readFile, writeFile, readBytes } = require('./fileService.js');
```
`registerIpc()` 안에 추가:
```js
  ipcMain.handle('file:readBytes', (_e, rawPath) => {
    const p = normalize(rawPath);
    allowed.add(p);
    const { bytes, byteSize } = readBytes(p);
    return { path: p, ext: path.basename(p), bytes, byteSize };
  });
```

`src/preload/preload.js`의 노출 객체에 추가:
```js
  readBytes: (path) => ipcRenderer.invoke('file:readBytes', path),
```

- [ ] **Step 6: 수동 확인 + 커밋**

Run: `node --test test/fileService.test.js` → PASS.
```bash
git add src/main/fileService.js src/main/ipc.js src/preload/preload.js test/fileService.test.js
git commit -m "feat: file:readBytes IPC for binary (pdf) loading with whitelist"
```

---

### Task 0.2: pdfjs-dist 설치 + 빌드 배선 + 렌더 스파이크

**Files:**
- Modify: `package.json`(의존성), `esbuild.mjs`
- Create: `test/helpers/makePdf.js`, `test/spike-pdf.mjs`(임시 검증, 커밋 제외)

**Interfaces:**
- Consumes: `window.wcompare.readBytes`(Task 0.1)
- Produces: `dist/renderer/pdf.worker.js`(번들 워커), `dist/renderer/pdf_viewer.css`(복사), `makePdf(pageCount, opts) → Buffer`

- [ ] **Step 1: 의존성 설치**

Run:
```bash
npm install --save pdfjs-dist@^6.0
```
Expected: `node_modules/pdfjs-dist` 생성. `node -e "console.log(require('pdfjs-dist/package.json').version)"` → `6.0.x`.

- [ ] **Step 2: esbuild에 pdf.worker 엔트리 + css 복사 추가**

`esbuild.mjs`의 `WORKERS` 객체에 pdf 워커를 추가하고, `copyStatic()`에 css 복사를 추가한다.

`WORKERS` 객체에 한 줄 추가:
```js
  'pdf.worker': 'pdfjs-dist/build/pdf.worker.mjs',
```

`copyStatic()` 함수 본문 끝에 추가:
```js
  await cp('node_modules/pdfjs-dist/web/pdf_viewer.css', out('renderer/pdf_viewer.css'));
  console.log('[esbuild] copied pdf_viewer.css');
```

- [ ] **Step 3: PDF 픽스처 생성기 작성**

`test/helpers/makePdf.js`:
```js
// 유효한 멀티페이지 PDF 바이트를 생성한다(xref 오프셋 정확 계산). 외부 의존 없음.
function makePdf(pageCount = 3, { width = 300, height = 900 } = {}) {
  const offsets = {};
  let pdf = '%PDF-1.4\n';
  const addObj = (num, body) => {
    offsets[num] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${num} 0 obj\n${body}\nendobj\n`;
  };
  // 1 Catalog, 2 Pages, 3 Font, 그 다음 페이지/콘텐츠 객체
  let objNum = 4;
  const kids = [];
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const pageNum = objNum++; const contentNum = objNum++;
    kids.push(`${pageNum} 0 R`);
    const stream = `BT /F1 28 Tf 24 ${height - 60} Td (Page ${i + 1}) Tj ET`;
    pages.push({ pageNum, contentNum, stream });
  }
  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`);
  addObj(3, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  for (const p of pages) {
    addObj(p.pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${p.contentNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    addObj(p.contentNum, `<< /Length ${Buffer.byteLength(p.stream, 'latin1')} >>\nstream\n${p.stream}\nendstream`);
  }
  const maxObj = objNum - 1;
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += String(offsets[n] ?? 0).padStart(10, '0') + ' 00000 n \n';
  pdf += xref + `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
module.exports = { makePdf };
```

- [ ] **Step 4: 스파이크 검증 스크립트 작성**

`test/spike-pdf.mjs`(임시):
```js
import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makePdf } = require('./helpers/makePdf.js');

const a = path.join(os.tmpdir(), 'spike-a.pdf'); fs.writeFileSync(a, makePdf(3));
const b = path.join(os.tmpdir(), 'spike-b.pdf'); fs.writeFileSync(b, makePdf(3));
const main = path.join(process.cwd(), 'src', 'main', 'main.js');
const app = await electron.launch({ args: [main, a, b] });
const win = await app.firstWindow();
const errors = [];
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await win.waitForTimeout(4000);
const canvases = await win.evaluate(() => document.querySelectorAll('canvas').length);
console.log('[spike] canvases:', canvases);
console.log('[spike] errors:', errors.length ? JSON.stringify(errors, null, 2) : 'NONE');
await win.screenshot({ path: 'dist/spike-pdf.png' });
await app.close();
console.log('[spike] RESULT:', canvases > 0 && errors.length === 0 ? 'PASS' : 'REVIEW');
process.exit(canvases > 0 && errors.length === 0 ? 0 : 1);
```

> 주: 이 스파이크는 Phase 4의 `#pdfview`/mode 라우팅이 아직 없으므로, **임시로** `src/renderer/app.js` 끝에 아래 최소 렌더 코드를 추가해 검증한다(검증 후 되돌리고 Phase 3/4의 정식 코드로 대체).
> ```js
> // --- SPIKE ONLY (검증 후 제거) ---
> import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
> GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.js', window.location.href).toString();
> window.wcompare.onOpenPair(async ({ left }) => {
>   if (!left || !left.endsWith('.pdf')) return;
>   const { bytes } = await window.wcompare.readBytes(left);
>   const doc = await getDocument({ data: bytes, isEvalSupported: false }).promise;
>   const page = await doc.getPage(1);
>   const vp = page.getViewport({ scale: 1 });
>   const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
>   document.body.appendChild(c);
>   await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
> });
> ```
> 이 스파이크는 `window.wcompare.readBytes`(Task 0.1)에 의존한다 — Task 0.1을 먼저 완료한 상태에서 실행한다.

- [ ] **Step 5: 빌드 + 스파이크 실행**

Run:
```bash
npm run build && node test/spike-pdf.mjs 2>&1 | grep -iE "spike|error"
```
Expected: `[spike] canvases: 1` 이상, `[spike] errors: NONE`, `RESULT: PASS`.
실패(워커 로딩/CSP/`import.meta`) 시: `dist/renderer/pdf.worker.js`가 생성됐는지 확인하고, 워커 로딩 에러면 설계 §13 P1 대안(Blob 워커 프록시: `GlobalWorkerOptions.workerSrc`를 fetch→Blob URL로 교체, `worker-src blob:` 활용)으로 전환 후 재검증.

- [ ] **Step 6: 스파이크 정리 + 커밋**

스파이크용 임시 코드(app.js의 SPIKE 블록)와 `test/spike-pdf.mjs`를 제거한다(빌드 배선·픽스처 생성기·의존성은 유지).
```bash
rm -f test/spike-pdf.mjs
git add package.json package-lock.json esbuild.mjs test/helpers/makePdf.js
git commit -m "spike: pdf.js renders under app://+sandbox (worker + viewer css wired)"
```

---
## Phase 1 — 순수 동기 모듈 (TDD)

### Task 1.1: syncScroll (비율 동기 목표 계산)

**Files:**
- Create: `src/renderer/syncScroll.js`
- Test: `test/syncScroll.test.js`

**Interfaces:**
- Produces: `syncTargetTop(from, to) → number` where `from`/`to` = `{ scrollTop, scrollHeight, clientHeight }`

- [ ] **Step 1: 실패 테스트 작성**

```js
// test/syncScroll.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { syncTargetTop } = require('../src/renderer/syncScroll.js');

test('비율 동일: 절반 스크롤이면 대상도 절반', () => {
  const from = { scrollTop: 250, scrollHeight: 1000, clientHeight: 500 }; // range 500, ratio .5
  const to = { scrollTop: 0, scrollHeight: 2000, clientHeight: 800 };     // range 1200
  assert.equal(syncTargetTop(from, to), 600); // .5 * 1200
});

test('상단/하단 경계', () => {
  assert.equal(syncTargetTop({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 800, clientHeight: 300 }), 0);
  // from 끝까지: ratio 1 → to 끝(range=500)
  assert.equal(syncTargetTop({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 800, clientHeight: 300 }), 500);
});

test('범위 0 가드: 내용이 뷰포트보다 작으면 0', () => {
  assert.equal(syncTargetTop({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }), 0);
  assert.equal(syncTargetTop({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 300, clientHeight: 500 }), 0);
});

test('클램프: 비율>1 입력도 대상 범위로 제한', () => {
  // 비정상적으로 큰 scrollTop이 와도 to 범위(=500) 초과 금지
  assert.equal(syncTargetTop({ scrollTop: 9999, scrollHeight: 1000, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 900, clientHeight: 400 }), 500);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/syncScroll.test.js`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```js
// src/renderer/syncScroll.js — 순수. DOM/pdf 미import.
function syncTargetTop(from, to) {
  const fromRange = from.scrollHeight - from.clientHeight;
  const toRange = to.scrollHeight - to.clientHeight;
  if (fromRange <= 0 || toRange <= 0) return 0;
  const ratio = from.scrollTop / fromRange;
  const target = ratio * toRange;
  return Math.max(0, Math.min(toRange, target));
}
module.exports = { syncTargetTop };
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/syncScroll.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/syncScroll.js test/syncScroll.test.js
git commit -m "feat: syncScroll pure ratio mapping with tests"
```

---

## Phase 2 — PDF 렌더러 모듈

### Task 2.1: pdfEnv (워커 경로 + 문서 옵션)

**Files:**
- Create: `src/renderer/pdfEnv.js`

**Interfaces:**
- Produces: side-effect로 `GlobalWorkerOptions.workerSrc` 설정, `export const DOC_OPTS`

- [ ] **Step 1: 구현**

```js
// src/renderer/pdfEnv.js — pdf.js 전역 워커 경로와 문서 로드 옵션을 한곳에서 설정.
import { GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';

// app://bundle/pdf.worker.js (renderer 자산과 동일 오리진)
GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.js', window.location.href).toString();

// CSP(script-src 'self') 준수: 동적 eval 비활성
export const DOC_OPTS = { isEvalSupported: false };
```

- [ ] **Step 2: 커밋**(빌드 검증은 Task 2.3 통합 후)

```bash
git add src/renderer/pdfEnv.js
git commit -m "feat: pdfEnv worker src + CSP-safe doc options"
```

---

### Task 2.2: pdfViewer (한 side 래퍼)

**Files:**
- Create: `src/renderer/pdfViewer.js`

**Interfaces:**
- Consumes: `pdfEnv.DOC_OPTS`, pdfjs `getDocument`, `PDFViewer`/`EventBus`/`PDFLinkService`
- Produces: `createPdfViewer(hostEl) → { el, load(bytes), setScale(n), getScale(), currentPage(), pageCount(), scrollToPage(n), onPageChange(cb) }`

- [ ] **Step 1: 구현**

```js
// src/renderer/pdfViewer.js — 한 side의 pdf.js PDFViewer를 캡슐화.
import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { PDFViewer, EventBus, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { DOC_OPTS } from './pdfEnv.js';

export function createPdfViewer(hostEl) {
  hostEl.classList.add('pdf-host'); // CSS: position:relative; overflow:hidden
  const container = document.createElement('div');
  container.className = 'pdf-container'; // CSS: position:absolute; inset:0; overflow:auto
  const viewerDiv = document.createElement('div');
  viewerDiv.className = 'pdfViewer';
  container.appendChild(viewerDiv);
  hostEl.appendChild(container);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const viewer = new PDFViewer({ container, viewer: viewerDiv, eventBus, linkService });
  linkService.setViewer(viewer);

  const pageCbs = [];
  eventBus.on('pagechanging', (e) => pageCbs.forEach((cb) => cb(e.pageNumber)));

  async function load(bytes) {
    const doc = await getDocument({ data: bytes, ...DOC_OPTS }).promise;
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    // pagesinit 후 초기 배율(page-width) 적용
    await new Promise((resolve) => {
      eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width'; resolve(); }, { once: true });
    });
  }

  return {
    el: container,
    load,
    setScale: (n) => { viewer.currentScale = n; },
    getScale: () => viewer.currentScale,
    currentPage: () => viewer.currentPageNumber || 1,
    pageCount: () => viewer.pagesCount || 0,
    scrollToPage: (n) => viewer.scrollPageIntoView({ pageNumber: n }),
    onPageChange: (cb) => pageCbs.push(cb),
  };
}
```

> 빌드/런타임 검증은 Task 2.3(dualView) 통합 후 한 번에 수행한다(pdf.js는 esbuild 번들 환경에서만 정상 동작).

- [ ] **Step 2: 커밋**

```bash
git add src/renderer/pdfViewer.js
git commit -m "feat: single-side pdf.js PDFViewer wrapper"
```

---

### Task 2.3: pdfDualView (두 뷰어 + 동기/줌/페이지/토글)

**Files:**
- Create: `src/renderer/pdfDualView.js`

**Interfaces:**
- Consumes: `createPdfViewer`(2.2), `syncTargetTop`(1.1)
- Produces: `createDualView(hostEl) → { openSide(side,{bytes}), setSync(bool), zoom(delta), gotoPage(n), onState(cb), isSync() }`
  - `onState(cb)`의 `cb(state)`: `{ sync:boolean, left:{page,count}, right:{page,count}, scale:number }`

- [ ] **Step 1: 구현**

```js
// src/renderer/pdfDualView.js — 두 PDFViewer를 좌/우 배치 + 비율 스크롤/줌/페이지/토글 동기.
import { createPdfViewer } from './pdfViewer.js';
import { syncTargetTop } from './syncScroll.js';

export function createDualView(hostEl) {
  const other = (s) => (s === 'left' ? 'right' : 'left');
  const viewers = {};
  for (const side of ['left', 'right']) {
    const pane = document.createElement('div');
    pane.className = 'pdf-pane';
    pane.dataset.side = side;
    hostEl.appendChild(pane);
    viewers[side] = createPdfViewer(pane);
  }

  let syncEnabled = true;
  let syncing = false;
  const loaded = { left: false, right: false };
  const stateCbs = [];

  function emit() {
    const st = {
      sync: syncEnabled,
      left: { page: viewers.left.currentPage(), count: viewers.left.pageCount() },
      right: { page: viewers.right.currentPage(), count: viewers.right.pageCount() },
      scale: viewers.left.getScale() || viewers.right.getScale() || 1,
    };
    stateCbs.forEach((cb) => cb(st));
  }

  function align(fromSide) {
    const to = viewers[other(fromSide)].el;
    to.scrollTop = syncTargetTop(viewers[fromSide].el, to);
  }

  function onScroll(fromSide) {
    if (!syncEnabled || syncing) return;
    if (!loaded.left || !loaded.right) return;
    syncing = true;
    align(fromSide);
    requestAnimationFrame(() => { syncing = false; });
  }

  for (const side of ['left', 'right']) {
    viewers[side].el.addEventListener('scroll', () => onScroll(side));
    viewers[side].onPageChange(() => emit());
  }

  async function openSide(side, { bytes }) {
    await viewers[side].load(bytes);
    loaded[side] = true;
    emit();
  }

  function setSync(on) {
    syncEnabled = on;
    if (on && loaded.left && loaded.right) align('left');
    emit();
  }

  function zoom(delta) {
    const cur = viewers.left.getScale() || viewers.right.getScale() || 1;
    const next = Math.max(0.25, Math.min(5, cur * (delta > 0 ? 1.1 : 1 / 1.1)));
    viewers.left.setScale(next);
    viewers.right.setScale(next);
    if (syncEnabled && loaded.left && loaded.right) requestAnimationFrame(() => align('left'));
    emit();
  }

  function gotoPage(n) {
    for (const side of ['left', 'right']) {
      const cnt = viewers[side].pageCount() || 1;
      viewers[side].scrollToPage(Math.max(1, Math.min(cnt, n)));
    }
    emit();
  }

  return { openSide, setSync, zoom, gotoPage, onState: (cb) => stateCbs.push(cb), isSync: () => syncEnabled };
}
```

- [ ] **Step 2: 커밋**(동작 검증은 Phase 3 통합 후 E2E에서)

```bash
git add src/renderer/pdfDualView.js
git commit -m "feat: pdfDualView (ratio scroll sync + zoom/page/toggle)"
```

---
## Phase 3 — 통합 (모드 전환 + 툴바/레이아웃)

### Task 3.1: index.html 레이아웃 + 정적 툴바 + toolbar.js 축소

**Files:**
- Modify: `src/renderer/index.html`(전면 교체), `src/renderer/toolbar.js`(buildToolbar 제거, setStatus 유지)

**Interfaces:**
- Produces: DOM ids — `btn-open-left/right`, `btn-mode`, `diff-controls`(+`btn-save/prev-diff/next-diff/ws/vim`), `pdf-controls`(+`btn-zoom-out/in`, `pdf-page`, `pdf-total`, `btn-sync`), `btn-theme`, `toolbar-status`, `editor`, `pdfview`, `statusbars`, `pdf-status`

- [ ] **Step 1: index.html 교체**

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'" />
<link rel="stylesheet" href="./app.css" />
<link rel="stylesheet" href="./pdf_viewer.css" />
<style>
  html, body { margin: 0; height: 100%; background:#1e1e1e; }
  #toolbar { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 8px; background: #1e1e1e; color: #ddd; font: 13px sans-serif; }
  #toolbar button { background: #333; color: #ddd; border: 1px solid #555; border-radius: 4px; padding: 3px 8px; cursor: pointer; }
  #toolbar button:hover { background: #444; }
  #toolbar input { background:#222; color:#ddd; border:1px solid #555; border-radius:4px; }
  #diff-controls, #pdf-controls { display:flex; align-items:center; gap:6px; color:#bbb; }
  #editor, #pdfview { height: calc(100% - 36px - 22px); }
  #pdfview { display:none; }
  .pdf-pane { flex:1; position:relative; min-width:0; border-right:1px solid #333; }
  .pdf-pane:last-child { border-right:none; }
  .pdf-container { position:absolute; inset:0; overflow:auto; background:#2a2a2a; }
  .pdfViewer .page { margin:8px auto; border:1px solid #444; }
  #statusbars { height: 22px; display: flex; background: #1e1e1e; color: #9cdcfe; font: 12px monospace; }
  #statusbars > div { flex: 1; padding: 0 8px; overflow: hidden; white-space: nowrap; opacity: 0.5; }
  #statusbars > div.active { opacity: 1; }
  #pdf-status { display:none; height:22px; background:#1e1e1e; color:#9cdcfe; font:12px monospace; align-items:center; padding:0 8px; }
</style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-open-left">Open Left</button>
    <button id="btn-open-right">Open Right</button>
    <button id="btn-mode">PDF Mode</button>
    <span id="diff-controls">
      <button id="btn-save">Save</button>
      <button id="btn-prev-diff">◀ Diff</button>
      <button id="btn-next-diff">Diff ▶</button>
      <button id="btn-ws">Whitespace</button>
      <button id="btn-vim">Vim</button>
    </span>
    <span id="pdf-controls" style="display:none">
      <button id="btn-zoom-out">−</button>
      <button id="btn-zoom-in">+</button>
      <span>Page <input id="pdf-page" type="number" min="1" value="1" style="width:46px" /> / <span id="pdf-total">0</span></span>
      <button id="btn-sync">Sync: ON</button>
    </span>
    <button id="btn-theme">Theme</button>
    <span id="toolbar-status" style="margin-left:auto; color:#9cdcfe; font:12px monospace;"></span>
  </div>
  <div id="editor"></div>
  <div id="pdfview"></div>
  <div id="statusbars"><div id="vim-left"></div><div id="vim-right"></div></div>
  <div id="pdf-status"></div>
  <script src="./app.js"></script>
</body>
</html>
```

- [ ] **Step 2: toolbar.js 축소(setStatus만 유지)**

```js
// src/renderer/toolbar.js
export function setStatus(msg) { const s = document.getElementById('toolbar-status'); if (s) s.textContent = msg; }
```

- [ ] **Step 3: 커밋**(앱 동작 검증은 Task 3.2 후)

```bash
git add src/renderer/index.html src/renderer/toolbar.js
git commit -m "feat: static toolbar + pdf layout (#pdfview, pdf controls, status)"
```

---

### Task 3.2: app.js — mode 매니저 + 확장자 라우팅 + pdf 배선

**Files:**
- Modify: `src/renderer/app.js`(전면 교체)

**Interfaces:**
- Consumes: `createDualView`(2.3), 기존 diff 모듈, `setStatus`(3.1), DOM ids(3.1)

- [ ] **Step 1: app.js 교체**

```js
import './monacoEnv.js';
import * as monaco from 'monaco-editor';
import { createDiff } from './diffEditor.js';
import { wireLintController } from './lintController.js';
import { setupVim, toggleVim, setSaveHandler, getActiveSide } from './vimBinding.js';
import { setStatus } from './toolbar.js';
import { setupDnd } from './dnd.js';
import { createDualView } from './pdfDualView.js';

const $ = (id) => document.getElementById(id);
const isPdf = (p) => /\.pdf$/i.test(p || '');

// ===== diff mode =====
const editorApi = createDiff($('editor'));
const linters = {
  left: wireLintController(monaco, editorApi, 'left'),
  right: wireLintController(monaco, editorApi, 'right'),
};
let theme = 'vs-dark';
let ws = false;
monaco.editor.setTheme(theme);

editorApi.onDirty(() => refreshStatus());
const mark = (s) => (s.path ? (s.dirty ? '● ' : '') + s.path.split('/').pop() : '(empty)');
function refreshStatus() {
  if (mode !== 'diff') return;
  setStatus(`${mark(editorApi.getState('left'))}  |  ${mark(editorApi.getState('right'))}`);
}
async function dirtyGuard(side) {
  if (!editorApi.getState(side).dirty) return true;
  const ans = prompt('미저장 변경이 있습니다. save / discard / cancel 중 입력', 'cancel');
  if (ans === 'save') { await save(side); return true; }
  return ans === 'discard';
}
function placeFile(side, file) {
  if (file.isBinary && !confirm('바이너리 파일입니다. 텍스트로 강제로 열까요?')) return;
  if (file.byteSize > 5 * 1024 * 1024) alert('5MB 초과: lint를 비활성화하고 엽니다.');
  editorApi.open(side, file);
  linters[side].cancel(); linters[side].request();
  refreshStatus();
}
async function save(side = getActiveSide()) {
  const st = editorApi.getState(side);
  if (!st.path) return;
  await window.wcompare.writeFile({ path: st.path, content: editorApi.getValue(side), eol: st.eol, encoding: 'utf8', bom: st.bom });
  editorApi.setDirty(side, false);
  linters[side].cancel(); linters[side].request();
  refreshStatus();
}
setSaveHandler(save);

// ===== pdf mode =====
let mode = 'diff';
let dualView = null;
function ensureDualView() {
  if (dualView) return dualView;
  dualView = createDualView($('pdfview'));
  dualView.onState(renderPdfStatus);
  return dualView;
}
function renderPdfStatus(st) {
  $('pdf-total').textContent = String(Math.max(st.left.count, st.right.count));
  $('pdf-page').value = String(st.left.page || st.right.page || 1);
  $('btn-sync').textContent = 'Sync: ' + (st.sync ? 'ON' : 'OFF');
  $('pdf-status').textContent = `L ${st.left.page}/${st.left.count}   R ${st.right.page}/${st.right.count}   ${Math.round(st.scale * 100)}%`;
}
function setMode(m) {
  mode = m;
  $('editor').style.display = m === 'diff' ? '' : 'none';
  $('pdfview').style.display = m === 'pdf' ? 'flex' : 'none';
  $('diff-controls').style.display = m === 'diff' ? 'flex' : 'none';
  $('pdf-controls').style.display = m === 'pdf' ? 'flex' : 'none';
  $('statusbars').style.display = m === 'diff' ? 'flex' : 'none';
  $('pdf-status').style.display = m === 'pdf' ? 'flex' : 'none';
  $('btn-mode').textContent = m === 'diff' ? 'PDF Mode' : 'Diff Mode';
  if (m === 'diff') refreshStatus();
}
async function openPdf(side, p) {
  try {
    const { bytes } = await window.wcompare.readBytes(p);
    ensureDualView();
    setMode('pdf');
    await dualView.openSide(side, { bytes });
  } catch (e) {
    alert('PDF를 열 수 없습니다: ' + (e?.message || e));
  }
}

// ===== open routing =====
async function openByPath(side, p) {
  if (isPdf(p)) return openPdf(side, p);
  if (!(await dirtyGuard(side))) return;
  const file = await window.wcompare.readFile(p);
  placeFile(side, file);
  setMode('diff');
}
async function openByDialog(side) {
  const file = await window.wcompare.openFileDialog();
  if (!file) return;
  if (isPdf(file.path)) return openPdf(side, file.path);
  if (!(await dirtyGuard(side))) return;
  placeFile(side, file);
  setMode('diff');
}

// ===== toolbar wiring (by id) =====
$('btn-open-left').onclick = () => openByDialog('left');
$('btn-open-right').onclick = () => openByDialog('right');
$('btn-mode').onclick = () => { ensureDualView(); setMode(mode === 'diff' ? 'pdf' : 'diff'); };
$('btn-theme').onclick = () => { theme = theme === 'vs-dark' ? 'vs' : 'vs-dark'; monaco.editor.setTheme(theme); };
$('btn-save').onclick = () => save();
$('btn-prev-diff').onclick = () => editorApi.goToDiff('previous');
$('btn-next-diff').onclick = () => editorApi.goToDiff('next');
$('btn-ws').onclick = () => { ws = !ws; editorApi.updateOptions({ ignoreTrimWhitespace: ws }); };
$('btn-vim').onclick = () => toggleVim(editorApi);
$('btn-zoom-out').onclick = () => dualView?.zoom(-1);
$('btn-zoom-in').onclick = () => dualView?.zoom(1);
$('btn-sync').onclick = () => dualView?.setSync(!dualView.isSync());
$('pdf-page').onchange = (e) => dualView?.gotoPage(parseInt(e.target.value, 10) || 1);

// 복사 화살표 (diff)
editorApi.innerOf('left').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, () => editorApi.copyCurrentBlock('left', 'right'));
editorApi.innerOf('right').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, () => editorApi.copyCurrentBlock('right', 'left'));

setupVim(editorApi);
setupDnd($('editor'), (side, p) => openByPath(side, p));
setupDnd($('pdfview'), (side, p) => openByPath(side, p));

const MENU = {
  'menu:open-left': () => openByDialog('left'),
  'menu:open-right': () => openByDialog('right'),
  'menu:save': () => save(),
  'menu:next-diff': () => editorApi.goToDiff('next'),
  'menu:prev-diff': () => editorApi.goToDiff('previous'),
  'menu:toggle-ws': () => { ws = !ws; editorApi.updateOptions({ ignoreTrimWhitespace: ws }); },
  'menu:toggle-vim': () => toggleVim(editorApi),
  'menu:toggle-theme': () => { theme = theme === 'vs-dark' ? 'vs' : 'vs-dark'; monaco.editor.setTheme(theme); },
};
window.wcompare.onMenu((ch) => { MENU[ch]?.(); });

window.wcompare.onOpenPair(async ({ left, right }) => {
  if (left) await openByPath('left', left);
  if (right) await openByPath('right', right);
});

setMode('diff');
refreshStatus();
```

- [ ] **Step 2: 빌드 + 수동/회귀 확인**

Run: `npm run build` → 에러 없음.
Run: `npm test` → 기존 단위테스트 + syncScroll/fileService PASS.
Run(선택): `npx electron . a.pdf b.pdf` → 두 PDF가 좌/우에 뜨고 스크롤이 함께 움직임. 텍스트 2개 → diff 모드.

- [ ] **Step 3: 커밋**

```bash
git add src/renderer/app.js
git commit -m "feat: mode manager + extension routing + pdf toolbar wiring"
```

---

## Phase 4 — E2E

### Task 4.1: PDF 듀얼 뷰어 E2E

**Files:**
- Create: `test/e2e/pdf-dual.spec.js`

**Interfaces:**
- Consumes: `makePdf`(0.2), 빌드 산출물

- [ ] **Step 1: 작성**

```js
// test/e2e/pdf-dual.spec.js
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

function writePair(tag) {
  const a = path.join(os.tmpdir(), `wc-pdf-a-${tag}.pdf`);
  const b = path.join(os.tmpdir(), `wc-pdf-b-${tag}.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900 }));
  fs.writeFileSync(b, makePdf(5, { height: 900 }));
  return { a, b };
}
const leftC = '.pdf-pane[data-side=left] .pdf-container';
const rightC = '.pdf-pane[data-side=right] .pdf-container';

test('두 PDF 렌더 + 비율 스크롤 동기(양쪽)', async () => {
  const { a, b } = writePair('sync' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  // 양쪽 캔버스 렌더
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  // 좌측 스크롤 → 우측 따라옴
  await win.evaluate((sel) => { document.querySelector(sel).scrollTop = 600; }, leftC);
  await win.waitForFunction((sel) => document.querySelector(sel).scrollTop > 50, rightC, { timeout: 5000 });

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('동기 OFF 시 한쪽만 움직인다', async () => {
  const { a, b } = writePair('off' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await win.click('#btn-sync'); // OFF
  await expect(win.locator('#btn-sync')).toHaveText('Sync: OFF');
  await win.evaluate((sel) => { document.querySelector(sel).scrollTop = 600; }, leftC);
  await win.waitForTimeout(400);
  const rightTop = await win.evaluate((sel) => document.querySelector(sel).scrollTop, rightC);
  expect(rightTop).toBe(0);
  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('줌+ 시 배율 증가(양쪽)', async () => {
  const { a, b } = writePair('zoom' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  const pct = () => win.evaluate(() => { const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || ''); return m ? +m[1] : 0; });
  const before = await pct();
  await win.click('#btn-zoom-in');
  await win.waitForFunction((b0) => { const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || ''); return m && +m[1] > b0; }, before, { timeout: 5000 });
  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('페이지 점프: 양쪽 이동', async () => {
  const { a, b } = writePair('page' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await win.fill('#pdf-page', '3');
  await win.locator('#pdf-page').press('Enter');
  await win.waitForFunction(() => /L 3\//.test(document.getElementById('pdf-status').textContent || ''), null, { timeout: 5000 });
  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('회귀: 텍스트 2개는 diff 모드', async () => {
  const a = path.join(os.tmpdir(), 'wc-txt-a-' + Date.now() + '.txt');
  const b = path.join(os.tmpdir(), 'wc-txt-b-' + Date.now() + '.txt');
  fs.writeFileSync(a, 'hello\n'); fs.writeFileSync(b, 'world\n');
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await expect(win.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 });
  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});
```

- [ ] **Step 2: 실행**

Run: `npm run e2e`
Expected: 신규 5개 + 기존 3개 모두 PASS(ruff 게이팅 제외).

- [ ] **Step 3: 커밋**

```bash
git add test/e2e/pdf-dual.spec.js
git commit -m "test(e2e): pdf dual viewer render/sync/zoom/page/regression"
```

---

## 완료 기준 (Acceptance 재확인)

- [ ] `npm test` — 기존 + `syncScroll`/`fileService.readBytes` 단위테스트 PASS.
- [ ] `npm run e2e` — pdf 렌더/스크롤 동기/동기 OFF/줌/페이지/회귀(diff) PASS.
- [ ] `electron . a.pdf b.pdf` → 두 PDF 동기 스크롤(양방향), 줌 양쪽, 동기 토글, 페이지 x/N 표시·점프.
- [ ] 텍스트/코드 파일 → 기존 diff 모드 회귀 없음.
- [ ] DevTools 콘솔에 워커/CSP 에러 0.

<!-- PLAN-END -->
