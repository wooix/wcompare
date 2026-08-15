// src/main/memoFiles.js — memo 모드의 파일 이름·경로 규칙. electron 미의존(단위 테스트 가능).
//
// 신뢰 경계: 메모 '이름'은 렌더러가 보낸 값이라 신뢰하지 않는다. 렌더러는 경로를 만들지 않고
// 이름만 넘기며, 실제 경로는 여기서 보관 폴더(dirFor('memos')) 기준으로만 만들어진다 —
// 그래야 ipc가 allowPath로 등록한 것 밖으로 새어 나갈 수 없다(summaryExport와 같은 태도).
const fs = require('node:fs');
const path = require('node:path');

// 파일시스템에서 문제 되는 문자들. summaryExport.BAD_NAME_CHARS와 같은 목록이지만, 상수 하나
// 때문에 두 pure 모듈 사이에 의존을 만들 이유가 없어 그대로 복제해 둔다.
const BAD_NAME_CHARS = '/\\:*?"<>|';
const MAX_NAME_CHARS = 80;
// 번역본 접미사. 원문 목록을 뽑을 때 이것으로 걸러내므로, 바꾸면 listMemos도 함께 봐야 한다.
const KO_SUFFIX = '.ko.md';

/**
 * 메모 이름을 파일명 stem으로 정화한다. 경로 구분자·제어문자·상위 토큰·선행 점을 없앤다.
 * 이 함수를 거친 값은 디렉터리를 가리킬 수 없다 — 그래서 memos/ 밖으로 나갈 수 없다.
 * @param {*} raw
 * @returns {string} 빈 문자열일 수 있다(호출측이 기본 이름으로 대체한다)
 */
function sanitizeMemoName(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let s = [...raw].filter((ch) => {
    const c = ch.codePointAt(0);
    return c > 31 && c !== 127 && !BAD_NAME_CHARS.includes(ch);
  }).join('');
  s = s.replace(/\.\./g, '').replace(/^\.+/, '').trim();
  s = s.replace(/\.md$/i, '').trim(); // 사용자가 확장자까지 적어도 두 번 붙지 않게
  // 코드 포인트로 자른다 — slice()는 이모지의 서로게이트 쌍을 반으로 갈라 깨진 글자를 남긴다.
  return [...s].slice(0, MAX_NAME_CHARS).join('');
}

/**
 * 번역본 경로. 원문이 `foo.md`면 `foo.ko.md`.
 * 이미 번역본 경로가 들어오면 그대로 돌려준다(번역본을 메인에 둔 채 다시 번역해도 `foo.ko.ko.md`가
 * 생기지 않게 — 좌우 스왑이 있는 모드라 이 경로가 실제로 열린다).
 * @param {string} srcPath
 * @returns {string}
 */
function translationPathFor(srcPath) {
  const p = String(srcPath ?? '');
  if (p.toLowerCase().endsWith(KO_SUFFIX)) return p;
  return `${p.replace(/\.md$/i, '')}${KO_SUFFIX}`;
}

// 번역본인가. 목록에서 걸러내고, 스왑 상태를 판정하는 데도 쓴다.
function isTranslation(p) {
  return String(p ?? '').toLowerCase().endsWith(KO_SUFFIX);
}

/**
 * memos/ 안의 '원문' 메모 목록. 번역본(.ko.md)은 원문에 딸린 것이라 목록에 내지 않는다.
 * 최근 수정 순으로 정렬한다 — 메모는 이름보다 "방금 쓰던 것"으로 찾는다.
 * 폴더가 없거나 읽을 수 없으면 빈 배열(호출측이 빈 목록을 그대로 보여주면 된다).
 * @param {string} dir
 * @returns {Array<{path:string, name:string, mtime:number}>}
 */
function listMemos(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.md$/i.test(n) || isTranslation(n)) continue;
    const full = path.join(dir, n);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({ path: full, name: n.replace(/\.md$/i, ''), mtime: st.mtimeMs });
    } catch { /* 방금 사라진 파일 — 목록에서 빼면 그만이다 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 겹치지 않는 새 메모 경로를 고른다. base가 이미 있으면 `base 2`, `base 3` … 으로 민다.
 * 존재 검사는 원문과 번역본 '둘 다' 본다 — `foo.ko.md`만 남아 있는 상태에서 `foo.md`를 새로
 * 만들면, 만들자마자 남의 번역본이 딸려 붙은 것처럼 보인다.
 * @param {string} dir
 * @param {string} [base]
 * @returns {string} 아직 존재하지 않는 절대 경로
 */
function uniqueMemoPath(dir, base = '무제') {
  const stem = sanitizeMemoName(base) || '무제';
  const taken = (p) => fs.existsSync(p) || fs.existsSync(translationPathFor(p));
  const first = path.join(dir, `${stem}.md`);
  if (!taken(first)) return first;
  // 상한을 둔다: 무한 루프는 UI가 멈춘 것과 구분되지 않는다.
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, `${stem} ${i}.md`);
    if (!taken(cand)) return cand;
  }
  return path.join(dir, `${stem} ${Date.now()}.md`);
}

module.exports = {
  sanitizeMemoName, translationPathFor, isTranslation, listMemos, uniqueMemoPath,
  KO_SUFFIX, MAX_NAME_CHARS,
};
