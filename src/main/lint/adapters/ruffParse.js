// src/main/lint/adapters/ruffParse.js
// ruff --output-format json 결과를 Diagnostic[]로. exit 0/1만 진단으로 채택.
function parseRuff(stdout, exitCode) {
  if (exitCode !== 0 && exitCode !== 1) return [];
  let arr;
  try { arr = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((d) => {
    const out = {
      startLine: d.location?.row ?? 1,
      startCol: d.location?.column ?? 1,
      endLine: d.end_location?.row ?? d.location?.row ?? 1,
      endCol: d.end_location?.column ?? (d.location?.column ?? 1) + 1,
      message: d.message ?? '',
      severity: d.code === 'invalid-syntax' ? 'error' : 'warning',
      source: 'ruff',
    };
    if (d.code != null) out.code = d.code;
    return out;
  });
}

module.exports = { parseRuff };
