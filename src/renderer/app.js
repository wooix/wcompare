import './monacoEnv.js';
import * as monaco from 'monaco-editor';
import { createDiff } from './diffEditor.js';
import { wireLintController } from './lintController.js';
import { setupVim, toggleVim, setSaveHandler, getActiveSide } from './vimBinding.js';
import { buildToolbar, setStatus } from './toolbar.js';
import { setupDnd } from './dnd.js';

const editorApi = createDiff(document.getElementById('editor'));
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
  setStatus(`${mark(editorApi.getState('left'))}  |  ${mark(editorApi.getState('right'))}`);
}

async function dirtyGuard(side) {
  // true면 진행 가능, false면 취소
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

async function openByPath(side, path) {
  if (!(await dirtyGuard(side))) return;
  const file = await window.wcompare.readFile(path);
  placeFile(side, file);
}

async function openByDialog(side) {
  if (!(await dirtyGuard(side))) return;
  const file = await window.wcompare.openFileDialog();
  if (file) placeFile(side, file);
}

async function save(side = getActiveSide()) {
  const st = editorApi.getState(side);
  if (!st.path) return;
  await window.wcompare.writeFile({ path: st.path, content: editorApi.getValue(side),
    eol: st.eol, encoding: 'utf8', bom: st.bom });
  editorApi.setDirty(side, false);
  linters[side].cancel(); linters[side].request();
  refreshStatus();
}
setSaveHandler(save);

const actions = {
  openLeft: () => openByDialog('left'),
  openRight: () => openByDialog('right'),
  save: () => save(),
  nextDiff: () => editorApi.goToDiff('next'),
  prevDiff: () => editorApi.goToDiff('previous'),
  toggleWs: () => { ws = !ws; editorApi.updateOptions({ ignoreTrimWhitespace: ws }); },
  toggleVim: () => toggleVim(editorApi),
  toggleTheme: () => { theme = theme === 'vs-dark' ? 'vs' : 'vs-dark'; monaco.editor.setTheme(theme); },
};
buildToolbar(document.getElementById('toolbar'), actions);

// 복사 화살표: Alt+→ 좌→우, Alt+← 우→좌 (각 inner editor에 개별 등록)
editorApi.innerOf('left').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.RightArrow,
  () => editorApi.copyCurrentBlock('left', 'right'));
editorApi.innerOf('right').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow,
  () => editorApi.copyCurrentBlock('right', 'left'));

setupVim(editorApi);
setupDnd(document.getElementById('editor'), (side, path) => openByPath(side, path));

const MENU = {
  'menu:open-left': actions.openLeft, 'menu:open-right': actions.openRight,
  'menu:save': actions.save, 'menu:next-diff': actions.nextDiff, 'menu:prev-diff': actions.prevDiff,
  'menu:toggle-ws': actions.toggleWs, 'menu:toggle-vim': actions.toggleVim, 'menu:toggle-theme': actions.toggleTheme,
};
window.wcompare.onMenu((ch) => { MENU[ch]?.(); });

window.wcompare.onOpenPair(async ({ left, right }) => {
  if (left) await openByPath('left', left);
  if (right) await openByPath('right', right);
});

refreshStatus();
