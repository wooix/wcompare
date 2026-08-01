// src/renderer/summaryPanel.js — 논문 요약 패널(Overview / 절별 요약 / 흐름도 3탭).
//
// 상태는 전부 클로저에 두고 밖으로는 함수만 노출한다(pdfDualView의 createBusy/createUrlPanel 관용구).
// 요약을 "만드는" 일은 콜백(onGenerate/onRegenerate)에 통째로 위임하고, 이 모듈은 표시와
// 오류 안내만 맡는다 — 덕분에 LLM 호출 경로가 바뀌어도 여기는 손댈 필요가 없다.
import { renderMarkdown } from './markdownView.js';
import { renderMermaid, setMermaidTheme } from './mermaidLoader.js';
import { createSummaryToc } from './summaryToc.js';

const TABS = [
  { kind: 'overview', label: 'Overview' },
  { kind: 'sections', label: '절별 요약' },
  { kind: 'flow', label: '흐름도' },
];

// LLM이 돌려준 문자열은 신뢰할 수 없다 → 상한을 둬서 렌더가 통째로 멎는 것을 막는다.
const MAX_TEXT = 200000; // 마크다운(overview/sections)
const MAX_FLOW = 20000; // mermaid 코드. 넘쳐서 잘리면 파싱이 깨지고, 그건 아래 오류 경로가 받아 준다.

let flowSeq = 0; // mermaid는 id로 <defs>를 구분한다 → 렌더마다 새 id를 준다

// ===== 글씨 크기 =====
// 본문 크기는 .sum-body의 font-size:var(--sum-font, 13px)가 정한다. 마크다운 규칙이 전부 em이라
// 패널 루트에 이 변수 하나만 세우면 제목·본문·코드·수식이 한꺼번에 따라 움직인다.
const FONT_DEFAULT = 13;
const FONT_MIN = 10;
const FONT_MAX = 24;
const FONT_STEP = 1;
// 문서가 아니라 사용자의 보기 취향이므로 프로젝트 파일이 아닌 localStorage에 둔다
// (app.js의 wc-night / wc-dict / wc-layout과 같은 계열).
const FONT_KEY = 'wc-sum-font';

// 스토리지 값은 신뢰하지 않는다 — 사람이 손댈 수 있고 옛 버전이 남긴 값일 수도 있다.
// 숫자가 아니거나 범위를 벗어나면 조용히 기본값으로 되돌린다.
function readFontSize() {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    if (Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX) return Math.round(n);
  } catch { /* 스토리지 불가 환경 */ }
  return FONT_DEFAULT;
}

