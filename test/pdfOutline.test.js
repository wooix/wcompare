// test/pdfOutline.test.js — flattenOutline/sectionRanges/sectionsDigest/outlineDigest 순수 함수 테스트.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  flattenOutline, sectionRanges, sectionsDigest, outlineDigest,
} = require('../src/renderer/pdfOutline.js');

// ---------------------------------------------------------------------------
// flattenOutline
// ---------------------------------------------------------------------------

test('flattenOutline: 중첩 트리가 문서 순서대로 펴진다', () => {
  const tree = [
    { title: 'Intro', dest: 'd1', items: [] },
    { title: 'Method', dest: 'd2', items: [
      { title: 'Method A', dest: 'd2a', items: [] },
      { title: 'Method B', dest: 'd2b', items: [] },
    ] },
    { title: 'Conclusion', dest: 'd3', items: [] },
  ];
  assert.deepEqual(flattenOutline(tree), [
    { title: 'Intro', depth: 1, dest: 'd1' },
    { title: 'Method', depth: 1, dest: 'd2' },
    { title: 'Method A', depth: 2, dest: 'd2a' },
    { title: 'Method B', depth: 2, dest: 'd2b' },
    { title: 'Conclusion', depth: 1, dest: 'd3' },
  ]);
});

test('flattenOutline: maxDepth 초과 항목(및 그 자손)은 잘라낸다', () => {
  const tree = [
    { title: 'A', items: [
      { title: 'A.1', items: [
        { title: 'A.1.1', items: [
          { title: 'A.1.1.1', items: [] }, // depth4 — depth3가 잘리므로 애초에 안 훑는다
        ] },
      ] },
    ] },
  ];
  assert.deepEqual(flattenOutline(tree, { maxDepth: 2 }), [
    { title: 'A', depth: 1, dest: undefined },
    { title: 'A.1', depth: 2, dest: undefined },
  ]);
});

test('flattenOutline: 제목 없는(공백뿐 포함) 항목은 버리되 그 자식은 원래 깊이로 순회한다', () => {
  const tree = [
    { title: 'Root', items: [
      { title: '   ', items: [
        { title: 'Child-of-blank', items: [] },
      ] },
      { title: 'Sibling', items: [] },
    ] },
  ];
  assert.deepEqual(flattenOutline(tree, { maxDepth: 3 }), [
    { title: 'Root', depth: 1, dest: undefined },
    { title: 'Child-of-blank', depth: 3, dest: undefined },
    { title: 'Sibling', depth: 2, dest: undefined },
  ]);
});

test('flattenOutline: maxItems를 넘으면 문서 순서상 앞쪽만 남기고 잘라낸다', () => {
  const tree = [1, 2, 3, 4, 5].map((n) => ({ title: String(n), items: [] }));
  assert.deepEqual(flattenOutline(tree, { maxItems: 3 }), [
    { title: '1', depth: 1, dest: undefined },
    { title: '2', depth: 1, dest: undefined },
    { title: '3', depth: 1, dest: undefined },
  ]);
});

test('flattenOutline: null/undefined/빈 입력은 안전하게 빈 배열', () => {
  assert.deepEqual(flattenOutline(null), []);
  assert.deepEqual(flattenOutline(undefined), []);
  assert.deepEqual(flattenOutline([]), []);
  // items 필드가 아예 없는 노드도 죽지 않는다
  assert.deepEqual(flattenOutline([{ title: 'X' }]), [{ title: 'X', depth: 1, dest: undefined }]);
});

// ---------------------------------------------------------------------------
// sectionRanges
// ---------------------------------------------------------------------------

test('sectionRanges: 연속 절의 endPage가 다음 startPage로 이어지고 마지막은 pageCount', () => {
  const flat = [
    { title: 'A', depth: 1, startPage: 1 },
    { title: 'B', depth: 1, startPage: 4 },
    { title: 'C', depth: 1, startPage: 9 },
  ];
  assert.deepEqual(sectionRanges(flat, 12), [
    { title: 'A', depth: 1, startPage: 1, endPage: 4 },
    { title: 'B', depth: 1, startPage: 4, endPage: 9 },
    { title: 'C', depth: 1, startPage: 9, endPage: 12 },
  ]);
});

