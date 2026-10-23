// A translucent native window on each display dims the desktop and other apps
// while wcompare's document windows remain above it. No screen capture is used.
function createFocusMode({ app, BrowserWindow, screen, ipcMain }) {
  const documents = new Set();
  const overlays = new Map();
  const previousTop = new Map();
  let enabled = false;

  const state = () => ({ enabled, supported: process.platform === 'darwin' });
  const broadcast = () => {
    for (const win of documents) {
      if (!win.isDestroyed()) win.webContents.send('focus-mode:changed', state());
    }
  };
  const restoreWindowLevels = () => {
    for (const [win, wasOnTop] of previousTop) {
      if (!win.isDestroyed()) win.setAlwaysOnTop(wasOnTop, 'floating');
    }
    previousTop.clear();
  };
  const hideOverlays = () => {
    for (const win of overlays.values()) if (!win.isDestroyed()) win.hide();
    restoreWindowLevels();
  };
  const destroyOverlays = () => {
    hideOverlays();
    for (const win of overlays.values()) if (!win.isDestroyed()) win.destroy();
    overlays.clear();
  };
  const makeOverlay = (display) => {
    const win = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win._wcompareFocusOverlay = true;
    win.setIgnoreMouseEvents(true);
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:rgba(13,18,29,.62)}</style>',
    )).catch(() => {}); // The window may be destroyed before loading finishes.
    win.setAlwaysOnTop(true, 'modal-panel');
    return win;
  };
  const sync = () => {
    if (!enabled || process.platform !== 'darwin') { destroyOverlays(); return; }
    const visibleDocuments = [...documents].filter(win =>
      !win.isDestroyed() && win.isVisible() && !win.isMinimized() && !win.isFullScreen());
    // Switching to another app must also restore wcompare's ordinary window
    // level, or it could remain in front even after the shade is hidden.
    if (!app.isActive() || visibleDocuments.length === 0) { hideOverlays(); return; }

    const displays = screen.getAllDisplays();
    const ids = new Set(displays.map(display => display.id));
    for (const [id, win] of overlays) {
      if (!ids.has(id)) { win.destroy(); overlays.delete(id); }
    }
    for (const display of displays) {
      let win = overlays.get(display.id);
      if (!win || win.isDestroyed()) {
        win = makeOverlay(display);
        overlays.set(display.id, win);
      } else if (JSON.stringify(win.getBounds()) !== JSON.stringify(display.bounds)) {
        win.setBounds(display.bounds);
      }
    }
    for (const win of visibleDocuments) {
      if (!previousTop.has(win)) previousTop.set(win, win.isAlwaysOnTop());
      win.setAlwaysOnTop(true, 'modal-panel', 1);
    }
    for (const win of overlays.values()) if (!win.isVisible()) win.showInactive();
  };

  ipcMain.handle('focus-mode:get', () => state());
  ipcMain.handle('focus-mode:set', (event, requested) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!documents.has(sender) || typeof requested !== 'boolean') throw new Error('잘못된 집중 모드 요청입니다.');
    if (requested && process.platform !== 'darwin') throw new Error('화면 가림막은 macOS에서만 지원합니다.');
    enabled = requested;
    try { sync(); } catch (error) {
      enabled = false;
      destroyOverlays();
      broadcast();
      throw error;
    }
    broadcast();
    return state();
  });
  app.on('did-resign-active', hideOverlays);
  app.on('did-become-active', sync);
  app.on('browser-window-focus', (_event, win) => { if (documents.has(win)) sync(); });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, sync);
  }
  return {
    registerWindow(win) {
      win._wcompareDocument = true;
      documents.add(win);
      for (const event of ['show', 'hide', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
        win.on(event, sync);
      }
      win.on('closed', () => {
        documents.delete(win);
        previousTop.delete(win);
        if (documents.size === 0) { enabled = false; destroyOverlays(); }
        else sync();
      });
      sync();
    },
    documentWindows: () => [...documents].filter(win => !win.isDestroyed()),
  };
}

module.exports = { createFocusMode };
