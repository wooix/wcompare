// src/main/lint/adapters/eslintParse.js
// eslint --format json: [{ filePath, messages: [{ ruleId, severity(1|2), message, line, column, endLine?, endColumn? }] }]
function parseEslint(stdout, exitCode) {
  if (exitCode !== 0 && exitCode !== 1) return [];
  let files;
  try { files = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(files)) return [];
  const out = [];
  for (const f of files) {
    for (const m of f.messages || []) {
      const d = {
        startLine: m.line ?? 1,
        startCol: m.column ?? 1,
        endLine: m.endLine ?? m.line ?? 1,
        endCol: m.endColumn ?? (m.column ?? 1) + 1,
        message: m.message ?? '',
        severity: m.severity === 2 ? 'error' : 'warning',
        source: 'eslint',
      };
      if (m.ruleId != null) d.code = m.ruleId;
      out.push(d);
    }
  }
  return out;
}

module.exports = { parseEslint };
