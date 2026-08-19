// src/main/openFiles.js — 창별 "지금 열려 있는 파일" 목록. 메뉴에 경로를 보여주기 위한 것.
//
// 메뉴는 앱에 하나뿐인데 창은 여럿일 수 있다. 그래서 webContents.id로 나눠 담고,
// 메뉴를 그릴 때 포커스된 창의 것만 꺼낸다(project.js가 프로젝트를 다루는 구조와 같다).
const path = require('node:path');
const os = require('node:os');
const { allowed, normalize } = require('./allowlist.js');

// 한 창에 올라갈 수 있는 파일은 좌·우 둘(메모 모드는 원문·번역본 둘)이다. 넉넉히 잡되
// 상한은 둔다 — 렌더러가 보낸 목록을 그대로 메뉴로 만들므로 길이가 무한이어선 안 된다.
const MAX_ENTRIES = 8;
const MAX_LABEL_CHARS = 24;
// 메뉴 한 줄에 담기는 길이. 넘치면 앞을 잘라내는데, 그 기준이 이 값이다.
const MAX_PATH_CHARS = 64;

const byWc = new Map();
let onChange = () => {};

function setOnChange(fn) { onChange = fn || (() => {}); }

// 렌더러가 보낸 목록을 그대로 믿지 않는다. 경로는 main이 allowPath로 발급한 것만 통과시킨다.
// 표시용이라고 검문을 건너뛸 수 없다 — 이 항목은 누르면 Finder를 여는 '동작'이고,
// 렌더러가 임의 경로를 넣을 수 있으면 임의 위치를 여는 통로가 된다.
function sanitize(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (out.length >= MAX_ENTRIES) break;
    if (typeof e?.path !== 'string' || !e.path) continue;
    const p = normalize(e.path);
    if (!allowed.has(p)) continue;
    if (out.some((v) => v.path === p)) continue; // 같은 파일을 좌우에 연 경우 한 줄로
    out.push({ label: String(e.label ?? '').slice(0, MAX_LABEL_CHARS), path: p });
  }
  return out;
}

function same(a, b) {
  return a.length === b.length
    && a.every((v, i) => v.path === b[i].path && v.label === b[i].label);
}

function set(wcId, entries) {
  const next = sanitize(entries);
  const prev = byWc.get(wcId) || [];
  // 렌더러는 상태가 바뀔 만한 곳마다 부담 없이 부른다. 같은 값이면 메뉴를 다시 만들지 않는다
  // — macOS 메뉴 재설정은 열려 있는 메뉴를 닫아 버려서, 잦은 재설정이 눈에 띈다.
  if (same(prev, next)) return;
  if (next.length) byWc.set(wcId, next); else byWc.delete(wcId);
  onChange();
}

function clear(wcId) { if (byWc.delete(wcId)) onChange(); }
function list(wcId) { return byWc.get(wcId) || []; }

/** 메뉴에 적을 경로. 홈 아래는 ~로 줄이고, 그래도 길면 앞을 잘라낸다. */
function displayPath(p, home = os.homedir()) {
  const s = home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
  if (s.length <= MAX_PATH_CHARS) return s;
  // 잘라야 한다면 앞쪽을 버린다 — 어느 폴더인지보다 어떤 파일인지가 먼저 읽혀야 한다.
  return `…${s.slice(-(MAX_PATH_CHARS - 1))}`;
}

module.exports = {
  set, clear, list, setOnChange, displayPath, sanitize,
  MAX_ENTRIES, MAX_PATH_CHARS,
};