// pdfDualView.createBusy와 같은 모양의 오버레이. 패널 위에 겹쳐 진행 상황을 알린다.
function createBusy(rootEl) {
  const el = document.createElement('div');
  el.className = 'sum-busy';
  const spin = document.createElement('div'); spin.className = 'sum-busy-spin';
  const title = document.createElement('div'); title.className = 'sum-busy-title';
  const sub = document.createElement('div'); sub.className = 'sum-busy-sub';
  const barWrap = document.createElement('div'); barWrap.className = 'sum-busy-bar';
  const bar = document.createElement('i');
  barWrap.appendChild(bar);
  const hint = document.createElement('div'); hint.className = 'sum-busy-hint';
  el.append(spin, title, sub, barWrap, hint);
  el.style.display = 'none';
  rootEl.appendChild(el);

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

export function createSummaryPanel(hostEl, { onGenerate, onRegenerate, onCopy, onSave } = {}) {
  const el = document.createElement('div');
  el.className = 'pdf-summary';

  // ===== 탭바 =====
  const tabbar = document.createElement('div');
  tabbar.className = 'sum-tabs';
  const tabBtns = {};
  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = 'sum-tab';
    b.dataset.kind = t.kind;
    b.textContent = t.label;
    b.addEventListener('click', () => setTab(t.kind));
    tabbar.appendChild(b);
    tabBtns[t.kind] = b;
  }
  // 글씨 크기 조절 — 탭바 오른쪽에 붙는다(.sum-font의 margin-left:auto가 여기를 기준으로 민다).
  // DOM 순서는 CSS가 전제하는 "탭 3개 → .sum-font"를 지켜야 한다(동작 버튼은 아래 .sum-acts 줄).
  const fontBox = document.createElement('div');
  fontBox.className = 'sum-font';
  const fontDec = document.createElement('button');
  fontDec.className = 'sum-font-dec';
  fontDec.textContent = 'A−';
  fontDec.title = '글씨 작게';
  const fontReset = document.createElement('button');
  fontReset.className = 'sum-font-reset';
  fontReset.textContent = '↺';
  fontReset.title = '글씨 크기 초기화';
  const fontInc = document.createElement('button');
  fontInc.className = 'sum-font-inc';
  fontInc.textContent = 'A+';
  fontInc.title = '글씨 크게';
  fontBox.append(fontDec, fontReset, fontInc);
  tabbar.appendChild(fontBox);

  // ===== 동작 버튼 줄 =====
  // 탭바에 같이 넣지 않은 이유: 패널 폭이 최소 300px인데 탭 3개 + 글씨 버튼 3개로 이미 그 폭이
  // 찬다. 여기에 복사·저장·다시 생성까지 끼우면 flex가 라벨을 눌러 글자가 잘린다.
  // 내용이 하나도 없을 때는 줄 전체를 감춘다(syncEmpty) — 빈 요약에 대고 복사/저장할 것이 없다.
  const acts = document.createElement('div');
  acts.className = 'sum-acts';
  const mkAct = (cls, label, title) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.dataset.label = label; // flash()가 되돌릴 원래 라벨(연타로 '복사됨됨'이 되지 않게)
    b.title = title;
    acts.appendChild(b);
    return b;
  };
  const copyBtn = mkAct('sum-copy', '복사', '요약 전체를 마크다운으로 클립보드에 복사합니다');
  const saveBtn = mkAct('sum-save', '저장', '요약 전체를 마크다운 파일로 저장합니다');
  // 범위가 "활성 탭 하나"라는 사실을 라벨 자체에 싣는다 — 툴팁만으로는 세 탭이 전부 다시
  // 만들어진다고 오해한 채 누르게 된다(실제로 그렇게 동작하던 시절의 라벨이 '다시 생성'이었다).
  const regen = mkAct('sum-regen', '이 탭 다시 생성', '현재 탭의 요약만 다시 만듭니다');

  // 성공을 알리는 방법: 토스트를 새로 만들지 않고 버튼 라벨을 잠깐 바꾼다. 복사·저장은
  // 결과가 화면에 보이지 않는 동작이라 아무 반응이 없으면 눌렸는지조차 알 수 없는데,
  // 라벨 교체는 시선이 이미 가 있는 자리에서 답을 준다(오류는 기존 .sum-err가 맡는다).
  const flashTimers = new WeakMap();
  function flash(btn, text) {
    clearTimeout(flashTimers.get(btn));
    btn.textContent = text;
    flashTimers.set(btn, setTimeout(() => { btn.textContent = btn.dataset.label; }, 1200));
  }

  // ===== 본문 =====
  // 탭별 컨테이너를 셋 다 유지하고 활성 것만 .on을 붙인다(표시/숨김은 CSS가 담당).
  // 지웠다 다시 만들지 않으므로 탭을 오갈 때 스크롤 위치와 이미 그린 SVG가 그대로 살아 있다.
  const body = document.createElement('div');
  body.className = 'sum-body';
  const panes = {};
  for (const t of TABS) {
    const p = document.createElement('div');
    p.className = 'sum-pane';
    p.dataset.kind = t.kind;
    body.appendChild(p);
    panes[t.kind] = p;
  }

  // 본문 + 절별 요약 목차를 담는 2열. 목차는 '절별 요약' 탭에서만 드러난다(setTab).
  const content = document.createElement('div');
  content.className = 'sum-content';
  content.appendChild(body);
  const toc = createSummaryToc(content, {
    // 목차는 "몇 번째 헤딩인가"(ord)만 알려준다 — 실제 스크롤은 렌더된 pane에서 여기가 한다.
    // 제목 문자열로 찾지 않는 이유: 같은 제목이 두 절에 나오면 늘 첫 번째만 잡힌다.
    onJump(h) {
      const heads = panes.sections.querySelectorAll('h1,h2,h3,h4,h5,h6');
      heads[h.ord]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  });

  const err = document.createElement('div');
  err.className = 'sum-err';
  err.style.display = 'none';

  // ===== 빈 상태 =====
  // 아직 아무것도 만들지 않았을 때 패널 전체를 덮는다(createUrlPanel의 빈 상태 UI와 같은 구성).
  const empty = document.createElement('div');
  empty.className = 'sum-empty';
  const emptyTitle = document.createElement('div');
  emptyTitle.className = 'sum-empty-title';
  emptyTitle.textContent = '논문 요약';
  const go = document.createElement('button');
  go.className = 'sum-empty-go';
  go.textContent = '논문 요약 생성';
  const emptyHint = document.createElement('div');
  emptyHint.className = 'sum-empty-hint';
  emptyHint.textContent = '원문 전체를 읽어 개요·절별 요약·흐름도를 만듭니다 (문서가 길면 시간이 걸립니다)';
  empty.append(emptyTitle, go, emptyHint);

  el.append(tabbar, acts, content, err, empty);
  const setBusy = createBusy(el); // 빈 상태까지 덮도록 마지막에 붙인다
  hostEl.appendChild(el);

  // 글씨 크기는 reset()이 건드리지 않는다 — 문서를 바꿔도 사용자가 고른 크기는 그대로여야 한다.
  // (흐름도는 SVG라 자체 크기를 가지므로 이 값의 영향을 받지 않고, 다시 그릴 필요도 없다.)
  let fontSize = readFontSize();
  function applyFont(save) {
    el.style.setProperty('--sum-font', `${fontSize}px`);
    // 경계에 닿으면 눌러도 아무 일이 일어나지 않는다 → "안 되는 상태"를 버튼 모양으로 보여 준다.
    fontDec.disabled = fontSize <= FONT_MIN;
    fontInc.disabled = fontSize >= FONT_MAX;
    if (save) {
      try { localStorage.setItem(FONT_KEY, String(fontSize)); } catch { /* 저장 실패 무시 */ }
    }
  }
  function setFontSize(n) {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, n));
    if (next === fontSize) return; // 값이 그대로면 저장도 하지 않는다
    fontSize = next;
    applyFont(true);
  }
  fontDec.addEventListener('click', () => setFontSize(fontSize - FONT_STEP));
  fontInc.addEventListener('click', () => setFontSize(fontSize + FONT_STEP));
  fontReset.addEventListener('click', () => setFontSize(FONT_DEFAULT));
  applyFont(false); // 읽어 온 값을 그대로 되쓰는 건 의미가 없으니 최초 반영은 저장하지 않는다

  let tab = 'overview';
  let flowCode = ''; // 흐름도 원본. 탭이 드러날 때까지 보관만 한다.
  let flowDrawn = ''; // 이미 그려 둔 코드 — 같은 코드를 두 번 렌더하지 않기 위한 캐시
  // 흐름도 렌더 요청 일련번호. renderMermaid는 코드마다 걸리는 시간이 달라 나중에 시작한 렌더가
  // 먼저 끝날 수 있다 → 완료 시점에 "내가 아직 최신 요청인가"를 확인해 낡은 결과를 버린다.
  // 내용이 바뀌는 곳(setPart/reset)에서도 올려 준다 — 그래야 이미 날아간 렌더가 새 화면을 덮지 않는다.
  let flowToken = 0;
  const filled = { overview: false, sections: false, flow: false };
  // 내보내기(복사/저장)가 넘길 원문. **화면에 실제로 들어간 값**을 담는다 — 상한(MAX_TEXT/MAX_FLOW)에
  // 걸려 잘렸다면 잘린 쪽을 담는다. "내보낸 것 = 보고 있는 것"이 어긋나면 어느 쪽이 진짜인지
  // 확인할 방법이 없다.
  const rawParts = { overview: '', sections: '', flow: '' };
  let pending = false; // 생성/재생성 중복 실행 방지 (버튼 연타)
  let runToken = 0;    // 생성 실행의 세대. reset이 올 때마다 올려 낡은 실행의 뒷정리를 무시한다.

  const hasContent = () => TABS.some((t) => filled[t.kind]);

  // 빈 상태와 동작 버튼 줄은 서로 배타적이다 — 내용 유무 한 곳에서만 판단해 어긋나지 않게 한다.
  // CSS가 아니라 여기서 display를 세우므로(.sum-acts에는 display 선언이 없다) 'flex'를 직접 쓴다.
  function syncEmpty() {
    const has = hasContent();
    empty.style.display = has ? 'none' : 'flex';
    acts.style.display = has ? 'flex' : 'none';
  }

  function setError(msg) {
    err.textContent = msg || '';
    err.style.display = msg ? 'block' : 'none';
  }

  function showFlowError(e, code) {
    const msg = document.createElement('div');
    msg.className = 'sum-err';
    msg.textContent = `흐름도를 그리지 못했습니다: ${e?.message || String(e)}`;
    // 무엇이 왔는지 사용자가 직접 볼 수 있게 원본 코드를 그대로 남긴다(오타 한 줄이면 눈으로 잡힌다).
    // 보여줄 코드는 인자로 받는다 — 렌더가 await로 늘어지는 동안 flowCode가 바뀌었을 수 있어서다.
    const pre = document.createElement('pre');
    pre.className = 'sum-code';
    pre.textContent = code;
    panes.flow.replaceChildren(msg, pre);
  }

  // mermaid.render는 글자 폭을 재려고 DOM에 임시 노드를 붙인다 → 숨겨져 폭이 0인 상태에서 그리면
  // 레이아웃이 뭉개진다. 그래서 흐름도는 "탭이 실제로 드러난 뒤"에만 그린다.
  async function drawFlow() {
    if (!flowCode || flowDrawn === flowCode) return;
    if (!panes.flow.clientWidth) return; // 아직 화면에 없다 → 아래 ResizeObserver가 드러나는 순간 다시 부른다
    const code = flowCode; // await 너머에서 flowCode를 다시 읽지 않는다 — 그 사이 바뀔 수 있다
    const token = ++flowToken;
    flowDrawn = code; // await 사이에 같은 코드로 두 번 들어오지 않게 먼저 잠근다
    panes.flow.replaceChildren();
    try {
      const svg = await renderMermaid(code, `sum-flow-${++flowSeq}`);
      if (token !== flowToken) return; // 낡은 결과 — 그 사이 새 코드가 들어왔으니 화면을 건드리지 않는다
      // mermaid를 securityLevel:'strict'로 초기화했으므로 이 SVG는 DOMPurify를 통과한 결과다
      // → LLM이 만든 코드에서 왔더라도 innerHTML로 넣어도 된다.
      panes.flow.innerHTML = svg;
    } catch (e) {
      if (token !== flowToken) return; // 낡은 실패도 마찬가지로 버린다
      showFlowError(e, code); // 실패한 코드도 캐시에 남긴다 — 다시 그려 봐야 같은 오류다
    }
  }

  // 흐름도가 숨겨진 동안 도착하면 drawFlow가 clientWidth 0을 보고 조용히 포기하는데, 재시도 트리거가
  // setTab 하나뿐이면 보기 형태를 바꿔 패널이 다시 드러나도 아무도 다시 부르지 않아 빈 화면이 영구히 남는다
  // (흐름도 탭을 켠 채 '대조형'으로 갔다가 '3분할'로 돌아오는 경로가 정확히 그렇다).
  // → 패널이 스스로 가시성 회복을 감지하게 한다. display:none은 IntersectionObserver가 못 잡는 경우가 있어
  // 폭 변화를 보는 ResizeObserver를 쓴다(display:none이면 폭이 0으로 관측된다).
  // 관찰자는 하나만 만들고 reset에서도 끊지 않는다 — 패널이 살아 있는 한 계속 필요하다.
  // 이미 그린 코드는 drawFlow 첫 줄의 flowDrawn 캐시가 걸러 주므로 여기서 다시 그려질 걱정은 없다.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { if (panes.flow.clientWidth) drawFlow(); });
    ro.observe(panes.flow);
  }

  function setTab(kind) {
    if (!panes[kind]) return;
    tab = kind;
    for (const t of TABS) {
      const on = t.kind === kind;
      tabBtns[t.kind].classList.toggle('on', on);
      panes[t.kind].classList.toggle('on', on);
    }
    if (kind === 'flow') drawFlow();
    toc.setVisible(kind === 'sections'); // 목차는 절별 요약 탭 전용 — 다른 탭에서는 폭만 잡아먹는다
  }

  function setPart(kind, text) {
    const s = typeof text === 'string' ? text : '';
    if (kind === 'flow') {
      // 상한을 넘긴 부분은 잘라 낸다 — 잘린 코드는 mermaid 파싱에서 깨지고,
      // 그 오류가 위의 "원본 보여주기" 경로로 흘러 사용자가 상황을 알게 된다.
      flowCode = s.slice(0, MAX_FLOW);
      flowDrawn = '';
      flowToken++; // 날아가 있는 옛 렌더가 돌아와 새 상태를 덮지 않게 여기서 무효화한다
      filled.flow = !!flowCode;
      rawParts.flow = flowCode;
      // 빈 문자열은 마크다운 탭과 마찬가지로 "지우라는 뜻"이다. drawFlow는 빈 코드에서 즉시 빠져나가므로
      // 여기서 명시적으로 비우지 않으면 이전 문서의 SVG가 다음 문서 화면에 그대로 남는다
      // (요약 캐시는 flow가 없을 때 ''를 돌려주는 것이 정상 상태다).
      if (!flowCode) panes.flow.replaceChildren();
      else if (tab === 'flow') drawFlow();
    } else if (panes[kind]) {
      const t = s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n\n…(이하 생략)` : s;
      renderMarkdown(panes[kind], t);
      filled[kind] = !!t;
      rawParts[kind] = t;
      // 목차는 반드시 "잘린 뒤의 t"로 그린다 — 그래야 ord(몇 번째 헤딩인가)가 렌더된 DOM과 맞는다.
      if (kind === 'sections') toc.render(t);
    } else {
      return;
    }
    syncEmpty();
  }

  function reset() {
    for (const t of TABS) panes[t.kind].replaceChildren();
    for (const k of Object.keys(rawParts)) rawParts[k] = '';
    toc.render(''); // 앞 문서의 목차가 새 문서 화면에 남지 않게(가시성은 아래 setTab이 끈다)
    flowCode = '';
    flowDrawn = '';
    flowToken++; // 진행 중이던 렌더의 결과가 방금 비운 pane에 늦게 들어오지 않게 한다
    for (const k of Object.keys(filled)) filled[k] = false;
    setError('');
    setBusy(null);
    setTab('overview');
    // 진행 중이던 생성의 잠금을 여기서 반드시 푼다. reset은 "이 패널이 이제 다른 문서의 것"이라는
    // 뜻이라 앞 문서의 생성은 더 이상 이 패널의 일이 아니다. 그리고 그 생성이 **끝나지 않을 수도**
    // 있다 — 문서를 닫으면 pdf.js가 loadingTask.destroy()를 부르고, 그때 진행 중이던
    // getPageTexts/getOutline promise는 영영 settle되지 않아 run()의 finally가 돌지 않는다.
    // 그 경우 pending이 참으로 굳어 버튼이 영구히 잠긴다(실제로 재현된 버그).
    runToken++; // 늦게 끝난 옛 실행이 방금 푼 잠금을 다시 걸지 않게 한다
    pending = false;
    setLocked(false);
    syncEmpty();
  }

  // 생성·복사·저장은 한 번에 하나만 돈다 → 잠금도 한 곳에서 건다.
  // 복사/저장까지 함께 잠그는 이유: 생성 중에는 parts가 탭마다 순서대로 채워지는 중이라,
  // 그때 내보내면 "절반만 든 요약"이 파일로 남는다.
  function setLocked(v) {
    go.disabled = regen.disabled = copyBtn.disabled = saveBtn.disabled = v;
  }

  // 생성/재생성 공통. 콜백이 던진 오류는 패널이 직접 보여준다 — 호출측이 try/catch를 반복하지 않게.
  // 실행 도중 reset이 오면(문서 교체) 이 실행은 낡은 것이 되므로, 끝나더라도 화면을 건드리지 않는다.
  // 콜백이 돌려준 값을 그대로 넘겨준다 — 복사/저장이 "복사됨"/"저장됨" 같은 알림 문구를
  // 돌려주면 호출부가 그것을 버튼 라벨에 잠깐 띄운다(취소는 빈 문자열 → 아무 말도 하지 않는다).
  async function run(fn) {
    if (!fn || pending) return undefined;
    const token = ++runToken;
    pending = true;
    setLocked(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      if (token === runToken) setError(e?.message || String(e));
      return undefined;
    } finally {
      if (token === runToken) {
        pending = false;
        setLocked(false);
      }
    }
  }
  go.addEventListener('click', () => run(onGenerate));
  regen.addEventListener('click', () => run(onRegenerate));
  copyBtn.addEventListener('click', async () => { const n = await run(onCopy); if (n) flash(copyBtn, n); });
  saveBtn.addEventListener('click', async () => { const n = await run(onSave); if (n) flash(saveBtn, n); });

  setTab('overview');
  syncEmpty();

  // 앱 테마가 바뀌면 흐름도를 다시 그린다. mermaid는 색을 SVG 안에 구워 넣으므로 CSS만으로는
  // 이미 그린 그림의 색이 바뀌지 않는다 — 캐시를 비워 새 테마로 다시 그리게 하는 수밖에 없다.
  // 탭이 숨겨져 폭이 0이면 drawFlow가 알아서 미루고, ResizeObserver가 드러날 때 다시 부른다.
  function setTheme(name) {
    setMermaidTheme(name);
    flowDrawn = '';
    drawFlow();
  }

  return {
    el,
    setPart,
    setBusy,
    setError,
    setTab,
    setTheme,
    getTab: () => tab,
    // 내보내기용 원문. 사본을 돌려준다 — 호출부가 실수로 고쳐도 패널 상태가 흔들리지 않게.
    getParts: () => ({ ...rawParts }),
    hasContent,
    reset,
  };
}
