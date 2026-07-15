// src/renderer/pdfDualView.js — 두 PDFViewer를 좌/우 배치 + 비율 스크롤/줌/페이지/토글 동기.
import { createPdfViewer } from './pdfViewer.js';
import { syncTargetTop, syncTargetLeft } from './syncScroll.js';
import { createMarkerLayer, newId } from './pdfMarkers.js';

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
  const outlines = {};
  // 마커는 side가 아니라 "문서"에 묶는다 → switch 해도 마커가 문서를 따라간다.
  const markerStore = new Map(); // 문서경로 -> 마커[]
  for (const side of SIDES) {
    const pane = document.createElement('div');
    pane.className = 'pdf-pane';
    pane.dataset.side = side;
    hostEl.appendChild(pane);
    panes[side] = pane;
    // 목차 드로어는 뷰어를 "겹치지 않고" flex 2열로 밀어낸다 — 겹치면 page-width 페이지의
    // 왼쪽이 가려지므로, 열고 닫을 때 applyFit으로 폭을 다시 계산한다.
    const outline = document.createElement('div');
    outline.className = 'pdf-outline';
    pane.appendChild(outline);
    outlines[side] = outline;
    const viewerHost = document.createElement('div');
    viewerHost.className = 'pdf-viewer-host';
    pane.appendChild(viewerHost);
    viewers[side] = createPdfViewer(viewerHost);
    marks[side] = createMarkerLayer(viewers[side], markerStore);
    busy[side] = createBusy(pane); // 뷰어 뒤에 붙여 위에 겹치게
  }

  let syncEnabled = true;
  let syncing = false;
  let fitWidth = true; // 최초 로드가 page-width라 켜진 상태로 시작
  let outlineOpen = false;
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
      outline: outlineOpen,
    };
    stateCbs.forEach((cb) => cb(st));
  }

  function align(fromSide) {
    const from = viewers[fromSide].el;
    const to = viewers[other(fromSide)].el;
    to.scrollTop = syncTargetTop(from, to);
    to.scrollLeft = syncTargetLeft(from, to); // 확대 시 생긴 가로 스크롤도 함께 맞춘다
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
      const snap = snapshot();
      const last = hist.back[hist.back.length - 1];
      // goToDestination이 내부에서 goToPage를 거치면 콜백이 연달아 두 번 온다
      // (스크롤 전이라 두 스냅샷이 동일) → 같은 위치는 한 번만 쌓는다.
      if (last && last.left === snap.left && last.right === snap.right) return;
      hist.back.push(snap);
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
    if (outlineOpen) { panes[side].classList.add('outline-open'); refreshOutline(side); }
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
    if (outlineOpen) {
      for (const s of SIDES) {
        panes[s].classList.toggle('outline-open', loaded[s]);
        if (loaded[s]) refreshOutline(s); // 목차도 문서를 따라간다
      }
    }
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
      hasDoc: !!loaded[side],
      // 미러 점프 가능: 반대편이 열려 있고, 커서가 렌더된 페이지 위일 때
      canMirror: !!loaded[other(side)] && !!marks[side].locate(clientX, clientY),
    };
  }
  // 우클릭 메뉴 경로: contextInfo()가 미리 잡아 둔 캡처를 쓴다.
  function addMarker(kind, color) {
    if (!pending?.capture) return markSelection(kind, color);
    mirror(pending.side, marks[pending.side].add(pending.capture, kind, color));
    window.getSelection()?.removeAllRanges();
    pending = null;
    return true;
  }

  // 단축키 경로: 지금 살아 있는 선택을 그 자리에서 캡처한다. 어느 pane인지도 선택에서 알아낸다.
  function markSelection(kind, color) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return false;
    const side = SIDES.find((s) => panes[s].contains(sel.anchorNode));
    if (!side) return false;
    const capture = marks[side].captureSelection(panes[side]);
    if (!capture) return false;
    mirror(side, marks[side].add(capture, kind, color));
    sel.removeAllRanges();
    return true;
  }

  // ===== 마커 미러링 =====
  // transpaper 오버레이 번역은 페이지 지오메트리를 보존한다 → 원문 p.N의 (x,y,w,h) 정규화
  // 좌표는 번역본에서도 같은 내용을 가리킨다. 문서쌍이 양쪽에 열려 있으면 한쪽에 그은 마커를
  // 반대편 문서에도 자동 생성한다(쌍은 공통 group id로 묶여 함께 지워진다).
  let pairKeys = null; // 번역 완료 시 app.js가 명시 등록. 파일명 규칙으로도 자동 감지한다.
  function setPair(a, b) { pairKeys = a && b ? [a, b] : null; }
  // transpaper outputPathFor 규칙: <이름>.pdf ↔ <이름>.ko.pdf
  function autoPairOf(key) {
    const auto = /\.ko\.pdf$/i.test(key)
      ? key.replace(/\.ko\.pdf$/i, '.pdf')
      : key.replace(/\.pdf$/i, '.ko.pdf');
    return auto !== key ? auto : null;
  }
  function pairOf(key) {
    if (!key) return null;
    if (pairKeys) {
      if (key === pairKeys[0]) return pairKeys[1];
      if (key === pairKeys[1]) return pairKeys[0];
    }
    return autoPairOf(key);
  }

  function mirror(side, made) {
    if (!made?.length) return;
    const dstKey = pairOf(marks[side].getDoc());
    // 쌍 문서가 화면에 없으면 미러하지 않는다 — 저장 스냅샷이 side 기준이라 어차피 유실된다.
    const dstSide = dstKey && SIDES.find((s) => marks[s].getDoc() === dstKey);
    if (!dstSide) return;
    let arr = markerStore.get(dstKey);
    if (!arr) { arr = []; markerStore.set(dstKey, arr); }
    for (const m of made) {
      m.group ||= `g${newId()}`; // 원본·미러가 공유하는 그룹 — 삭제가 쌍으로 전파된다
      arr.push({ ...m, id: newId(), origin: 'mirror', rects: m.rects.map((r) => ({ ...r })) });
      marks[dstSide].renderPage(m.page);
    }
  }

  function removeMarker(side, id) {
    if (!id) return;
    const key = marks[side].getDoc();
    const target = key && (markerStore.get(key) || []).find((m) => m.id === id);
    marks[side].remove(id);
    // 미러 쌍(같은 group)이 반대편 문서에 있으면 함께 지운다.
    const g = target?.group;
    const dstKey = g && pairOf(key);
    if (!dstKey) return;
    const twin = (markerStore.get(dstKey) || []).find((m) => m.group === g);
    const dstSide = twin && SIDES.find((s) => marks[s].getDoc() === dstKey);
    if (dstSide) marks[dstSide].remove(twin.id);
  }

  // ===== 미러 점프 =====
  // Alt+클릭한 지점과 "같은 페이지·같은 위치"로 반대편을 스크롤하고 도착점을 펄스로 표시한다.
  // 좌표 동형성(오버레이 번역)이 전제. 이동 직전 위치는 링크 히스토리에 쌓여 ⌘←로 복귀한다.
  function jumpMirror(side, clientX, clientY) {
    const at = marks[side].locate(clientX, clientY);
    const to = other(side);
    if (!at || !loaded[to]) return false;
    const tv = viewers[to];
    const page = Math.min(tv.pageCount() || 1, at.page);

    hist.back.push(snapshot());
    if (hist.back.length > HIST_MAX) hist.back.shift();
    hist.fwd.length = 0;

    tv.scrollToPage(page);
    // scrollToPage 직후 대상 페이지는 미렌더일 수 있다 → 항상 존재하는 pageDiv 기준으로 보정
    // (textLayer는 화면 밖에서 파괴된다). 1px border 오차는 무시 가능.
    requestAnimationFrame(() => {
      const pd = tv.pageDivOf(page);
      if (pd) {
        tv.el.scrollTop = pd.offsetTop + at.y * pd.offsetHeight - tv.el.clientHeight / 2;
        const pulse = document.createElement('div');
        pulse.className = 'wc-pulse';
        pulse.style.left = `${at.x * 100}%`;
        pulse.style.top = `${at.y * 100}%`;
        pd.appendChild(pulse); // 일회성 — reset()에 지워져도 애니메이션 수명(1.5s)이면 충분
        setTimeout(() => pulse.remove(), 1600);
      }
      emit();
    });
    return true;
  }

  // ===== 목차 (TOC) =====
  async function refreshOutline(side) {
    const el = outlines[side];
    el.replaceChildren();
    let items = null;
    try { items = await viewers[side].getOutline(); } catch { /* 목차 없음으로 취급 */ }
    if (!items?.length) {
      const d = document.createElement('div');
      d.className = 'toc-empty';
      d.textContent = '(목차 없음)';
      el.appendChild(d);
      return;
    }
    el.appendChild(renderOutlineItems(items, side));
  }

  function renderOutlineItems(items, side) {
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'toc-item';
      const tog = document.createElement('span');
      tog.className = 'toc-toggle';
      const title = document.createElement('span');
      title.className = 'toc-title';
      title.textContent = it.title || '(제목 없음)';
      row.append(tog, title);
      if (it.dest) {
        // goToDestination은 pdfViewer의 몽키패치를 지난다 → 뒤로/앞으로 히스토리 자동 연동
        row.addEventListener('click', () => viewers[side].goToDest(it.dest));
      } else {
        // dest 없이 url(외부 링크)/action만 있는 항목도 흔하다 — 보안상 열지 않고 표시만.
        row.classList.add('disabled');
        if (it.url) row.title = '외부 링크: ' + it.url;
      }
      frag.appendChild(row);
      if (it.items?.length) {
        const kids = document.createElement('div');
        kids.className = 'toc-kids';
        kids.appendChild(renderOutlineItems(it.items, side));
        frag.appendChild(kids);
        tog.textContent = '▾';
        tog.addEventListener('click', (e) => {
          e.stopPropagation(); // 행 클릭(페이지 이동)과 분리
          tog.textContent = kids.classList.toggle('collapsed') ? '▸' : '▾';
        });
      }
    }
    return frag;
  }

  function setOutline(on) {
    outlineOpen = !!on;
    for (const side of SIDES) {
      const show = outlineOpen && loaded[side];
      panes[side].classList.toggle('outline-open', show);
      if (show) refreshOutline(side);
    }
    if (fitWidth) applyFit(); // 드로어가 pane 폭을 바꾼다 → page-width 재계산
    emit();
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
    setPair,
    jumpMirror,
    setOutline,
    isOutline: () => outlineOpen,
    getFullText: (side) => viewers[side].getFullText(),
    setBusy: (side, state) => busy[side](state),
    onState: (cb) => stateCbs.push(cb),
    isSync: () => syncEnabled,
    isFit: () => fitWidth,
  };
}
