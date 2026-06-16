// src/main/lint/adapters/eslint.js
const { spawn } = require('node:child_process');
const path = require('node:path');
const { parseEslint } = require('./eslintParse.js');
const { applyUtf16 } = require('./ruff.js'); // 동일 UTF-16 보정 재사용

const TIMEOUT = 5000;
const BUNDLED_CONFIG = path.join(__dirname, '..', '..', '..', '..', 'eslint.config.mjs');

function runEslint(content, filePath) {
  return new Promise((resolve) => {
    const abs = path.resolve(filePath || 'untitled.js');
    const args = ['--no-config-lookup', '-c', BUNDLED_CONFIG, '--format', 'json',
      '--stdin', '--stdin-filename', abs];
    const child = spawn('eslint', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, TIMEOUT);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return resolve([]);
      resolve(applyUtf16(parseEslint(out, code), content));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(content);
  });
}

module.exports = { runEslint };
