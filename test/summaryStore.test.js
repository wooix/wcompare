// test/summaryStore.test.js — PDF별 논문 요약 캐시 저장소(순수 fs 모듈).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const summaryStore = require('../src/main/summaryStore.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sumstore-')); }

const PARTS = { overview: '전체 요약입니다.', sections: '1장: 서론\n2장: 방법', flow: 'graph TD; A-->B;' };
const META = { engine: 'agy', model: 'sonnet', truncated: false };

test('경로→파일명은 결정적: 같은 경로는 같은 파일, 다른 경로는 다른 파일', () => {
  const a = '/Users/me/docs/paper.pdf';
  assert.equal(summaryStore.fileNameFor(a), summaryStore.fileNameFor(a), '같은 경로 → 같은 파일명');
  assert.notEqual(summaryStore.fileNameFor(a), summaryStore.fileNameFor('/Users/me/docs/other.pdf'));
  assert.match(summaryStore.fileNameFor(a), /^paper\.pdf\.[0-9a-f]{40}\.summary\.json$/, 'basename 접두 + sha1 + .summary');
});

test('저장→로드 왕복: 저장한 파트가 그대로 읽힌다', () => {
  const dir = tmpDir();
  const abs = '/Users/me/docs/round.pdf';
  const res = summaryStore.save(dir, abs, PARTS, META);
  assert.equal(res.saved, true);
  assert.deepEqual(res.parts, PARTS);

  const loaded = summaryStore.load(dir, abs);
  assert.deepEqual(loaded.parts, PARTS);
  assert.equal(loaded.meta.engine, 'agy');
  assert.equal(loaded.meta.model, 'sonnet');
  assert.equal(loaded.meta.truncated, false);
  assert.equal(typeof loaded.meta.savedAt, 'string');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('저장 파일에는 format/version/path 메타가 담긴다', () => {
  const dir = tmpDir();
  const abs = path.join(dir, 'meta.pdf');
  summaryStore.save(dir, abs, PARTS, META);
  const raw = JSON.parse(fs.readFileSync(summaryStore.filePathFor(dir, abs), 'utf8'));
  assert.equal(raw.format, 'wcompare-summary');
  assert.equal(raw.version, 1);
  assert.equal(raw.path, path.resolve(abs));
  assert.equal(typeof raw.savedAt, 'string');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('부분 저장: overview만 있어도 저장되고, 나머지는 빈 문자열로 로드된다', () => {
  const dir = tmpDir();
  const abs = '/x/partial.pdf';
  const res = summaryStore.save(dir, abs, { overview: '개요만 있음' }, {});
  assert.equal(res.saved, true);
  const loaded = summaryStore.load(dir, abs);
  assert.equal(loaded.parts.overview, '개요만 있음');
  assert.equal(loaded.parts.sections, '');
  assert.equal(loaded.parts.flow, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('부분 저장 정책: save는 병합하지 않고 넘어온 parts로 그대로 덮어쓴다', () => {
  const dir = tmpDir();
  const abs = '/x/overwrite.pdf';
  summaryStore.save(dir, abs, PARTS, META);
  // sections만 다시 저장 — overview/flow는 명시적으로 병합하지 않으면 사라져야 한다(정책 문서화된 대로).
  summaryStore.save(dir, abs, { sections: '새 섹션' }, {});
  const loaded = summaryStore.load(dir, abs);
  assert.equal(loaded.parts.sections, '새 섹션');
  assert.equal(loaded.parts.overview, '', '병합은 호출자 책임 — 저장소는 그대로 덮어쓴다');
  assert.equal(loaded.parts.flow, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sanitizeParts: 상한 초과 파트는 잘리고, 문자열이 아닌 값은 빈 문자열이 된다', () => {
  const long = 'a'.repeat(summaryStore.MAX_PART_CHARS + 500);
  const clean = summaryStore.sanitizeParts({ overview: long, sections: { not: 'a string' }, flow: ['array'] });
  assert.equal(clean.overview.length, summaryStore.MAX_PART_CHARS);
  assert.equal(clean.sections, '');
  assert.equal(clean.flow, '');

  // 숫자, null, 배열 자체가 raw로 와도 안전
  assert.deepEqual(summaryStore.sanitizeParts(42), { overview: '', sections: '', flow: '' });
  assert.deepEqual(summaryStore.sanitizeParts(null), { overview: '', sections: '', flow: '' });
  assert.deepEqual(summaryStore.sanitizeParts([1, 2, 3]), { overview: '', sections: '', flow: '' });
});

test('상한 초과 파트를 저장하면 로드 시에도 잘린 채로 나온다', () => {
  const dir = tmpDir();
  const abs = '/x/truncate.pdf';
  const long = 'b'.repeat(summaryStore.MAX_PART_CHARS + 1000);
  summaryStore.save(dir, abs, { overview: long }, {});
  const loaded = summaryStore.load(dir, abs);
  assert.equal(loaded.parts.overview.length, summaryStore.MAX_PART_CHARS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('meta는 engine/model/truncated 외 값을 걸러낸다', () => {
  const dir = tmpDir();
  const abs = '/x/meta-sanitize.pdf';
  summaryStore.save(dir, abs, PARTS, { engine: 'claude', model: 123, truncated: 'yes', evil: () => {} });
  const loaded = summaryStore.load(dir, abs);
  assert.equal(loaded.meta.engine, 'claude');
  assert.equal(loaded.meta.model, '', '문자열이 아니면 버린다');
  assert.equal(loaded.meta.truncated, false, '불리언이 아니면 버린다');
  assert.equal(loaded.meta.evil, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('세 파트가 전부 비면 저장 대신 파일을 지운다(정리)', () => {
  const dir = tmpDir();
  const abs = '/x/empty.pdf';
  summaryStore.save(dir, abs, PARTS, META);
  assert.equal(fs.existsSync(summaryStore.filePathFor(dir, abs)), true);

  const res = summaryStore.save(dir, abs, { overview: '', sections: '', flow: '' }, {});
  assert.equal(res.saved, false);
  assert.equal(fs.existsSync(summaryStore.filePathFor(dir, abs)), false, '빈 저장 → 파일 삭제');
  // 없는 파일에 빈 저장을 다시 해도 예외 없이 통과
  assert.doesNotThrow(() => summaryStore.save(dir, abs, {}, {}));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('원자 기록: 저장 후 .tmp 잔존이 없다', () => {
  const dir = tmpDir();
  const abs = '/x/atomic.pdf';
  summaryStore.save(dir, abs, PARTS, META);
  const leftover = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, [], 'tmp 파일이 남지 않아야 한다');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('깨진 JSON을 로드하면 빈 값을 돌려준다(열기 흐름을 막지 않는다)', () => {
  const dir = tmpDir();
  const abs = '/x/broken.pdf';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(summaryStore.filePathFor(dir, abs), '{ not json');
  const loaded = summaryStore.load(dir, abs);
  assert.deepEqual(loaded.parts, { overview: '', sections: '', flow: '' });
  assert.equal(loaded.meta, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('format/version이 다르면 빈 값을 돌려준다', () => {
  const dir = tmpDir();
  const abs = '/x/wrongformat.pdf';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(summaryStore.filePathFor(dir, abs), JSON.stringify({
    format: 'something-else', version: 1, parts: PARTS,
  }));
  assert.deepEqual(summaryStore.load(dir, abs).parts, { overview: '', sections: '', flow: '' });
  assert.equal(summaryStore.load(dir, abs).meta, null);

  const abs2 = '/x/wrongversion.pdf';
  fs.writeFileSync(summaryStore.filePathFor(dir, abs2), JSON.stringify({
    format: 'wcompare-summary', version: 99, parts: PARTS,
  }));
  assert.deepEqual(summaryStore.load(dir, abs2).parts, { overview: '', sections: '', flow: '' });
  assert.equal(summaryStore.load(dir, abs2).meta, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('없는 파일을 로드하면 빈 값을 돌려준다', () => {
  const dir = tmpDir();
  const loaded = summaryStore.load(dir, '/x/missing.pdf');
  assert.deepEqual(loaded.parts, { overview: '', sections: '', flow: '' });
  assert.equal(loaded.meta, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
