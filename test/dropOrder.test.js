const { test } = require('node:test');
const assert = require('node:assert');
const { orderByName, basename } = require('../src/renderer/dropOrder.js');

test('basename: 경로에서 파일명만', () => {
  assert.equal(basename('/a/b/ko.pdf'), 'ko.pdf');
  assert.equal(basename('C:\\docs\\en.pdf'), 'en.pdf');
  assert.equal(basename('plain.pdf'), 'plain.pdf');
});

test('orderByName: basename 이름순 정렬 (디렉토리 무시)', () => {
  const input = ['/x/z/ko.pdf', '/a/en.pdf'];
  assert.deepEqual(orderByName(input), ['/a/en.pdf', '/x/z/ko.pdf']);
});

test('orderByName: 숫자 자연 정렬 (page2 < page10)', () => {
  assert.deepEqual(
    orderByName(['/d/page10.pdf', '/d/page2.pdf']),
    ['/d/page2.pdf', '/d/page10.pdf']
  );
});

test('orderByName: 원본 배열 불변(순수)', () => {
  const input = ['/b.pdf', '/a.pdf'];
  const out = orderByName(input);
  assert.deepEqual(input, ['/b.pdf', '/a.pdf']); // 원본 유지
  assert.deepEqual(out, ['/a.pdf', '/b.pdf']);
});
