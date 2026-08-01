// src/renderer/paneSplit.js — 요약 패널 폭을 드래그로 조절하는 스플리터.
//
// 왜 flex 고정값을 걷어냈나: 예전 `.pdf-summary { flex:0 0 clamp(300px,30%,560px) }` 은 화면이
// 넓든 좁든 앱이 폭을 정했다. 논문을 읽는 사람마다 "원문을 크게" 와 "요약을 크게" 가 갈리는데
// 그 선택지가 아예 없었다. 이제 JS가 flex-basis를 직접 세우고 이 모듈이 그 값을 관리한다.
//
// 신뢰 경계는 없다(순수 렌더러 UI). 대신 지켜야 할 불변식이 하나 있다:
// **어느 쪽도 0px가 되어서는 안 된다.** 뷰어 폭이 0이면 pdf.js의 page-width 계산이 0으로 나눈
// 값을 받아 배율이 NaN/Infinity가 되고, 요약 폭이 0이면 mermaid가 폭 0에서 레이아웃을 재
// 빈 그림을 그린다(둘 다 이 코드베이스가 실제로 겪은 실패다 — pdfDualView의 setPaneVisible 주석 참고).
// 그래서 clampWidth가 양쪽 최소치를 동시에 지킨다.

// 요약 패널이 이보다 좁으면 마크다운 한 줄에 몇 글자 들어가지 않는다.
const MIN_SUMMARY = 240;
// 남는 뷰어 쪽(목차 + pane 두 개)에 반드시 남겨 둘 폭. 두 pane이 나뉘므로 하나당 최소 ~160px.
const MIN_REST = 360;
// 두 최소치를 동시에 만족할 수 없을 만큼 창이 좁을 때 요약이 내려갈 수 있는 절대 바닥.
// 0px 금지만으로는 부족하다 — 1px도 mermaid가 빈 그림을 그리는 폭이다.
const HARD_FLOOR = 80;
const DEFAULT_WIDTH = 380;
// 사용자의 보기 취향이라 문서가 아니라 localStorage에 둔다(summaryPanel의 FONT_KEY와 같은 계열).
const WIDTH_KEY = 'wc-sum-width';

/**
 * 요약 폭을 허용 범위로 조인다. 순수 함수라 DOM 없이 단위 테스트할 수 있다.
 *
 * 창이 아주 좁을 때가 까다롭다: MIN_SUMMARY(240) + MIN_REST(360) = 600px보다 창이 좁으면
 * 두 최소치를 동시에 만족시킬 수 없다. 그때는 **요약 쪽을 양보시킨다** — 뷰어가 원문이고
 * 요약은 곁다리라, 둘 중 하나가 찌그러져야 한다면 원문을 지키는 편이 맞다.
 * 다만 HARD_FLOOR 아래로는 내리지 않는다. 처음에는 하한을 1px로 두었는데, 그러면 300px짜리
 * 극단적인 창에서 요약이 1px가 되어 위 불변식의 '0px 금지'를 형식적으로만 지키게 된다 —
 * mermaid는 그 폭에서도 레이아웃을 재 빈 그림을 그린다. 실측으로 확인하고 바닥을 올렸다.
 * @param {*} want 원하는 폭(px)
 * @param {*} total 두 열이 나눠 쓸 전체 폭(px)
 * @returns {number} 정수 px
 */
function clampWidth(want, total) {
  const t = Number.isFinite(total) && total > 0 ? total : 0;
  // 숫자와 숫자 문자열만 값으로 인정한다. Number()에 그냥 맡기면 null과 []이 0으로 조용히
  // 변환돼(Number(null)===0, Number([])===0) "값이 없다"가 "0px를 원한다"로 둔갑한다 —
  // 그러면 기본값이 아니라 최소 폭으로 떨어져, 원인 없이 요약이 좁아진 것처럼 보인다.
  const numeric = typeof want === 'number' || (typeof want === 'string' && want.trim() !== '');
  const w = numeric && Number.isFinite(Number(want)) ? Number(want) : DEFAULT_WIDTH;
  if (!t) return Math.round(Math.max(MIN_SUMMARY, w)); // 아직 레이아웃 전 — 최소치만 지킨다
  const hi = Math.max(HARD_FLOOR, t - MIN_REST);
  const lo = Math.min(MIN_SUMMARY, hi); // 창이 좁으면 하한도 함께 내려간다(그래야 lo<=hi)
  return Math.round(Math.min(hi, Math.max(lo, w)));
}

