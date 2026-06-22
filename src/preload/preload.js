const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('wcompare', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  readBytes: (path) => ipcRenderer.invoke('file:readBytes', path),
  writeFile: (payload) => ipcRenderer.invoke('file:write', payload),
  lint: (payload) => ipcRenderer.invoke('lint:run', payload),
  // 드롭된 File에서 OS 경로 추출 (최신 Electron은 File.path 제거 → webUtils 사용)
  getDropPath: (file) => { try { return webUtils.getPathForFile(file); } catch { return file?.path || null; } },
  // 이벤트: 콜백 래핑 — IpcRendererEvent를 렌더러로 넘기지 않는다
  onOpenPair: (cb) => ipcRenderer.on('open-pair', (_e, data) => cb(data)),
  onMenu: (cb) => {
    const channels = ['menu:open-left','menu:open-right','menu:save','menu:next-diff','menu:prev-diff','menu:toggle-ws','menu:toggle-vim','menu:toggle-theme'];
    channels.forEach((ch) => ipcRenderer.on(ch, () => cb(ch)));
  },
});
