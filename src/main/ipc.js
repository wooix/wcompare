// src/main/ipc.js
const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { readFile, writeFile } = require('./fileService.js');
const { lint } = require('./lint/lintService.js');

// 현재 세션에서 열린(=쓰기 허용) 경로 화이트리스트
const allowed = new Set();

function normalize(p) {
  try { return fs.realpathSync.native(path.resolve(p)); }
  catch { return path.resolve(p); }
}

function readWithPath(p) {
  const meta = readFile(p);
  return { path: p, ext: path.basename(p), ...meta };
}

function registerIpc() {
  ipcMain.handle('dialog:openFile', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const p = normalize(res.filePaths[0]);
    allowed.add(p);
    return readWithPath(p);
  });

  ipcMain.handle('file:read', (_e, rawPath) => {
    const p = normalize(rawPath);
    allowed.add(p); // 사용자가 명시 선택(dialog/CLI/DnD)한 경로만 렌더러가 보냄
    return readWithPath(p);
  });

  ipcMain.handle('file:write', (_e, { path: rawPath, content, eol, encoding, bom }) => {
    const p = normalize(rawPath);
    if (!allowed.has(p)) throw new Error('write denied: path not in session whitelist');
    writeFile(p, content, { eol, encoding, bom });
    return { ok: true, mtimeMs: fs.statSync(p).mtimeMs };
  });

  ipcMain.handle('lint:run', (_e, payload) => lint(payload));
}

function allowPath(p) { allowed.add(normalize(p)); }

module.exports = { registerIpc, allowPath };
