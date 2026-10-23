const { app, BrowserWindow, shell, ipcMain, screen } = require('electron');
const path = require('node:path');
const { registerScheme, handleScheme, APP_ORIGIN } = require('./scheme');
const {
  registerIpc, cancelTranslation, cancelForWebContents, registerOpenInNewWindow,
} = require('./ipc');
const { allowPath } = require('./allowlist');
const { applyMenu, setHandlers, noteFocus } = require('./menu');
const project = require('./project');
const { parsePair } = require('./cli');
const { windowTitle } = require('./version');
const { createFocusMode } = require('./focusMode');

let focusMode;
let quitRequested = false;
const closeApproved = new WeakSet();
const closePending = new WeakSet();
app.on('before-quit', () => { quitRequested = true; });
ipcMain.handle('window:finish-close', (event, confirmed) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  closePending.delete(win);
  if (confirmed !== true) { quitRequested = false; return; }
  closeApproved.add(win);
  setImmediate(() => {
    if (!win || win.isDestroyed()) return;
    if (quitRequested) app.quit(); else win.close();
  });
});
app.enableSandbox();
registerScheme();

// pair는 이 창이 처음 로드할 좌/우 파일. 최초 창만 CLI 인자를 받고, New Window·activate는 빈 pair.
function createWindow(pair = { left: null, right: null }) {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    // index.html에 <title>이 없어야 이 값이 유지된다. 문서 제목이 있으면 Electron이
    // 그것으로 덮어쓰므로, 제목은 여기 한 곳에서만 정한다.
    title: windowTitle(),
    // e2e가 돌 때마다 창이 사용자 화면 위로 튀어나와 작업을 방해한다.
    // 숨긴 창도 레이아웃·렌더 경로는 그대로라 크기 측정과 스크린샷이 보이는 창과 동일하게 나온다
    // (실측 확인). WCOMPARE_TRANSPAPER·WCOMPARE_DICT_FAKE와 같은 계열의 테스트 심이다.
    show: !process.env.WCOMPARE_HIDE_WINDOW,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, '..', '..', 'dist', 'preload', 'preload.js'),
    },
  });
  focusMode.registerWindow(win);
  let rendererReady = false;
  win.webContents.on('did-finish-load', () => { rendererReady = true; });
  win.webContents.on('render-process-gone', () => { rendererReady = false; });
  win.on('close', event => {
    if (!rendererReady || closeApproved.has(win)) return;
    event.preventDefault();
    if (closePending.has(win)) return;
    closePending.add(win);
    win.webContents.send('window:request-close');
  });
  win.loadURL(APP_ORIGIN + 'index.html');
  // 핀치/비주얼 줌 잠금 — 렌더러의 Ctrl+휠/단축키 PDF 줌과 충돌하는 페이지 전체 줌 방지.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.once('did-finish-load', () => {
    if (pair.left) allowPath(pair.left);
    if (pair.right) allowPath(pair.right);
    win.webContents.send('open-pair', pair);
  });
  // 창이 닫히면 그 창의 번역만 취소하고, 그 창의 현재 프로젝트 항목도 정리한다
  // (다른 창의 진행 중 번역·현재 프로젝트는 건드리지 않는다).
  const wc = win.webContents;
  wc.on('destroyed', () => { cancelForWebContents(wc.id); project.forget(wc.id); });
}

// ===== Finder에서 연 파일 (PDF 기본 앱) =====
// macOS는 Finder로 연 파일을 argv가 아니라 'open-file' 이벤트로 알려 준다. 이 핸들러가 없으면
// 기본 앱으로 지정해도 창만 뜨고 문서는 열리지 않는다.
// whenReady() '밖'에 등록해야 한다 — 파일 더블클릭으로 앱을 처음 띄우면 준비되기 전에 도착한다.
// (Info.plist의 CFBundleDocumentTypes 선언은 scripts/pack-mac.mjs에 있다. 둘 다 있어야 동작한다.)
const pendingFiles = [];
let flushTimer = null;

function routeOpenFiles(files) {
  const paths = files.map((f) => allowPath(f)); // 경로를 허용목록에 등록하는 주체는 언제나 main
  files.forEach((f) => require('./recentFiles').record(f));
  const win = BrowserWindow.getFocusedWindow() || focusMode.documentWindows()[0];
  if (!win) { createWindow({ left: paths[0] || null, right: paths[1] || null }); return; }
  // 어느 pane이 비었는지는 렌더러만 안다. 자리 배치는 렌더러에 맡기고, 자리가 없으면
  // 렌더러가 window:open-files로 되물어 새 창을 받는다.
  win.webContents.send('open-files', paths);
  if (win.isMinimized()) win.restore();
  win.focus();
}

function flushPendingFiles() {
  if (!app.isReady() || !pendingFiles.length) return;
  routeOpenFiles(pendingFiles.splice(0));
}

app.on('open-file', (event, filePath) => {
  event.preventDefault(); // 없으면 macOS 기본 처리로 넘어간다
  pendingFiles.push(filePath);
  // Finder에서 두 개를 한꺼번에 열면 이벤트가 연달아 온다. 한 틱 모아 좌/우로 나란히 띄운다
  // — 이 앱의 본래 쓰임새가 대조이기 때문.
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushPendingFiles, 50);
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

app.whenReady().then(() => {
  const firstPair = parsePair(process.argv, app.isPackaged);
  focusMode = createFocusMode({ app, BrowserWindow, screen, ipcMain });
  handleScheme();
  registerIpc();
  project.setOnChange(applyMenu); // 최근 목록이 바뀌면 메뉴를 다시 세팅
  require('./recentFiles').setOnChange(applyMenu);
  require('./openFiles').setOnChange(applyMenu);
  // 메뉴는 앱에 하나뿐이라 '포커스된 창의 파일'을 보여주려면 창이 바뀔 때 다시 그려야 한다.
  app.on('browser-window-focus', (_e, win) => { noteFocus(win); applyMenu(); });
  setHandlers({ newWindow: () => createWindow() }); // ⌘N — 빈 창을 새로 연다
  applyMenu();
  // 렌더러가 "이 창엔 자리가 없다"고 알려 오면 새 창에 띄운다. 경로는 여기서 다시 검문한다
  // — 렌더러가 임의 경로로 창을 열게 두면 허용목록 원칙이 무너진다.
  registerOpenInNewWindow(createWindow);
  createWindow(firstPair);
  // 파일 더블클릭으로 앱이 처음 뜬 경우, open-file은 이미 도착해 큐에 쌓여 있다.
  flushPendingFiles();
  app.on('activate', () => { if (focusMode.documentWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// 번역 중 종료해도 transpaper/agy가 백그라운드에 남지 않게 프로세스 그룹째 정리한다.
app.on('will-quit', () => cancelTranslation());
