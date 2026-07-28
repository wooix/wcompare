const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('wcompare', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  readBytes: (path) => ipcRenderer.invoke('file:readBytes', path),
  writeFile: (payload) => ipcRenderer.invoke('file:write', payload),
  lint: (payload) => ipcRenderer.invoke('lint:run', payload),
  pdfContextMenu: (flags) => ipcRenderer.invoke('ui:pdf-context-menu', flags),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  // URL로 PDF 열기: 렌더러는 URL 문자열과 force 여부만 넘긴다 — 다운로드·저장 위치·경로 등록은 전부 main이 한다.
  // force는 "이미 받아 둔 파일을 무시하고 다시 받는다"는 사용자의 명시적 요청(⌥+클릭)이다.
  openPdfUrl: (url, opts) => ipcRenderer.invoke('pdf:open-url', url, opts),
  translatePdf: (payload) => ipcRenderer.invoke('pdf:translate', payload),
  cancelTranslate: () => ipcRenderer.invoke('pdf:translate:cancel'),
  // 번역본 조회·삭제. 넘기는 것은 언제나 "원본" 경로다 — 지울 파일 경로는 main이 다시 유도한다.
  // 렌더러가 삭제 대상을 지목할 수 있으면 그 순간 임의 파일 삭제가 되기 때문.
  translation: {
    info: (paths) => ipcRenderer.invoke('pdf:translation:info', paths),
    remove: (sourcePath) => ipcRenderer.invoke('pdf:translation:delete', sourcePath),
  },
  // 논문 요약: 본문 텍스트는 렌더러가 뽑아 보낸다(pdf.js가 렌더러에만 있다). 경로는 main이 검문한다.
  summarize: (payload) => ipcRenderer.invoke('pdf:summarize', payload),
  cancelSummarize: () => ipcRenderer.invoke('pdf:summarize:cancel'),
  summary: {
    load: (path) => ipcRenderer.invoke('summary:load', path),
    save: (path, parts, meta) => ipcRenderer.invoke('summary:save', path, parts, meta),
  },
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
  // 실시간 사전: 외부 앱(ShortcutDictionary)에 위임 — 인자 없이 Control+Shift+D를 트리거한다.
  // 선택 텍스트는 그 앱이 자체적으로 읽으므로 렌더러가 텍스트/경로를 넘기지 않는다.
  dict: {
    external: () => ipcRenderer.invoke('dict:external'),
  },
  // 번역 AI 모델 목록: agy CLI("agy models")를 실행해 설정에 저장하고 목록을 돌려준다.
  models: {
    refresh: () => ipcRenderer.invoke('models:refresh'),
  },
  // PDF 마커 자동 영속화: 경로별 마커 저장/복원. path는 openPdf가 받은 정규화 절대경로.
  markers: {
    save: (path, markers) => ipcRenderer.invoke('markers:save', path, markers),
    load: (path) => ipcRenderer.invoke('markers:load', path),
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
      'menu:toggle-night', 'menu:toggle-dict', 'menu:settings',
    ];
    channels.forEach((ch) => ipcRenderer.on(ch, () => cb(ch)));
  },
});
