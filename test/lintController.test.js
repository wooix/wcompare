const { test } = require('node:test');
const assert = require('node:assert');
const { makeScheduler } = require('../src/renderer/lintController.js');

test('stale 결과 폐기: 캡처 버전과 현재 버전이 다르면 적용 안 함', async () => {
  let applied = null;
  let version = 1;
  const sched = makeScheduler({
    getVersion: () => version,
    runLint: async () => [{ id: 'x' }],
    apply: (markers) => { applied = markers; },
    debounceMs: 0,
  });
  const p = sched.request();
  version = 2; // runLint 동안 버전 변경 → 폐기되어야 함
  await p;
  assert.equal(applied, null);
});

test('fresh 결과는 적용', async () => {
  let applied = null;
  const sched = makeScheduler({
    getVersion: () => 5,
    runLint: async () => [{ id: 'ok' }],
    apply: (m) => { applied = m; },
    debounceMs: 0,
  });
  await sched.request();
  assert.deepEqual(applied, [{ id: 'ok' }]);
});

test('cancel은 떠 있는 디바운스를 취소', async () => {
  let calls = 0;
  const sched = makeScheduler({ getVersion: () => 1, runLint: async () => { calls++; return []; },
    apply: () => {}, debounceMs: 50 });
  sched.schedule();
  sched.cancel();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 0);
});
