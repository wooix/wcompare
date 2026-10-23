// src/main/menu.js — 애플리케이션 메뉴. 최근 프로젝트가 바뀌면 통째로 다시 세팅한다
// (macOS에는 이미 설정된 앱 메뉴의 하위 항목만 부분 갱신하는 신뢰할 만한 API가 없다).
const { Menu, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const project = require('./project.js');
const recentFiles = require('./recentFiles.js');
const openFiles = require('./openFiles.js');

const send = (ch) => {
  const w = BrowserWindow.getFocusedWindow();
  if (w) w.webContents.send(ch);
};
const focused = () => BrowserWindow.getFocusedWindow();

// 메뉴가 "어느 창의 파일을 보여줄 것인가". 포커스가 1순위지만 거기에만 기대지 않는다:
// 창을 숨겨 띄우면(e2e) 포커스가 잡히지 않고, 앱이 배경에 있는 동안에도 비어 있을 수 있다.
// 마지막으로 포커스됐던 창을 기억해 두고, 그래도 없으면 창이 하나뿐일 때 그 창을 쓴다 —
// 창이 여럿인데 어느 것인지 모르면 남의 파일을 보여주느니 아무것도 안 보여준다.
let lastFocusedId = null;
function noteFocus(win) { lastFocusedId = win?.webContents?.id ?? null; }
function menuWindow() {
  const f = focused();
  if (f) return f;
  const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w._wcompareFocusOverlay);
  const last = all.find((w) => w.webContents.id === lastFocusedId);
  return last || (all.length === 1 ? all[0] : null);
}

// main.js가 주입하는 메뉴 액션 핸들러(예: newWindow) — project.setOnChange 주입 패턴과 동일.
let handlers = {};
function setHandlers(h) { handlers = { ...handlers, ...h }; }

function recentSubmenu() {
  const items = project.list();
  if (!items.length) return [{ label: '(없음)', enabled: false }];
  return [
    ...items.map((r) => ({
      label: r.name,
      toolTip: r.path,
      click: () => { try { project.openRecent(focused(), r.id); } catch { /* 무시 */ } },
    })),
    { type: 'separator' },
    { label: '목록 지우기', click: () => project.clearRecents() },
  ];
}

function recentFilesSubmenu() {
  const items = recentFiles.list();
  if (!items.length) return [{ label: '(없음)', enabled: false }];
  return [
    ...items.map((r) => ({
      // 프로젝트와 달리 파일은 확장자가 정보다(.pdf/.js/...) → basename 그대로 보여준다
      label: path.basename(r.path),
      toolTip: r.path,
      click: () => { try { recentFiles.openRecent(focused(), r.id); } catch { /* 무시 */ } },
    })),
    { type: 'separator' },
    { label: '목록 지우기', click: () => recentFiles.clear() },
  ];
}

// 지금 이 창에 열려 있는 파일들의 경로. 파일이 없으면 빈 배열을 내어 File 메뉴 맨 위가
// 그냥 New Window로 시작하게 둔다 — 아무것도 안 열린 창에 "(없음)" 줄을 두면 자리만 먹는다.
function openFilesSection() {
  const w = menuWindow();
  const items = w ? openFiles.list(w.webContents.id) : [];
  if (!items.length) return [];
  return [
    ...items.map((f) => ({
      label: `${f.label}  ${openFiles.displayPath(f.path)}`,
      // 줄인 경로만으로는 어느 폴더인지 확실하지 않을 수 있어 원본을 툴팁에 남긴다.
      toolTip: f.path,
      click: () => shell.showItemInFolder(f.path),
    })),
    { type: 'separator' },
  ];
}

function build() {
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      // 열려 있는 파일의 경로를 맨 위에 둔다: 파일 메뉴를 여는 이유의 절반이
      // "지금 뭘 보고 있더라"이고, 그 답이 메뉴 아래쪽에 있으면 찾지 않게 된다.
      ...openFilesSection(),
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => handlers.newWindow?.() },
      { type: 'separator' },
      { label: 'Open Left…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open-left') },
      { label: 'Open Right…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu:open-right') },
      { label: 'Recent Files', submenu: recentFilesSubmenu() },
      { label: 'Reload Files', accelerator: 'CmdOrCtrl+R', click: (_item, win) => (win || focused())?.webContents.send('menu:reload-files') },
      // ⌘W는 macOS의 창 닫기 표준 단축키다. win.close()는 main.js의 미저장 메모 확인을 거친다.
      { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: (_item, win) => (win || focused())?.close() },
      { label: 'Close Left', accelerator: 'CmdOrCtrl+Alt+W', click: () => send('menu:close-left') },
      { label: 'Close Right', accelerator: 'CmdOrCtrl+Alt+Shift+W', click: () => send('menu:close-right') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
      { type: 'separator' },
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+Shift+P', click: () => { project.open(focused()).catch(() => {}); } },
      { label: 'Save Project', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu:project-save') },
      { label: 'Save Project As…', click: () => send('menu:project-save-as') },
      { label: 'Recent Projects', submenu: recentSubmenu() },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('menu:settings') },
      { type: 'separator' }, { role: 'quit' },
    ]},
    // Edit role 메뉴가 없으면 macOS에서 ⌘C/⌘V/⌘X/⌘A 자체가 앱에 전달되지 않는다
    // (Chromium이 자동 처리하는 게 아니라 애플리케이션 메뉴의 accelerator를 통해 라우팅된다).
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Next Diff', accelerator: 'F7', click: () => send('menu:next-diff') },
      { label: 'Prev Diff', accelerator: 'Shift+F7', click: () => send('menu:prev-diff') },
      { label: 'Toggle Whitespace', click: () => send('menu:toggle-ws') },
      { label: 'Toggle Word Wrap', click: () => send('menu:toggle-wrap') },
      { label: 'Toggle Equal Pane Width', click: () => send('menu:toggle-pane-equal') },
      { label: 'Toggle Vim', click: () => send('menu:toggle-vim') },
      { label: 'Toggle Theme', click: () => send('menu:toggle-theme') },
      { label: 'Toggle Night (PDF)', click: () => send('menu:toggle-night') },
      { label: 'Toggle Dictionary', click: () => send('menu:toggle-dict') },
      { type: 'separator' }, { role: 'toggleDevTools' },
    ]},
  ]);
}

function applyMenu() { Menu.setApplicationMenu(build()); }

module.exports = { applyMenu, setHandlers, noteFocus };
