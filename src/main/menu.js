// src/main/menu.js — 애플리케이션 메뉴. 최근 프로젝트가 바뀌면 통째로 다시 세팅한다
// (macOS에는 이미 설정된 앱 메뉴의 하위 항목만 부분 갱신하는 신뢰할 만한 API가 없다).
const { Menu, BrowserWindow } = require('electron');
const project = require('./project.js');

const send = (ch) => {
  const w = BrowserWindow.getFocusedWindow();
  if (w) w.webContents.send(ch);
};
const focused = () => BrowserWindow.getFocusedWindow();

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

function build() {
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open Left…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open-left') },
      { label: 'Open Right…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu:open-right') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
      { type: 'separator' },
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+Shift+P', click: () => { project.open(focused()).catch(() => {}); } },
      { label: 'Save Project', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu:project-save') },
      { label: 'Save Project As…', click: () => send('menu:project-save-as') },
      { label: 'Recent Projects', submenu: recentSubmenu() },
      { type: 'separator' }, { role: 'quit' },
    ]},
    // Edit role 메뉴가 없으면 macOS에서 ⌘C/⌘V/⌘X/⌘A 자체가 앱에 전달되지 않는다
    // (Chromium이 자동 처리하는 게 아니라 애플리케이션 메뉴의 accelerator를 통해 라우팅된다).
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Next Diff', accelerator: 'F7', click: () => send('menu:next-diff') },
      { label: 'Prev Diff', accelerator: 'Shift+F7', click: () => send('menu:prev-diff') },
      { label: 'Toggle Whitespace', click: () => send('menu:toggle-ws') },
      { label: 'Toggle Vim', click: () => send('menu:toggle-vim') },
      { label: 'Toggle Theme', click: () => send('menu:toggle-theme') },
      { type: 'separator' }, { role: 'toggleDevTools' },
    ]},
  ]);
}

function applyMenu() { Menu.setApplicationMenu(build()); }

module.exports = { applyMenu };
