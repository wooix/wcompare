// test/dictPopup.test.js — 영→한 게이트(isEnglishQuery) 순수 판정 단위 테스트.
// createDictPopup은 DOM을 쓰지만 함수 내부에서만 참조하므로 이 require는 안전하다.
const { test } = require('node:test');
const assert = require('node:assert');
const { isEnglishQuery } = require('../src/renderer/dictPopup.js');

test('영어(라틴 2자 이상, 한글 없음)만 통과', () => {
  assert.equal(isEnglishQuery('apple'), true);
  assert.equal(isEnglishQuery('a whole sentence'), true);
  assert.equal(isEnglishQuery('It is 42 today'), true, '숫자가 섞여도 라틴 2자 이상이면 통과');
});

test('한글이 섞이면 무시한다(영→한 대상 아님)', () => {
  assert.equal(isEnglishQuery('안녕'), false);
  assert.equal(isEnglishQuery('안녕 hello'), false, '한글이 하나라도 있으면 무시');
  assert.equal(isEnglishQuery('사과 apple'), false);
});

test('라틴 문자가 부족하면 무시한다', () => {
  assert.equal(isEnglishQuery(''), false);
  assert.equal(isEnglishQuery('   '), false);
  assert.equal(isEnglishQuery('a'), false, '라틴 1자는 부족');
  assert.equal(isEnglishQuery('123 !!!'), false, '숫자·기호만');
  assert.equal(isEnglishQuery(null), false);
});
