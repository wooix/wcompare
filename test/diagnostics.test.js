const { test } = require('node:test');
const assert = require('node:assert');
const { toMarker, codepointColToUtf16Col } = require('../src/shared/diagnostics.js');

test('Diagnostic → Monaco marker (1-based, exclusive end 유지, 보정 없음)', () => {
  const d = { startLine: 1, startCol: 8, endLine: 1, endCol: 10,
    message: 'unused', severity: 'warning', source: 'ruff', code: 'F401' };
  const m = toMarker(d);
  assert.equal(m.startLineNumber, 1);
  assert.equal(m.startColumn, 8);
  assert.equal(m.endLineNumber, 1);
  assert.equal(m.endColumn, 10);
  assert.equal(m.message, 'unused');
  assert.equal(m.source, 'ruff');
  assert.equal(m.code, 'F401');
  assert.equal(m.severity, 4); // warning
});

test('severity 매핑', () => {
  assert.equal(toMarker({ severity: 'error', startLine:1,startCol:1,endLine:1,endCol:1,message:'' }).severity, 8);
  assert.equal(toMarker({ severity: 'info', startLine:1,startCol:1,endLine:1,endCol:1,message:'' }).severity, 2);
  assert.equal(toMarker({ severity: 'x', startLine:1,startCol:1,endLine:1,endCol:1,message:'' }).severity, 4); // 기본 warning
});

test('codepoint column → UTF-16 column (surrogate pair 보정)', () => {
  const line = '😀x';
  assert.equal(codepointColToUtf16Col(line, 1), 1); // 시작
  assert.equal(codepointColToUtf16Col(line, 2), 3); // 😀 다음
  assert.equal(codepointColToUtf16Col(line, 3), 4); // x 다음(끝, exclusive)
});

test('codepointColToUtf16Col: BMP only는 그대로', () => {
  assert.equal(codepointColToUtf16Col('abc', 3), 3);
});
