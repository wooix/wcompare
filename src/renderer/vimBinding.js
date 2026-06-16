// src/renderer/vimBinding.js
import { initVimMode, VimMode } from 'monaco-vim';

// 모듈 스코프 단일 진실원천: 현재 활성(포커스) side
let activeSide = 'right';
let saveHandler = null; // (side) => void  — app.js가 주입
let instances = { left: null, right: null };
let enabled = true;
let exRegistered = false;

export function setSaveHandler(fn) { saveHandler = fn; }
export function getActiveSide() { return activeSide; }

export function setupVim(editorApi) {
  // :w / :wq 전역 1회 등록 — activeSide로 라우팅
  if (!exRegistered) {
    VimMode.Vim.defineEx('write', 'w', () => { if (saveHandler) saveHandler(activeSide); });
    VimMode.Vim.defineEx('wquit', 'wq', () => { if (saveHandler) saveHandler(activeSide); });
    exRegistered = true;
  }
  bindFocus(editorApi, 'left');
  bindFocus(editorApi, 'right');
  attachAll(editorApi);
}

function bindFocus(editorApi, side) {
  editorApi.innerOf(side).onDidFocusEditorWidget(() => {
    activeSide = side;
    document.getElementById('vim-' + side)?.classList.add('active');
    document.getElementById('vim-' + (side === 'left' ? 'right' : 'left'))?.classList.remove('active');
  });
}

function attachAll(editorApi) {
  for (const side of ['left', 'right']) {
    const statusEl = document.getElementById('vim-' + side);
    instances[side] = initVimMode(editorApi.innerOf(side), statusEl);
  }
  enabled = true;
}

export function toggleVim(editorApi) {
  if (enabled) {
    for (const side of ['left', 'right']) { instances[side]?.dispose(); instances[side] = null; }
    enabled = false;
  } else {
    attachAll(editorApi);
  }
  return enabled;
}
