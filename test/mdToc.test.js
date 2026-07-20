// test/mdToc.test.js — parseMdHeadings 순수 파서 단위 테스트.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseMdHeadings } = require('../src/renderer/mdToc.js');

test('레벨 파싱: 1~6개 # + 공백 + 제목, line은 1-based', () => {
  const md = [
    '# H1',            // line 1
    'body',            // 2
    '## H2',           // 3
    '### H3',          // 4
    '###### H6',       // 5
  ].join('\n');
  assert.deepEqual(parseMdHeadings(md), [
    { level: 1, title: 'H1', line: 1 },
    { level: 2, title: 'H2', line: 3 },
    { level: 3, title: 'H3', line: 4 },
    { level: 6, title: 'H6', line: 5 },
  ]);
});

test('펜스 내부(``` 및 ~~~)의 #은 무시한다', () => {
  const md = [
    '# real',          // 1  헤딩
    '```',             // 2  펜스 열림
    '# fake in code',  // 3  무시
    '## also fake',    // 4  무시
    '```',             // 5  펜스 닫힘
    '## after',        // 6  헤딩
    '~~~js',           // 7  물결 펜스 열림(info string 포함)
    '# tilde fake',    // 8  무시
    '~~~',             // 9  닫힘
    '### tail',        // 10 헤딩
  ].join('\n');
  assert.deepEqual(parseMdHeadings(md), [
    { level: 1, title: 'real', line: 1 },
    { level: 2, title: 'after', line: 6 },
    { level: 3, title: 'tail', line: 10 },
  ]);
});

test('빈 문서 / 헤딩 없는 문서 → 빈 배열', () => {
  assert.deepEqual(parseMdHeadings(''), []);
  assert.deepEqual(parseMdHeadings('plain text\nno headings\n'), []);
  assert.deepEqual(parseMdHeadings(null), []);
});

test('공백 없는 #hashtag 는 헤딩이 아니다', () => {
  const md = [
    '#hashtag',        // 1  공백 없음 → 비헤딩
    '#tag #another',   // 2  비헤딩
    '####### seven',   // 3  7개 # → 비헤딩(최대 6)
    '# ok',            // 4  헤딩
  ].join('\n');
  assert.deepEqual(parseMdHeadings(md), [
    { level: 1, title: 'ok', line: 4 },
  ]);
});

test('닫는 # 시퀀스는 제목에서 제거된다', () => {
  assert.deepEqual(parseMdHeadings('## Title ##'), [
    { level: 2, title: 'Title', line: 1 },
  ]);
});
