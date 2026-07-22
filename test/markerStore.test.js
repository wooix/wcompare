// test/markerStore.test.js — PDF별 마커 자동 영속화 저장소(순수 fs 모듈).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const markerStore = require('../src/main/markerStore.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mkstore-')); }

const MARKER = { id: 'mk1', page: 3, kind: 'highlight', color: '#ffd64a', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }] };

test('경로→파일명은 결정적: 같은 경로는 같은 파일, 다른 경로는 다른 파일', () => {
  const a = '/Users/me/docs/paper.pdf';
  assert.equal(markerStore.fileNameFor(a), markerStore.fileNameFor(a), '같은 경로 → 같은 파일명');
  assert.notEqual(markerStore.fileNameFor(a), markerStore.fileNameFor('/Users/me/docs/other.pdf'));
  assert.match(markerStore.fileNameFor(a), /^paper\.pdf\.[0-9a-f]{40}\.json$/, 'basename 접두 + sha1');
});

test('저장→로드 왕복: 저장한 마커가 그대로 읽힌다', () => {
  const dir = tmpDir();
  const abs = '/Users/me/docs/round.pdf';
  const res = markerStore.save(dir, abs, [MARKER]);
  assert.equal(res.count, 1);
  assert.equal(res.deleted, false);
  assert.deepEqual(markerStore.load(dir, abs), [MARKER]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('저장 파일에는 format/version/path 메타가 담긴다', () => {
  const dir = tmpDir();
  const abs = path.join(dir, 'meta.pdf');
  markerStore.save(dir, abs, [MARKER]);
  const raw = JSON.parse(fs.readFileSync(markerStore.filePathFor(dir, abs), 'utf8'));
  assert.equal(raw.format, 'wcompare-markers');
  assert.equal(raw.version, 1);
  assert.equal(raw.path, path.resolve(abs));
  assert.equal(typeof raw.savedAt, 'string');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sanitize 적용: 초과 마커 수와 범위 밖 좌표를 걸러/클램프한다', () => {
  const dir = tmpDir();
  const abs = '/x/sanitize.pdf';
  // 5000개 상한 초과
  const many = Array.from({ length: 6000 }, (_, i) => ({ ...MARKER, id: `mk${i}`, page: 1 }));
  markerStore.save(dir, abs, many);
  assert.equal(markerStore.load(dir, abs).length, 5000, '5000개로 상한');

  // 범위 밖 좌표는 0~1로 클램프, 알 수 없는 종류는 제거
  const dirty = [
    { kind: 'evil', page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] },
    { kind: 'underline', page: 2, rects: [{ x: -5, y: 9, w: 2, h: 0.5 }] },
  ];
  markerStore.save(dir, abs, dirty);
  const clean = markerStore.load(dir, abs);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].kind, 'underline');
  assert.deepEqual(clean[0].rects, [{ x: 0, y: 1, w: 1, h: 0.5 }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('빈 배열 저장 시 파일을 삭제한다(정리)', () => {
  const dir = tmpDir();
  const abs = '/x/empty.pdf';
  markerStore.save(dir, abs, [MARKER]);
  assert.equal(fs.existsSync(markerStore.filePathFor(dir, abs)), true);

  const res = markerStore.save(dir, abs, []);
  assert.equal(res.deleted, true);
  assert.equal(res.count, 0);
  assert.equal(fs.existsSync(markerStore.filePathFor(dir, abs)), false, '빈 저장 → 파일 삭제');
  // 없는 파일에 빈 저장을 다시 해도 예외 없이 통과
  assert.doesNotThrow(() => markerStore.save(dir, abs, []));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sanitize 후 유효 마커가 0개면 저장이 아니라 삭제로 처리된다', () => {
  const dir = tmpDir();
  const abs = '/x/allbad.pdf';
  markerStore.save(dir, abs, [MARKER]);
  // 전부 불량 → 정화 후 0개 → 파일 삭제
  const res = markerStore.save(dir, abs, [{ kind: 'evil', page: 1, rects: [] }, null]);
  assert.equal(res.deleted, true);
  assert.equal(fs.existsSync(markerStore.filePathFor(dir, abs)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('원자 기록: 저장 후 .tmp 잔존이 없다', () => {
  const dir = tmpDir();
  const abs = '/x/atomic.pdf';
  markerStore.save(dir, abs, [MARKER]);
  const leftover = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, [], 'tmp 파일이 남지 않아야 한다');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('깨진 JSON을 로드하면 빈 배열을 돌려준다(열기 흐름을 막지 않는다)', () => {
  const dir = tmpDir();
  const abs = '/x/broken.pdf';
  fs.writeFileSync(markerStore.filePathFor(dir, abs), '{ not json');
  assert.deepEqual(markerStore.load(dir, abs), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('없는 파일을 로드하면 빈 배열을 돌려준다', () => {
  const dir = tmpDir();
  assert.deepEqual(markerStore.load(dir, '/x/missing.pdf'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
