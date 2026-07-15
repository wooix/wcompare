// src/renderer/pdfMarkers.js — 형광펜/밑줄 마커 오버레이.
//
// 좌표계: 페이지의 textLayer 박스를 기준으로 0~1 정규화해 저장하고, 렌더는 % 로 한다.
//  - textLayer 기준인 이유: .pdfViewer .page 는 content-box 인데 우리가 border:1px 를 줘서
//    pageDiv.getBoundingClientRect() 는 원점이 1px 바깥이고 폭이 2px 크다. textLayer 는 inset:0.
//  - % 렌더인 이유: 페이지 div 크기가 CSS 변수(--total-scale-factor)로 구동되므로
//    줌/리사이즈/page-width 재적용을 JS 개입 없이 그대로 따라간다.
//
// 생명주기: 줌하면 PDFPageView.reset() 이 페이지 div의 "pdf.js가 모르는 자식"을 전부 지운다.
// 그래서 pagerendered 마다 멱등하게 재부착한다.

let seq = 0;
const newId = () => `mk${Date.now().toString(36)}${(seq++).toString(36)}`;

// getClientRects()는 한 줄마다 거의 같은 사각형을 여러 개 돌려준다(세로로 크게 겹침).
// 그대로 그리면 형광펜은 multiply가 곱해져 진해지고 밑줄은 겹쳐서 굵어진다.
// 세로로 절반 이상 겹치는 사각형들을 "같은 줄"로 묶어 줄당 하나로 합친다.
export function coalesceRects(rects) {
  const rows = [];
  for (const r of [...rects].sort((a, b) => a.y - b.y)) {
    const row = rows[rows.length - 1];
    const overlap = row ? Math.min(row.y + row.h, r.y + r.h) - Math.max(row.y, r.y) : 0;
    if (row && overlap >= Math.min(row.h, r.h) * 0.5) {
      const x = Math.min(row.x, r.x);
      const y = Math.min(row.y, r.y);
      row.w = Math.max(row.x + row.w, r.x + r.w) - x;
      row.h = Math.max(row.y + row.h, r.y + r.h) - y;
      row.x = x; row.y = y;
    } else {
      rows.push({ ...r });
    }
  }
  return rows;
}

export const COLORS = {
  highlight: 'rgba(255, 214, 74, 0.45)',
  underline: '#ff5c5c',
};

/**
 * @param viewer createPdfViewer(...) 가 돌려준 객체
 * @param store  문서경로 -> 마커배열 (좌/우 뷰어가 공유 → switch 해도 마커가 문서를 따라간다)
 */
