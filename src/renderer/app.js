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
function ensureDualView() {
  if (dualView) return dualView;
  dualView = createDualView($('pdfview'));
  dualView.onState(renderPdfStatus);
  return dualView;
}
function renderPdfStatus(st) {
  $('pdf-total').textContent = String(Math.max(st.left.count, st.right.count));
  $('pdf-page').value = String(st.left.page || st.right.page || 1);
  $('btn-sync').textContent = 'Sync: ' + (st.sync ? 'ON' : 'OFF');
  $('pdf-status').textContent = `L ${st.left.page}/${st.left.count}   R ${st.right.page}/${st.right.count}   ${Math.round(st.scale * 100)}%`;
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
  if (m === 'diff') refreshStatus();
}
async function openPdf(side, p) {
  try {
    const { bytes } = await window.wcompare.readBytes(p);
    ensureDualView();
    setMode('pdf');
    await dualView.openSide(side, { bytes });
  } catch (e) {
    alert('PDF를 열 수 없습니다: ' + (e?.message || e));
  }
}

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
$('pdf-page').onchange = (e) => dualView?.gotoPage(parseInt(e.target.value, 10) || 1);

// 복사 화살표 (diff)
editorApi.innerOf('left').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, () => editorApi.copyCurrentBlock('left', 'right'));
editorApi.innerOf('right').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, () => editorApi.copyCurrentBlock('right', 'left'));

setupVim(editorApi);
setupDnd($('editor'), (side, p) => openByPath(side, p));
setupDnd($('pdfview'), (side, p) => openByPath(side, p));

const MENU = {
  'menu:open-left': () => openByDialog('left'),
  'menu:open-right': () => openByDialog('right'),
  'menu:save': () => save(),
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
