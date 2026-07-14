// src/main/allowlist.js — 이번 세션에서 사용자가 실제로 연 경로만 모아 둔다.
// ipc.js와 project.js가 함께 쓰므로 별도 모듈로 분리(순환 require 방지).
const fs = require('node:fs');
const path = require('node:path');

// 쓰기가 허용된 경로 (dialog / CLI / DnD / 프로젝트로 연 파일)
const allowed = new Set();
// 번역 대상이 될 수 있는 PDF (외부 프로세스 인자로 나가므로 별도 관리)
const openedPdfs = new Set();

function normalize(p) {
  try { return fs.realpathSync.native(path.resolve(p)); }
  catch { return path.resolve(p); }
}

function allowPath(p) {
  const n = normalize(p);
  allowed.add(n);
  if (/\.pdf$/i.test(n)) openedPdfs.add(n);
  return n;
}

module.exports = { allowed, openedPdfs, normalize, allowPath };
