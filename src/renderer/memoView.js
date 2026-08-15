// src/renderer/memoView.js — memo 모드의 3열 뷰: [에디터 | 번역 | 미리보기].
//
// diffEditor.js를 재사용하지 않는 이유: 그쪽은 Monaco의 diff 에디터라 좌우를 비교 대상으로
// 묶고 변경 하이라이트를 그린다. 메모는 원문과 번역본이 서로 다른 글이지 비교 대상이 아니다.
// 그래서 독립 에디터 두 개를 직접 만든다.
//
// === 이 모듈의 중심 개념: mainSide ===
// 'source' | 'translation' 하나로 "지금 왼쪽(메인)에 있는 것이 원문인가 번역본인가"를 나타낸다.
// 미리보기는 언제나 메인을 렌더한다. 좌우 스왑은 이 값만 뒤집는다.
//
// **스왑은 배치만 바꾼다.** 두 에디터의 '내용'을 맞바꾸는 구현은 절대 쓰지 않는다 —
// 내용을 옮기면 각 에디터가 들고 있는 path·dirty가 내용과 어긋나, 저장이 엉뚱한 파일로 나간다.
// 여기서는 CSS `order`만 바꾼다(DOM도 그대로 둔다 — 재부착하면 Monaco가 스크롤·커서를 잃는다).
import * as monaco from 'monaco-editor';
import { renderMarkdown } from './markdownView.js';
import { createPaneSplit } from './paneSplit.js';

// 미리보기 다시 그리기 디바운스. 타자마다 renderMarkdown을 부르면 긴 메모에서 눈에 띄게 밀린다.
// 600ms는 설정창 프롬프트 저장에서 쓴 값과 같다(같은 성격의 "손이 멈추면 반영").
const PREVIEW_DEBOUNCE_MS = 300;

// 진행 오버레이 — pdfDualView.createBusy와 같은 구성이고 CSS도 같은 규칙을 함께 쓴다
// (index.html의 `.pdf-busy, .memo-busy`). 같은 종류의 기다림이라 같아 보여야 하고,
// 규칙을 복제하면 한쪽만 고쳐져 언젠가 갈라진다.
function createBusy(paneEl) {
  const el = document.createElement('div');
  el.className = 'memo-busy';
  const spin = document.createElement('div'); spin.className = 'memo-busy-spin';
  const title = document.createElement('div'); title.className = 'memo-busy-title';
  const sub = document.createElement('div'); sub.className = 'memo-busy-sub';
  const barWrap = document.createElement('div'); barWrap.className = 'memo-busy-bar';
  const bar = document.createElement('i');
  barWrap.appendChild(bar);
  const hint = document.createElement('div'); hint.className = 'memo-busy-hint';
  el.append(spin, title, sub, barWrap, hint);
  el.style.display = 'none';
  paneEl.appendChild(el);

  return (state) => {
    if (!state) { el.style.display = 'none'; return; }
    title.textContent = state.title || '';
    sub.textContent = state.sub || '';
    hint.textContent = state.hint || '';
    // ratio가 숫자가 아니면 막대를 숨겨 "얼마나 남았는지 모른다"를 그대로 보여준다.
    // 메모 번역은 LLM 호출 1회라 진행 단위가 없다 — PDF처럼 "n/N 페이지"를 셀 수 없다.
    const known = typeof state.ratio === 'number';
    barWrap.style.visibility = known ? 'visible' : 'hidden';
    bar.style.width = known ? `${Math.round(Math.min(1, Math.max(0, state.ratio)) * 100)}%` : '0%';
    el.style.display = 'flex';
  };
}

const EDITOR_OPTS = {
  language: 'markdown',
  automaticLayout: true,
  wordWrap: 'on', // 메모는 코드가 아니라 글이다 — 가로 스크롤은 읽기를 방해한다
  minimap: { enabled: false },
  lineNumbers: 'off',
  renderLineHighlight: 'none',
  scrollBeyondLastLine: false,
  fontSize: 13,
};

/**
 * hostEl 아래에 memo 뷰를 만든다.
 * @param {HTMLElement} hostEl
 * @param {object} cb
 * @param {() => void} [cb.onDirty] 어느 쪽이든 dirty 상태가 바뀌면 호출(툴바 갱신용)
 * @param {(pane:'main'|'trans') => void} [cb.onFocus] 포커스가 옮겨가면 호출(⌘S 대상 판정용)
 */
