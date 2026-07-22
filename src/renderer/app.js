import './monacoEnv.js';
import * as monaco from 'monaco-editor';
import { createDiff } from './diffEditor.js';
import { wireLintController } from './lintController.js';
import { setupVim, toggleVim, setSaveHandler, getActiveSide } from './vimBinding.js';
import { setStatus } from './toolbar.js';
import { setupDnd } from './dnd.js';
import { createDualView } from './pdfDualView.js';
import { createMdToc } from './mdToc.js';
import { normalizeEvent, hasModifier, format as fmtShortcut, isReserved, ACTIONS } from './shortcuts.js';

const $ = (id) => document.getElementById(id);
const isPdf = (p) => /\.pdf$/i.test(p || '');

// ===== diff mode =====
const editorApi = createDiff($('editor'));
const linters = {
  left: wireLintController(monaco, editorApi, 'left'),
  right: wireLintController(monaco, editorApi, 'right'),
};
let theme = 'vs-dark';
let ws = false;
monaco.editor.setTheme(theme);

editorApi.onDirty(() => refreshStatus());
const mark = (s) => (s.path ? (s.dirty ? '● ' : '') + s.path.split('/').pop() : '(empty)');
function refreshStatus() {
  if (mode !== 'diff') return;
  setStatus(`${mark(editorApi.getState('left'))}  |  ${mark(editorApi.getState('right'))}`);
}
async function dirtyGuard(side) {
  if (!editorApi.getState(side).dirty) return true;
  const ans = prompt('미저장 변경이 있습니다. save / discard / cancel 중 입력', 'cancel');
  if (ans === 'save') { await save(side); return true; }
  return ans === 'discard';
}
function placeFile(side, file) {
  if (file.isBinary && !confirm('바이너리 파일입니다. 텍스트로 강제로 열까요?')) return;
  if (file.byteSize > 5 * 1024 * 1024) alert('5MB 초과: lint를 비활성화하고 엽니다.');
  editorApi.open(side, file);
  linters[side].cancel(); linters[side].request();
  refreshStatus();
}
async function save(side = getActiveSide()) {
  const st = editorApi.getState(side);
  if (!st.path) return;
  await window.wcompare.writeFile({ path: st.path, content: editorApi.getValue(side), eol: st.eol, encoding: 'utf8', bom: st.bom });
  editorApi.setDirty(side, false);
  linters[side].cancel(); linters[side].request();
  refreshStatus();
}
setSaveHandler(save);

// ===== pdf mode =====
let mode = 'diff';
let dualView = null;
const pdfPaths = { left: null, right: null };
let pdfState = null;

// ===== markdown TOC (diff 모드) =====
// 열림 상태는 세션 한정 — PDF outline과 대칭(localStorage 불필요).
let mdTocOpen = false;
const mdToc = createMdToc(editorApi, {
  leftEl: $('md-toc-left'),
  rightEl: $('md-toc-right'),
  onChange: () => updateTocBtn(), // 콘텐츠 변경(디바운스) → 표시 규칙 재평가 + 재렌더
});
function toggleMdToc() { mdTocOpen = !mdTocOpen; updateTocBtn(); }

