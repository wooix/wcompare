// src/main/transpaper.js — 외부 transpaper CLI로 PDF를 한국어로 오버레이 번역.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Finder에서 띄운 .app은 셸을 거치지 않아 PATH가 /usr/bin:/bin:/usr/sbin:/sbin 뿐이다.
// transpaper는 내부에서 agy/claude CLI를 다시 spawn하므로 사용자 bin 디렉터리를 직접 얹어준다.
const EXTRA_BIN_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

const NOT_FOUND_HINT =
  'transpaper를 찾을 수 없습니다.\n\n' +
  '다음 중 하나로 해결하세요:\n' +
  '  1) ln -s <transpaper>/.venv/bin/transpaper ~/.local/bin/transpaper\n' +
  '  2) WCOMPARE_TRANSPAPER 환경변수에 실행 파일 절대경로 지정';

function pathDirs(env = process.env, extraDirs = EXTRA_BIN_DIRS) {
  const seen = new Set();
  return [...extraDirs, ...(env.PATH || '').split(path.delimiter)]
    .filter((d) => d && !seen.has(d) && seen.add(d));
}

function envWithPath(env = process.env) {
  // PYTHONUNBUFFERED: transpaper는 Python이라 stdout이 파이프면 블록 버퍼링(~8KB)이 걸린다.
  // 진행 줄("page N: ...")이 40바이트 남짓이라 버퍼를 못 채워, 끄면 전부 프로세스 종료 시점에
  // 몰아서 flush된다 → 실시간 진행률이 안 나온다. 켜면 페이지마다 즉시 도착한다.
  return { ...env, PATH: pathDirs(env).join(path.delimiter), PYTHONUNBUFFERED: '1' };
}

function isExec(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch { return false; }
}

// 탐색 순서: WCOMPARE_TRANSPAPER → PATH → 형제 저장소의 venv(개발 편의)
function resolveBin(env = process.env, appRoot = path.join(__dirname, '..', '..'), extraDirs = EXTRA_BIN_DIRS) {
  const explicit = env.WCOMPARE_TRANSPAPER;
  if (explicit) {
    if (isExec(explicit)) return explicit;
    throw new Error(`WCOMPARE_TRANSPAPER가 실행 가능한 파일이 아닙니다: ${explicit}`);
  }
  for (const dir of pathDirs(env, extraDirs)) {
    const cand = path.join(dir, 'transpaper');
    if (isExec(cand)) return cand;
  }
  const sibling = path.join(appRoot, '..', 'transpaper', '.venv', 'bin', 'transpaper');
  return isExec(sibling) ? sibling : null;
}

// 출력 경로는 항상 메인이 유도한다 — 렌더러가 임의 경로를 지정하면 임의 파일 쓰기가 된다.
function outputPathFor(input, tmpDir = os.tmpdir()) {
  const dir = path.dirname(input);
  const base = path.basename(input).replace(/\.pdf$/i, '');
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return path.join(dir, `${base}.ko.pdf`);
  } catch {
    return path.join(tmpDir, `${base}.ko.pdf`); // 원본 폴더가 읽기 전용이면 임시 폴더로
  }
}

// transpaper -v 는 페이지마다 "page N: translated K blocks, M overflowed"를 stdout에 찍는다.
const PROGRESS_RE = /^page\s+\d+:/;
const isProgressLine = (line) => PROGRESS_RE.test(line.trim());

// 스트림을 줄 단위로 잘라 콜백. 마지막 조각은 다음 chunk와 이어 붙인다.
function onLines(stream, cb) {
  let tail = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (tail + chunk).split('\n');
    tail = lines.pop();
    lines.forEach(cb);
  });
}

/**
 * transpaper를 띄우고 진행 상황을 스트리밍한다.
 * @param {string} input 원본 PDF 절대경로
 * @param {object} [opts]
 * @param {(d:{done:number})=>void} [opts.onProgress] 페이지마다 호출
 * @param {string} [opts.output] 출력 경로를 직접 지정(없으면 outputPathFor로 유도). main이 유도한 값만 넘긴다.
 * @returns {{ promise: Promise<{output,partial,pages}>, cancel: () => void, output: string }}
 */
function translate(input, { onProgress, output, env = process.env } = {}) {
  const bin = resolveBin(env);
  if (!bin) return { promise: Promise.reject(new Error(NOT_FOUND_HINT)), cancel() {}, output: null };

  const outPath = output || outputPathFor(input);
  // detached: 자신만의 프로세스 그룹을 갖게 해, 취소 시 transpaper가 띄운 agy/claude까지 함께 정리한다.
  const child = spawn(bin, [input, '-o', outPath, '-v'], {
    env: envWithPath(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });

  let pages = 0;
  let canceled = false;
  const errTail = [];

  onLines(child.stdout, (line) => { if (isProgressLine(line)) onProgress?.({ done: ++pages }); });
  onLines(child.stderr, (line) => { errTail.push(line); if (errTail.length > 40) errTail.shift(); });

  const promise = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`transpaper 실행 실패: ${e.message}`)));
    child.on('close', (code) => {
      if (canceled) return reject(new Error('번역이 취소되었습니다.'));
      // 0=성공, 2=일부 페이지는 번역 실패해 원문 유지, 그 외=오류
      if (code === 0 || code === 2) return resolve({ output: outPath, partial: code === 2, pages });
      reject(new Error(`transpaper 오류 (exit ${code})\n${errTail.join('\n').slice(-600)}`));
    });
  });

  function cancel() {
    canceled = true;
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 이미 종료됨 */ }
  }

  return { promise, cancel, output: outPath };
}

module.exports = { translate, resolveBin, outputPathFor, isProgressLine, pathDirs, envWithPath, NOT_FOUND_HINT };
