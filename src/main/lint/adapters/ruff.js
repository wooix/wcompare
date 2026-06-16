// src/main/lint/adapters/ruff.js
const { spawn } = require('node:child_process');
const path = require('node:path');
const { parseRuff } = require('./ruffParse.js');
const { codepointColToUtf16Col } = require('../../../shared/diagnostics.js');

const TIMEOUT = 5000;

function runRuff(content, filePath) {
  return new Promise((resolve) => {
    const abs = path.resolve(filePath || 'untitled.py');
    const args = ['check', '--isolated', '--output-format', 'json', '--stdin-filename', abs, '-'];
    const child = spawn('ruff', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, TIMEOUT);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return resolve([]);
      resolve(applyUtf16(parseRuff(out, code), content));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(content);
  });
}

// 코드포인트 column → UTF-16 column (라인 텍스트 기준)
function applyUtf16(diags, content) {
  const lines = content.split('\n');
  return diags.map((d) => {
    const sl = lines[d.startLine - 1] ?? '';
    const el = lines[d.endLine - 1] ?? '';
    return { ...d, startCol: codepointColToUtf16Col(sl, d.startCol), endCol: codepointColToUtf16Col(el, d.endCol) };
  });
}

module.exports = { runRuff, applyUtf16 };
