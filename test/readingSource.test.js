const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareReadingSource, citationPage } = require('../src/shared/readingSource');
const { buildPrompt } = require('../src/main/paperSummary');
test('source retains actual page IDs, including blank pages', () => {
  assert.deepEqual(prepareReadingSource(['intro', '', 'results']), { text: '[PDF p.1]\nintro\n\n[PDF p.2]\n\n\n[PDF p.3]\nresults', truncated: false });
});
test('long source samples middle methods as well as ends without exceeding budget', () => {
  const pages = Array.from({ length: 50 }, (_, i) => `PAGE${i + 1}:` + 'x'.repeat(5000));
  const out = prepareReadingSource(pages, 10000);
  assert.ok(out.truncated); assert.ok(out.text.length <= 10000);
  for (const n of [1, 25, 50]) assert.ok(out.text.includes(`[PDF p.${n}]`));
  assert.ok(out.text.includes('생략'));
});
test('very large document keeps original numbering and bounded length', () => {
  const out = prepareReadingSource(Array(2000).fill('x'.repeat(1000)));
  assert.ok(out.text.length <= 110000); assert.ok(out.text.includes('[PDF p.2000]'));
});
test('empty extracted document stops before sending a fabricated summary request', () => {
  for (const pages of [[], ['', '  '], null]) assert.throws(() => prepareReadingSource(pages));
});
test('source links only accept positive exact PDF page fragments', () => {
  assert.equal(citationPage('#paper-page-12'), 12);
  for (const href of ['#paper-page-0', '#paper-page--1', '#paper-page-3evil', 'javascript:alert(1)', 'https://x/#paper-page-3', '#paper-page-9999999']) assert.equal(citationPage(href), null);
});
test('reading prompts require evidence, concrete examples and retrieval without forcing numbers', () => {
  const doc = { text: '[PDF p.1]\nEvidence' };
  const overview = buildPrompt('overview', doc);
  assert.ok(overview.includes('다음에 볼 곳'));
  assert.ok(overview.includes('수치를 강요하지 않는다'));
  assert.ok(overview.includes('#paper-page-N'));
  const narrative = buildPrompt('narrative', doc);
  for (const term of ['입력 →', '논문 실험 아님', '<details>', '먼저 알 개념']) assert.ok(narrative.includes(term));
});
