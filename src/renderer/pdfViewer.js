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
  const initCbs = [];

  eventBus.on('pagechanging', (e) => pageCbs.forEach((cb) => cb(e.pageNumber)));
  // 줌하면 PDFPageView.update() → reset() 이 페이지 div의 "pdf.js가 모르는 자식"을 전부 지운다.
  // 마커 오버레이는 여기서 매번 다시 붙여야 살아남는다.
  eventBus.on('pagerendered', (e) => renderCbs.forEach((cb) => cb(e.pageNumber)));
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
    prev?.destroy(); // 재로드 시 이전 문서의 워커·메모리 해제
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
    onPagesInit: (cb) => initCbs.push(cb),
    scrollToPage: (n) => viewer.scrollPageIntoView({ pageNumber: n }),
    onPageChange: (cb) => pageCbs.push(cb),
    find,
    findClose,
    onFind: (cb) => findCbs.push(cb),
    onLinkNav: (cb) => navCbs.push(cb),
  };
}