// #btn-toc는 두 모드에서 보인다. pdf 모드는 뷰어 outline, diff 모드는 md TOC를 제어한다.
// setMode / 파일 open·close / 토글 시 이 함수 하나로 버튼 상태와 드로어 표시를 맞춘다.
function updateTocBtn() {
  const btn = $('btn-toc');
  if (!btn) return;
  if (mode === 'pdf') {
    // pdf 모드 라벨은 renderPdfStatus도 갱신하지만, 모드 전환 직후 상태가 안 와도 맞도록 여기서도 맞춘다.
    btn.disabled = false;
    btn.textContent = 'TOC' + (dualView && dualView.isOutline() ? ' ✓' : '');
    return;
  }
  const isMd = (s) => !!editorApi.getState(s).path && editorApi.languageOf(s) === 'markdown';
  const anyMd = isMd('left') || isMd('right');
  if (!anyMd) mdTocOpen = false; // markdown 파일이 한쪽도 없으면 열림 상태 해제
  btn.disabled = !anyMd;
  btn.textContent = 'TOC' + (mdTocOpen ? ' ✓' : '');
  mdToc.render('left', mdTocOpen && isMd('left'));
  mdToc.render('right', mdTocOpen && isMd('right'));
}
function ensureDualView() {
  if (dualView) return dualView;
  dualView = createDualView($('pdfview'));
  dualView.onState(renderPdfStatus);
  dualView.onFind(renderFindCount);
  return dualView;
}
// 원문/번역본은 텍스트가 달라 한쪽만 걸리는 게 정상 → 양쪽 결과를 따로 보여준다.
function renderFindCount({ query, left, right }) {
  const el = $('pdf-find-count');
  if (!query) { el.textContent = ''; el.classList.remove('miss'); return; }
  const fmt = (c) => (c ? `${c.total ? c.current : 0}/${c.total}` : '–');
  el.textContent = `L ${fmt(left)}  R ${fmt(right)}`;
  el.classList.toggle('miss', !(left?.total || right?.total));
}
function renderPdfStatus(st) {
  pdfState = st;
  $('pdf-total').textContent = String(Math.max(st.left.count, st.right.count));
  $('pdf-page').value = String(st.left.page || st.right.page || 1);
  $('btn-sync').textContent = 'Sync: ' + (st.sync ? 'ON' : 'OFF');
  $('btn-sync').classList.toggle('on', !!st.sync);
  $('btn-fit').textContent = 'Fit: ' + (st.fit ? 'ON' : 'OFF');
  $('btn-fit').classList.toggle('on', !!st.fit);
  $('btn-toc').textContent = 'TOC' + (st.outline ? ' ✓' : '');
  $('pdf-status').textContent = `L ${st.left.page}/${st.left.count}   R ${st.right.page}/${st.right.count}   ${Math.round(st.scale * 100)}%`;
  $('btn-back').disabled = !st.canBack;
  $('btn-forward').disabled = !st.canForward;
  updatePdfBtns();
}
function setMode(m) {
  mode = m;
  // #diff-wrap 전체를 토글해야 좌/우 md TOC 드로어도 에디터와 함께 사라진다.
  $('diff-wrap').style.display = m === 'diff' ? 'flex' : 'none';
  $('pdfview').style.display = m === 'pdf' ? 'flex' : 'none';
  $('diff-controls').style.display = m === 'diff' ? 'flex' : 'none';
  $('pdf-controls').style.display = m === 'pdf' ? 'flex' : 'none';
  $('statusbars').style.display = m === 'diff' ? 'flex' : 'none';
  $('pdf-status').style.display = m === 'pdf' ? 'flex' : 'none';
  $('btn-mode').textContent = m === 'diff' ? 'PDF Mode' : 'Diff Mode';
  if (m === 'diff') refreshStatus(); else setStatus('');
  resetDict(); // 모드가 바뀌면 선택 컨텍스트가 달라지므로 중복 전송 기준을 리셋한다
  updatePdfBtns();
  updateTocBtn();
}
async function openPdf(side, p) {
  try {
    // 메인이 정규화한 경로를 그대로 보관 — 번역 IPC의 화이트리스트 키와 어긋나지 않게.
    const { path: real, bytes } = await window.wcompare.readBytes(p);
    ensureDualView();
    setMode('pdf');
    await dualView.openSide(side, { bytes, path: real });
    pdfPaths[side] = real;
    updatePdfBtns();
  } catch (e) {
    alert('PDF를 열 수 없습니다: ' + (e?.message || e));
  }
}

// 좌우 교체 — 뷰어 문서와 경로를 함께 맞바꾼다.
async function switchSides() {
  if (translating) return;
  await dualView?.switchSides();
  [pdfPaths.left, pdfPaths.right] = [pdfPaths.right, pdfPaths.left];
  updatePdfBtns();
}

// ===== pdf 번역 (transpaper) =====
// 한쪽에만 PDF가 열려 있을 때, 그 PDF를 한국어로 번역해 반대편 pane에 띄운다.
let translating = false;
let translateTarget = null; // 진행 상황을 띄울 빈 pane
let translateDone = 0;
let translateTotal = 0;
let translateStart = 0;
let translateTimer = 0;
const loadedPdfSides = () => ['left', 'right'].filter((s) => pdfPaths[s]);

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// 경과 시간 + 남은 시간 추정. 1페이지 = agy 1회로 페이지당 시간이 균일해 done 기준 선형 추정이 잘 맞는다.
// done=0이면 아직 페이지당 시간을 몰라 남은 시간은 표기하지 않는다.
function progressTimes(done, total, elapsedSec) {
  const elapsed = fmtDuration(elapsedSec);
  if (!done || !total) return { elapsed, eta: null };
  const perPage = elapsedSec / done;
  return { elapsed, eta: fmtDuration(perPage * (total - done)) };
}

// 진행 상황은 번역본이 들어올 "빈 창"에 오버레이로 보여준다.
function showTranslateProgress(sub) {
  if (!translateTarget) return;
  const elapsedSec = translateStart ? (Date.now() - translateStart) / 1000 : 0;
  const { elapsed, eta } = progressTimes(translateDone, translateTotal, elapsedSec);
  const pages = translateTotal ? `${translateDone} / ${translateTotal} 페이지` : `${translateDone} 페이지`;
  dualView?.setBusy(translateTarget, {
    title: '한국어 번역 중…',
    sub: sub ?? pages,
    hint: eta ? `경과 ${elapsed} · 남은 시간 약 ${eta}` : `경과 ${elapsed} · 남은 시간 계산 중…`,
    ratio: translateTotal ? translateDone / translateTotal : undefined,
  });
}

