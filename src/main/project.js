// src/main/project.js — 프로젝트 열기/저장.
// 보안 원칙: 경로 문자열은 렌더러에서 받지 않는다.
//  - 열기: main이 dialog를 띄운다. 최근 목록은 경로가 아니라 id로 연다.
//  - 저장: 저장 대상 파일 경로는 "이번 세션에 실제로 연 파일"(allowed)이어야 한다.
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { serialize, parse, MAX_BYTES } = require('./projectFile.js');
const { createRecents } = require('./recentProjects.js');
const { allowed, allowPath, normalize } = require('./allowlist.js');

const EXT = 'wcproj';
let recents = null;
let onChange = () => {};
let currentPath = null; // 현재 열린/저장된 프로젝트

const store = () => (recents ||= createRecents(path.join(app.getPath('userData'), 'recent-projects.json')));

// 렌더러가 아직 로딩 중이면(app.js는 12MB 번들이라 늦게 뜬다) 리스너가 없어 메시지가 조용히 유실된다.
// main.js가 open-pair에 did-finish-load 가드를 두는 것과 같은 이유.
function sendWhenReady(win, channel, payload) {
  const wc = win?.webContents;
  if (!wc) return;
  if (wc.isLoadingMainFrame()) wc.once('did-finish-load', () => wc.send(channel, payload));
  else wc.send(channel, payload);
}

// dialog가 준 경로는 /var/... 인데 파일 경로는 realpath로 /private/var/... 이다.
// 둘의 표기가 다르면 path.relative가 ../../../.. 로 터무니없이 길어진다 → 기준을 맞춘다.
function realDir(p) {
  const dir = path.dirname(path.resolve(p));
  try { return path.join(fs.realpathSync.native(dir), path.basename(p)); }
  catch { return path.resolve(p); }
}

function setOnChange(fn) { onChange = fn || (() => {}); }
function list() { return store().list().map(({ id, name, path: p }) => ({ id, name, path: p })); }
function clearRecents() { store().clear(); onChange(); }

function loadFrom(win, projectPath) {
  const stat = fs.statSync(projectPath);
  if (stat.size > MAX_BYTES) throw new Error('프로젝트 파일이 너무 큽니다 (2MB 초과)');
  const project = parse(fs.readFileSync(projectPath, 'utf8'), projectPath);

  // 프로젝트에 적힌 파일을 이 세션에서 열 수 있도록 화이트리스트에 넣는다.
  // (CLI 인자와 동일한 취급 — 사용자가 명시적으로 연 프로젝트이므로.)
  const payload = { mode: project.mode, view: project.view, markers: project.markers, files: {}, missing: [] };
  for (const side of ['left', 'right']) {
    const f = project.files[side];
    if (!f) { payload.files[side] = null; continue; }
    if (f.missing) { payload.files[side] = null; payload.missing.push({ side, path: f.path }); continue; }
    payload.files[side] = allowPath(f.path);
  }

  currentPath = projectPath;
  store().add(projectPath);
  onChange();
  sendWhenReady(win, 'project:load', payload);
  return { ok: true, path: projectPath, missing: payload.missing };
}

async function open(win) {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'wcompare 프로젝트', extensions: [EXT] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return loadFrom(win, res.filePaths[0]);
}

function openRecent(win, id) {
  const p = store().pathOf(id);
  if (!p) throw new Error('최근 항목을 찾을 수 없습니다');
  if (!fs.existsSync(p)) {
    // 외장 드라이브 언마운트 같은 일시적 부재가 있으므로 자동 삭제하지 않고 물어본다.
    const pick = dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: '프로젝트 파일을 찾을 수 없습니다',
      detail: p,
      buttons: ['목록에서 제거', '유지'],
      defaultId: 1,
    });
    if (pick === 0) { store().remove(id); onChange(); }
    return null;
  }
  return loadFrom(win, p);
}

// 렌더러가 임의 경로를 프로젝트에 심어 저장하지 못하게 한다.
function assertOwned(snapshot) {
  for (const side of ['left', 'right']) {
    const p = snapshot?.files?.[side];
    if (!p) continue;
    if (!allowed.has(normalize(p))) throw new Error('save denied: 이 세션에서 연 파일이 아닙니다');
  }
}

async function save(win, snapshot, { saveAs = false } = {}) {
  assertOwned(snapshot);
  let target = saveAs ? null : currentPath;
  if (!target) {
    const base = snapshot?.files?.left ? path.basename(snapshot.files.left, path.extname(snapshot.files.left)) : 'untitled';
    const res = await dialog.showSaveDialog(win, {
      defaultPath: `${base}.${EXT}`,
      filters: [{ name: 'wcompare 프로젝트', extensions: [EXT] }],
    });
    if (res.canceled || !res.filePath) return null;
    target = realDir(res.filePath); // 파일 경로와 같은 표기로 맞춰야 rel이 정상적으로 나온다
  }
  fs.writeFileSync(target, serialize(snapshot, target));
  currentPath = target;
  store().add(target);
  onChange();
  return { ok: true, path: target };
}

const currentProject = () => currentPath;

module.exports = { open, openRecent, save, list, clearRecents, setOnChange, currentProject, EXT };
