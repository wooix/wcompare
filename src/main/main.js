const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { registerScheme, handleScheme, APP_ORIGIN } = require('./scheme');
const { registerIpc, cancelTranslation } = require('./ipc');
const { allowPath } = require('./allowlist');
const { applyMenu } = require('./menu');
const project = require('./project');
const { parsePair } = require('./cli');

app.enableSandbox();
registerScheme();

let initialPair = { left: null, right: null };

function createWindow() {
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
    if (initialPair.left) allowPath(initialPair.left);
    if (initialPair.right) allowPath(initialPair.right);
    win.webContents.send('open-pair', initialPair);
  });
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

app.whenReady().then(() => {
  initialPair = parsePair(process.argv, app.isPackaged);
  handleScheme();
  registerIpc();
  project.setOnChange(applyMenu); // 최근 목록이 바뀌면 메뉴를 다시 세팅
  applyMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// 번역 중 종료해도 transpaper/agy가 백그라운드에 남지 않게 프로세스 그룹째 정리한다.
app.on('will-quit', () => cancelTranslation());

