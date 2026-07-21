// test/shortcuts.test.js — 단축키 표현/매칭 순수 모듈 단위 테스트.
const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeEvent, hasModifier, format, isReserved, RESERVED, ACTIONS } = require('../src/renderer/shortcuts.js');

// 모의 KeyboardEvent — 필요한 필드만 채운다.
const ev = (over) => ({ code: '', key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

test('normalizeEvent: Cmd+D / Alt+F / Alt+ArrowRight를 표현으로 만든다', () => {
  assert.equal(normalizeEvent(ev({ code: 'KeyD', metaKey: true })), 'Cmd+D');
  assert.equal(normalizeEvent(ev({ code: 'KeyF', altKey: true })), 'Alt+F');
  assert.equal(normalizeEvent(ev({ code: 'ArrowRight', altKey: true })), 'Alt+ArrowRight');
});

test('normalizeEvent: modifier 순서를 Cmd, Ctrl, Alt, Shift로 고정한다', () => {
  const s = normalizeEvent(ev({ code: 'KeyF', shiftKey: true, altKey: true, ctrlKey: true, metaKey: true }));
  assert.equal(s, 'Cmd+Ctrl+Alt+Shift+F');
  // 입력 순서와 무관하게 항상 같은 표현
  assert.equal(normalizeEvent(ev({ code: 'KeyF', metaKey: true, shiftKey: true })), 'Cmd+Shift+F');
});

test('normalizeEvent: main key는 e.code에서 유도한다(Digit/Comma 등)', () => {
  assert.equal(normalizeEvent(ev({ code: 'Digit1', metaKey: true })), 'Cmd+1');
  assert.equal(normalizeEvent(ev({ code: 'Comma', metaKey: true })), 'Cmd+Comma');
});

test('normalizeEvent: modifier 단독키(Meta/Alt/Shift/Control)만 눌리면 null', () => {
  assert.equal(normalizeEvent(ev({ code: 'MetaLeft', metaKey: true })), null);
  assert.equal(normalizeEvent(ev({ code: 'AltRight', altKey: true })), null);
  assert.equal(normalizeEvent(ev({ code: 'ShiftLeft', shiftKey: true })), null);
  assert.equal(normalizeEvent(ev({ code: 'ControlLeft', ctrlKey: true })), null);
});

test('normalizeEvent: code가 없으면 null', () => {
  assert.equal(normalizeEvent(ev({ code: '', metaKey: true })), null);
  assert.equal(normalizeEvent(null), null);
});

test('민감도: main key는 e.key가 아니라 e.code에서 나온다 — ⌥F의 특수문자를 무시한다', () => {
  // macOS에서 ⌥+F는 e.key가 "ƒ"로 온다. e.key를 쓰면 "Alt+ƒ"가 되어버린다.
  // 아래는 e.key에 특수문자를 넣어도 code(KeyF) 기반이라 "Alt+F"가 나오는지 확인한다.
  assert.equal(normalizeEvent(ev({ code: 'KeyF', key: 'ƒ', altKey: true })), 'Alt+F');
});

test('hasModifier: modifier 없는 단일 키는 거부, modifier가 있으면 통과', () => {
  assert.equal(hasModifier('D'), false);
  assert.equal(hasModifier('ArrowRight'), false);
  assert.equal(hasModifier('Cmd+D'), true);
  assert.equal(hasModifier('Alt+ArrowRight'), true);
  // normalizeEvent가 modifier 없이 낸 단일 키 표현도 거부된다
  assert.equal(hasModifier(normalizeEvent(ev({ code: 'KeyD' }))), false);
});

test('format: 표시용 기호로 치환한다', () => {
  assert.equal(format('Cmd+D'), '⌘D');
  assert.equal(format('Alt+F'), '⌥F');
  assert.equal(format('Alt+ArrowRight'), '⌥→');
  assert.equal(format('Cmd+Shift+H'), '⌘⇧H');
  assert.equal(format('Cmd+Comma'), '⌘,');
  assert.equal(format('Cmd+ArrowLeft'), '⌘←');
  assert.equal(format(''), '');
});

test('isReserved: 예약된 표현이면 라벨, 아니면 null', () => {
  assert.equal(isReserved('Cmd+S'), '저장');
  assert.equal(isReserved('Cmd+F'), '찾기');
  assert.equal(isReserved('Cmd+ArrowRight'), '앞으로');
  assert.equal(isReserved('Cmd+Comma'), '설정');
  assert.equal(isReserved('Alt+F'), null); // 기본 fit 단축키는 예약이 아니다
  assert.equal(isReserved('Cmd+D'), null); // 기본 dict 단축키도 예약이 아니다
  assert.equal(isReserved(''), null);
});

test('RESERVED와 ACTIONS의 형태', () => {
  assert.equal(typeof RESERVED, 'object');
  assert.ok(RESERVED['Cmd+N'] === '새 창');
  assert.deepEqual(ACTIONS.map((a) => a.id), ['dict', 'fit', 'sync', 'night', 'switch']);
  for (const a of ACTIONS) assert.equal(typeof a.label, 'string');
});
