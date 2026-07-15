// src/main/settings.js — 앱 설정(userData/settings.json). 보관 폴더(storageDir)와 보관 정책 토글.
// electron에 의존하는 얇은 래퍼일 뿐, 저장 로직은 settingsStore(단위 테스트 가능)에 있다.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore } = require('./settingsStore.js');

const DEFAULTS = {
  storageDir: path.join(os.homedir(), '.local', 'wcompare'),
  archivePdfOnOpen: false,
  keepTranslationsInStorage: false,
};

let store = null;
// app.getPath('userData')는 앱 준비 후에만 유효하므로 최초 사용 시점에 만든다(lazy).
const inst = () => (store ||= createSettingsStore(path.join(app.getPath('userData'), 'settings.json'), DEFAULTS));

const get = () => inst().get();
const set = (patch) => inst().set(patch);

// 보관 폴더 하위의 종류별 디렉터리를 보장하고 그 경로를 돌려준다.
const SUBDIRS = { documents: 'documents', translations: 'translations', projects: 'projects' };
function dirFor(kind) {
  const sub = SUBDIRS[kind];
  if (!sub) throw new Error(`알 수 없는 보관 폴더 종류: ${kind}`);
  const dir = path.join(get().storageDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { get, set, dirFor, DEFAULTS };