test('sectionRanges: startPage=null은 바로 다음의 유효한 값을 물려받고, 끝까지 없으면 버린다', () => {
  const flat = [
    { title: 'Group', depth: 1, startPage: null }, // Sec1의 시작 페이지(2)를 물려받는다
    { title: 'Sec1', depth: 2, startPage: 2 },
    { title: 'Sec2', depth: 2, startPage: 5 },
    { title: 'TrailingBroken', depth: 1, startPage: null }, // 뒤에 유효한 값이 전혀 없어 버려진다
  ];
  assert.deepEqual(sectionRanges(flat, 10), [
    { title: 'Group', depth: 1, startPage: 2, endPage: 2 },
    { title: 'Sec1', depth: 2, startPage: 2, endPage: 5 },
    { title: 'Sec2', depth: 2, startPage: 5, endPage: 10 },
  ]);
});

test('sectionRanges: 역행하는(앞 절보다 작은) 깨진 목차는 앞 절 시작 페이지로 끌어올린다', () => {
  const flat = [
    { title: 'A', depth: 1, startPage: 5 },
    { title: 'B', depth: 1, startPage: 3 }, // 역행 → 5로 클램프
    { title: 'C', depth: 1, startPage: 8 },
  ];
  assert.deepEqual(sectionRanges(flat, 10), [
    { title: 'A', depth: 1, startPage: 5, endPage: 5 },
    { title: 'B', depth: 1, startPage: 5, endPage: 8 },
    { title: 'C', depth: 1, startPage: 8, endPage: 10 },
  ]);
});

test('sectionRanges: 항목 1개면 endPage가 바로 pageCount', () => {
  const flat = [{ title: 'Solo', depth: 1, startPage: 3 }];
  assert.deepEqual(sectionRanges(flat, 7), [
    { title: 'Solo', depth: 1, startPage: 3, endPage: 7 },
  ]);
});

test('sectionRanges: 빈 배열/null 입력은 안전하게 빈 배열', () => {
  assert.deepEqual(sectionRanges([], 10), []);
  assert.deepEqual(sectionRanges(null, 10), []);
});

// ---------------------------------------------------------------------------
// sectionsDigest
// ---------------------------------------------------------------------------

test('sectionsDigest: 절의 페이지 범위 텍스트가 올바르게 이어붙는다', () => {
  const ranges = [
    { title: 'Intro', depth: 1, startPage: 1, endPage: 3 },
    { title: 'Method', depth: 1, startPage: 3, endPage: 5 },
  ];
  const pageTexts = ['P1', 'P2', 'P3', 'P4'];
  assert.equal(
    sectionsDigest(ranges, pageTexts),
    '## 1. Intro (p.1-2)\nP1\nP2\n\n## 2. Method (p.3-4)\nP3\nP4',
  );
});

test('sectionsDigest: 절당 상한(maxCharsPerSection)을 넘으면 잘라내고 표시한다', () => {
  const ranges = [{ title: 'Big', depth: 1, startPage: 1, endPage: 2 }];
  const pageTexts = ['x'.repeat(100)];
  const result = sectionsDigest(ranges, pageTexts, { maxCharsPerSection: 10 });
  assert.equal(result, `## 1. Big (p.1)\n${'x'.repeat(10)}\n…(절 길이 제한으로 이하 생략)`);
});

test('sectionsDigest: 전체 상한(maxTotalChars)을 넘으면 전체를 잘라내고 표시한다', () => {
  const ranges = [
    { title: 'S1', depth: 1, startPage: 1, endPage: 2 },
    { title: 'S2', depth: 1, startPage: 2, endPage: 3 },
  ];
  const pageTexts = ['a'.repeat(50), 'b'.repeat(50)];
  const joined = `## 1. S1 (p.1)\n${'a'.repeat(50)}\n\n## 2. S2 (p.2)\n${'b'.repeat(50)}`;
  const result = sectionsDigest(ranges, pageTexts, { maxCharsPerSection: 1000, maxTotalChars: 20 });
  assert.equal(result, `${joined.slice(0, 20)}\n…(전체 길이 제한으로 이후 생략)`);
});

