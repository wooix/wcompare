const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');
const { registerScheme, handleScheme, APP_ORIGIN } = require('./scheme');
const { registerIpc, allowPath } = require('./ipc');
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
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function buildMenu() {
  const send = (ch) => { const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.send(ch); };
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open Left…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open-left') },
      { label: 'Open Right…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu:open-right') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
      { type: 'separator' }, { role: 'quit' },
    ]},
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
