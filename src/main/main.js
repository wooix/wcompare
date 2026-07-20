const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { registerScheme, handleScheme, APP_ORIGIN } = require('./scheme');
const { registerIpc, cancelTranslation, cancelForWebContents } = require('./ipc');
const { allowPath } = require('./allowlist');
const { applyMenu, setHandlers } = require('./menu');
const project = require('./project');
const { parsePair } = require('./cli');

app.enableSandbox();
registerScheme();

// pair는 이 창이 처음 로드할 좌/우 파일. 최초 창만 CLI 인자를 받고, New Window·activate는 빈 pair.
function createWindow(pair = { left: null, right: null }) {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, '..', '..', 'dist', 'preload', 'preload.js'),
    },
  });
  win.loadURL(APP_ORIGIN + 'index.html');
  // 핀치/비주얼 줌 잠금 — 렌더러의 Ctrl+휠/단축키 PDF 줌과 충돌하는 페이지 전체 줌 방지.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.once('did-finish-load', () => {
    if (pair.left) allowPath(pair.left);
    if (pair.right) allowPath(pair.right);
    win.webContents.send('open-pair', pair);
  });
  // 창이 닫히면 그 창의 번역만 취소한다(다른 창의 진행 중 번역은 건드리지 않는다).
  const wc = win.webContents;
  wc.on('destroyed', () => cancelForWebContents(wc.id));
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

app.whenReady().then(() => {
  const firstPair = parsePair(process.argv, app.isPackaged);
  handleScheme();
  registerIpc();
  project.setOnChange(applyMenu); // 최근 목록이 바뀌면 메뉴를 다시 세팅
  require('./recentFiles').setOnChange(applyMenu);
  setHandlers({ newWindow: () => createWindow() }); // ⌘N — 빈 창을 새로 연다
  applyMenu();
  createWindow(firstPair);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// 번역 중 종료해도 transpaper/agy가 백그라운드에 남지 않게 프로세스 그룹째 정리한다.
app.on('will-quit', () => cancelTranslation());

