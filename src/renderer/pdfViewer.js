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
