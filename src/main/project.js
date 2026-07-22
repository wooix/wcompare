// src/main/project.js — 프로젝트 열기/저장.
// 보안 원칙: 경로 문자열은 렌더러에서 받지 않는다.
//  - 열기: main이 dialog를 띄운다. 최근 목록은 경로가 아니라 id로 연다.
//  - 저장: 저장 대상 파일 경로는 "이번 세션에 실제로 연 파일"(allowed)이어야 한다.
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serialize, parse, MAX_BYTES, FORMAT } = require('./projectFile.js');
const { createRecents } = require('./recentProjects.js');
const { allowed, allowPath, normalize } = require('./allowlist.js');
const { decide, writeProjectFile } = require('./projectSaveDecision.js');
const settings = require('./settings.js');

const EXT = 'wcproj';
let recents = null;
let onChange = () => {};
// 현재 열린/저장된 프로젝트를 "창(webContents.id)별"로 보관한다.
// 모듈 전역 하나면 창A가 연 프로젝트가 창B의 저장 대상까지 바꿔 버린다(창 간 오염).
const currentPaths = new Map(); // wcId → 프로젝트 경로

const store = () => (recents ||= createRecents(path.join(app.getPath('userData'), 'recent-projects.json')));

const wcIdOf = (win) => win?.webContents?.id ?? null;

// 창이 파괴될 때 그 창의 현재 프로젝트 항목을 정리한다(main.js의 destroyed 훅에서 호출).
function forget(wcId) { currentPaths.delete(wcId); }

// cur 파일에 기록된 좌/우 파일 쌍(abs)만 가볍게 읽는다 — "같은 프로젝트인가" 판정용.
// parse는 rel 우선 해석이라 파일이 옮겨졌으면 다른 경로를 돌려줄 수 있어, 저장 당시의 abs를 그대로 본다.
// 읽기 실패(삭제·손상·비-wcproj)면 throw → 판정 모듈이 needName으로 떨어뜨린다.
function readPair(projectPath) {
  const raw = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  if (raw?.format !== FORMAT) throw new Error('wcompare 프로젝트 파일이 아닙니다');
  return { left: raw.files?.left?.abs ?? null, right: raw.files?.right?.abs ?? null };
}

// 상태줄 표기용: 홈 디렉터리 접두사를 ~로 축약한다(전체 경로를 보여주되 짧게).
function displayPath(p) {
  const home = os.homedir();
  return (p === home || p.startsWith(home + path.sep)) ? '~' + p.slice(home.length) : p;
}

// 렌더러가 아직 로딩 중이면(app.js는 12MB 번들이라 늦게 뜬다) 리스너가 없어 메시지가 조용히 유실된다.
// main.js가 open-pair에 did-finish-load 가드를 두는 것과 같은 이유.
function sendWhenReady(win, channel, payload) {
  const wc = win?.webContents;
  if (!wc) return;
  if (wc.isLoadingMainFrame()) wc.once('did-finish-load', () => wc.send(channel, payload));
  else wc.send(channel, payload);
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
  // projectName: 렌더러 이름 모달의 기본값 후보(현재는 사용 안 해도 무방).
  const payload = { mode: project.mode, view: project.view, markers: project.markers, files: {}, missing: [],
    projectName: path.basename(projectPath, `.${EXT}`) };
  for (const side of ['left', 'right']) {
    const f = project.files[side];
    if (!f) { payload.files[side] = null; continue; }
    if (f.missing) { payload.files[side] = null; payload.missing.push({ side, path: f.path }); continue; }
    payload.files[side] = allowPath(f.path);
  }

  currentPaths.set(wcIdOf(win), projectPath); // 이 창의 현재 프로젝트만 갱신
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

// 덮어쓰기 확인. 실제로는 main이 dialog를 띄우지만, e2e에서 다이얼로그가 이벤트 루프를 막지 않도록
// WCOMPARE_TEST_CONFIRM('overwrite'|'cancel')이 설정되면 다이얼로그 대신 그 값을 쓴다
// (ipc.js의 WCOMPARE_DICT_FAKE와 동일한 테스트 심).
async function confirmOverwrite(win, target) {
  const forced = process.env.WCOMPARE_TEST_CONFIRM;
  if (forced === 'overwrite') return true;
  if (forced === 'cancel') return false;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: '이미 같은 이름의 프로젝트가 있습니다',
    detail: `"${path.basename(target)}"을(를) 덮어쓸까요? 기존 내용은 사라집니다.`,
    buttons: ['덮어쓰기', '취소'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

// 판정(재저장/needName/confirm/거부)은 순수 모듈(projectSaveDecision)에 있다.
// 여기서는 그 계획을 받아 dialog·fs 기록만 수행한다.
async function save(win, snapshot, { saveAs = false, name } = {}) {
  assertOwned(snapshot);

  const projectsDir = settings.dirFor('projects');
  const wcId = wcIdOf(win);
  const curPath = currentPaths.get(wcId) || null;

  const plan = decide(
    { name, saveAs, curPath, snapshot, projectsDir, ext: EXT },
    { exists: fs.existsSync, readPair, norm: normalize },
  );

  if (plan.action === 'needName') return { needName: true, suggest: plan.suggest };

  let { target, backup } = plan;
  if (plan.action === 'confirm') {
    if (!(await confirmOverwrite(win, target))) return { canceled: true };
    backup = true; // 확인을 받아 덮어쓰므로 반드시 백업을 남긴다
  }

  writeProjectFile(target, serialize(snapshot, target), { backup });
  currentPaths.set(wcId, target); // 이 창의 현재 프로젝트만 갱신
  store().add(target);
  onChange();
  return { ok: true, path: target, display: displayPath(target) };
}

module.exports = { open, openRecent, save, list, clearRecents, setOnChange, forget, EXT };