function updatePdfBtns() {
  const only = loadedPdfSides().length === 1;
  const any = loadedPdfSides().length > 0;

  const t = $('btn-translate');
  if (t) {
    t.disabled = !translating && !only;
    t.textContent = translating ? '번역 취소' : '한국어 번역 ▶';
    t.title = translating || only ? 'transpaper로 번역해 반대편에 엽니다' : 'PDF를 한쪽에만 열었을 때 사용할 수 있습니다';
  }
  const s = $('btn-switch');
  if (s) {
    s.disabled = translating || !any;
    s.title = translating ? '번역 중에는 교체할 수 없습니다' : '좌우 화면을 서로 바꿉니다';
  }
}

async function translatePdf() {
  if (translating) { await window.wcompare.cancelTranslate(); return; }
  const [side] = loadedPdfSides();
  if (!side) return;
  const src = pdfPaths[side];

  translating = true;
  translateTarget = side === 'left' ? 'right' : 'left';
  translateDone = 0;
  translateTotal = pdfState?.[side]?.count || 0;
  translateStart = Date.now();
  updatePdfBtns();
  // 분모(전체 페이지 수)는 이미 알고 있으므로 처음부터 "0 / N 페이지"로 보여준다.
  // 1페이지 = agy 1회 호출 = 진행 1틱. 첫 틱은 1쪽 번역이 끝나야 오므로 그동안은 0/N.
  showTranslateProgress();
  clearInterval(translateTimer);
  translateTimer = setInterval(() => { if (translating) showTranslateProgress(); }, 1000); // 경과 시간을 매초 갱신
  try {
    let res = await window.wcompare.translatePdf({ path: src });
    if (res.existed) {
      const again = confirm('이미 번역본이 있습니다.\n\n[확인] 다시 번역하기\n[취소] 기존 번역본 열기');
      if (again) { translateDone = 0; showTranslateProgress(); res = await window.wcompare.translatePdf({ path: src, force: true }); }
    }
    await openPdf(translateTarget, res.output);
    if (res.partial) alert('일부 페이지는 번역에 실패해 원문 그대로 유지되었습니다.');
  } catch (e) {
    alert('번역 실패: ' + (e?.message || e));
  } finally {
    clearInterval(translateTimer);
    dualView?.setBusy(translateTarget, null);
    translating = false;
    translateTarget = null;
    translateStart = 0;
    updatePdfBtns();
  }
}

window.wcompare.onTranslateProgress(({ done }) => {
  if (!translating) return;
  translateDone = done;
  showTranslateProgress();
});

// ===== 실시간 사전 (외부 앱 위임) =====
// 드래그로 텍스트를 선택하면 main이 시스템에 Control+Shift+D를 합성해
// ShortcutDictionary가 그 선택을 사전에서 열게 한다(앱은 사전 데이터를 직접 갖지 않는다).
// 한/영 판별·팝업이 없다 — 선택 텍스트는 외부 앱이 자체적으로 읽는다. 활성 상태는 localStorage("wc-dict").
let dictOn = false;
try { dictOn = localStorage.getItem('wc-dict') === '1'; } catch { /* 스토리지 불가 */ }
let dictSelTimer = 0;             // 선택 디바운스(모드별로 하나만 활성)
let lastSent = '';               // 직전에 보낸 선택 텍스트 — 같은 선택 중복 전송을 막는다
let accessibilityWarned = false; // 접근성 권한 안내는 세션당 1회만(매 선택 반복 금지)
let dictExternalCalls = 0;       // e2e 훅용 — external() 실제 호출 횟수(중복 전송 방지 이후에만 증가)

function updateDictBtn() {
  $('btn-dict').textContent = 'Dict: ' + (dictOn ? 'ON' : 'OFF');
  $('btn-dict').classList.toggle('on', dictOn); // ON일 때 버튼 강조
}
// 선택 해제·모드 전환·Dict OFF 시 — 팝업이 없으므로 중복 전송 기준(lastSent)만 리셋한다.
function resetDict() {
  clearTimeout(dictSelTimer);
  lastSent = '';
}
function setDict(on) {
  dictOn = on;
  try { localStorage.setItem('wc-dict', on ? '1' : '0'); } catch { /* 저장 실패 무시 */ }
  if (!on) resetDict();
  updateDictBtn();
}
function toggleDict() { setDict(!dictOn); }

// 선택이 확정되면 외부 사전 앱을 트리거한다. 같은 선택 반복은 무시한다.
async function sendToExternalDict(text) {
  const t = (text || '').trim();
  if (!dictOn || !t) return;
  if (t === lastSent) return; // 같은 선택으로 중복 전송 방지
  lastSent = t;
  dictExternalCalls++;
  try {
    const res = await window.wcompare.dict.external();
    if (res && res.ok === false && res.code === 'no-accessibility') {
      if (!accessibilityWarned) {
        accessibilityWarned = true;
        setStatus('손쉬운 사용 권한이 필요합니다: 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 wcompare를 허용하세요');
      }
    } else if (res && res.ok === false) {
      console.warn('사전 트리거 실패:', res.message); // 그 외 오류는 조용히 무시(콘솔 경고만)
    }
  } catch (e) {
    console.warn('사전 트리거 실패:', e?.message || e);
  }
}

