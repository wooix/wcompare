// test/shortcutDict.test.js — triggerShortcutDict: 가짜 run 주입으로 osascript 호출/에러 분기 검증.
const { test } = require('node:test');
const assert = require('node:assert');

const { triggerShortcutDict } = require('../src/main/shortcutDict.js');

test('성공 시 {ok:true}', async () => {
  const res = await triggerShortcutDict({ run: () => Promise.resolve({ stdout: '', stderr: '' }) });
  assert.deepEqual(res, { ok: true });
});

test('stderr에 -1719가 있으면 code "no-accessibility"', async () => {
  const run = () => {
    const e = new Error('osascript 실패');
    e.stderr = 'execution error: System Events가 오류를 일으켰습니다. (-1719)';
    return Promise.reject(e);
  };
  const res = await triggerShortcutDict({ run });
  assert.deepEqual(res, { ok: false, code: 'no-accessibility' });
});

test('"not allowed"/"assistive" 메시지도 no-accessibility로 매핑된다', async () => {
  const notAllowed = await triggerShortcutDict({
    run: () => Promise.reject(Object.assign(new Error('x'), { stderr: 'osascript is not allowed to send keystrokes' })),
  });
  assert.equal(notAllowed.code, 'no-accessibility');
  const assistive = await triggerShortcutDict({
    run: () => Promise.reject(Object.assign(new Error('x'), { stderr: 'assistive access required' })),
  });
  assert.equal(assistive.code, 'no-accessibility');
});

test('그 외 오류는 code "error" + message', async () => {
  const run = () => Promise.reject(Object.assign(new Error('boom'), { stderr: 'some other failure' }));
  const res = await triggerShortcutDict({ run });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'error');
  assert.match(res.message, /some other failure/);
});

test('run에 전달되는 인자가 osascript이고 스크립트에 key code 2 / control+shift가 담긴다', async () => {
  let seen = null;
  const run = (command, args) => { seen = { command, args }; return Promise.resolve({ stdout: '', stderr: '' }); };
  await triggerShortcutDict({ run });
  assert.equal(seen.command, 'osascript');
  const script = seen.args.join(' ');
  assert.match(script, /key code 2/, '스크립트에 key code 2가 포함');
  assert.match(script, /control down, shift down/, 'Control+Shift 조합이 포함');
  assert.match(script, /System Events/, 'System Events로 합성');
});
