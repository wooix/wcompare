const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { registerScheme, handleScheme, APP_ORIGIN } = require('./scheme');

app.enableSandbox();
registerScheme(); // app ready 이전 필수

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '..', '..', 'dist', 'preload', 'preload.js'),
    },
  });
  win.loadURL(APP_ORIGIN + 'index.html');
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

app.whenReady().then(() => {
  handleScheme();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
