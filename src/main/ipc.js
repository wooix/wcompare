// src/main/ipc.js
const { ipcMain, dialog, BrowserWindow, Menu, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { readFile, writeFile, readBytes } = require('./fileService.js');
const { lint } = require('./lint/lintService.js');
const { translate, outputPathFor } = require('./transpaper.js');
const { allowed, openedPdfs, normalize, allowPath } = require('./allowlist.js');
const { triggerShortcutDict } = require('./shortcutDict.js');
const project = require('./project.js');
const recentFiles = require('./recentFiles.js');
const settings = require('./settings.js');
const { createTranslationJobs } = require('./translationJobs.js');

// 형광펜 팔레트. 렌더러 pdfMarkers의 기본 노랑과 같은 투명도(0.45) 계열.
const HIGHLIGHT_COLORS = [
  { label: '노랑', color: 'rgba(255, 214, 74, 0.45)' },
  { label: '초록', color: 'rgba(122, 224, 122, 0.45)' },
  { label: '파랑', color: 'rgba(96, 180, 255, 0.45)' },
  { label: '분홍', color: 'rgba(255, 128, 192, 0.45)' },
];

// 창(webContents.id)별 번역 job — 여러 창에서 동시에 서로 다른 PDF를 번역할 수 있다.
const jobs = createTranslationJobs();

function readWithPath(p) {
  const meta = readFile(p);
  return { path: p, ext: path.basename(p), ...meta };
}

// file이 dir 하위(또는 같음)인지. path.relative가 ..로 시작하지 않으면 하위.
function isInside(dir, file) {
  const rel = path.relative(dir, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 설정이 켜져 있으면 연 PDF를 보관 폴더(documents)에 사본으로 남긴다 —
// 원본이 외장 드라이브 등에서 사라져도 기록이 남게. 실패해도 열기는 계속한다(콘솔 경고만).
function archivePdfIfEnabled(p) {
  try {
    const s = settings.get();
    if (!s.archivePdfOnOpen || !/\.pdf$/i.test(p)) return;
    const docs = settings.dirFor('documents'); // storageDir/documents 보장
    if (isInside(normalize(s.storageDir), p)) return; // 이미 보관 폴더 안에서 연 파일
    const base = path.basename(p).replace(/\.pdf$/i, '');
    const srcSize = fs.statSync(p).size;
    // 같은 이름이 있고 크기가 같으면 이미 보관된 것으로 보고 skip. 다르면 base-2.pdf, base-3.pdf … 로.
    for (let n = 1; n < 1000; n++) {
      const dst = path.join(docs, n === 1 ? `${base}.pdf` : `${base}-${n}.pdf`);
      if (!fs.existsSync(dst)) { fs.copyFileSync(p, dst); return; }
      if (fs.statSync(dst).size === srcSize) return; // 이미 동일 사본이 있다
    }
  } catch (e) {
    console.warn('PDF 보관 실패(무시):', e?.message || e);
  }
}

function registerIpc() {
  ipcMain.handle('dialog:openFile', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const p = allowPath(res.filePaths[0]);
    recentFiles.record(p);
    return readWithPath(p);
  });

  // ===== 프로젝트 =====
  // 경로 문자열은 렌더러에서 받지 않는다: 열기는 main이 dialog를 띄우고, 최근 항목은 id로 연다.
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('project:open', (e) => project.open(winOf(e)));
  ipcMain.handle('project:open-recent', (e, id) => project.openRecent(winOf(e), id));
  // name은 문자열만 통과시킨다(렌더러 이름 모달 결과). 나머지 경로 결정은 main이 한다.
  ipcMain.handle('project:save', (e, snapshot, name) =>
    project.save(winOf(e), snapshot, { name: typeof name === 'string' ? name : undefined }));
  ipcMain.handle('project:save-as', (e, snapshot, name) =>
    project.save(winOf(e), snapshot, { saveAs: true, name: typeof name === 'string' ? name : undefined }));
  ipcMain.handle('project:recents', () => project.list().map(({ id, name }) => ({ id, name })));

  ipcMain.handle('file:read', (_e, rawPath) => {
    const p = allowPath(rawPath); // 사용자가 명시 선택(dialog/CLI/DnD/프로젝트)한 경로만 렌더러가 보냄
    recentFiles.record(p); // pane에 파일을 올리는 모든 경로가 여기를 지난다
    return readWithPath(p);
  });

  ipcMain.handle('file:write', (_e, { path: rawPath, content, eol, encoding, bom }) => {
    const p = normalize(rawPath);
    if (!allowed.has(p)) throw new Error('write denied: path not in session whitelist');
    writeFile(p, content, { eol, encoding, bom });
    return { ok: true, mtimeMs: fs.statSync(p).mtimeMs };
  });

  ipcMain.handle('file:readBytes', (_e, rawPath) => {
    const p = allowPath(rawPath);
    recentFiles.record(p);
    const { bytes, byteSize } = readBytes(p);
    // 설정: PDF를 열 때 보관 폴더에 사본 저장 (원본이 외장 드라이브 등에서 사라져도 기록이 남게)
    archivePdfIfEnabled(p);
    return { path: p, ext: path.basename(p), bytes, byteSize };
  });

  // ===== 설정 =====
  ipcMain.handle('settings:get', () => settings.get());
  // 렌더러는 boolean 두 개만 바꿀 수 있다 (storageDir는 dialog를 거쳐야 바꾼다 — 임의 경로 쓰기 방지).
  ipcMain.handle('settings:set', (_e, patch = {}) => {
    const next = {};
    if (typeof patch.archivePdfOnOpen === 'boolean') next.archivePdfOnOpen = patch.archivePdfOnOpen;
    if (typeof patch.keepTranslationsInStorage === 'boolean') next.keepTranslationsInStorage = patch.keepTranslationsInStorage;
    // shortcuts는 object면 그대로 넘기고 settingsStore가 하위 키·문자열 값을 재검증한다.
    if (patch.shortcuts && typeof patch.shortcuts === 'object') next.shortcuts = patch.shortcuts;
    return settings.set(next);
  });
  ipcMain.handle('settings:pick-storage-dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    return settings.set({ storageDir: res.filePaths[0] }); // 절대경로만 통과(settingsStore가 검증)
  });

  // 전체 텍스트 복사 등 "DOM 선택이 아닌" 텍스트의 클립보드 기록.
  // (선택 복사는 반드시 role:'copy' — 아래 컨텍스트 메뉴 주석 참고.)
  ipcMain.handle('clipboard:writeText', (_e, text) => {
    const t = String(text ?? '');
    if (t.length > 20 * 1024 * 1024) throw new Error('텍스트가 너무 커서 복사할 수 없습니다');
    clipboard.writeText(t);
    return { ok: true, length: t.length };
  });

  // ===== 실시간 사전 (외부 앱 위임) =====
  // 인자를 받지 않는다: 선택 텍스트는 ShortcutDictionary가 자체적으로 읽으므로
  // 렌더러가 경로/명령/텍스트를 조립할 필요가 없다(allowlist 원칙 유지).
  // main은 Control+Shift+D 키 이벤트만 시스템에 합성한다.
  // 테스트(WCOMPARE_DICT_FAKE): 실제 osascript(시스템 키 이벤트) 대신 성공을 흉내 낸다
  // — transpaper의 env 주입 시맨틱과 동일한 테스트 심(seam).
  const fakeDictRun = process.env.WCOMPARE_DICT_FAKE ? () => Promise.resolve({}) : null;
  ipcMain.handle('dict:external', async () =>
    triggerShortcutDict(fakeDictRun ? { run: fakeDictRun } : undefined));

  ipcMain.handle('lint:run', (_e, payload) => lint(payload));

  ipcMain.handle('pdf:translate', async (e, { path: rawPath, force } = {}) => {
    const wc = e.sender;
    const wcId = wc.id;
    const p = normalize(rawPath);
    if (!openedPdfs.has(p)) throw new Error('translate denied: 이 세션에서 연 PDF가 아닙니다');
    if (jobs.has(wcId)) throw new Error('이 창에서 이미 번역이 진행 중입니다');

    const output = settings.get().keepTranslationsInStorage
      ? path.join(settings.dirFor('translations'), path.basename(p).replace(/\.pdf$/i, '') + '.ko.pdf')
      : outputPathFor(p);
    if (!force && fs.existsSync(output)) return { output, existed: true };
    // 같은 출력 경로를 다른 창이 이미 쓰고 있으면 거부 — 같은 파일을 두 창에서 동시에 덮어쓰는 것을 막는다.
    if (jobs.outputInUse(output)) throw new Error('같은 파일을 다른 창에서 번역 중입니다');

    const job = translate(p, {
      onProgress: (d) => { if (!wc.isDestroyed()) wc.send('pdf:translate:progress', d); },
      output,
    });
    jobs.add(wcId, output, job);
    try {
      const res = await job.promise;
      const out = normalize(res.output);
      allowed.add(out);
      openedPdfs.add(out);
      return { ...res, output: out, existed: false };
    } finally {
      jobs.remove(wcId);
    }
  });

  ipcMain.handle('pdf:translate:cancel', (e) => {
    jobs.cancel(e.sender.id);
    return { ok: true };
  });

  // PDF 우클릭 메뉴. 렌더러가 "선택이 있는가 / 이 좌표에 마커가 있는가"만 알려주고,
  // 메뉴 구성은 메인이 한다(렌더러가 임의 메뉴를 띄우지 못하게).
  // 복사는 반드시 role:'copy' — clipboard.writeText로 직접 쓰면 pdf.js textLayer의
  // copy 핸들러(유니코드 정규화)를 건너뛰어 깨진 텍스트가 들어간다.
  ipcMain.handle('ui:pdf-context-menu', (e, { hasSelection, hasMarker, hasDoc, canMirror } = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return null;

    let settle = null; // Promise 안에서 채워진다. click 콜백은 popup 이후에만 불린다.
    const pick = (id) => settle?.(id);

    const tpl = [];
    if (hasSelection) {
      tpl.push({ role: 'copy', label: '복사', enabled: true });
      tpl.push({ type: 'separator' });
      tpl.push({
        label: '형광펜',
        submenu: HIGHLIGHT_COLORS.map((c) => ({ label: c.label, click: () => pick(`highlight:${c.color}`) })),
      });
      tpl.push({ label: '밑줄', click: () => pick('underline') });
    }
    if (hasMarker) {
      if (tpl.length) tpl.push({ type: 'separator' });
      tpl.push({ label: '마커 삭제', click: () => pick('remove') });
    }
    if (canMirror) {
      if (tpl.length) tpl.push({ type: 'separator' });
      tpl.push({ label: '반대편 같은 위치 보기', click: () => pick('mirror-jump') });
    }
    if (hasDoc) {
      if (tpl.length) tpl.push({ type: 'separator' });
      tpl.push({ label: '전체 텍스트 복사', click: () => pick('copy-all') });
    }
    if (!tpl.length) return null;

    return new Promise((resolve) => {
      let done = false;
      settle = (id) => { if (!done) { done = true; resolve(id); } };
      const menu = Menu.buildFromTemplate(tpl);
      // 닫힘 콜백이 click보다 먼저 도착할 수 있으므로 한 틱 미뤄 null로 마감한다.
      menu.popup({ window: win, callback: () => setTimeout(() => settle(null), 0) });
    });
  });
}

// 앱 종료 시 호출 — detached로 띄운 transpaper(및 그 자식 agy/claude)가 살아남지 않도록.
function cancelTranslation() { jobs.cancelAll(); }

// 특정 창이 파괴될 때 그 창의 번역만 취소한다(main.js의 webContents 'destroyed' 훅에서 호출).
function cancelForWebContents(wcId) { jobs.cancel(wcId); }

module.exports = { registerIpc, allowPath, cancelTranslation, cancelForWebContents };
