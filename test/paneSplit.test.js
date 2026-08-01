// test/paneSplit.test.js — 요약 폭 스플리터의 순수 로직(clampWidth).
// DOM이 필요한 드래그 동작은 e2e(pdf-summary.spec.js)가 맡고, 여기서는 "어느 쪽도 0px가 되지
// 않는다"는 불변식만 집중해서 지킨다 — 뷰어가 0이면 pdf.js page-width가 0으로 나눈 값을 받고,
// 요약이 0이면 mermaid가 빈 그림을 그린다(둘 다 이 코드베이스가 실제로 겪은 실패다).
const { test } = require('node:test');
const assert = require('node:assert');

const {
  clampWidth, MIN_SUMMARY, MIN_REST, DEFAULT_WIDTH,
} = require('../src/renderer/paneSplit.js');

test('clampWidth: 정상 범위의 값은 그대로 통과한다', () => {
  assert.equal(clampWidth(DEFAULT_WIDTH, 1400), DEFAULT_WIDTH);
  assert.equal(clampWidth(500, 1400), 500);
});

test('clampWidth: 최소치보다 좁게 끌면 최소치에서 멈춘다', () => {
  assert.equal(clampWidth(10, 1400), MIN_SUMMARY);
  assert.equal(clampWidth(0, 1400), MIN_SUMMARY);
  assert.equal(clampWidth(-999, 1400), MIN_SUMMARY);
});

test('clampWidth: 뷰어 쪽 최소 폭(MIN_REST)을 반드시 남긴다', () => {
  // 요약을 창 끝까지 끌어도 뷰어가 사라지면 안 된다.
  for (const total of [800, 1400, 2560]) {
    const w = clampWidth(99999, total);
    assert.equal(w, total - MIN_REST);
    assert.ok(total - w >= MIN_REST, `뷰어에 ${MIN_REST}px가 남아야 한다 (total=${total})`);
  }
});

test('clampWidth: 두 최소치를 함께 지킬 수 없는 좁은 창에서는 요약이 양보한다', () => {
  // 뷰어가 원문이고 요약은 곁다리라, 하나가 찌그러져야 한다면 원문을 지킨다.
  const w = clampWidth(400, 500);
  assert.ok(w < MIN_SUMMARY, '요약이 최소치보다 좁아진다');
  assert.equal(500 - w, MIN_REST, '뷰어 몫은 그대로 지켜진다');
});

test('clampWidth: 극단적으로 좁은 창에서도 요약이 0이나 1px가 되지 않는다', () => {
  // 회귀 감시: 처음에는 하한을 1px로 두었는데 300px 창에서 요약이 1px가 됐다.
  // "0px 금지"를 형식적으로만 지킨 값이라, mermaid는 그 폭에서도 빈 그림을 그린다.
  for (const total of [200, 300, 400]) {
    const w = clampWidth(400, total);
    assert.ok(w >= 80, `요약이 쓸 수 있는 폭으로 남아야 한다: total=${total} → ${w}`);
    assert.ok(total - w > 0, `뷰어도 0이 되면 안 된다: total=${total} → 남은 ${total - w}`);
  }
});

test('clampWidth: 못 쓸 값이 들어오면 기본값으로 물러난다', () => {
  // localStorage는 사람이 손댈 수 있고 옛 버전이 남긴 값일 수도 있다.
  for (const bad of ['abc', NaN, null, undefined, {}, []]) {
    assert.equal(clampWidth(bad, 1400), DEFAULT_WIDTH);
  }
});

test('clampWidth: 레이아웃 전(total=0)에도 터지지 않고 최소치를 지킨다', () => {
  assert.equal(clampWidth(10, 0), MIN_SUMMARY);
  assert.equal(clampWidth(DEFAULT_WIDTH, 0), DEFAULT_WIDTH);
});
