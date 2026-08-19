// scripts/bump-version.mjs — package.json의 buildVersion을 올린다.
//
// package:mac이 build보다 먼저 이것을 돌린다. 배포본마다 서로 다른 번호가 붙는 것이
// 목적이라, 사용자가 "이 창이 어느 빌드인가"를 제목만 보고 말할 수 있다.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..', 'package.json');
const require = createRequire(import.meta.url);
const { nextBuildVersion } = require('../src/main/version.js');

// 원본 문자열을 정규식으로 바꾼다. JSON.parse -> stringify로 다시 쓰면 키 순서와
// 들여쓰기가 통째로 재배치되어, 버전 한 줄 올린 커밋이 package.json 전체 diff가 된다.
const raw = readFileSync(PKG, 'utf8');
const current = JSON.parse(raw).buildVersion;
const next = nextBuildVersion(current);

const FIELD = /("buildVersion"\s*:\s*")([^"]*)(")/;
if (!FIELD.test(raw)) {
  console.error('bump-version: package.json에 buildVersion 필드가 없습니다.');
  process.exit(1);
}
writeFileSync(PKG, raw.replace(FIELD, `$1${next}$3`), 'utf8');
console.log(`[bump-version] ${current ?? '(없음)'} -> ${next}`);