// diff 모드: 양쪽 inner editor의 선택 변경(300ms 디바운스).
function handleDiffSelection(side) {
  if (!dictOn || mode !== 'diff') return;
  const ed = editorApi.innerOf(side);
  const sel = ed.getSelection();
  if (!sel || sel.isEmpty()) { resetDict(); return; } // 선택 해제 → lastSent 리셋
  sendToExternalDict(editorApi.modelOf(side).getValueInRange(sel));
}
for (const side of ['left', 'right']) {
  editorApi.innerOf(side).onDidChangeCursorSelection(() => {
    if (!dictOn || mode !== 'diff') return;
    clearTimeout(dictSelTimer);
    dictSelTimer = setTimeout(() => handleDiffSelection(side), 300);
  });
}

// PDF 모드: #pdfview mouseup(250ms 디바운스). 선택이 .textLayer 내부이고 비어있지 않을 때만.
function textLayerOf(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el?.closest?.('.textLayer') || null;
}
function handlePdfSelection() {
  if (!dictOn || mode !== 'pdf') return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode) { resetDict(); return; }
  if (!textLayerOf(sel.anchorNode)) return; // PDF 본문(textLayer) 밖 선택은 무시
  const text = sel.toString();
  if (!text.trim()) { resetDict(); return; }
  sendToExternalDict(text);
}
$('pdfview').addEventListener('mouseup', () => {
  if (!dictOn || mode !== 'pdf') return;
  clearTimeout(dictSelTimer);
  dictSelTimer = setTimeout(handlePdfSelection, 250);
});

// ===== open routing =====
async function openByPath(side, p) {
  if (isPdf(p)) return openPdf(side, p);
  if (!(await dirtyGuard(side))) return;
  try {
    const file = await window.wcompare.readFile(p);
    placeFile(side, file);
    setMode('diff');
  } catch (e) {
    alert('파일을 열 수 없습니다: ' + (e?.message || e)); // 최근 파일이 사라진 경우 등
  }
}
async function openByDialog(side) {
  const file = await window.wcompare.openFileDialog();
  if (!file) return;
  if (isPdf(file.path)) return openPdf(side, file.path);
  if (!(await dirtyGuard(side))) return;
  placeFile(side, file);
  setMode('diff');
}

// 열린 파일 닫기 — pdf는 뷰어 문서 해제, diff는 미저장 확인 후 빈 모델로.
async function closeFile(side) {
  if (mode === 'pdf') {
    if (translating) return; // 번역 중 문서 상태 변경 금지 (switch와 동일)
    await dualView?.closeSide(side);
    pdfPaths[side] = null;
    updatePdfBtns();
  } else {
    if (!(await dirtyGuard(side))) return;
    editorApi.close(side);
    linters[side].cancel();
    refreshStatus();
    updateTocBtn(); // 닫힌 side가 markdown이면 드로어를 숨기고 버튼 상태를 갱신
  }
}

// ===== toolbar wiring (by id) =====
$('btn-open-left').onclick = () => openByDialog('left');
$('btn-open-right').onclick = () => openByDialog('right');
$('btn-mode').onclick = () => { ensureDualView(); setMode(mode === 'diff' ? 'pdf' : 'diff'); };
$('btn-theme').onclick = () => { theme = theme === 'vs-dark' ? 'vs' : 'vs-dark'; monaco.editor.setTheme(theme); };
$('btn-save').onclick = () => save();
$('btn-prev-diff').onclick = () => editorApi.goToDiff('previous');
$('btn-next-diff').onclick = () => editorApi.goToDiff('next');
$('btn-ws').onclick = () => { ws = !ws; editorApi.updateOptions({ ignoreTrimWhitespace: ws }); };
$('btn-vim').onclick = () => toggleVim(editorApi);
$('btn-zoom-out').onclick = () => dualView?.zoom(-1);
$('btn-zoom-in').onclick = () => dualView?.zoom(1);
$('btn-sync').onclick = () => dualView?.setSync(!dualView.isSync());
$('btn-fit').onclick = () => dualView?.setFit(!dualView.isFit());
$('btn-switch').onclick = () => switchSides();
$('btn-translate').onclick = () => translatePdf();
$('btn-back').onclick = () => dualView?.goBack();
$('btn-forward').onclick = () => dualView?.goForward();
$('btn-toc').onclick = () => {
  if (mode === 'pdf') dualView?.setOutline(!dualView.isOutline());
  else toggleMdToc();
};
$('btn-dict').onclick = () => toggleDict();

