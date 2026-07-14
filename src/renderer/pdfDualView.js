// src/renderer/pdfDualView.js — 두 PDFViewer를 좌/우 배치 + 비율 스크롤/줌/페이지/토글 동기.
import { createPdfViewer } from './pdfViewer.js';
import { syncTargetTop } from './syncScroll.js';
import { createMarkerLayer } from './pdfMarkers.js';

// 오래 걸리는 작업(번역)을 해당 pane 위에 겹쳐 보여주는 오버레이.
function createBusy(paneEl) {
  const el = document.createElement('div');
  el.className = 'pdf-busy';
  const spin = document.createElement('div'); spin.className = 'pdf-busy-spin';
  const title = document.createElement('div'); title.className = 'pdf-busy-title';
  const sub = document.createElement('div'); sub.className = 'pdf-busy-sub';
  const barWrap = document.createElement('div'); barWrap.className = 'pdf-busy-bar';
  const bar = document.createElement('i');
  barWrap.appendChild(bar);
  const hint = document.createElement('div'); hint.className = 'pdf-busy-hint';
  el.append(spin, title, sub, barWrap, hint);
  el.style.display = 'none';
  paneEl.appendChild(el);

  return (state) => {
    if (!state) { el.style.display = 'none'; return; }
    title.textContent = state.title || '';
    sub.textContent = state.sub || '';
    hint.textContent = state.hint || '';
    const known = typeof state.ratio === 'number';
    barWrap.style.visibility = known ? 'visible' : 'hidden';
    bar.style.width = known ? `${Math.round(Math.min(1, Math.max(0, state.ratio)) * 100)}%` : '0%';
    el.style.display = 'flex';
  };
}

