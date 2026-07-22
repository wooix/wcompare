// src/shared/diagnostics.js — 순수. monaco를 import하지 않고 숫자 상수만 사용한다.
const SEVERITY = { error: 8, warning: 4, info: 2 }; // monaco.MarkerSeverity 값과 동일

function toMarker(d) {
  return {
    startLineNumber: d.startLine,
    startColumn: d.startCol,
    endLineNumber: d.endLine,
    endColumn: d.endCol,
    message: d.message,
    severity: SEVERITY[d.severity] ?? SEVERITY.warning,
    source: d.source,
    ...(d.code != null ? { code: String(d.code) } : {}),
  };
}

// linter는 column을 유니코드 코드포인트(1-based)로 센다. Monaco는 UTF-16 code unit(1-based).
// 1-based codepoint column을 1-based UTF-16 column으로 변환한다.
function codepointColToUtf16Col(lineText, cpCol) {
  if (cpCol <= 1) return cpCol;
  let cp = 1, utf16 = 1;
  for (const ch of lineText) {       // for..of는 코드포인트 단위 순회
    if (cp >= cpCol) break;
    utf16 += ch.length;              // surrogate pair면 2
    cp += 1;
  }
  return utf16;
}

module.exports = { toMarker, codepointColToUtf16Col, SEVERITY };
