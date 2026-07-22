const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRecents } = require('../src/main/recentProjects.js');

const store = () => createRecents(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-rec-')), 'recent.json'));

test('최근 목록은 최신이 앞에 오고 10개를 넘지 않는다', () => {
  const r = store();
  for (let i = 1; i <= 13; i++) r.add(`/p/proj${i}.wcproj`);
  const items = r.list();
  assert.equal(items.length, 10);
  assert.equal(items[0].path, '/p/proj13.wcproj', '가장 최근이 맨 앞');
  assert.equal(items[9].path, '/p/proj4.wcproj', '오래된 3개는 밀려남');
});

test('같은 프로젝트를 다시 열면 중복되지 않고 맨 앞으로 온다', () => {
  const r = store();
  r.add('/p/a.wcproj');
  r.add('/p/b.wcproj');
  r.add('/p/a.wcproj');
  const items = r.list();
  assert.equal(items.length, 2);
  assert.equal(items[0].path, '/p/a.wcproj');
});

test('id로만 경로를 되찾을 수 있다 (렌더러는 경로를 모른다)', () => {
  const r = store();
  r.add('/p/a.wcproj');
  const { id } = r.list()[0];
  assert.equal(r.pathOf(id), '/p/a.wcproj');
  assert.equal(r.pathOf('없는-id'), null);
});

test('제거와 비우기', () => {
  const r = store();
  r.add('/p/a.wcproj'); r.add('/p/b.wcproj');
  r.remove(r.list().find((x) => x.path === '/p/a.wcproj').id);
  assert.deepEqual(r.list().map((x) => x.path), ['/p/b.wcproj']);
  r.clear();
  assert.deepEqual(r.list(), []);
});

test('목록 파일이 깨져 있어도 앱이 죽지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-rec-'));
  const file = path.join(dir, 'recent.json');
  fs.writeFileSync(file, '{ 이건 JSON이 아니다');
  const r = createRecents(file);
  assert.deepEqual(r.list(), [], '조용히 빈 목록으로 복구');
  r.add('/p/a.wcproj');
  assert.equal(r.list().length, 1, '그 뒤로는 정상 동작');
});

test('없는 파일을 읽어도 빈 목록', () => {
  const r = createRecents('/definitely/not/here/recent.json');
  assert.deepEqual(r.list(), []);
});
