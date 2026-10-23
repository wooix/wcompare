// src/renderer/pdfViewer.js — 한 side의 pdf.js PDFViewer를 캡슐화.
import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { PDFViewer, EventBus, PDFLinkService, PDFFindController } from 'pdfjs-dist/web/pdf_viewer.mjs';
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
  // findController는 생성자 옵션으로 넘겨야 viewer.setDocument()가 문서를 자동으로 물려준다.
  const findController = new PDFFindController({ linkService, eventBus });
  const viewer = new PDFViewer({ container, viewer: viewerDiv, eventBus, linkService, findController });
  linkService.setViewer(viewer);

  const pageCbs = [];
  const findCbs = [];
  const navCbs = [];
  const renderCbs = [];
  const textRenderCbs = [];
  const initCbs = [];

  eventBus.on('pagechanging', (e) => pageCbs.forEach((cb) => cb(e.pageNumber)));
  // 줌하면 PDFPageView.update() → reset() 이 페이지 div의 "pdf.js가 모르는 자식"을 전부 지운다.
  // 마커 오버레이는 여기서 매번 다시 붙여야 살아남는다.
  eventBus.on('pagerendered', (e) => renderCbs.forEach((cb) => cb(e.pageNumber)));
  eventBus.on('textlayerrendered', (e) => textRenderCbs.forEach((cb) => cb(e.pageNumber)));
  eventBus.on('pagesinit', () => initCbs.forEach((cb) => cb()));

  const onFindUpdate = (e) => {
    const c = e.matchesCount || {};
    findCbs.forEach((cb) => cb({ current: c.current ?? 0, total: c.total ?? 0 }));
  };
  eventBus.on('updatefindmatchescount', onFindUpdate);
  eventBus.on('updatefindcontrolstate', onFindUpdate);

  // 문서 내부 링크 클릭은 반드시 linkService를 지난다 → 이동 "직전"에 알려 히스토리를 쌓게 한다.
  for (const m of ['goToDestination', 'goToPage']) {
    const orig = linkService[m].bind(linkService);
    linkService[m] = (...args) => {
      navCbs.forEach((cb) => cb());
      return orig(...args);
    };
  }

  let doc = null;

  // 이미 파싱된 문서를 붙이거나(next) 떼어낸다(null). 이전 문서는 반환만 하고 destroy하지 않는다
  // — switch에서 반대편 뷰어로 그대로 넘겨야 하기 때문(재파싱 0).
  async function setDoc(next) {
    const prev = doc;
    doc = next || null;
    const ready = doc && new Promise((resolve) => eventBus.on('pagesinit', resolve, { once: true }));
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    if (doc) await ready;
    return prev;
  }

  async function load(bytes) {
    const next = await getDocument({ data: bytes, ...DOC_OPTS }).promise;
    const prev = await setDoc(next);
    // 재로드 시 이전 문서의 워커·메모리 해제. pdf.js v6 프록시엔 destroy가 없어 loadingTask로 정리한다.
    prev?.loadingTask?.destroy();
    viewer.currentScaleValue = 'page-width';
  }

  // again=true면 같은 질의에서 다음/이전 일치로만 이동한다(재검색 없음).
  function find(query, { again = false, findPrevious = false } = {}) {
    if (!doc) return;
    eventBus.dispatch('find', {
      source: null,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  }
  function findClose() { eventBus.dispatch('findbarclose', { source: null }); }

  // 페이지별 텍스트 배열(0-based: [0]이 1페이지). 렌더 여부와 무관하게 getTextContent로 뽑는다
  // — 화면 밖 페이지의 textLayer는 pdf.js가 버퍼(기본 10) 밖에서 파괴하므로 DOM에 기댈 수 없다.
  // 페이지 경계를 유지하는 이유: 절별 요약은 목차의 페이지 범위로 본문을 잘라야 해서,
  // 통짜 문자열로 합쳐 버리면 "이 절이 몇 페이지에 있는지"를 되찾을 수 없다.
  async function getPageTexts() {
    if (!doc) return [];
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let out = '';
      for (const item of tc.items) {
        if (typeof item.str !== 'string') continue;
        out += item.str;
        out += item.hasEOL ? '\n' : ' ';
      }
      pages.push(out);
    }
    return pages;
  }

  // 문서 전체 텍스트 — 페이지 배열을 빈 줄로 이어 붙인 것(기존 '전체 텍스트 복사' 계약 유지).
  async function getFullText() {
    return (await getPageTexts()).join('\n\n');
  }

  // 목차 항목의 dest → 1-based 페이지 번호. pdf.js의 PDFLinkService.goToDestination이 내부에서
  // 쓰는 것과 같은 절차다: 명명된 목적지(문자열)는 getDestination으로 explicit 배열을 얻고,
  // 그 첫 원소(Ref)를 getPageIndex에 넘긴다. 끊어진 링크·그룹핑용 항목은 null —
  // 호출자는 그 절을 "페이지 매핑 없음"으로 취급하면 된다(요약 흐름을 예외로 끊지 않는다).
  async function destToPage(dest) {
    if (!doc || !dest) return null;
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit.length) return null;
      const ref = explicit[0];
      if (ref && typeof ref === 'object') return (await doc.getPageIndex(ref)) + 1;
      if (Number.isInteger(ref)) return ref + 1; // 페이지 인덱스가 직접 들어 있는 형태
      return null;
    } catch {
      return null;
    }
  }

  // 논문 제목 — 요약 프롬프트의 앵커로 쓴다. 메타데이터가 비어 있는 PDF가 흔하므로 실패는 빈 문자열.
  async function getTitle() {
    if (!doc) return '';
    try {
      const { info } = await doc.getMetadata();
      const t = info?.Title;
      return typeof t === 'string' ? t.trim() : '';
    } catch {
      return '';
    }
  }

  return {
    el: container,
    load,
    getDoc: () => doc,
    setDoc,
    setScale: (n) => { viewer.currentScale = n; },
    // 'page-width' 같은 문자열 배율. 호출 시점의 컨테이너 너비로 계산되므로 리사이즈마다 재대입해야 한다.
    setScaleValue: (v) => { viewer.currentScaleValue = v; },
    getScale: () => viewer.currentScale,
    currentPage: () => viewer.currentPageNumber || 1,
    pageCount: () => viewer.pagesCount || 0,
    // 현재 페이지의 DOM 요소. offsetLeft/offsetWidth는 스크롤과 무관한 콘텐츠 좌표라
    // 확대 기준점을 "페이지 안의 위치"로 잡는 데 쓴다.
    pageDiv: () => viewer.getPageView((viewer.currentPageNumber || 1) - 1)?.div || null,
    pageDivOf: (n) => viewer.getPageView(n - 1)?.div || null,
    // 마커 좌표의 기준 박스. 페이지 div는 우리가 준 1px border 때문에 원점이 어긋나지만
    // textLayer는 inset:0 이라 콘텐츠 박스와 정확히 일치한다.
    textLayerOf: (n) => viewer.getPageView(n - 1)?.textLayer?.div || null,
    onPageRendered: (cb) => renderCbs.push(cb),
    onTextLayerRendered: (cb) => textRenderCbs.push(cb),
    onPagesInit: (cb) => initCbs.push(cb),
    scrollToPage: (n) => viewer.scrollPageIntoView({ pageNumber: n }),
    onPageChange: (cb) => pageCbs.push(cb),
    find,
    findClose,
    onFind: (cb) => findCbs.push(cb),
    onLinkNav: (cb) => navCbs.push(cb),
    getFullText,
    getPageTexts,
    getTitle,
    destToPage,
    // 목차. goToDestination은 위의 몽키패치를 지나므로 링크 히스토리(뒤로/앞으로)가 그대로 작동한다.
    getOutline: () => (doc ? doc.getOutline() : Promise.resolve(null)),
    goToDest: (dest) => { if (dest) linkService.goToDestination(dest); },
  };
}
