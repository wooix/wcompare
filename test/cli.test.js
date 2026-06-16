const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { parsePair } = require('../src/main/cli.js');

const f1 = path.join(os.tmpdir(), 'wc-cli-1-' + Date.now() + '.txt');
const f2 = path.join(os.tmpdir(), 'wc-cli-2-' + Date.now() + '.txt');
fs.writeFileSync(f1, 'a'); fs.writeFileSync(f2, 'b');

test('비패키징 `electron . a b` → a,b (앱경로 . 건너뜀)', () => {
  const r = parsePair(['electron', '.', f1, f2], false);
  assert.equal(r.left, f1);
  assert.equal(r.right, f2);
});

test('비패키징 `electron main.js a b` → a,b (엔트리 스크립트 제외)', () => {
  const main = path.join(os.tmpdir(), 'main.js'); fs.writeFileSync(main, '//');
  const r = parsePair(['electron', main, f1, f2], false);
  assert.equal(r.left, f1, 'main.js가 left로 새지 않아야 함');
  assert.equal(r.right, f2);
  fs.rmSync(main, { force: true });
});

test('패키징 `exe a` → left=a, right=null', () => {
  const r = parsePair(['exe', f1], true);
  assert.equal(r.left, f1);
  assert.equal(r.right, null);
});

test('파일 인자 없음 → null,null', () => {
  const r = parsePair(['electron', '.'], false);
  assert.deepEqual(r, { left: null, right: null });
});

test('존재하지 않는 경로는 무시', () => {
  const r = parsePair(['electron', '.', '/no/such/file', f1], false);
  assert.equal(r.left, f1);
  assert.equal(r.right, null);
});
