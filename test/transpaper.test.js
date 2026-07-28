const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveBin, outputPathFor, translationCandidates, isProgressLine, pathDirs, translate,
  buildTranslateArgs, parseModelList,
} = require('../src/main/transpaper.js');

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

// translationCandidates는 "삭제 대상 경로"를 만드는 함수라 규칙이 어긋나면 엉뚱한 파일이 지워진다.
// 그래서 유도 규칙 자체를 여기서 못 박는다.
test('translationCandidates: 보관 폴더와 원본 옆, 두 자리를 모두 후보로 준다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cand-'));
  const store = path.join(dir, 'storage', 'translations');
  const got = translationCandidates(path.join(dir, 'paper.pdf'), store);
  // 설정(keepTranslationsInStorage)은 번역 뒤에 바뀔 수 있으므로 한 자리만 보면 놓친다.
  assert.deepEqual(got, [path.join(store, 'paper.ko.pdf'), path.join(dir, 'paper.ko.pdf')]);
});

test('translationCandidates: 보관 폴더가 없으면 원본 옆 한 자리만', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cand1-'));
  assert.deepEqual(translationCandidates(path.join(dir, 'paper.pdf'), null),
    [path.join(dir, 'paper.ko.pdf')]);
});

test('translationCandidates: 두 자리가 같은 경로면 한 번만 (중복 삭제 방지)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cand2-'));
  // 보관 폴더가 곧 원본 폴더인 경우 — 같은 파일을 두 번 지우려 들면 두 번째에서 실패한다.
  assert.deepEqual(translationCandidates(path.join(dir, 'paper.pdf'), dir),
    [path.join(dir, 'paper.ko.pdf')]);
});

test('translationCandidates: 원본 자신은 결코 후보가 되지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cand3-'));
  // 이미 번역본인 파일을 열어 둔 채 삭제를 눌러도, 보고 있는 그 파일이 대상이 되면 안 된다.
  const ko = path.join(dir, 'paper.ko.pdf');
  const got = translationCandidates(ko, dir);
  assert.ok(!got.includes(ko), `원본이 후보에 들어갔다: ${got.join(', ')}`);
  assert.deepEqual(got, [path.join(dir, 'paper.ko.ko.pdf')]);
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

// ===== buildTranslateArgs (순수 함수) =====
test('buildTranslateArgs: 정상 engine·모델이면 --engine/--agy-model/--claude-model을 붙인다', () => {
  const args = buildTranslateArgs('/in.pdf', '/out.ko.pdf', {
    engine: 'claude', agyModel: 'gemini-3.6-flash-low', claudeModel: 'claude-sonnet-4-6',
  });
  assert.deepEqual(args, [
    '/in.pdf', '-o', '/out.ko.pdf', '-v',
    '--engine', 'claude',
    '--agy-model', 'gemini-3.6-flash-low',
    '--claude-model', 'claude-sonnet-4-6',
  ]);
});

test('buildTranslateArgs: 빈 값/미지정이면 플래그를 생략한다(엔진 기본값 사용)', () => {
  assert.deepEqual(buildTranslateArgs('/in.pdf', '/out.ko.pdf', {}), ['/in.pdf', '-o', '/out.ko.pdf', '-v']);
  assert.deepEqual(
    buildTranslateArgs('/in.pdf', '/out.ko.pdf', { engine: 'agy', agyModel: '', claudeModel: '' }),
    ['/in.pdf', '-o', '/out.ko.pdf', '-v', '--engine', 'agy'],
  );
  assert.deepEqual(buildTranslateArgs('/in.pdf', '/out.ko.pdf', undefined), ['/in.pdf', '-o', '/out.ko.pdf', '-v']);
});

test('buildTranslateArgs: 불량 모델명(선행 -, 공백 등)은 조용히 생략한다', () => {
  const args = buildTranslateArgs('/in.pdf', '/out.ko.pdf', {
    engine: 'weird', agyModel: '-rf', claudeModel: 'has space',
  });
  assert.deepEqual(args, ['/in.pdf', '-o', '/out.ko.pdf', '-v'], 'engine도 agy/claude가 아니면 생략');
});

// ===== parseModelList (순수 함수) =====
test('parseModelList: 줄 단위 trim·빈 줄 제외·형식 안 맞는 줄 제외', () => {
  const out = 'gemini-3.6-flash-low\n\n  claude-sonnet-4-6  \n-bad-line\nhas space\nclaude-opus-4-1\n';
  assert.deepEqual(parseModelList(out), ['gemini-3.6-flash-low', 'claude-sonnet-4-6', 'claude-opus-4-1']);
});

test('parseModelList: 빈 입력은 빈 배열', () => {
  assert.deepEqual(parseModelList(''), []);
  assert.deepEqual(parseModelList(undefined), []);
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
