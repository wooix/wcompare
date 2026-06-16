const { test } = require('node:test');
const assert = require('node:assert');
const { parseEslint } = require('../src/main/lint/adapters/eslintParse.js');

const SAMPLE = JSON.stringify([{
  filePath: '<text>',
  messages: [
    { ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used.",
      line: 1, column: 7, endLine: 1, endColumn: 8 },
    { ruleId: 'eqeqeq', severity: 1, message: 'Expected ===', line: 2, column: 1, endLine: 2, endColumn: 3 },
  ],
}]);

test('eslint JSON → Diagnostic[], severity 2→error 1→warning', () => {
  const r = parseEslint(SAMPLE, 1);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { startLine:1, startCol:7, endLine:1, endCol:8,
    message: "'x' is defined but never used.", severity:'error', source:'eslint', code:'no-unused-vars' });
  assert.equal(r[1].severity, 'warning');
  assert.equal(r[1].code, 'eqeqeq');
});

test('endLine/endColumn 누락 시 start로 폴백', () => {
  const s = JSON.stringify([{ messages: [{ ruleId:null, severity:2, message:'parse', line:3, column:5 }] }]);
  const r = parseEslint(s, 1);
  assert.equal(r[0].endLine, 3);
  assert.equal(r[0].endCol, 6);
  assert.equal(r[0].source, 'eslint');
});

test('exit 2 / 파싱 실패 → []', () => {
  assert.deepEqual(parseEslint('', 2), []);
  assert.deepEqual(parseEslint('boom', 1), []);
});

test('빈 messages → []', () => {
  assert.deepEqual(parseEslint(JSON.stringify([{ messages: [] }]), 0), []);
});
