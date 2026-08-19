const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { allowed, allowPath } = require('../src/main/allowlist.js');
const openFiles = require('../src/main/openFiles.js');

const TMP = path.join('/tmp', 'wc-openfiles-test');
const p = (n) => path.join(TMP, n);

test.beforeEach(() => {
  allowed.clear();
  for (const id of [1, 2, 3]) openFiles.clear(id);
  openFiles.setOnChange(null);
});

test('sanitize: 허용목록에 없는 경로는 버린다', () => {
  // 이 항목은 누르면 Finder를 여는 동작이다. 렌더러가 임의 경로를 얹을 수 있으면
  // 허용목록 원칙이 메뉴를 통해 무너진다.
  allowPath(p('ok.pdf'));
  const out = openFiles.sanitize([
    { label: '왼쪽', path: p('ok.pdf') },
    { label: '오른쪽', path: p('never-opened.pdf') },
    { label: '악의', path: '/etc/passwd' },
  ]);
  assert.deepStrictEqual(out.map((e) => e.path), [p('ok.pdf')]);
});

test('sanitize: 경로가 아닌 값과 이상한 입력을 견딘다', () => {
  assert.deepStrictEqual(openFiles.sanitize(null), []);
  assert.deepStrictEqual(openFiles.sanitize('문자열'), []);
  assert.deepStrictEqual(openFiles.sanitize([null, {}, { path: 42 }, { path: '' }]), []);
});

test('sanitize: 같은 파일을 좌우에 열면 한 줄로 합친다', () => {
  const one = allowPath(p('same.pdf'));
  const out = openFiles.sanitize([
    { label: '왼쪽', path: one }, { label: '오른쪽', path: one },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].label, '왼쪽');
});

test('sanitize: 항목 수에 상한이 있다', () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) {
    many.push({ label: `f${i}`, path: allowPath(p(`f${i}.txt`)) });
  }
  assert.strictEqual(openFiles.sanitize(many).length, openFiles.MAX_ENTRIES);
});

test('set/list: 창별로 따로 담는다', () => {
  const a = allowPath(p('a.pdf'));
  const b = allowPath(p('b.pdf'));
  openFiles.set(1, [{ label: '왼쪽', path: a }]);
  openFiles.set(2, [{ label: '왼쪽', path: b }]);
  assert.deepStrictEqual(openFiles.list(1).map((e) => e.path), [a]);
  assert.deepStrictEqual(openFiles.list(2).map((e) => e.path), [b]);
  assert.deepStrictEqual(openFiles.list(99), []);
});

test('set: 값이 그대로면 메뉴를 다시 만들지 않는다', () => {
  // 렌더러는 상태가 바뀔 만한 자리마다 부담 없이 부른다. 매번 메뉴를 다시 세팅하면
  // 열려 있던 메뉴가 닫혀 버려서 사용자 눈에 띈다.
  const a = allowPath(p('a.pdf'));
  let fired = 0;
  openFiles.setOnChange(() => { fired += 1; });
  openFiles.set(1, [{ label: '왼쪽', path: a }]);
  assert.strictEqual(fired, 1);
  openFiles.set(1, [{ label: '왼쪽', path: a }]);
  openFiles.set(1, [{ label: '왼쪽', path: a }]);
  assert.strictEqual(fired, 1, '같은 값에도 메뉴를 다시 만들었다');
  openFiles.set(1, [{ label: '오른쪽', path: a }]); // 라벨만 달라도 갱신
  assert.strictEqual(fired, 2);
});

test('clear: 그 창의 것만 지운다', () => {
  const a = allowPath(p('a.pdf'));
  openFiles.set(1, [{ label: '왼쪽', path: a }]);
  openFiles.set(2, [{ label: '왼쪽', path: a }]);
  openFiles.clear(1);
  assert.deepStrictEqual(openFiles.list(1), []);
  assert.strictEqual(openFiles.list(2).length, 1);
});

test('set: 빈 목록은 창을 목록에서 지운다', () => {
  const a = allowPath(p('a.pdf'));
  openFiles.set(1, [{ label: '왼쪽', path: a }]);
  openFiles.set(1, []);
  assert.deepStrictEqual(openFiles.list(1), []);
});

test('displayPath: 홈 아래는 ~로 줄인다', () => {
  assert.strictEqual(
    openFiles.displayPath('/Users/me/docs/a.pdf', '/Users/me'), '~/docs/a.pdf');
  // 홈과 접두사만 같은 남의 폴더는 줄이지 않는다
  assert.strictEqual(
    openFiles.displayPath('/Users/menace/a.pdf', '/Users/me'), '/Users/menace/a.pdf');
  assert.strictEqual(openFiles.displayPath('/opt/x.pdf', '/Users/me'), '/opt/x.pdf');
});

test('displayPath: 길면 앞을 자르고 파일명을 남긴다', () => {
  // 어느 폴더인지보다 어떤 파일인지가 먼저 읽혀야 한다.
  const long = `/Users/me/${'d'.repeat(200)}/논문-최종.pdf`;
  const out = openFiles.displayPath(long, '/Users/me');
  assert.ok(out.length <= openFiles.MAX_PATH_CHARS);
  assert.ok(out.startsWith('…'));
  assert.ok(out.endsWith('논문-최종.pdf'), `파일명이 잘렸다: ${out}`);
});
