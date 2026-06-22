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
