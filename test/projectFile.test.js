const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { serialize, parse, sanitizeMarkers } = require('../src/main/projectFile.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wc-proj-')); }
function touch(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; }

const MARKER = { id: 'mk1', page: 3, kind: 'highlight', color: '#ffd64a', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }] };

test('왕복: 저장한 뒤 그대로 읽힌다', () => {
  const dir = tmpDir();
  const left = touch(path.join(dir, 'a.pdf'));
  const right = touch(path.join(dir, 'b.pdf'));
  const proj = path.join(dir, 'p.wcproj');

  const snap = {
    mode: 'pdf',
    files: { left, right },
    view: { sync: false, fit: false, page: { left: 7, right: 7 } },
    markers: { left: [MARKER], right: [] },
  };
  fs.writeFileSync(proj, serialize(snap, proj));
  const got = parse(fs.readFileSync(proj, 'utf8'), proj);

  assert.equal(got.mode, 'pdf');
  assert.equal(got.files.left.path, left);
  assert.equal(got.files.left.missing, false);
  assert.equal(got.files.right.path, right);
  assert.deepEqual(got.view, { sync: false, fit: false, page: { left: 7, right: 7 } });
  assert.deepEqual(got.markers.left, [MARKER]);
  assert.deepEqual(got.markers.right, []);
});

test('프로젝트와 파일이 함께 옮겨가도 상대경로로 찾아낸다', () => {
  const a = tmpDir(); const b = tmpDir();
  const proj = path.join(a, 'p.wcproj');
  touch(path.join(a, 'docs', 'x.pdf'));
  fs.writeFileSync(proj, serialize({
    mode: 'pdf', files: { left: path.join(a, 'docs', 'x.pdf'), right: null },
  }, proj));

  // 폴더째 다른 곳으로 복사 (절대경로는 이제 원래 자리를 가리킨다)
  fs.cpSync(a, b, { recursive: true });
  fs.rmSync(a, { recursive: true, force: true }); // 원래 자리를 없앤다 → abs는 실패해야 한다

  const moved = path.join(b, 'p.wcproj');
  const got = parse(fs.readFileSync(moved, 'utf8'), moved);
  assert.equal(got.files.left.missing, false, '상대경로로 찾아야 한다');
  assert.equal(got.files.left.path, path.join(b, 'docs', 'x.pdf'));
});

test('파일이 없으면 missing으로 표시하되 열기 자체는 실패하지 않는다', () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'p.wcproj');
  fs.writeFileSync(proj, serialize({ mode: 'pdf', files: { left: path.join(dir, 'gone.pdf'), right: null } }, proj));
  const got = parse(fs.readFileSync(proj, 'utf8'), proj);
  assert.equal(got.files.left.missing, true);
  assert.equal(got.files.right, null);
});

test('wcompare 프로젝트가 아니면 거부', () => {
  assert.throws(() => parse('{"format":"other","version":1}', '/x/p.wcproj'), /프로젝트 파일이 아닙니다/);
  assert.throws(() => parse('not json', '/x/p.wcproj'), /JSON 형식 오류/);
});

test('상위 버전은 열지 않는다 (관대하게 열면 모르는 필드가 조용히 유실된다)', () => {
  assert.throws(
    () => parse('{"format":"wcompare-project","version":99}', '/x/p.wcproj'),
    /더 새로운 버전/,
  );
});

test('마커 검증: 신뢰할 수 없는 입력을 전부 걸러낸다', () => {
  const dirty = [
    { kind: 'evil', page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] },        // 알 수 없는 종류
    { kind: 'highlight', page: 0, rects: [{ x: 0, y: 0, w: 1, h: 1 }] },   // 페이지 0
    { kind: 'highlight', page: 2, rects: [] },                              // rect 없음
    { kind: 'highlight', page: 2, rects: [{ x: 0, y: 0, w: 0, h: 0 }] },   // 크기 0
    { kind: 'underline', page: 2, rects: [{ x: -5, y: 9, w: 2, h: 0.5 }] }, // 범위 밖 → clamp
    null,
  ];
  const clean = sanitizeMarkers(dirty);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].kind, 'underline');
  assert.deepEqual(clean[0].rects, [{ x: 0, y: 1, w: 1, h: 0.5 }], '0~1로 clamp');
});

test('2MB를 초과하는 프로젝트는 저장(직렬화) 단계에서 거부한다', () => {
  // 마커 5000개×rect 500개 상한만으로는 2MB를 못 막는다 — rect 하나가 pretty-print로 ~100바이트라
  // 마커 수십 개(각 500 rects)면 이미 넘는다. 저장을 허용하면 "다시 열 수 없는 파일"이 생긴다.
  const markers = Array.from({ length: 60 }, (_, i) => ({
    id: `mk${i}`, page: i + 1, kind: 'highlight', color: '#ffd64a',
    rects: Array.from({ length: 500 }, () => ({ x: 0.123456, y: 0.234567, w: 0.345678, h: 0.045678 })),
  }));
  assert.throws(
    () => serialize({ mode: 'pdf', files: { left: '/x/a.pdf', right: null }, markers: { left: markers, right: [] } }, '/x/p.wcproj'),
    /2MB/,
  );
});

test('v2: 미러 마커의 group/origin이 보존되고 검증된다', () => {
  const dirty = [
    { ...MARKER, group: 'g'.padEnd(80, 'x'), origin: 'mirror' }, // 과대 group은 64자로 자름
    { ...MARKER, id: 'mk2', origin: 'evil' },                     // 알 수 없는 origin은 버림
    { ...MARKER, id: 'mk3' },                                     // 필드 없으면 만들지 않음(v1 왕복 동일)
  ];
  const clean = sanitizeMarkers(dirty);
  assert.equal(clean[0].group.length, 64);
  assert.equal(clean[0].origin, 'mirror');
  assert.ok(!('origin' in clean[1]));
  assert.ok(!('group' in clean[2]) && !('origin' in clean[2]));
});

test('v1 프로젝트는 v2 앱에서 그대로 열린다', () => {
  const text = JSON.stringify({
    format: 'wcompare-project', version: 1, mode: 'pdf',
    files: { left: null, right: null }, view: {},
    markers: { left: [MARKER], right: [] },
  });
  const got = parse(text, '/x/p.wcproj');
  assert.deepEqual(got.markers.left, [MARKER]);
});

test('마커 개수/rect 상한으로 파서 DoS를 막는다', () => {
  const many = Array.from({ length: 9000 }, () => ({ ...MARKER }));
  assert.equal(sanitizeMarkers(many).length, 5000);
  const fat = [{ ...MARKER, rects: Array.from({ length: 900 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 })) }];
  assert.equal(sanitizeMarkers(fat)[0].rects.length, 500);
});