// ===== 커스텀 토글 단축키 =====
// shortcuts는 액션(dict/fit/sync/night/switch)→표현문자열 맵. 시작 시 설정에서 로드하고,
// 설정창에서 바꾸면 즉시 갱신한다(현재 창 한정 — 다른 창은 다음 openSettings/재시작 시 반영).
let shortcuts = { dict: 'Cmd+D', fit: 'Alt+F', sync: 'Alt+S', night: 'Alt+N', switch: 'Alt+ArrowRight' };
let settingsCapture = null; // 설정창에서 키 입력 대기 중인 액션 id(없으면 null)
async function loadShortcuts() {
  try {
    const s = await window.wcompare.settings.get();
    if (s && s.shortcuts) shortcuts = { ...shortcuts, ...s.shortcuts };
  } catch { /* 로드 실패 시 기본값 유지 */ }
}
// 액션 실행. PDF 전용(fit/sync/switch)은 dualView 존재·pdf 모드 가드를 지킨다(없으면 무시).
function runShortcutAction(id) {
  switch (id) {
    case 'dict': toggleDict(); break;
    case 'night': toggleNight(); break;
    case 'fit': if (dualView && mode === 'pdf') dualView.setFit(!dualView.isFit()); break;
    case 'sync': if (dualView && mode === 'pdf') dualView.setSync(!dualView.isSync()); break;
    case 'switch': if (dualView && mode === 'pdf') switchSides(); break;
  }
}
// 커스텀 단축키를 기존 keydown(find/zoom/back-forward)보다 "먼저" 매칭한다 → capture 단계에 등록.
// 입력 필드(찾기/이름/설정 input, Monaco 내부 textarea 포함)에 포커스가 있으면 텍스트 입력을 방해하지 않도록 skip.
window.addEventListener('keydown', (e) => {
  if (settingsCapture) return; // 설정창에서 키 캡처 중이면 여기서 발동 금지(캡처 핸들러가 처리)
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
  const str = normalizeEvent(e);
  if (!str) return;
  for (const id of Object.keys(shortcuts)) {
    if (shortcuts[id] && shortcuts[id] === str) {
      e.preventDefault();
      e.stopImmediatePropagation(); // 뒤따르는 기존 keydown 리스너가 같은 키를 또 처리하지 않게
      runShortcutAction(id);
      return;
    }
  }
}, true);

// ===== 설정 다이얼로그 wiring (요소는 항상 존재하므로 한 번만 건다) =====
$('set-archive-pdf').onchange = (e) => window.wcompare.settings.set({ archivePdfOnOpen: e.target.checked });
$('set-keep-translations').onchange = (e) => window.wcompare.settings.set({ keepTranslationsInStorage: e.target.checked });
$('set-storage-change').onclick = async () => {
  const s = await window.wcompare.settings.pickStorageDir(); // main dialog, 취소 시 null
  if (s) $('set-storage-path').value = s.storageDir;
};
$('settings-close').onclick = () => { endShortcutCapture(); $('settings-dialog').close(); };

// ===== 설정창: 토글 단축키 UI =====
// ACTIONS 순서대로 행을 만든다: 라벨 + readonly 표시 input + "변경" 버튼 + 경고 span.
function buildShortcutRows() {
  const host = $('shortcut-rows');
  if (!host || host.childElementCount) return; // 한 번만 만든다
  for (const { id, label } of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'sc-row';
    row.dataset.action = id;
    const lab = document.createElement('span'); lab.className = 'sc-label'; lab.textContent = label;
    const key = document.createElement('input'); key.className = 'sc-key'; key.readOnly = true; key.dataset.role = 'key';
    const btn = document.createElement('button'); btn.textContent = '변경'; btn.dataset.role = 'change';
    const warn = document.createElement('span'); warn.className = 'sc-warn'; warn.dataset.role = 'warn';
    row.append(lab, key, btn, warn);
    host.appendChild(row);
    const start = () => startShortcutCapture(id); // 변경 클릭 또는 input 포커스 시 캡처 시작
    btn.addEventListener('click', start);
    key.addEventListener('focus', start);
  }
}
const shortcutRow = (id) => $('shortcut-rows').querySelector(`.sc-row[data-action="${id}"]`);
function renderShortcutRow(id) {
  const row = shortcutRow(id); if (!row) return;
  const str = shortcuts[id] || '';
  row.querySelector('[data-role=key]').value = str ? fmtShortcut(str) : '(없음)';
  const res = isReserved(str);
  row.querySelector('[data-role=warn]').textContent = res ? `⚠ 이미 '${res}'에 사용 중` : '';
}
function renderAllShortcutRows() { for (const { id } of ACTIONS) renderShortcutRow(id); }
function startShortcutCapture(id) {
  if (settingsCapture) endShortcutCapture(); // 다른 행이 대기 중이면 먼저 취소
  settingsCapture = id;
  const key = shortcutRow(id)?.querySelector('[data-role=key]');
  if (key) { key.classList.add('capturing'); key.value = '키 입력 대기…'; }
}
function endShortcutCapture() {
  const id = settingsCapture;
  settingsCapture = null;
  if (!id) return;
  shortcutRow(id)?.querySelector('[data-role=key]')?.classList.remove('capturing');
  renderShortcutRow(id); // 대기 표시를 원래 값으로 되돌린다
}
function saveShortcuts() { window.wcompare.settings.set({ shortcuts }).catch(() => {}); }
// 캡처 keydown — document capture 단계로 등록. window(capture)의 발동 핸들러는 settingsCapture 중엔 skip하므로
// 이 핸들러가 키를 잡는다. modifier 최소 1개 필요, Escape는 취소.
document.addEventListener('keydown', (e) => {
  if (!settingsCapture) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.key === 'Escape') { endShortcutCapture(); return; }
  const str = normalizeEvent(e);
  if (!str || !hasModifier(str)) return; // modifier 없는 단일 키/단독 modifier는 무시하고 계속 대기
  const id = settingsCapture;
  shortcuts[id] = str;
  settingsCapture = null;
  shortcutRow(id)?.querySelector('[data-role=key]')?.classList.remove('capturing');
  renderShortcutRow(id);
  saveShortcuts(); // 즉시 저장 + 현재 창 반영(shortcuts 변수는 이미 갱신됨)
}, true);
buildShortcutRows();

