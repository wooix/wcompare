const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveBin, outputPathFor, isProgressLine, pathDirs, translate } = require('../src/main/transpaper.js');

function tmpExec(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-tp-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  return { dir, p };
}

test('outputPathFor: 쓰기 가능한 원본 폴더에는 옆에 .ko.pdf', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-out-'));
  assert.equal(outputPathFor(path.join(dir, 'paper.pdf')), path.join(dir, 'paper.ko.pdf'));
  assert.equal(outputPathFor(path.join(dir, 'paper.PDF')), path.join(dir, 'paper.ko.pdf'), '대소문자 무관');
  assert.equal(outputPathFor(path.join(dir, 'v1.2.pdf')), path.join(dir, 'v1.2.ko.pdf'), '마지막 확장자만 치환');
});

test('outputPathFor: 원본 폴더에 쓸 수 없으면 임시 폴더로', () => {
  // /System 은 SIP로 보호되어 쓰기 불가
  assert.equal(outputPathFor('/System/paper.pdf', '/tmp'), '/tmp/paper.ko.pdf');
});

test('isProgressLine: transpaper -v 의 페이지 진행 줄만 인식', () => {
  assert.ok(isProgressLine('page 0: translated 12 blocks, 0 overflowed'));
  assert.ok(isProgressLine('  page 7: translation failed (x); keeping original'));
  assert.ok(!isProgressLine('wrote /a/b/paper.ko.pdf'));
  assert.ok(!isProgressLine('note: 3 block(s) shrunk to minimum size (overflow)'));
  assert.ok(!isProgressLine(''));
});

test('pathDirs: 사용자 bin 디렉터리를 PATH 앞에 얹고 중복은 제거', () => {
  const dirs = pathDirs({ PATH: '/usr/bin:/opt/homebrew/bin' });
  assert.equal(dirs[0], path.join(os.homedir(), '.local', 'bin'), 'GUI .app의 빈약한 PATH 보강');
  assert.equal(dirs.filter((d) => d === '/opt/homebrew/bin').length, 1, '중복 없음');
  assert.ok(dirs.includes('/usr/bin'));
});

test('resolveBin: WCOMPARE_TRANSPAPER가 최우선', () => {
  const { p } = tmpExec('transpaper');
  assert.equal(resolveBin({ WCOMPARE_TRANSPAPER: p, PATH: '' }, '/nowhere', []), p);
});

test('resolveBin: WCOMPARE_TRANSPAPER가 실행 불가면 오류', () => {
  assert.throws(
    () => resolveBin({ WCOMPARE_TRANSPAPER: '/nope/transpaper', PATH: '' }, '/nowhere', []),
    /실행 가능한 파일이 아닙니다/,
  );
});

test('resolveBin: PATH에서 탐색', () => {
  const { dir, p } = tmpExec('transpaper');
  assert.equal(resolveBin({ PATH: dir }, '/nowhere', []), p);
});

test('resolveBin: 어디에도 없으면 null', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-empty-'));
  assert.equal(resolveBin({ PATH: empty }, empty, []), null);
});

test('translate: output 오버라이드가 주어지면 outputPathFor 대신 그 경로를 쓴다', async () => {
  const { p: bin } = tmpExec('transpaper'); // #!/bin/sh — 즉시 exit 0
  const custom = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-tp-out-')), 'custom.ko.pdf');
  const job = translate('/some/input.pdf', { output: custom, env: { WCOMPARE_TRANSPAPER: bin, PATH: '' } });
  assert.equal(job.output, custom, '반환 객체의 output이 지정 경로여야 한다');
  const res = await job.promise;
  assert.equal(res.output, custom, 'promise 결과의 output도 지정 경로여야 한다');
});

test('resolveBin: 형제 저장소의 venv를 개발 편의로 탐색', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-root-'));
  const venvBin = path.join(root, 'transpaper', '.venv', 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  const bin = path.join(venvBin, 'transpaper');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  // appRoot가 <root>/wcompare 이면 ../transpaper/.venv/bin/transpaper 를 찾아낸다
  assert.equal(resolveBin({ PATH: '' }, path.join(root, 'wcompare'), []), bin);
});
