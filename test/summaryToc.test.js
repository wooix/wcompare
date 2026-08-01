// test/summaryToc.test.js — DOM 없이 검증 가능한 순수 로직만 시험한다(clampDepth, filterByDepth).
// createSummaryToc는 document를 필요로 하므로 e2e(통합 담당)가 다룬다.
const { test } = require('node:test');
const assert = require('node:assert');
const { filterByDepth, clampDepth, parseCollapsed } = require('../src/renderer/summaryToc.js');

test('clampDepth: 1~6 정수는 그대로 통과한다', () => {
  for (let n = 1; n <= 6; n++) assert.equal(clampDepth(n), n);
});

test('clampDepth: 범위 밖 숫자는 기본값(2)으로 되돌아간다', () => {
  assert.equal(clampDepth(0), 2);
  assert.equal(clampDepth(7), 2);
  assert.equal(clampDepth(-1), 2);
  assert.equal(clampDepth(100), 2);
});

test('clampDepth: 정수가 아닌 값(소수/비숫자/빈값)은 기본값으로 되돌아간다', () => {
  assert.equal(clampDepth(2.5), 2);
  assert.equal(clampDepth('abc'), 2);
  assert.equal(clampDepth(''), 2);
  assert.equal(clampDepth(null), 2);
  assert.equal(clampDepth(undefined), 2);
  assert.equal(clampDepth('  '), 2);
  assert.equal(clampDepth(NaN), 2);
});

test('clampDepth: localStorage가 돌려주는 형태인 숫자 문자열도 처리한다', () => {
  // localStorage.getItem은 항상 문자열(또는 null)을 돌려준다 — 숫자 그대로 오지 않는다.
  assert.equal(clampDepth('1'), 1);
  assert.equal(clampDepth('6'), 6);
  assert.equal(clampDepth('3'), 3);
  assert.equal(clampDepth('9'), 2); // 범위 밖 문자열
});

test('filterByDepth: depth 이하 레벨만 남기고, ord는 원본 배열의 인덱스를 그대로 붙인다', () => {
  const heads = [
    { level: 1, title: 'A', line: 1 },  // ord 0
    { level: 2, title: 'B', line: 3 },  // ord 1
    { level: 3, title: 'C', line: 5 },  // ord 2
    { level: 2, title: 'D', line: 7 },  // ord 3
  ];
  assert.deepEqual(filterByDepth(heads, 2), [
    { level: 1, title: 'A', line: 1, ord: 0 },
    { level: 2, title: 'B', line: 3, ord: 1 },
    { level: 2, title: 'D', line: 7, ord: 3 },
  ]);
});

test('filterByDepth: depth를 낮춰도 남은 항목의 ord는 바뀌지 않는다(DOM 인덱스와 계속 맞아야 함)', () => {
  const heads = [
    { level: 1, title: 'A', line: 1 },  // ord 0
    { level: 2, title: 'B', line: 3 },  // ord 1
    { level: 3, title: 'C', line: 5 },  // ord 2
  ];
  // depth=1이면 A만 남지만 A의 ord는 여전히 0이다(원본 헤딩 중 몇 번째인지는 depth와 무관).
  assert.deepEqual(filterByDepth(heads, 1), [
    { level: 1, title: 'A', line: 1, ord: 0 },
  ]);
  // depth=3이면 셋 다 남고, ord는 각각 0/1/2 그대로다.
  assert.deepEqual(filterByDepth(heads, 3), [
    { level: 1, title: 'A', line: 1, ord: 0 },
    { level: 2, title: 'B', line: 3, ord: 1 },
    { level: 3, title: 'C', line: 5, ord: 2 },
  ]);
});

test('filterByDepth: 같은 제목이 두 번 나와도 ord로 구분된다(제목 매칭의 한계를 피하는 지점)', () => {
  const heads = [
    { level: 2, title: '실험 결과', line: 10 },  // ord 0
    { level: 2, title: '실험 결과', line: 40 },  // ord 1
  ];
  const out = filterByDepth(heads, 2);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].ord, out[1].ord);
  assert.equal(out[0].ord, 0);
  assert.equal(out[1].ord, 1);
});

