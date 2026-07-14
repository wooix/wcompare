import './monacoEnv.js';
import * as monaco from 'monaco-editor';
import { createDiff } from './diffEditor.js';
import { wireLintController } from './lintController.js';
import { setupVim, toggleVim, setSaveHandler, getActiveSide } from './vimBinding.js';
import { setStatus } from './toolbar.js';
import { setupDnd } from './dnd.js';
import { createDualView } from './pdfDualView.js';

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
  $('btn-fit').textContent = 'Fit: ' + (st.fit ? 'ON' : 'OFF');
  $('pdf-status').textContent = `L ${st.left.page}/${st.left.count}   R ${st.right.page}/${st.right.count}   ${Math.round(st.scale * 100)}%`;
  $('btn-back').disabled = !st.canBack;
  $('btn-forward').disabled = !st.canForward;
  updatePdfBtns();
}
function setMode(m) {
  mode = m;
  $('editor').style.display = m === 'diff' ? '' : 'none';
  $('pdfview').style.display = m === 'pdf' ? 'flex' : 'none';
  $('diff-controls').style.display = m === 'diff' ? 'flex' : 'none';
  $('pdf-controls').style.display = m === 'pdf' ? 'flex' : 'none';
  $('statusbars').style.display = m === 'diff' ? 'flex' : 'none';
  $('pdf-status').style.display = m === 'pdf' ? 'flex' : 'none';
  $('btn-mode').textContent = m === 'diff' ? 'PDF Mode' : 'Diff Mode';
  if (m === 'diff') refreshStatus(); else setStatus('');
  updatePdfBtns();
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
const loadedPdfSides = () => ['left', 'right'].filter((s) => pdfPaths[s]);

// 진행 상황은 번역본이 들어올 "빈 창"에 오버레이로 보여준다.
function showTranslateProgress(sub) {
  if (!translateTarget) return;
  dualView?.setBusy(translateTarget, {
    title: '한국어 번역 중…',
    sub: sub ?? (translateTotal ? `${translateDone} / ${translateTotal} 페이지` : `${translateDone} 페이지`),
    hint: '툴바의 “번역 취소”를 누르면 중단됩니다',
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
  updatePdfBtns();
  showTranslateProgress('준비 중…');
  try {
    let res = await window.wcompare.translatePdf({ path: src });
    if (res.existed) {
      const again = confirm('이미 번역본이 있습니다.\n\n[확인] 다시 번역하기\n[취소] 기존 번역본 열기');
      if (again) { showTranslateProgress('준비 중…'); res = await window.wcompare.translatePdf({ path: src, force: true }); }
    }
    await openPdf(translateTarget, res.output);
    if (res.partial) alert('일부 페이지는 번역에 실패해 원문 그대로 유지되었습니다.');
  } catch (e) {
    alert('번역 실패: ' + (e?.message || e));
  } finally {
    dualView?.setBusy(translateTarget, null);
    translating = false;
    translateTarget = null;
    updatePdfBtns();
  }
}

window.wcompare.onTranslateProgress(({ done }) => {
  if (!translating) return;
  translateDone = done;
  showTranslateProgress();
});

// ===== open routing =====
async function openByPath(side, p) {
  if (isPdf(p)) return openPdf(side, p);
  if (!(await dirtyGuard(side))) return;
  const file = await window.wcompare.readFile(p);
  placeFile(side, file);
  setMode('diff');
}
async function openByDialog(side) {
  const file = await window.wcompare.openFileDialog();
  if (!file) return;
  if (isPdf(file.path)) return openPdf(side, file.path);
  if (!(await dirtyGuard(side))) return;
  placeFile(side, file);
  setMode('diff');
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

// ===== 우클릭: 복사 / 형광펜 / 밑줄 / 마커 삭제 =====
// 선택 영역은 contextInfo()가 "지금 이 순간" 동기적으로 캡처한다.
// 메뉴를 띄우고 응답을 기다리는 사이에 선택이 사라져도 안전하도록.
$('pdfview').addEventListener('contextmenu', async (e) => {
  if (mode !== 'pdf' || !dualView) return;
  const side = e.target.closest?.('.pdf-pane')?.dataset.side;
  if (!side) return;
  e.preventDefault();
  const { hasSelection, markerId } = dualView.contextInfo(side, e.clientX, e.clientY);
  const action = await window.wcompare.pdfContextMenu({ hasSelection, hasMarker: !!markerId });
  if (action === 'highlight' || action === 'underline') dualView.addMarker(action);
  else if (action === 'remove') dualView.removeMarker(side, markerId);
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
  else if (e.shiftKey && (e.key === 'H' || e.key === 'h')) { e.preventDefault(); dualView.markSelection('highlight'); }
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
    const res = as ? await window.wcompare.project.saveAs(snap) : await window.wcompare.project.save(snap);
    if (res?.path) setStatus(`프로젝트 저장됨: ${res.path.split('/').pop()}`);
  } catch (e) {
    alert('프로젝트 저장 실패: ' + (e?.message || e));
  }
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
  'menu:save': () => save(),
  'menu:project-save': () => saveProject(false),
  'menu:project-save-as': () => saveProject(true),
  'menu:next-diff': () => editorApi.goToDiff('next'),
  'menu:prev-diff': () => editorApi.goToDiff('previous'),
  'menu:toggle-ws': () => { ws = !ws; editorApi.updateOptions({ ignoreTrimWhitespace: ws }); },
  'menu:toggle-vim': () => toggleVim(editorApi),
  'menu:toggle-theme': () => { theme = theme === 'vs-dark' ? 'vs' : 'vs-dark'; monaco.editor.setTheme(theme); },
};
window.wcompare.onMenu((ch) => { MENU[ch]?.(); });

window.wcompare.onOpenPair(async ({ left, right }) => {
  if (left) await openByPath('left', left);
  if (right) await openByPath('right', right);
});

setMode('diff');
refreshStatus();