export function createMemoView(hostEl, { onDirty, onFocus } = {}) {
  const el = document.createElement('div');
  el.className = 'memo-view';
  hostEl.appendChild(el);

  // pane 두 개 + 미리보기. DOM 순서는 고정이고 보이는 순서는 CSS order가 정한다.
  const mk = (cls) => { const d = document.createElement('div'); d.className = cls; el.appendChild(d); return d; };
  const srcPane = mk('memo-pane memo-src');
  const transPane = mk('memo-pane memo-trans');
  const preview = mk('memo-preview');

  const editors = {
    source: monaco.editor.create(srcPane, { ...EDITOR_OPTS }),
    translation: monaco.editor.create(transPane, { ...EDITOR_OPTS }),
  };
  // 번역 진행은 결과가 들어올 자리(번역창) 위에 겹쳐 보여준다 — PDF가 "번역본이 들어올 빈 pane"에
  // 띄우는 것과 같은 자리 선택이다. 기다리는 동안 원문은 그대로 읽고 고칠 수 있다.
  const setBusy = createBusy(transPane);
  // path/dirty는 에디터가 아니라 '문서'에 붙는다. 스왑해도 이 짝이 흐트러지지 않는 것이 핵심이다.
  const docs = {
    source: { path: null, name: '', dirty: false, eol: '\n', bom: false },
    translation: { path: null, name: '', dirty: false, eol: '\n', bom: false },
  };
  // 마지막 번역 시점의 번역본 내용. 재번역 전에 "사용자가 손댔는가"를 이걸로 판정한다
  // (결정 8). 저장 여부와는 무관한 축이라 dirty로 대신할 수 없다 — 번역 직후 저장하면
  // dirty는 false지만 번역본은 여전히 '손대지 않은' 상태다.
  let lastTranslated = null;

  let mainSide = 'source';
  let showTrans = false;
  let showPreview = false;

  for (const side of ['source', 'translation']) {
    editors[side].getModel().onDidChangeContent(() => {
      if (!docs[side].dirty) { docs[side].dirty = true; onDirty && onDirty(); }
      if (side === mainSide) schedulePreview();
    });
    editors[side].onDidFocusEditorText(() => {
      focused = side;
      onFocus && onFocus(side);
    });
  }
  let focused = 'source';

  // ===== 미리보기 =====
  let previewTimer = 0;
  function renderPreview() {
    if (!showPreview) return;
    renderMarkdown(preview, editors[mainSide].getValue());
  }
  function schedulePreview() {
    if (!showPreview) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, PREVIEW_DEBOUNCE_MS);
  }

  // ===== 배치 =====
  // 스플리터는 '보이는 열' 사이에만 있어야 한다. 닫힌 열 옆에 손잡이가 남으면 허공을 끄는
  // 손잡이가 된다(PDF 모드에서 같은 실수를 이미 한 번 잡았다).
  const splits = [];
  function applyLayout() {
    // order: 메인이 0, 나머지가 1, 미리보기가 2. 스왑은 이 숫자만 뒤집는다.
    srcPane.style.order = mainSide === 'source' ? '0' : '1';
    transPane.style.order = mainSide === 'translation' ? '0' : '1';
    preview.style.order = '2';
    // 번역창이 닫혀 있으면, 그것이 메인이더라도 보일 수 없다 → 메인을 원문으로 되돌린다.
    transPane.style.display = showTrans ? '' : 'none';
    preview.style.display = showPreview ? '' : 'none';
    el.classList.toggle('has-trans', showTrans);
    el.classList.toggle('has-preview', showPreview);
    for (const s of splits) s.el.style.display = s.when() ? '' : 'none';
    renderPreview();
  }

  // ===== 공개 동작 =====
  function setDoc(side, { path, name, content, eol, bom }) {
    const model = editors[side].getModel();
    model.setValue(typeof content === 'string' ? content : '');
    Object.assign(docs[side], {
      path: path || null, name: name || '', dirty: false, eol: eol || '\n', bom: !!bom,
    });
    if (side === 'translation') lastTranslated = null; // 새로 연 번역본은 '손대지 않음' 기준이 없다
    onDirty && onDirty();
    if (side === mainSide) renderPreview();
  }

  function markTranslated(text) {
    editors.translation.getModel().setValue(text);
    docs.translation.dirty = true; // 아직 파일에 없다 — 저장해야 남는다
    lastTranslated = text;
    onDirty && onDirty();
    if (mainSide === 'translation') renderPreview();
  }

  // 번역본이 마지막 번역 이후 사람 손을 탔는가. 재번역 확인(결정 8)의 판정 기준이다.
  // 번역한 적이 없으면(lastTranslated === null) 덮어쓸 것도 없으므로 false.
  function translationEdited() {
    if (lastTranslated === null) return false;
    return editors.translation.getValue() !== lastTranslated;
  }

  function swap() {
    // 번역창이 닫혀 있으면 바꿀 상대가 없다 — 조용히 무시하지 않고 호출측이 버튼을 잠근다.
    if (!showTrans) return false;
    mainSide = mainSide === 'source' ? 'translation' : 'source';
    applyLayout();
    return true;
  }

  function setShowTrans(v) {
    showTrans = !!v;
    // 번역창을 닫는데 그게 메인이었다면 메인을 원문으로 되돌린다 — 안 그러면 미리보기가
    // 화면에 없는 문서를 계속 렌더한다.
    if (!showTrans && mainSide === 'translation') mainSide = 'source';
    applyLayout();
  }

  function setShowPreview(v) {
    showPreview = !!v;
    applyLayout();
  }

  // 스플리터는 뷰가 만들어질 때 한 번만 붙인다. target이 '지금 오른쪽에 있는 것'이 아니라
  // 고정된 요소라 스왑과 무관하게 동작한다(스왑은 order만 바꾸므로 폭 규칙은 그대로다).
  splits.push({
    ...createPaneSplit(el, { target: preview, onResize: () => {} }),
    when: () => showPreview,
  });

  applyLayout();

  return {
    el,
    setBusy,
    setDoc,
    getValue: (side) => editors[side].getValue(),
    getDoc: (side) => docs[side],
    setSaved: (side) => { docs[side].dirty = false; onDirty && onDirty(); },
    isDirty: () => docs.source.dirty || docs.translation.dirty,
    focusedSide: () => focused,
    mainSide: () => mainSide,
    swap,
    setShowTrans,
    setShowPreview,
    isShowTrans: () => showTrans,
    isShowPreview: () => showPreview,
    markTranslated,
    translationEdited,
    layout: () => { for (const s of ['source', 'translation']) editors[s].layout(); },
    focus: (side) => editors[side || mainSide].focus(),
  };
}