test('filterByDepth: 빈 배열/헤딩 없는 목록 → 빈 배열', () => {
  assert.deepEqual(filterByDepth([], 2), []);
});

test('filterByDepth: 잘못된 depth 인자도 clampDepth를 거쳐 안전하게 처리된다', () => {
  const heads = [
    { level: 1, title: 'A', line: 1 },
    { level: 2, title: 'B', line: 2 },
  ];
  // depth=99 → clampDepth가 기본값 2로 되돌리므로 결과는 depth=2와 같다.
  assert.deepEqual(filterByDepth(heads, 99), filterByDepth(heads, 2));
});

// 회귀: 요약 프롬프트가 절 제목을 '## 제목'으로 못박아 실데이터는 사실상 h2뿐이다.
// depth=1이면 목차가 텅 비는데 그 값이 localStorage에 영구 저장되므로, 빠져나올 수 있어야 한다.
test('filterByDepth: h2만 있는 실데이터에서 depth 1은 비고 2 이상은 전부 보인다', () => {
  const heads = [
    { level: 2, title: '1. 서론', line: 1 },
    { level: 2, title: '2. 제안 방법', line: 5 },
  ];
  assert.equal(filterByDepth(heads, 1).length, 0);
  for (const d of [2, 3, 4, 5, 6]) assert.equal(filterByDepth(heads, d).length, 2);
});

test('filterByDepth: ord는 거르기 전 배열의 인덱스라 depth를 바꿔도 DOM과 어긋나지 않는다', () => {
  const heads = [
    { level: 1, title: 'A', line: 1 },
    { level: 2, title: 'B', line: 3 },
    { level: 3, title: 'C', line: 5 },
    { level: 2, title: 'D', line: 7 },
  ];
  // depth 2로 걸러도 D의 ord는 원문 순번 3이어야 한다(렌더된 h1~h6의 4번째).
  assert.deepEqual(filterByDepth(heads, 2).map((h) => h.ord), [0, 1, 3]);
  assert.deepEqual(filterByDepth(heads, 6).map((h) => h.ord), [0, 1, 2, 3]);
});

// ===== 번호 보존 =====
// 예전에는 여기서 제목 앞 번호를 뗐다. 그 번호가 옛 outlineDigest의 '평탄화 순번'이라 계층과
// 어긋났기 때문이다(5의 하위 절이 6이 됨). 이제 outlineDigest가 '2.1' 같은 올바른 계층 번호를
// 직접 매기므로, 목차는 그 번호를 **그대로 보여야** 한다 — 논문의 절 번호와 같아야 하기 때문이다.
test('filterByDepth: 제목의 계층 번호를 떼지 않고 그대로 넘긴다', () => {
  const heads = [
    { level: 2, title: '1. Introduction (p.1)', line: 1 },
    { level: 3, title: '5.1. Your Language Model Is Secretly a Reward Model (p.5)', line: 5 },
  ];
  assert.deepEqual(filterByDepth(heads, 3).map((h) => h.title),
    ['1. Introduction (p.1)', '5.1. Your Language Model Is Secretly a Reward Model (p.5)']);
});

// ===== 접힘 상태 =====
// 저장값 해석은 "잘못 해석해도 안전한 쪽"으로 기운다 — 접힌 채 잘못 열리면 손해가 없지만,
// 펴야 하는데 접힌 채 굳으면 사용자가 목차 자체를 못 찾는다. 그래서 정확히 '1'만 접힘으로 본다.
test('parseCollapsed: 정확히 "1"일 때만 접힘, 나머지는 전부 펼침', () => {
  assert.equal(parseCollapsed('1'), true);
  for (const v of ['0', '', 'true', 'yes', null, undefined, '01', ' 1']) {
    assert.equal(parseCollapsed(v), false, `펼침이어야 한다: ${JSON.stringify(v)}`);
  }
});
