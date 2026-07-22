// src/main/recentFiles.js — 최근에 연 "개별 파일" 목록 (최근 프로젝트와 별개).
// 보안 원칙은 프로젝트와 동일: 렌더러에 경로를 미리 뿌리지 않고, 사용자가 메뉴에서
// 명시적으로 클릭한 순간 main이 allowlist에 등록한 뒤 경로를 보낸다(dialog와 같은 신뢰 수준).
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createRecents } = require('./recentProjects.js');
const { allowPath } = require('./allowlist.js');

let recents = null;
let onChange = () => {};
const store = () => (recents ||= createRecents(path.join(app.getPath('userData'), 'recent-files.json')));

function setOnChange(fn) { onChange = fn || (() => {}); }
function list() { return store().list(); }
function clear() { store().clear(); onChange(); }

// 파일이 열릴 때마다 호출. dialog/DnD/CLI/프로젝트 어느 경로든 파일 IPC를 지나므로 그 한 곳이면 된다.
function record(p) { store().add(p); onChange(); }

function openRecent(win, id) {
  const p = store().pathOf(id);
  if (!p) return;
  if (!fs.existsSync(p)) {
    // 외장 드라이브 언마운트 같은 일시적 부재가 있으므로 자동 삭제하지 않고 물어본다.
    const pick = dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: '파일을 찾을 수 없습니다',
      detail: p,
      buttons: ['목록에서 제거', '유지'],
      defaultId: 1,
    });
    if (pick === 0) { store().remove(id); onChange(); }
    return;
  }
  win?.webContents.send('menu:open-recent-file', allowPath(p));
}

module.exports = { list, clear, record, openRecent, setOnChange };
