// test/buildDict.test.js — build-dict.mjs 순수 변환 함수 단위 테스트.
// build-dict.mjs 는 ESM이지만 main() 이 엔트리 가드로 보호되어 require(import) 시 실행되지 않는다.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  hasHangul,
  stripParens,
  normalizeGloss,
  isValidKey,
  glossToKeys,
  kaikkiToEntries,
  parseMuse,
  mergeEntries,
  buildOutput,
} = require('../scripts/build-dict.mjs');

// ── gloss 정규화 ────────────────────────────────────────────────────────────

test('normalizeGloss: 괄호 구간 제거', () => {
  assert.equal(normalizeGloss('bank (financial institution)'), 'bank');
  assert.equal(normalizeGloss('apple (a fruit) tree'), 'apple tree');
  // 중첩 괄호까지 제거
  assert.equal(normalizeGloss('foo (bar (baz)) qux'), 'foo qux');
});

test('normalizeGloss: 선행 to/a/an/the 1회 제거(대소문자 무관)', () => {
  assert.equal(normalizeGloss('to run'), 'run');
  assert.equal(normalizeGloss('To Run'), 'run');
  assert.equal(normalizeGloss('a cat'), 'cat');
  assert.equal(normalizeGloss('an apple'), 'apple');
  assert.equal(normalizeGloss('the dog'), 'dog');
});

test('normalizeGloss: 끝 마침표 제거 + 공백 정규화', () => {
  assert.equal(normalizeGloss('run.'), 'run');
  assert.equal(normalizeGloss('  ice   cream  '), 'ice cream');
});

test('isValidKey/glossToKeys: 4단어 이상 기각', () => {
  assert.equal(isValidKey('one two three'), true);
  assert.equal(isValidKey('one two three four'), false);
  assert.deepEqual(glossToKeys('one two three four'), []);
});

test('isValidKey/glossToKeys: 비ASCII 기각', () => {
  assert.equal(isValidKey('사과'), false);
  assert.equal(isValidKey('café'), false); // 악센트 문자
  assert.equal(isValidKey('a1'), false); // 숫자
  // 혼합 gloss에서 유효한 후보만 남는다
  assert.deepEqual(glossToKeys('사과; apple'), ['apple']);
});

test('glossToKeys: ";"·"," 분리 + 정규화', () => {
  assert.deepEqual(glossToKeys('apple; the fruit, red thing'), ['apple', 'fruit', 'red thing']);
});

// ── kaikki 추출 ─────────────────────────────────────────────────────────────

test('kaikkiToEntries: 마지막 gloss만 사용, pos 부착', () => {
  const obj = { word: '사과', pos: 'noun', senses: [{ glosses: ['a type of fruit', 'apple'] }] };
  assert.deepEqual(kaikkiToEntries(obj), [{ key: 'apple', ko: '사과', pos: 'noun' }]);
});

test('kaikkiToEntries: word에 한글 없거나 senses 없으면 skip', () => {
  assert.deepEqual(kaikkiToEntries({ word: 'apple', pos: 'noun', senses: [{ glosses: ['apple'] }] }), []);
  assert.deepEqual(kaikkiToEntries({ word: '사과', pos: 'noun' }), []);
  assert.deepEqual(kaikkiToEntries({ word: '사과', pos: 'noun', senses: [] }), []);
});

// ── 병합 규칙 ───────────────────────────────────────────────────────────────

test('mergeEntries: MUSE가 kaikki보다 앞', () => {
  const muse = parseMuse('apple 사과\n');
  const kaikki = [{ key: 'apple', ko: '능금', pos: 'noun' }];
  const e = mergeEntries(muse, kaikki);
  assert.deepEqual(e.apple, [['사과', null], ['능금', 'noun']]);
});

test('mergeEntries: ko 중복 제거(MUSE분 유지)', () => {
  const muse = [{ key: 'apple', ko: '사과', pos: null }];
  const kaikki = [{ key: 'apple', ko: '사과', pos: 'noun' }];
  const e = mergeEntries(muse, kaikki);
  assert.deepEqual(e.apple, [['사과', null]]);
});

test('mergeEntries: pos "name" 항목은 뒤로', () => {
  const kaikki = [
    { key: 'k', ko: '이름', pos: 'name' },
    { key: 'k', ko: '보통', pos: 'noun' },
    { key: 'k', ko: '이름2', pos: 'name' },
  ];
  const e = mergeEntries([], kaikki);
  assert.deepEqual(e.k, [['보통', 'noun'], ['이름', 'name'], ['이름2', 'name']]);
});

test('mergeEntries: 키당 8개 제한', () => {
  const kaikki = [];
  for (let i = 0; i < 12; i++) kaikki.push({ key: 'k', ko: 'ko' + i, pos: 'noun' });
  const e = mergeEntries([], kaikki);
  assert.equal(e.k.length, 8);
  assert.deepEqual(e.k[0], ['ko0', 'noun']);
  assert.deepEqual(e.k[7], ['ko7', 'noun']);
});

test('buildOutput: 키 사전순 정렬 + version', () => {
  const out = buildOutput({ zebra: [['얼룩말', null]], apple: [['사과', null]] });
  assert.equal(out.version, 1);
  assert.deepEqual(Object.keys(out.entries), ['apple', 'zebra']);
});

// 유틸 회귀
test('hasHangul/stripParens 기본 동작', () => {
  assert.equal(hasHangul('사과 apple'), true);
  assert.equal(hasHangul('apple'), false);
  assert.equal(stripParens('a (b) c').replace(/\s+/g, ' ').trim(), 'a c');
});
