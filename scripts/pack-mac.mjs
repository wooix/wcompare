// scripts/pack-mac.mjs — 의존성 없는 로컬 개발용 macOS .app 어셈블러.
// 프리빌트 node_modules/electron/dist/Electron.app 을 복제 → 실행 파일 rename →
// 앱 소스(src/main, src/preload, dist, package.json) 주입 → Info.plist 패치 → ad-hoc 서명.
// 서명/공증/dmg 없음. 런타임 외부 npm 의존성이 없어(esbuild가 dist에 인라인) node_modules는 넣지 않는다.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, renameSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const APP_NAME = pkg.name;            // wcompare → wcompare.app
const BUNDLE_ID = 'com.wooix.wcompare';

const ROOT = path.resolve('.');
const electronBin = require('electron');                          // .../dist/Electron.app/Contents/MacOS/Electron
const electronApp = path.resolve(electronBin, '..', '..', '..');  // .../dist/Electron.app
const OUT = path.join(ROOT, 'release');
const APP = path.join(OUT, `${APP_NAME}.app`);

// 1) 클린 후 Electron.app 복제 (번들 구조/심링크 보존 위해 ditto 사용)
rmSync(APP, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync('ditto', [electronApp, APP]);

const CONTENTS = path.join(APP, 'Contents');
const MACOS = path.join(CONTENTS, 'MacOS');
const RES = path.join(CONTENTS, 'Resources');

// 2) 실행 파일 rename: Electron → wcompare
renameSync(path.join(MACOS, 'Electron'), path.join(MACOS, APP_NAME));

// 3) 기본 placeholder 제거 + 앱 소스 주입 (Resources/app/ 이 default_app.asar보다 우선 로드됨)
rmSync(path.join(RES, 'default_app.asar'), { force: true });
const APPDIR = path.join(RES, 'app');
mkdirSync(APPDIR, { recursive: true });
cpSync(path.join(ROOT, 'package.json'), path.join(APPDIR, 'package.json'));
const skip = (s) => /\.map$/.test(s) || /dist\/(demo|demo-pdf|spike|spike-pdf)\.png$/.test(s);
// src/ 전체 복사 — 메인 프로세스의 require 그래프(src/main → src/shared 등)가 번들 안에서 모두 해소되도록.
// (src/renderer 소스는 런타임 미사용이지만 KB 단위라 함께 복사: 누락 리스크 제거가 우선)
for (const d of ['src', 'dist']) {
  cpSync(path.join(ROOT, d), path.join(APPDIR, d), { recursive: true, filter: (s) => !skip(s) });
}

// 4) Info.plist 패치
const plist = path.join(CONTENTS, 'Info.plist');
const set = (k, v) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${k} ${v}`, plist]);
set('CFBundleExecutable', APP_NAME);
set('CFBundleName', APP_NAME);
set('CFBundleDisplayName', APP_NAME);
set('CFBundleIdentifier', BUNDLE_ID);
set('CFBundleShortVersionString', pkg.version);
set('CFBundleVersion', pkg.version);

// 5) ad-hoc 재서명 (arm64는 유효 서명 없으면 실행 차단; 번들 수정으로 기존 서명이 깨졌음)
execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'inherit' });

// 6) 자가검증: 메인 프로세스 require 그래프가 번들 안에서 전부 해소되는지 정적 추적.
//    (누락 모듈은 Electron 실행 시 GUI 다이얼로그 크래시로만 드러나 놓치기 쉬움 → 빌드 시점에 차단)
{
  const APPDIR = path.join(RES, 'app');
  const seen = new Set();
  const missing = [];
  const resolveReq = (from, spec) => {
    const base = path.resolve(path.dirname(from), spec);
    for (const c of [base, base + '.js', path.join(base, 'index.js')]) if (existsSync(c)) return c;
    return null;
  };
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const re = /require\((['"])([^'"]+)\1\)/g;
    let m;
    const src = readFileSync(file, 'utf8');
    while ((m = re.exec(src))) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue; // builtin / electron / npm
      const r = resolveReq(file, spec);
      if (!r) missing.push(`${path.relative(APPDIR, file)} -> ${spec}`);
      else walk(r);
    }
  };
  walk(path.join(APPDIR, 'src', 'main', 'main.js'));
  if (missing.length) {
    console.error('[pack-mac] FAIL — 번들에 누락된 모듈:');
    for (const x of missing) console.error('  ' + x);
    process.exit(1);
  }
  console.log(`[pack-mac] require graph ok (${seen.size} files)`);
}

console.log(`[pack-mac] built ${path.relative(ROOT, APP)}`);