// 스토리지 값은 신뢰하지 않는다 — 사람이 손대거나 옛 버전이 남긴 값일 수 있다.
function readWidth() {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}

function writeWidth(n) {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(n))); } catch { /* 저장 실패 무시 */ }
}

/**
 * hostEl(=#pdfview) 안에 스플리터를 만들고 target(=요약 패널)의 폭을 관리한다.
 * DOM 순서상 target 바로 앞에 놓아야 하므로, 호출측이 target을 붙이기 **전에** 부른다.
 * @param {HTMLElement} hostEl 두 열을 담은 flex 컨테이너
 * @param {object} opts
 * @param {HTMLElement} opts.target 폭을 조절할 요소(요약 패널)
 * @param {(w:number)=>void} [opts.onResize] 폭이 실제로 바뀔 때마다 호출(호출측이 applyFit)
 * @returns {{ el: HTMLElement, apply: () => void, getWidth: () => number }}
 */
function createPaneSplit(hostEl, { target, onResize } = {}) {
  const el = document.createElement('div');
  el.className = 'pane-split';
  el.title = '드래그해서 요약 폭 조절 (더블클릭 = 기본 폭)';
  // 손잡이는 반드시 target '앞'에 온다. append로 붙이면 요약 패널 뒤(창의 오른쪽 끝)에 놓여
  // 엉뚱한 자리를 잡으므로, 순서를 호출측의 생성 순서에 맡기지 않고 여기서 못 박는다.
  hostEl.insertBefore(el, target);

  let width = readWidth();

  // 드래그 중에는 매 픽셀마다 onResize를 부르지 않는다. applyFit은 페이지 배율을 다시 계산하고
  // pdf.js에 재렌더를 요청하므로, pointermove 빈도(초당 수십~수백)로 부르면 손이 멈춘 뒤에도
  // 렌더가 밀린다. rAF로 묶어 프레임당 한 번만 흘려보낸다.
  let raf = 0;
  function notify() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; onResize && onResize(width); });
  }

  // 폭을 화면에 반영한다. 창 크기가 바뀌면 허용 범위도 달라지므로 저장값을 다시 조인다 —
  // 넓은 화면에서 요약을 크게 잡아 둔 채 창을 좁히면 뷰어가 사라질 수 있기 때문이다.
  function apply() {
    const total = hostEl.clientWidth;
    const next = clampWidth(width, total);
    if (next !== width) width = next;
    target.style.flex = `0 0 ${width}px`;
  }

  function setWidth(w, { save = true } = {}) {
    const next = clampWidth(w, hostEl.clientWidth);
    if (next === width) return;
    width = next;
    target.style.flex = `0 0 ${width}px`;
    if (save) writeWidth(width);
    notify();
  }

  // pointer capture를 쓰는 이유: 마우스가 창 밖이나 다른 요소 위로 나가도 이벤트가 계속
  // 이 요소로 오게 하려는 것이다. 안 쓰면 빠르게 끌 때 포인터가 손잡이를 앞질러 드래그가
  // 중간에 끊기고, 놓은 것을 못 받아 상태가 "누른 채"로 남는다.
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // 텍스트 선택 방지
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    // 요약은 오른쪽 끝 열이다 → 폭 = 컨테이너 오른쪽 끝 - 포인터 x.
    const rect = hostEl.getBoundingClientRect();
    setWidth(rect.right - e.clientX);
  });
  const end = (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // 더블클릭으로 기본 폭 복귀 — 끝까지 끌어 놓고 되돌리지 못하는 상황을 막는 탈출구다.
  el.addEventListener('dblclick', () => setWidth(DEFAULT_WIDTH));

  apply();
  return { el, apply, getWidth: () => width };
}

module.exports = { createPaneSplit, clampWidth, MIN_SUMMARY, MIN_REST, DEFAULT_WIDTH };
