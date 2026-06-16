// src/main/lint/which.js — PATH에서 실행파일 존재를 1회 확인하고 캐시한다.
const { execFileSync } = require('node:child_process');
const cache = new Map();

function hasCommand(cmd) {
  if (cache.has(cmd)) return cache.get(cmd);
  let ok = false;
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(probe, [cmd], { stdio: 'ignore' });
    ok = true;
  } catch { ok = false; }
  cache.set(cmd, ok);
  return ok;
}

module.exports = { hasCommand, _cache: cache };
