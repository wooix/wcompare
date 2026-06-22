const { test } = require('node:test');
const assert = require('node:assert');
const { syncTargetTop } = require('../src/renderer/syncScroll.js');

test('비율 동일: 절반 스크롤이면 대상도 절반', () => {
  const from = { scrollTop: 250, scrollHeight: 1000, clientHeight: 500 }; // range 500, ratio .5
  const to = { scrollTop: 0, scrollHeight: 2000, clientHeight: 800 };     // range 1200
  assert.equal(syncTargetTop(from, to), 600); // .5 * 1200
});

test('상단/하단 경계', () => {
  assert.equal(syncTargetTop({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 800, clientHeight: 300 }), 0);
  assert.equal(syncTargetTop({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 800, clientHeight: 300 }), 500);
});

test('범위 0 가드: 내용이 뷰포트보다 작으면 0', () => {
  assert.equal(syncTargetTop({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }), 0);
  assert.equal(syncTargetTop({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 300, clientHeight: 500 }), 0);
});

test('클램프: 비율>1 입력도 대상 범위로 제한', () => {
  assert.equal(syncTargetTop({ scrollTop: 9999, scrollHeight: 1000, clientHeight: 400 }, { scrollTop: 0, scrollHeight: 900, clientHeight: 400 }), 500);
});
