// src/main/version.js — 창 제목에 붙는 빌드 버전.
//
// 형식은 yyyy-mm-dd-XXX. 날짜는 그 빌드를 만든 날이고 XXX는 그날의 순번이라,
// "언제 만든 것인가"와 "그날 몇 번째인가"를 한눈에 읽는다. package.json의 semver
// version과는 별개 필드다 — npm은 version이 semver가 아니면 거부하므로 여기에
// 날짜를 넣을 수 없다.
const path = require('node:path');

// 순번 자리수. 하루 999번을 넘길 일은 없지만, 넘치면 자리수가 늘 뿐 깨지지 않는다.
const SEQ_WIDTH = 3;
const VERSION_RE = /^(\d{4}-\d{2}-\d{2})-(\d+)$/;
// package.json에 buildVersion이 없거나 망가졌을 때 쓰는 값. 빈 문자열이 아니라
// 눈에 띄는 표식을 쓴다 — 제목에 아무것도 안 붙으면 "버전 기능이 죽었다"를
// 사용자가 알 길이 없다.
const UNKNOWN = '0000-00-00-000';

// 로컬 날짜. UTC를 쓰면 한국 시간 오전 9시 이전 빌드가 전날로 찍힌다.
function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 다음 빌드 버전. 같은 날이면 순번을 올리고, 날이 바뀌었으면 001부터 다시 센다.
 * current가 없거나 형식에 맞지 않으면 오늘 001로 시작한다 — 망가진 값 때문에
 * 패키징이 멈추는 것보다 새로 세는 편이 낫다.
 */
function nextBuildVersion(current, date = today()) {
  const m = VERSION_RE.exec(String(current ?? '').trim());
  const seq = m && m[1] === date ? Number(m[2]) + 1 : 1;
  return `${date}-${String(seq).padStart(SEQ_WIDTH, '0')}`;
}

function isValid(v) {
  return VERSION_RE.test(String(v ?? '').trim());
}

// 개발 실행은 저장소 루트, 패키징된 .app은 Contents/Resources/app — 두 경우 모두
// 이 파일 기준 ../../package.json 이다(pack-mac이 package.json을 같이 넣는다).
function readBuildVersion(pkgPath = path.join(__dirname, '..', '..', 'package.json')) {
  try {
    const v = require(pkgPath).buildVersion;
    return isValid(v) ? String(v).trim() : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

// 창 제목. 이름과 버전 사이는 공백 하나 — 괄호나 대시를 끼우면 파일명이 붙는
// macOS 제목 표시줄에서 구분자가 두 종류가 되어 읽기 나빠진다.
function windowTitle(version = readBuildVersion(), name = 'wcompare') {
  return `${name} ${version}`;
}

module.exports = { nextBuildVersion, readBuildVersion, windowTitle, isValid, today, UNKNOWN };