export function createDualView(hostEl) {
  const other = (s) => (s === 'left' ? 'right' : 'left');
  const SIDES = ['left', 'right'];
  const viewers = {};
  const panes = {};
  const busy = {};
  const marks = {};
  // 마커는 side가 아니라 "문서"에 묶는다 → switch 해도 마커가 문서를 따라간다.
  const markerStore = new Map(); // 문서경로 -> 마커[]
  for (const side of SIDES) {
    const pane = document.createElement('div');
    pane.className = 'pdf-pane';
    pane.dataset.side = side;
    hostEl.appendChild(pane);
    panes[side] = pane;
    viewers[side] = createPdfViewer(pane);
    marks[side] = createMarkerLayer(viewers[side], markerStore);
    busy[side] = createBusy(pane); // 뷰어 뒤에 붙여 위에 겹치게
  }

  let syncEnabled = true;
  let syncing = false;
  let fitWidth = true; // 최초 로드가 page-width라 켜진 상태로 시작
  const loaded = { left: false, right: false };
  const stateCbs = [];

  const loadedSides = () => SIDES.filter((s) => loaded[s]);
  // 배율은 반드시 "로드된" 쪽에서 읽는다 — 빈 뷰어의 기본 배율을 집으면 엉뚱한 값이 된다.
  const baseScale = () => {
    const s = loadedSides()[0];
    return (s && viewers[s].getScale()) || 1;
  };

  function emit() {
    const st = {
      sync: syncEnabled,
      fit: fitWidth,
      loaded: { ...loaded },
      left: { page: viewers.left.currentPage(), count: viewers.left.pageCount() },
      right: { page: viewers.right.currentPage(), count: viewers.right.pageCount() },
      scale: baseScale(),
      canBack: hist.back.length > 0,
      canForward: hist.fwd.length > 0,
    };
    stateCbs.forEach((cb) => cb(st));
  }

  function align(fromSide) {
    const to = viewers[other(fromSide)].el;
    to.scrollTop = syncTargetTop(viewers[fromSide].el, to);
  }

  function realign() {
    if (syncEnabled && loaded.left && loaded.right) requestAnimationFrame(() => align('left'));
  }

  function onScroll(fromSide) {
    if (!syncEnabled || syncing) return;
    if (!loaded.left || !loaded.right) return;
    syncing = true;
    align(fromSide);
    requestAnimationFrame(() => { syncing = false; });
  }

  for (const side of SIDES) {
    viewers[side].el.addEventListener('scroll', () => onScroll(side));
    viewers[side].onPageChange(() => emit());
    // Ctrl(또는 trackpad 핀치) + 휠 → 줌. 브라우저 기본 페이지 줌 차단 위해 passive:false + preventDefault.
    viewers[side].el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  // ===== 링크 이동 히스토리 =====
  // 문서 내부 링크로 튄 "직전" 스크롤 위치를 양쪽 다 기록해 두고, 뒤/앞으로 되돌린다.
  // 양쪽을 함께 기록하는 이유: Sync가 꺼져 있으면 두 pane의 위치가 서로 다르기 때문.
  const hist = { back: [], fwd: [] };
  const HIST_MAX = 50;
  const snapshot = () => ({ left: viewers.left.el.scrollTop, right: viewers.right.el.scrollTop });

  function restore(pos) {
    syncing = true; // 양쪽을 직접 되돌리므로 스크롤 동기가 끼어들지 않게 한다
    viewers.left.el.scrollTop = pos.left;
    viewers.right.el.scrollTop = pos.right;
    requestAnimationFrame(() => { syncing = false; emit(); });
  }

  for (const side of SIDES) {
    viewers[side].onLinkNav(() => {
      hist.back.push(snapshot());
      if (hist.back.length > HIST_MAX) hist.back.shift();
      hist.fwd.length = 0;
      emit();
    });
  }

  function goBack() {
    if (!hist.back.length) return;
    hist.fwd.push(snapshot());
    restore(hist.back.pop());
    emit();
  }
  function goForward() {
    if (!hist.fwd.length) return;
    hist.back.push(snapshot());
    restore(hist.fwd.pop());
    emit();
  }

  // ===== 문자열 검색 =====
  // 양쪽 pane에서 동시에 찾는다. 원문/번역본은 텍스트가 달라 한쪽만 걸리는 게 정상이다.
  let findQuery = '';
  const findCounts = { left: null, right: null }; // null = 문서 없음
  const findCbs = [];
  const emitFind = () => findCbs.forEach((cb) => cb({ query: findQuery, ...findCounts }));
  for (const side of SIDES) viewers[side].onFind((c) => { findCounts[side] = c; emitFind(); });

  function find(query, { prev = false } = {}) {
    const q = query || '';
    if (!q) {
      findQuery = '';
      findCounts.left = findCounts.right = null;
      for (const side of SIDES) viewers[side].findClose();
      emitFind();
      return;
    }
    const again = q === findQuery; // 같은 질의 → 다음/이전 일치로만 이동
    findQuery = q;
    for (const side of SIDES) {
      if (loaded[side]) viewers[side].find(q, { again, findPrevious: prev });
      else findCounts[side] = null;
    }
    emitFind();
  }

  // page-width는 대입 시점의 컨테이너 너비로만 계산된다 → 창이 바뀌면 다시 대입해야 한다.
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (!fitWidth) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(applyFit);
  });

  function applyFit() {
    for (const side of loadedSides()) viewers[side].setScaleValue('page-width');
    realign();
    emit();
  }

  async function openSide(side, { bytes, path }) {
    await viewers[side].load(bytes);
    loaded[side] = true;
    marks[side].setDoc(path || null); // 재렌더가 이전 문서 마커를 그리지 않도록 동기 갱신
    // fit이 꺼져 있으면 반대편이 쓰던 배율에 맞춘다 (자기 배율을 읽으면 방금 적용된 page-width가 나온다).
    if (fitWidth) applyFit();
    else if (loaded[other(side)]) viewers[side].setScale(viewers[other(side)].getScale());
    refind();
    emit();
  }

  function setSync(on) {
    syncEnabled = on;
    if (on && loaded.left && loaded.right) align('left');
    emit();
  }

  function setFit(on) {
    fitWidth = on;
    if (on) applyFit(); else emit();
  }

  function zoom(delta) {
    fitWidth = false; // 사용자가 배율을 직접 정했으므로 fit 해제
    const cur = baseScale();
    const next = Math.max(0.25, Math.min(5, cur * (delta > 0 ? 1.1 : 1 / 1.1)));
    if (next === cur) return;

    // 가로 중앙 기준 확대/축소.
    // 그냥 두면 왼쪽이 고정된 채 커진다: 페이지가 컨테이너보다 넓어지는 순간 .pdfViewer .page의
    // margin:auto가 0으로 접혀 페이지가 왼쪽에 붙고, pdf.js도 스크롤을 페이지 왼쪽 기준으로 복원한다.
    // 그래서 컨테이너 콘텐츠 좌표가 아니라 "페이지 안에서의 위치(0~1)"를 기준으로 삼는다
    // — 페이지가 좁을 땐 가운데 정렬돼 원점이 움직이므로, 콘텐츠 좌표로는 계산이 어긋난다.
    const anchor = {};
    for (const side of loadedSides()) {
      const el = viewers[side].el;
      const page = viewers[side].pageDiv();
      if (!page?.offsetWidth) continue;
      anchor[side] = (el.scrollLeft + el.clientWidth / 2 - page.offsetLeft) / page.offsetWidth;
    }

    for (const side of SIDES) viewers[side].setScale(next);

    for (const side of loadedSides()) {
      if (anchor[side] === undefined) continue;
      const el = viewers[side].el;
      const page = viewers[side].pageDiv();
      if (!page?.offsetWidth) continue;
      // 범위를 벗어난 값은 브라우저가 [0, 최대] 로 알아서 클램프한다.
      el.scrollLeft = page.offsetLeft + anchor[side] * page.offsetWidth - el.clientWidth / 2;
    }
    realign();
    emit();
  }

  function gotoPage(n) {
    for (const side of loadedSides()) {
      const cnt = viewers[side].pageCount() || 1;
      viewers[side].scrollToPage(Math.max(1, Math.min(cnt, n)));
    }
    emit();
  }

  // 좌우 교체 — 파싱된 문서 객체만 맞바꾼다(재파싱 없음). 한쪽만 열려 있으면 반대편으로 옮긴다.
  async function switchSides() {
    const pages = { left: viewers.left.currentPage(), right: viewers.right.currentPage() };
    const docs = { left: viewers.left.getDoc(), right: viewers.right.getDoc() };
    if (!docs.left && !docs.right) return;

    const keys = { left: marks.left.getDoc(), right: marks.right.getDoc() };
    await viewers.left.setDoc(docs.right);
    await viewers.right.setDoc(docs.left);
    loaded.left = !!docs.right;
    loaded.right = !!docs.left;
    marks.left.setDoc(keys.right); // 마커도 문서를 따라 반대편으로
    marks.right.setDoc(keys.left);

    if (fitWidth) for (const s of loadedSides()) viewers[s].setScaleValue('page-width');
    else for (const s of loadedSides()) viewers[s].setScale(baseScale());

    for (const side of loadedSides()) {
      const p = pages[other(side)];
      if (p > 1) viewers[side].scrollToPage(Math.min(viewers[side].pageCount() || 1, p));
    }
    hist.back.length = 0; // 문서가 바뀌었으므로 링크 히스토리는 무효
    hist.fwd.length = 0;
    refind();
    realign();
    emit();
  }

  // 문서가 교체되면 findController가 초기화된다 → 활성 질의가 있으면 다시 건다.
  function refind() {
    if (!findQuery) return;
    const q = findQuery;
    findQuery = '';
    find(q);
  }

  // ===== 마커 (형광펜/밑줄) =====
  // 우클릭 시점에 선택 영역을 "동기적으로" 캡처해 둔다 — 메뉴를 띄우는 동안 선택이 사라질 수 있다.
  let pending = null;

  function contextInfo(side, clientX, clientY) {
    pending = { side, capture: marks[side].captureSelection(panes[side]) };
    return {
      hasSelection: !!pending.capture,
      markerId: marks[side].markerAt(clientX, clientY),
    };
  }
  // 우클릭 메뉴 경로: contextInfo()가 미리 잡아 둔 캡처를 쓴다.
  function addMarker(kind) {
    if (!pending?.capture) return markSelection(kind);
    marks[pending.side].add(pending.capture, kind);
    window.getSelection()?.removeAllRanges();
    pending = null;
    return true;
  }

  // 단축키 경로: 지금 살아 있는 선택을 그 자리에서 캡처한다. 어느 pane인지도 선택에서 알아낸다.
  function markSelection(kind) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return false;
    const side = SIDES.find((s) => panes[s].contains(sel.anchorNode));
    if (!side) return false;
    const capture = marks[side].captureSelection(panes[side]);
    if (!capture) return false;
    marks[side].add(capture, kind);
    sel.removeAllRanges();
    return true;
  }
  function removeMarker(side, id) {
    if (id) marks[side].remove(id);
  }
  // 프로젝트 저장/복원용 — side 기준으로 주고받는다(경로 해석 결과가 달라도 안전).
  function getMarkers() {
    return { left: [...marks.left.markers()], right: [...marks.right.markers()] };
  }
  function setMarkers(side, list) {
    const key = marks[side].getDoc();
    if (!key) return;
    markerStore.set(key, Array.isArray(list) ? list : []);
    marks[side].renderAll();
  }

  return {
    openSide,
    setSync,
    setFit,
    zoom,
    gotoPage,
    switchSides,
    find,
    onFind: (cb) => findCbs.push(cb),
    goBack,
    goForward,
    contextInfo,
    addMarker,
    markSelection,
    removeMarker,
    getMarkers,
    setMarkers,
    setBusy: (side, state) => busy[side](state),
    onState: (cb) => stateCbs.push(cb),
    isSync: () => syncEnabled,
    isFit: () => fitWidth,
  };
}
