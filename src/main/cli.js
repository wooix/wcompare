// src/main/cli.js — process.argv에서 최대 2개 파일 경로를 추출한다.
const fs = require('node:fs');
const path = require('node:path');

// 비패키징: argv = [electron, appPathOrMainJs, ...userArgs] → slice(2)
// 패키징:   argv = [exe, ...userArgs]                        → slice(1)
function parsePair(argv, isPackaged = false) {
  const start = isPackaged ? 1 : 2;
  const args = argv.slice(start).filter((a) => a !== '.' && !a.startsWith('-'));
  const files = args.filter((a) => { try { return fs.statSync(a).isFile(); } catch { return false; } })
    .map((a) => path.resolve(a));
  return { left: files[0] || null, right: files[1] || null };
}

module.exports = { parsePair };
