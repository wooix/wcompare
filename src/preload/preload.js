const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('wcompare', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  readBytes: (path) => ipcRenderer.invoke('file:readBytes', path),
  writeFile: (payload) => ipcRenderer.invoke('file:write', payload),
  lint: (payload) => ipcRenderer.invoke('lint:run', payload),
  pdfContextMenu: (flags) => ipcRenderer.invoke('ui:pdf-context-menu', flags),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  translatePdf: (payload) => ipcRenderer.invoke('pdf:translate', payload),
  cancelTranslate: () => ipcRenderer.invoke('pdf:translate:cancel'),
  onTranslateProgress: (cb) => ipcRenderer.on('pdf:translate:progress', (_e, d) => cb(d)),
  // 드롭된 File에서 OS 경로 추출 (최신 Electron은 File.path 제거 → webUtils 사용)
  getDropPath: (file) => { try { return webUtils.getPathForFile(file); } catch { return file?.path || null; } },
  // 프로젝트: 경로 문자열을 넘기지 않는다 (열기는 main이 dialog, 최근 항목은 id)
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    openRecent: (id) => ipcRenderer.invoke('project:open-recent', id),
    // name(문자열)은 이름 모달에서 받은 프로젝트 이름 — 없으면 needName 신호로 되돌아온다.
    save: (snapshot, name) => ipcRenderer.invoke('project:save', snapshot, name),
    saveAs: (snapshot, name) => ipcRenderer.invoke('project:save-as', snapshot, name),
    recents: () => ipcRenderer.invoke('project:recents'),
  },
  // 설정: 렌더러는 boolean 두 개만 바꿀 수 있고 보관 폴더는 pickStorageDir(=main dialog)로만 바꾼다.
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    pickStorageDir: () => ipcRenderer.invoke('settings:pick-storage-dir'),
  },
  onProjectLoad: (cb) => ipcRenderer.on('project:load', (_e, p) => cb(p)),
  // 최근 파일: 메뉴 클릭 시 main이 allowlist에 등록한 경로를 보낸다
  onOpenRecentFile: (cb) => ipcRenderer.on('menu:open-recent-file', (_e, p) => cb(p)),
  // 이벤트: 콜백 래핑 — IpcRendererEvent를 렌더러로 넘기지 않는다
  onOpenPair: (cb) => ipcRenderer.on('open-pair', (_e, data) => cb(data)),
  onMenu: (cb) => {
    const channels = [
      'menu:open-left', 'menu:open-right', 'menu:close-left', 'menu:close-right', 'menu:save',
      'menu:project-save', 'menu:project-save-as',
      'menu:next-diff', 'menu:prev-diff', 'menu:toggle-ws', 'menu:toggle-vim', 'menu:toggle-theme',
      'menu:toggle-night', 'menu:settings',
    ];
    channels.forEach((ch) => ipcRenderer.on(ch, () => cb(ch)));
  },
});