test('sectionsDigest: 페이지 범위가 pageTexts 밖이면 제목 줄만 남는다', () => {
  const ranges = [{ title: 'OOB', depth: 1, startPage: 5, endPage: 8 }];
  const pageTexts = ['only1', 'only2'];
  assert.equal(sectionsDigest(ranges, pageTexts), '## 1. OOB (p.5-7)');
});

// 회귀(L12): endPage가 비정상적으로 커도 순회는 pageTexts 길이에서 멈춰야 한다.
// 고치기 전에는 endPage=1e9에서 1.7초, MAX_SAFE_INTEGER에서는 사실상 영영 돌아오지 않아 렌더러가 멎었다.
// 시간 자체가 검사 대상이라 "짧은 상한 안에 끝났는가"를 함께 확인한다(느린 CI를 감안해 넉넉히 1초).
test('sectionsDigest: endPage가 비정상적으로 커도 즉시 끝난다(페이지 순회 상한)', () => {
  const started = Date.now();
  assert.equal(
    sectionsDigest([{ title: 'x', startPage: 1, endPage: 1000000000 }], ['a', 'b']),
    '## 1. x (p.1-999999999)\na\nb',
  );
  assert.equal(
    sectionsDigest([{ title: 'x', startPage: 1, endPage: Number.MAX_SAFE_INTEGER }], ['a', 'b']),
    `## 1. x (p.1-${Number.MAX_SAFE_INTEGER - 1})\na\nb`,
  );
  assert.ok(Date.now() - started < 1000, '페이지 순회가 pageTexts 길이로 묶이지 않았다');
});

// 회귀(L12): 반대쪽 경계도 같은 이유로 묶여 있어야 한다 — startPage가 크게 음수면 배열 앞쪽 밖을
// 수억 번 헛돌게 된다. 배열 밖 페이지는 어차피 버려지므로 결과는 그대로여야 한다.
test('sectionsDigest: startPage가 크게 음수여도 즉시 끝난다(배열 앞쪽 경계)', () => {
  const started = Date.now();
  assert.equal(
    sectionsDigest([{ title: 'Neg', startPage: -1000000000, endPage: 2 }], ['a', 'b']),
    '## 1. Neg (p.-1000000000-1)\na',
  );
  assert.ok(Date.now() - started < 1000, '페이지 순회가 1페이지 아래로 내려가지 않게 묶이지 않았다');
});

test('sectionsDigest: pageTexts가 비어있거나 없어도 안전하다', () => {
  const ranges = [{ title: 'Empty', depth: 1, startPage: 1, endPage: 3 }];
  assert.equal(sectionsDigest(ranges, []), '## 1. Empty (p.1-2)');
  assert.equal(sectionsDigest(ranges, undefined), '## 1. Empty (p.1-2)');
  assert.equal(sectionsDigest([], []), '');
});

// ---------------------------------------------------------------------------
// outlineDigest
// ---------------------------------------------------------------------------

test('outlineDigest: depth를 들여쓰기로, 페이지 범위를 함께 표기한다', () => {
  const ranges = [
    { title: 'Intro', depth: 1, startPage: 1, endPage: 3 },
    { title: 'Sub', depth: 2, startPage: 3, endPage: 5 },
    { title: 'Conclusion', depth: 1, startPage: 5, endPage: 9 },
  ];
  assert.equal(
    outlineDigest(ranges),
    '1. Intro (p.1-2)\n  2. Sub (p.3-4)\n3. Conclusion (p.5-8)',
  );
});

test('outlineDigest: 빈 입력은 빈 문자열', () => {
  assert.equal(outlineDigest([]), '');
  assert.equal(outlineDigest(null), '');
  assert.equal(outlineDigest(undefined), '');
});
