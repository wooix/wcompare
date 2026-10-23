// src/main/defaultApp.js — macOS에서 "PDF 기본 앱" 지정을 돕는다.
//
// Electron에는 파일 형식의 기본 앱을 바꾸는 API가 없다. app.setAsDefaultProtocolClient는
// URL 스킴(http:, mailto: …) 전용이라 파일 형식에는 쓸 수 없다. macOS에서 이걸 바꾸는 공식
// 경로는 Objective-C의 LSSetDefaultRoleHandlerForContentType 하나뿐이고, JS에서 닿지 않는다.
// LaunchServices의 plist를 직접 고치는 우회는 형식이 문서화돼 있지 않고 lsregister 재시작까지
// 필요해, 남의 시스템 설정을 건드리는 방법으로는 위험하다.
//
// 그래서 그 함수를 감싼 외부 도구 duti가 있으면 쓰고, 없으면 수동 방법을 안내한다.
// 안내로 끝나더라도 소용이 있다: Info.plist에 PDF 문서 타입을 선언해 두었으므로
// Finder의 "다음으로 열기" 목록에는 이미 wcompare가 나타난다(scripts/pack-mac.mjs).
//
// PATH 탐색은 transpaper.js의 pathDirs를 재사용한다 — Finder로 띄운 .app은 PATH가
// /usr/bin:/bin 남짓이라 사용자 bin 디렉터리를 직접 얹어야 하는 사정이 똑같기 때문이다.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathDirs } = require('./transpaper.js');

const PDF_UTI = 'com.adobe.pdf';

function findDuti(env = process.env, extraDirs) {
  for (const dir of pathDirs(env, extraDirs)) {
    const cand = path.join(dir, 'duti');
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      if (fs.statSync(cand).isFile()) return cand;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

// `duti -x pdf` 는 이름·경로·번들ID를 세 줄로 뱉는다. 우리가 쓸 것은 마지막 줄이다.
function parseHandler(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

/**
 * 지금 PDF를 여는 앱의 번들 ID.
 * duti가 없으면 handler를 null로 둔다 — "다른 앱이 기본이다"와 "확인할 수 없다"는 다른 사실이고,
 * 사용자에게도 다르게 말해야 한다.
 */
function getPdfHandler({ run = execFileSync, env = process.env, extraDirs } = {}) {
  const bin = findDuti(env, extraDirs);
  if (!bin) return { duti: false, handler: null };
  try {
    return { duti: true, handler: parseHandler(run(bin, ['-x', 'pdf'], { encoding: 'utf8' })) };
  } catch {
    return { duti: true, handler: null };
  }
}

/**
 * PDF 기본 앱을 bundleId로 바꾼다. 'all' 은 뷰어·에디터 역할을 모두 지정한다는 뜻.
 * 실패 사유를 구분해 돌려준다 — 사용자가 다음에 무엇을 해야 할지가 사유마다 다르기 때문.
 */
function setPdfHandler(bundleId, { run = execFileSync, env = process.env, extraDirs } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(String(bundleId || ''))) {
    return { ok: false, reason: 'bad-id' };
  }
  const bin = findDuti(env, extraDirs);
  if (!bin) return { ok: false, reason: 'no-duti' };
  try {
    run(bin, ['-s', bundleId, PDF_UTI, 'all'], { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, reason: 'failed', message: String(e?.message || e).slice(0, 300) };
  }
  return { ok: true, handler: getPdfHandler({ run, env, extraDirs }).handler };
}

module.exports = { findDuti, parseHandler, getPdfHandler, setPdfHandler, PDF_UTI };
