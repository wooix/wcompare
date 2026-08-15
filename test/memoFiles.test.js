// test/memoFiles.test.js — memo 모드의 파일 이름·경로 규칙(main/memoFiles.js).
// 여기서 지키는 핵심은 하나다: **렌더러가 보낸 이름으로 memos/ 밖을 가리킬 수 없다.**
// 렌더러는 경로를 만들지 않고 이름만 넘기므로, 그 이름이 경로 구분자나 '..'을 품으면
// 보관 폴더 밖에 파일을 쓰게 된다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sanitizeMemoName, translationPathFor, isTranslation, listMemos, uniqueMemoPath, KO_SUFFIX,
} = require('../src/main/memoFiles.js');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `wc-memo-${tag}-`));

test('sanitizeMemoName: 경로 구분자·상위 토큰·제어문자·선행 점을 없앤다', () => {
  assert.equal(sanitizeMemoName('a/b\\c'), 'abc');
  assert.equal(sanitizeMemoName('../../etc/passwd'), 'etcpasswd');
  assert.equal(sanitizeMemoName('a:b*c?d"e<f>g|h'), 'abcdefgh');
  assert.equal(sanitizeMemoName('a\x00\x1f\x7fb'), 'ab');
  assert.equal(sanitizeMemoName('.hidden'), 'hidden');
  assert.ok(!sanitizeMemoName('a..b..c').includes('..'));
});

test('sanitizeMemoName: .md를 사용자가 붙여도 두 번 붙지 않는다', () => {
  assert.equal(sanitizeMemoName('회의록.md'), '회의록');
  assert.equal(sanitizeMemoName('회의록.MD'), '회의록');
  assert.equal(sanitizeMemoName('회의록'), '회의록');
});

test('sanitizeMemoName: 못 쓸 값이면 빈 문자열(호출측이 기본 이름을 쓴다)', () => {
  for (const v of ['', '   ', '...', '/', null, undefined, 42, {}]) {
    assert.equal(sanitizeMemoName(v), '');
  }
});

test('sanitizeMemoName: 서로게이트 쌍을 반쪽으로 자르지 않는다', () => {
  const out = sanitizeMemoName('🎉'.repeat(120));
  const lone = [...out].some((ch) => ch.length === 1
    && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff);
  assert.equal(lone, false, '고아 서로게이트가 남았다');
});

test('translationPathFor: 원문 → .ko.md', () => {
  assert.equal(translationPathFor('/m/foo.md'), `/m/foo${KO_SUFFIX}`);
  assert.equal(translationPathFor('/m/foo.MD'), `/m/foo${KO_SUFFIX}`);
});

test('translationPathFor: 번역본을 다시 넣어도 .ko.ko.md가 되지 않는다', () => {
  // 좌우 스왑이 있는 모드라 번역본이 '메인'인 상태에서 이 함수가 다시 불릴 수 있다.
  const ko = `/m/foo${KO_SUFFIX}`;
  assert.equal(translationPathFor(ko), ko);
  assert.equal(translationPathFor(translationPathFor('/m/foo.md')), ko);
});

test('isTranslation: 번역본만 참', () => {
  assert.equal(isTranslation(`/m/foo${KO_SUFFIX}`), true);
  assert.equal(isTranslation('/m/foo.md'), false);
  assert.equal(isTranslation('/m/ko.md'), false, "'ko.md'는 접미사가 아니다");
  assert.equal(isTranslation(null), false);
});

test('listMemos: 원문만 최근 수정 순으로 낸다(번역본은 제외)', () => {
  const dir = tmp('list');
  fs.writeFileSync(path.join(dir, 'old.md'), 'a');
  fs.writeFileSync(path.join(dir, `old${KO_SUFFIX}`), 'b'); // 번역본 — 목록에 없어야 한다
  fs.writeFileSync(path.join(dir, 'new.md'), 'c');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'd'); // md가 아니다
  fs.mkdirSync(path.join(dir, 'sub.md')); // 디렉터리 — 파일이 아니다
  // mtime을 벌려 정렬을 확정한다(같은 ms면 순서가 흔들린다).
  const past = Date.now() / 1000 - 60;
  fs.utimesSync(path.join(dir, 'old.md'), past, past);

  const out = listMemos(dir);
  assert.deepEqual(out.map((m) => m.name), ['new', 'old']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listMemos: 폴더가 없거나 못 읽으면 빈 배열(던지지 않는다)', () => {
  assert.deepEqual(listMemos('/nonexistent-xyz-123'), []);
  assert.deepEqual(listMemos(null), []);
});

test('uniqueMemoPath: 이름이 겹치면 뒤에 번호를 붙인다', () => {
  const dir = tmp('uniq');
  assert.equal(uniqueMemoPath(dir, '회의록'), path.join(dir, '회의록.md'));
  fs.writeFileSync(path.join(dir, '회의록.md'), 'x');
  assert.equal(uniqueMemoPath(dir, '회의록'), path.join(dir, '회의록 2.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uniqueMemoPath: 번역본만 남아 있어도 그 이름을 피한다', () => {
  // foo.ko.md만 있는데 foo.md를 새로 만들면, 만들자마자 남의 번역본이 딸려 붙은 것처럼 보인다.
  const dir = tmp('uniq-ko');
  fs.writeFileSync(path.join(dir, `회의록${KO_SUFFIX}`), 'x');
  assert.equal(uniqueMemoPath(dir, '회의록'), path.join(dir, '회의록 2.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uniqueMemoPath: 이름이 못 쓸 값이면 기본 이름으로 물러난다', () => {
  const dir = tmp('uniq-bad');
  assert.equal(uniqueMemoPath(dir, '../../etc/passwd'), path.join(dir, 'etcpasswd.md'));
  assert.equal(uniqueMemoPath(dir, ''), path.join(dir, '무제.md'));
  assert.equal(uniqueMemoPath(dir), path.join(dir, '무제.md'));
  // 어떤 입력이 와도 결과는 반드시 dir 안이다 — 이것이 이 함수의 존재 이유다.
  for (const bad of ['/etc/passwd', '..', '....', null, 42]) {
    assert.equal(path.dirname(uniqueMemoPath(dir, bad)), dir, `dir 밖으로 나갔다: ${String(bad)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
