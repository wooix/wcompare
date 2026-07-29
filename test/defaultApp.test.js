// test/defaultApp.test.js — PDF 기본 앱 지정 보조(defaultApp.js).
// duti 실행은 주입한 run으로 대신한다: 실제로 부르면 테스트가 사용자의 기본 앱을 바꿔 버린다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findDuti, parseHandler, getPdfHandler, setPdfHandler } = require('../src/main/defaultApp.js');

function fakeDuti() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-duti-'));
  fs.writeFileSync(path.join(dir, 'duti'), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}

// `duti -x pdf` 는 이름·경로·번들ID 세 줄을 뱉는다. 우리가 쓰는 것은 마지막 줄이다.
test('parseHandler: 마지막 줄의 번들 ID를 고른다', () => {
  assert.equal(
    parseHandler('Preview.app\n/System/Applications/Preview.app\ncom.apple.Preview\n'),
    'com.apple.Preview',
  );
  assert.equal(parseHandler('com.wooix.wcompare'), 'com.wooix.wcompare');
});

test('parseHandler: 빈 출력이면 null (모른다는 뜻)', () => {
  assert.equal(parseHandler(''), null);
  assert.equal(parseHandler('   \n\n'), null);
  assert.equal(parseHandler(undefined), null);
});

test('findDuti: PATH에서 찾고, 없으면 null', () => {
  const dir = fakeDuti();
  assert.equal(findDuti({ PATH: dir }), path.join(dir, 'duti'));
  assert.equal(findDuti({ PATH: '/nonexistent-xyz' }), null);
});

test('getPdfHandler: duti가 없으면 handler를 null로 둔다', () => {
  // "다른 앱이 기본이다"와 "확인할 수 없다"는 다른 사실이라, duti 유무를 함께 돌려준다.
  const res = getPdfHandler({ run: () => 'com.apple.Preview', env: { PATH: '/nonexistent-xyz' } });
  assert.deepEqual(res, { duti: false, handler: null });
});

test('getPdfHandler: duti가 있으면 현재 핸들러를 읽는다', () => {
  const dir = fakeDuti();
  const calls = [];
  const run = (bin, args) => { calls.push(args); return 'Preview.app\n/x\ncom.apple.Preview\n'; };
  assert.deepEqual(getPdfHandler({ run, env: { PATH: dir } }),
    { duti: true, handler: 'com.apple.Preview' });
  assert.deepEqual(calls, [['-x', 'pdf']]);
});

test('getPdfHandler: duti가 실패해도 던지지 않는다', () => {
  const dir = fakeDuti();
  const run = () => { throw new Error('boom'); };
  assert.deepEqual(getPdfHandler({ run, env: { PATH: dir } }), { duti: true, handler: null });
});

test('setPdfHandler: duti -s <id> com.adobe.pdf all 을 부른다', () => {
  const dir = fakeDuti();
  const calls = [];
  const run = (bin, args) => {
    calls.push(args);
    return args[0] === '-x' ? 'w\n/x\ncom.wooix.wcompare\n' : '';
  };
  const res = setPdfHandler('com.wooix.wcompare', { run, env: { PATH: dir } });
  assert.deepEqual(res, { ok: true, handler: 'com.wooix.wcompare' });
  assert.deepEqual(calls[0], ['-s', 'com.wooix.wcompare', 'com.adobe.pdf', 'all']);
});

test('setPdfHandler: duti가 없으면 사유를 밝혀 거절한다', () => {
  // 사유마다 사용자가 할 일이 다르다 — 설치 안내인지, 수동 지정 안내인지.
  assert.deepEqual(setPdfHandler('com.wooix.wcompare', { run: () => '', env: { PATH: '/nope-xyz' } }),
    { ok: false, reason: 'no-duti' });
});

test('setPdfHandler: 불량 번들 ID는 실행 전에 막는다', () => {
  // duti 인자로 나가는 값이라 형식 검사를 통과한 것만 넘긴다.
  const dir = fakeDuti();
  let called = false;
  const run = () => { called = true; return ''; };
  for (const bad of ['', '-s', 'a b', 'x;rm -rf /', null, undefined]) {
    assert.deepEqual(setPdfHandler(bad, { run, env: { PATH: dir } }), { ok: false, reason: 'bad-id' });
  }
  assert.equal(called, false, 'duti를 부르지 않아야 한다');
});

test('setPdfHandler: duti 실패는 사유와 메시지를 함께 돌려준다', () => {
  const dir = fakeDuti();
  const run = () => { throw new Error('failed to set handler'); };
  const res = setPdfHandler('com.wooix.wcompare', { run, env: { PATH: dir } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'failed');
  assert.match(res.message, /failed to set handler/);
});