// ===== PDF 야간 모드 =====
// 페이지 canvas만 CSS 필터로 반전한다(index.html). Monaco 테마(btn-theme)와는 독립 —
// 묶으면 diff/pdf 상태가 서로 꼬인다.
let night = false;
try { night = localStorage.getItem('wc-night') === '1'; } catch { /* 스토리지 불가 환경 */ }
function applyNight() {
  $('pdfview').classList.toggle('night', night);
  $('btn-night').textContent = 'Night: ' + (night ? 'ON' : 'OFF');
  $('btn-night').classList.toggle('on', night); // ON일 때 버튼 강조
}
function toggleNight() {
  night = !night;
  try { localStorage.setItem('wc-night', night ? '1' : '0'); } catch { /* 저장 실패는 무시 */ }
  applyNight();
}
$('btn-night').onclick = toggleNight;
applyNight();

// ===== 전체 텍스트 복사 =====
// DOM 선택과 무관하게 getTextContent로 뽑으므로 role:'copy' 경유가 필요 없다(main이 클립보드 기록).
async function copyAllText(side) {
  try {
    const text = await dualView.getFullText(side);
    await window.wcompare.copyText(text);
    setStatus(`전체 텍스트 복사됨 (${text.length.toLocaleString()}자)`);
  } catch (e) {
    alert('텍스트 추출 실패: ' + (e?.message || e));
  }
}

// ===== 우클릭: 복사 / 형광펜 / 밑줄 / 마커 삭제 =====
// 선택 영역은 contextInfo()가 "지금 이 순간" 동기적으로 캡처한다.
// 메뉴를 띄우고 응답을 기다리는 사이에 선택이 사라져도 안전하도록.
let lastHighlightColor = null; // 팔레트에서 마지막으로 고른 색 — ⌘⇧H 단축키가 따라간다
$('pdfview').addEventListener('contextmenu', async (e) => {
  if (mode !== 'pdf' || !dualView) return;
  const side = e.target.closest?.('.pdf-pane')?.dataset.side;
  if (!side) return;
  e.preventDefault();
  const info = dualView.contextInfo(side, e.clientX, e.clientY);
  const action = await window.wcompare.pdfContextMenu({ ...info, hasMarker: !!info.markerId });
  if (!action) return;
  if (action.startsWith('highlight')) {
    // 'highlight' 또는 'highlight:<색상>' — 메인이 팔레트에서 고른 색을 붙여 보낸다
    const color = action.slice('highlight:'.length) || null;
    if (color) lastHighlightColor = color;
    dualView.addMarker('highlight', color);
  } else if (action === 'underline') dualView.addMarker('underline');
  else if (action === 'remove') dualView.removeMarker(side, info.markerId);
  else if (action === 'mirror-jump') dualView.jumpMirror(side, e.clientX, e.clientY);
  else if (action === 'copy-all') copyAllText(side);
});

// pane 우상단 ✕ → 그 문서 닫기. altKey와 무관하므로 미러 점프 리스너와 독립으로 둔다.
$('pdfview').addEventListener('click', (e) => {
  const b = e.target.closest?.('.pdf-close');
  if (!b) return;
  e.stopPropagation();
  const side = b.closest('.pdf-pane')?.dataset.side;
  if (side) closeFile(side);
});

