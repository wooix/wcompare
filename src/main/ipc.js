// src/main/ipc.js
const { ipcMain, dialog, BrowserWindow, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { readFile, writeFile, readBytes } = require('./fileService.js');
const { lint } = require('./lint/lintService.js');
const { translate, outputPathFor } = require('./transpaper.js');
const { allowed, openedPdfs, normalize, allowPath } = require('./allowlist.js');
const project = require('./project.js');

let job = null; // 동시에 하나의 번역만 허용

function readWithPath(p) {
  const meta = readFile(p);
  return { path: p, ext: path.basename(p), ...meta };
}

function registerIpc() {
  ipcMain.handle('dialog:openFile', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return null;
    return readWithPath(allowPath(res.filePaths[0]));
  });

  // ===== 프로젝트 =====
  // 경로 문자열은 렌더러에서 받지 않는다: 열기는 main이 dialog를 띄우고, 최근 항목은 id로 연다.
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('project:open', (e) => project.open(winOf(e)));
  ipcMain.handle('project:open-recent', (e, id) => project.openRecent(winOf(e), id));
  ipcMain.handle('project:save', (e, snapshot) => project.save(winOf(e), snapshot));
  ipcMain.handle('project:save-as', (e, snapshot) => project.save(winOf(e), snapshot, { saveAs: true }));
  ipcMain.handle('project:recents', () => project.list().map(({ id, name }) => ({ id, name })));

  ipcMain.handle('file:read', (_e, rawPath) => {
    const p = allowPath(rawPath); // 사용자가 명시 선택(dialog/CLI/DnD/프로젝트)한 경로만 렌더러가 보냄
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
    const { bytes, byteSize } = readBytes(p);
    return { path: p, ext: path.basename(p), bytes, byteSize };
  });

  ipcMain.handle('lint:run', (_e, payload) => lint(payload));

  ipcMain.handle('pdf:translate', async (e, { path: rawPath, force } = {}) => {
    const p = normalize(rawPath);
    if (!openedPdfs.has(p)) throw new Error('translate denied: 이 세션에서 연 PDF가 아닙니다');
    if (job) throw new Error('이미 번역이 진행 중입니다');

    const output = outputPathFor(p);
    if (!force && fs.existsSync(output)) return { output, existed: true };

    const wc = e.sender;
    job = translate(p, {
      onProgress: (d) => { if (!wc.isDestroyed()) wc.send('pdf:translate:progress', d); },
    });
    try {
      const res = await job.promise;
      const out = normalize(res.output);
      allowed.add(out);
      openedPdfs.add(out);
      return { ...res, output: out, existed: false };
    } finally {
      job = null;
    }
  });

  ipcMain.handle('pdf:translate:cancel', () => {
    job?.cancel();
    return { ok: true };
  });

  // PDF 우클릭 메뉴. 렌더러가 "선택이 있는가 / 이 좌표에 마커가 있는가"만 알려주고,
  // 메뉴 구성은 메인이 한다(렌더러가 임의 메뉴를 띄우지 못하게).
  // 복사는 반드시 role:'copy' — clipboard.writeText로 직접 쓰면 pdf.js textLayer의
  // copy 핸들러(유니코드 정규화)를 건너뛰어 깨진 텍스트가 들어간다.
  ipcMain.handle('ui:pdf-context-menu', (e, { hasSelection, hasMarker } = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return null;

    let settle = null; // Promise 안에서 채워진다. click 콜백은 popup 이후에만 불린다.
    const pick = (id) => settle?.(id);

    const tpl = [];
    if (hasSelection) {
      tpl.push({ role: 'copy', label: '복사', enabled: true });
      tpl.push({ type: 'separator' });
      tpl.push({ label: '형광펜', click: () => pick('highlight') });
      tpl.push({ label: '밑줄', click: () => pick('underline') });
    }
    if (hasMarker) {
      if (tpl.length) tpl.push({ type: 'separator' });
      tpl.push({ label: '마커 삭제', click: () => pick('remove') });
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
function cancelTranslation() { job?.cancel(); job = null; }

module.exports = { registerIpc, allowPath, cancelTranslation };
