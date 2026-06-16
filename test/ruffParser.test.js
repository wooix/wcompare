const { test } = require('node:test');
const assert = require('node:assert');
const { parseRuff } = require('../src/main/lint/adapters/ruffParse.js');

const SAMPLE = JSON.stringify([{
  code: 'F401',
  location: { row: 1, column: 8 },
  end_location: { row: 1, column: 10 },
  message: '`os` imported but unused',
  url: 'https://docs.astral.sh/ruff/rules/unused-import',
  fix: null, noqa_row: 1,
}]);

test('exit 1 + JSON → Diagnostic 1개, 좌표 1-based 그대로', () => {
  const r = parseRuff(SAMPLE, 1);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], {
    startLine: 1, startCol: 8, endLine: 1, endCol: 10,
    message: '`os` imported but unused', severity: 'warning', source: 'ruff', code: 'F401',
  });
});

test('invalid-syntax → error severity', () => {
  const s = JSON.stringify([{ code: 'invalid-syntax', location:{row:2,column:1},
    end_location:{row:2,column:5}, message:'SyntaxError', url:null, fix:null, noqa_row:null }]);
  const r = parseRuff(s, 1);
  assert.equal(r[0].severity, 'error');
  assert.equal(r[0].code, 'invalid-syntax');
});

test('code 누락 안전 처리', () => {
  const s = JSON.stringify([{ location:{row:1,column:1}, end_location:{row:1,column:2}, message:'x' }]);
  const r = parseRuff(s, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].source, 'ruff');
});

test('exit 0 + 빈 배열 → []', () => {
  assert.deepEqual(parseRuff('[]', 0), []);
});

test('exit 2 또는 파싱 실패 → []', () => {
  assert.deepEqual(parseRuff('', 2), []);
  assert.deepEqual(parseRuff('not json', 1), []);
});