// Alt+클릭 → 반대편 같은 위치로 미러 점프 (원문↔번역 대조 읽기의 기본 동선)
$('pdfview').addEventListener('click', (e) => {
  if (mode !== 'pdf' || !dualView || !e.altKey) return;
  const side = e.target.closest?.('.pdf-pane')?.dataset.side;
  if (!side) return;
  e.preventDefault();
  dualView.jumpMirror(side, e.clientX, e.clientY);
});

// ===== 문자열 검색 =====
const findInput = $('pdf-find');
let findTimer = 0;
const runFind = (prev = false) => dualView?.find(findInput.value.trim(), { prev });

findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runFind(), 200); // 타이핑 중 재검색 폭주 방지
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); runFind(e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); findInput.value = ''; dualView?.find(''); findInput.blur(); }
});
$('btn-find-next').onclick = () => runFind(false);
$('btn-find-prev').onclick = () => runFind(true);
$('pdf-page').onchange = (e) => dualView?.gotoPage(parseInt(e.target.value, 10) || 1);

// PDF 모드 단축키: Cmd/Ctrl + '+'/'-' 줌(브라우저 기본 페이지 줌 차단),
// Cmd/Ctrl + F 검색, Cmd/Ctrl + ←/→ 링크 뒤로·앞으로.
window.addEventListener('keydown', (e) => {
  if (mode !== 'pdf' || !dualView) return;
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') { e.preventDefault(); dualView.zoom(1); }
  else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') { e.preventDefault(); dualView.zoom(-1); }
  else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); findInput.focus(); findInput.select(); }
  // 마커 단축키 — 렌더러 keydown이라 네이티브 메뉴를 거치지 않는다(우클릭 메뉴와 같은 경로).
  else if (e.shiftKey && (e.key === 'H' || e.key === 'h')) { e.preventDefault(); dualView.markSelection('highlight', lastHighlightColor); }
  else if (e.shiftKey && (e.key === 'U' || e.key === 'u')) { e.preventDefault(); dualView.markSelection('underline'); }
  // 검색창 안에서는 Cmd+←/→가 커서 이동이므로 가로채지 않는다.
  else if (e.target !== findInput && e.key === 'ArrowLeft') { e.preventDefault(); dualView.goBack(); }
  else if (e.target !== findInput && e.key === 'ArrowRight') { e.preventDefault(); dualView.goForward(); }
});

// 마우스 옵션 버튼(뒤로 3 / 앞으로 4). Chromium은 mousedown의 button 값으로 전달한다.
window.addEventListener('mousedown', (e) => {
  if (mode !== 'pdf' || !dualView) return;
  if (e.button === 3) { e.preventDefault(); dualView.goBack(); }
  else if (e.button === 4) { e.preventDefault(); dualView.goForward(); }
});

// 복사 화살표 (diff)
editorApi.innerOf('left').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, () => editorApi.copyCurrentBlock('left', 'right'));
editorApi.innerOf('right').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, () => editorApi.copyCurrentBlock('right', 'left'));

setupVim(editorApi);
setupDnd($('editor'), (side, p) => openByPath(side, p));
setupDnd($('pdfview'), (side, p) => openByPath(side, p));

// ===== 프로젝트 =====
// 저장할 것: 좌/우 파일, 모드, 뷰 상태(sync/fit/page), PDF 마커.
function projectSnapshot() {
  const filePath = (side) => (mode === 'pdf' ? pdfPaths[side] : editorApi.getState(side).path) || null;
  return {
    mode,
    files: { left: filePath('left'), right: filePath('right') },
    view: {
      sync: dualView ? dualView.isSync() : true,
      fit: dualView ? dualView.isFit() : true,
      page: { left: pdfState?.left.page || 1, right: pdfState?.right.page || 1 },
    },
    markers: dualView ? dualView.getMarkers() : { left: [], right: [] },
  };
}
async function saveProject(as = false) {
  try {
    const snap = projectSnapshot();
    if (!snap.files.left && !snap.files.right) { alert('저장할 파일이 없습니다.'); return; }
    let res = as ? await window.wcompare.project.saveAs(snap) : await window.wcompare.project.save(snap);
    // 이름이 필요하면 모달로 받아 다시 저장. 정화 후 빈 이름 등으로 다시 needName이 오면 한 번 더 묻는다.
    while (res?.needName) {
      const name = await promptProjectName(res.suggest); // 취소 시 null
      if (!name) return;
      res = await window.wcompare.project.save(snap, name);
    }
    if (res?.canceled) return; // 덮어쓰기 취소 — 조용히 중단(기존 상태 유지)
    if (res?.path) setStatus(`프로젝트 저장됨: ${res.display || res.path}`);
  } catch (e) {
    alert('프로젝트 저장 실패: ' + (e?.message || e));
  }
}