export function createMarkerLayer(viewer, store) {
  let docKey = null;

  const list = () => (docKey && store.get(docKey)) || [];

  // 오버레이는 항상 페이지 div의 "마지막 자식"이어야 한다.
  // pdf.js의 #addLayer는 .after()/.prepend() 만 쓰므로 마지막 자리는 침범당하지 않는다.
  function layerOf(page) {
    const pageDiv = viewer.pageDivOf(page);
    if (!pageDiv) return null;
    let layer = pageDiv.querySelector(':scope > .wc-marker-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'wc-marker-layer';
    }
    if (layer.parentNode !== pageDiv || pageDiv.lastElementChild !== layer) pageDiv.appendChild(layer);
    return layer;
  }

  function renderPage(page) {
    const layer = layerOf(page);
    if (!layer) return;
    layer.replaceChildren();
    for (const m of list()) {
      if (m.page !== page) continue;
      for (const r of m.rects) {
        const el = document.createElement('div');
        el.className = `wc-mark wc-mark-${m.kind}`;
        el.dataset.id = m.id;
        el.style.left = `${r.x * 100}%`;
        el.style.top = `${r.y * 100}%`;
        el.style.width = `${r.w * 100}%`;
        el.style.height = `${r.h * 100}%`;
        if (m.kind === 'highlight') el.style.background = m.color;
        else el.style.color = m.color; // box-shadow: inset 0 -2px 0 currentColor
        layer.appendChild(el);
      }
    }
  }

  function renderAll() {
    const n = viewer.pageCount();
    for (let p = 1; p <= n; p++) if (viewer.pageDivOf(p)) renderPage(p);
  }

  viewer.onPageRendered((p) => renderPage(p));
  viewer.onPagesInit(() => renderAll());

  // 화면 좌표 → 페이지 번호 + 페이지 내 0~1 좌표. 렌더된 페이지만 대상.
  function locate(clientX, clientY) {
    const n = viewer.pageCount();
    for (let p = 1; p <= n; p++) {
      const tl = viewer.textLayerOf(p);
      if (!tl) continue;
      const b = tl.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (clientX < b.left || clientX > b.right || clientY < b.top || clientY > b.bottom) continue;
      return { page: p, x: (clientX - b.left) / b.width, y: (clientY - b.top) / b.height };
    }
    return null;
  }

  // 선택 영역 → 페이지별 정규화 rect. 여러 페이지에 걸친 선택도 rect 단위로 나눠 담는다.
  // (pdf.js의 getSelectionBoxes는 selection이 한 textLayer 안에 있을 때만 동작하므로 그대로 못 쓴다.)
  function captureSelection(hostEl) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    // 이 pane 안에서 일어난 선택인가 (좌/우는 같은 document의 서로 다른 서브트리다)
    if (!hostEl.contains(sel.anchorNode) || !hostEl.contains(sel.focusNode)) return null;

    const boxes = [];
    const n = viewer.pageCount();
    for (let p = 1; p <= n; p++) {
      const tl = viewer.textLayerOf(p);
      if (tl) boxes.push({ page: p, b: tl.getBoundingClientRect() });
    }

    const byPage = new Map();
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const r of sel.getRangeAt(i).getClientRects()) {
        if (r.width <= 0 || r.height <= 0) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hit = boxes.find(({ b }) => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom);
        if (!hit) continue;
        const { b } = hit;
        let rects = byPage.get(hit.page);
        if (!rects) { rects = []; byPage.set(hit.page, rects); }
        rects.push({
          x: (r.left - b.left) / b.width,
          y: (r.top - b.top) / b.height,
          w: r.width / b.width,
          h: r.height / b.height,
        });
      }
    }
    if (!byPage.size) return null;
    for (const [page, rects] of byPage) byPage.set(page, coalesceRects(rects));
    return byPage;
  }

  function add(byPage, kind) {
    if (!docKey || !byPage) return [];
    let arr = store.get(docKey);
    if (!arr) { arr = []; store.set(docKey, arr); }
    const made = [];
    for (const [page, rects] of byPage) {
      const m = { id: newId(), page, kind, color: COLORS[kind], rects };
      arr.push(m);
      made.push(m);
      renderPage(page);
    }
    return made;
  }

  function markerAt(clientX, clientY) {
    const at = locate(clientX, clientY);
    if (!at) return null;
    // 나중에 찍은 마커가 위에 있으므로 뒤에서부터 찾는다
    const arr = list();
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (m.page !== at.page) continue;
      if (m.rects.some((r) => at.x >= r.x && at.x <= r.x + r.w && at.y >= r.y && at.y <= r.y + r.h)) return m.id;
    }
    return null;
  }

  function remove(id) {
    if (!docKey) return;
    const arr = store.get(docKey);
    if (!arr) return;
    const i = arr.findIndex((m) => m.id === id);
    if (i < 0) return;
    const { page } = arr[i];
    arr.splice(i, 1);
    renderPage(page);
  }

  return {
    // 문서 키는 반드시 동기적으로 바꾼다 — 재렌더가 이전 문서의 마커를 그리지 않게.
    setDoc: (key) => { docKey = key || null; renderAll(); },
    getDoc: () => docKey,
    captureSelection,
    add,
    markerAt,
    remove,
    renderAll,
    markers: () => list(),
  };
}