// 프로젝트 이름 입력 모달. 확장자 없는 이름 전체가 선택된 상태로 뜬다(요구사항: input.select()).
// 저장 대상 경로는 main이 storageDir/projects 하위로 유도하므로, 렌더러는 "이름 문자열"만 넘긴다.
function promptProjectName(suggest) {
  return new Promise((resolve) => {
    const dlg = $('project-name-dialog');
    const input = $('project-name-input');
    input.value = suggest || '';
    // 이름 모달의 두 버튼은 순서상 첫 submit이 '취소'라, Enter 기본 제출이 취소가 된다 →
    // Enter는 저장으로 명시 처리한다(Esc는 dialog가 빈 returnValue로 닫아 취소가 된다).
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); dlg.close('ok'); } };
    const onClose = () => {
      input.removeEventListener('keydown', onKey);
      dlg.removeEventListener('close', onClose);
      const name = dlg.returnValue === 'ok' ? input.value.trim() : '';
      resolve(name || null);
    };
    input.addEventListener('keydown', onKey);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

// 설정 모달 — 현재 값으로 채우고 띄운다. 체크박스는 change 시 즉시 반영(아래 wiring 참조).
async function openSettings() {
  const s = await window.wcompare.settings.get();
  $('set-storage-path').value = s.storageDir;
  $('set-archive-pdf').checked = !!s.archivePdfOnOpen;
  $('set-keep-translations').checked = !!s.keepTranslationsInStorage;
  if (s.shortcuts) shortcuts = { ...shortcuts, ...s.shortcuts }; // 저장된 값으로 현재 창 갱신
  renderAllShortcutRows();
  $('settings-dialog').showModal();
}

window.wcompare.onProjectLoad(async (p) => {
  // 미저장 변경은 한 번만 묻는다 (좌/우 각각 물어 반쪽 상태가 되지 않도록)
  if (editorApi.getState('left').dirty || editorApi.getState('right').dirty) {
    if (!confirm('미저장 변경이 있습니다. 버리고 프로젝트를 열까요?')) return;
    editorApi.setDirty('left', false);
    editorApi.setDirty('right', false);
  }
  for (const side of ['left', 'right']) {
    if (p.files[side]) await openByPath(side, p.files[side]);
  }
  if (p.mode === 'pdf' && dualView) {
    dualView.setSync(p.view.sync);
    dualView.setFit(p.view.fit);
    for (const side of ['left', 'right']) dualView.setMarkers(side, p.markers?.[side] || []);
    const page = p.view.page?.left || 1;
    if (page > 1) dualView.gotoPage(page);
  }
  if (p.missing?.length) {
    alert('파일을 찾을 수 없습니다:\n' + p.missing.map((m) => `${m.side}: ${m.path}`).join('\n'));
  }
});

const MENU = {
  'menu:open-left': () => openByDialog('left'),
  'menu:open-right': () => openByDialog('right'),
  'menu:close-left': () => closeFile('left'),
  'menu:close-right': () => closeFile('right'),
  'menu:save': () => save(),
  'menu:project-save': () => saveProject(false),
  'menu:project-save-as': () => saveProject(true),
  'menu:next-diff': () => editorApi.goToDiff('next'),
  'menu:prev-diff': () => editorApi.goToDiff('previous'),
  'menu:toggle-ws': () => { ws = !ws; editorApi.updateOptions({ ignoreTrimWhitespace: ws }); },
  'menu:toggle-vim': () => toggleVim(editorApi),
  'menu:toggle-theme': () => { theme = theme === 'vs-dark' ? 'vs' : 'vs-dark'; monaco.editor.setTheme(theme); },
  'menu:toggle-night': () => toggleNight(),
  'menu:toggle-dict': () => toggleDict(),
  'menu:settings': () => openSettings(),
};
window.wcompare.onMenu((ch) => { MENU[ch]?.(); });

// 최근 파일(메뉴): main이 allowlist에 등록한 경로를 보낸다. 빈 pane을 골라 연다.
window.wcompare.onOpenRecentFile((p) => {
  const empty = isPdf(p)
    ? (!pdfPaths.left ? 'left' : (!pdfPaths.right ? 'right' : 'left'))
    : (!editorApi.getState('left').path ? 'left' : (!editorApi.getState('right').path ? 'right' : 'left'));
  openByPath(empty, p);
});

window.wcompare.onOpenPair(async ({ left, right }) => {
  if (left) await openByPath('left', left);
  if (right) await openByPath('right', right);
});

updateDictBtn();
setMode('diff');
refreshStatus();
loadShortcuts(); // 저장된 커스텀 단축키를 로드(비동기 — 실패 시 기본값 유지)

// e2e 테스트 훅 — 렌더러 내부 상태를 읽기 전용으로 노출한다(외부 네트워크·경로 생성과 무관).
window.__wc = { editorApi, getMode: () => mode, isMdTocOpen: () => mdTocOpen, isDictOn: () => dictOn, dictCalls: () => dictExternalCalls, getShortcuts: () => ({ ...shortcuts }), isNight: () => night };
