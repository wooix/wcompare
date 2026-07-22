// test/projectSaveDecision.test.js — 저장 판정 순수 모듈 + 백업/원자 기록 fs 테스트.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decide, sanitizeName, pairsEqual, uniqueName, writeProjectFile } =
  require('../src/main/projectSaveDecision.js');

const PROJ = '/store/projects';
const id = (p) => p; // norm 자리에 넣을 항등 함수(문자열 그대로 비교)
// exists를 "존재하는 절대경로 집합"으로 흉내 낸다.
const existsFrom = (set) => (p) => set.has(p);

// 공통 입력 뼈대
function input(over = {}) {
  return {
    name: undefined, saveAs: false, curPath: null,
    snapshot: { files: { left: '/a.pdf', right: '/b.pdf' } },
    projectsDir: PROJ, ext: 'wcproj', ...over,
  };
}
function deps(over = {}) {
  return { exists: () => false, readPair: () => ({ left: null, right: null }), norm: id, ...over };
}

// ===== Case B: 조용한 재저장 =====
test('같은 파일 쌍이면 cur에 조용히 재저장한다(write + backup)', () => {
  const cur = path.join(PROJ, 'p.wcproj');
  const plan = decide(
    input({ curPath: cur, snapshot: { files: { left: '/a.pdf', right: '/b.pdf' } } }),
    deps({ readPair: () => ({ left: '/a.pdf', right: '/b.pdf' }) }),
  );
  assert.deepEqual(plan, { action: 'write', target: cur, backup: true });
});

test('파일 쌍이 바뀌면(사실상 다른 프로젝트) 기존 파일을 건드리지 않고 needName', () => {
  const cur = path.join(PROJ, 'p.wcproj');
  const plan = decide(
    input({ curPath: cur, snapshot: { files: { left: '/c.pdf', right: '/b.pdf' } } }),
    deps({ readPair: () => ({ left: '/a.pdf', right: '/b.pdf' }) }),
  );
  assert.equal(plan.action, 'needName');
});

test('한쪽만 바뀌어도(null↔파일) 다른 프로젝트로 보고 needName', () => {
  const cur = path.join(PROJ, 'p.wcproj');
  const plan = decide(
    input({ curPath: cur, snapshot: { files: { left: '/a.pdf', right: null } } }),
    deps({ readPair: () => ({ left: '/a.pdf', right: '/b.pdf' }) }),
  );
  assert.equal(plan.action, 'needName');
});

test('cur 파일 읽기 실패(삭제·손상)면 needName', () => {
  const cur = path.join(PROJ, 'p.wcproj');
  const plan = decide(
    input({ curPath: cur }),
    deps({ readPair: () => { throw new Error('ENOENT'); } }),
  );
  assert.equal(plan.action, 'needName');
});

test('cur이 보관 폴더 밖(레거시)이면 읽지도 않고 needName', () => {
  let read = false;
  const plan = decide(
    input({ curPath: '/outside/legacy.wcproj' }),
    deps({ readPair: () => { read = true; throw new Error('x'); } }),
  );
  assert.equal(plan.action, 'needName');
  assert.equal(read, false, '레거시 경로는 파일을 읽지 않는다');
});

test('saveAs면 cur이 같은 쌍이어도 needName(항상 이름 확정을 거친다)', () => {
  const cur = path.join(PROJ, 'p.wcproj');
  const plan = decide(
    input({ saveAs: true, curPath: cur }),
    deps({ readPair: () => ({ left: '/a.pdf', right: '/b.pdf' }) }),
  );
  assert.equal(plan.action, 'needName');
});

// ===== Case A: 이름 지정 저장 =====
test('이름 지정 + 대상 없음 → 확인 없이 write(backup:false)', () => {
  const plan = decide(input({ name: 'new' }), deps({ exists: () => false }));
  assert.deepEqual(plan, { action: 'write', target: path.join(PROJ, 'new.wcproj'), backup: false });
});

test('이름 지정 + 대상이 이미 있고 cur과 다르면 → confirm', () => {
  const target = path.join(PROJ, 'other.wcproj');
  const plan = decide(
    input({ name: 'other', curPath: path.join(PROJ, 'p.wcproj') }),
    deps({ exists: existsFrom(new Set([target])) }),
  );
  assert.deepEqual(plan, { action: 'confirm', target });
});

test('이름 지정 + 대상이 cur과 같으면 → 확인 없이 write(backup:true)', () => {
  const cur = path.join(PROJ, 'p.wcproj');
  const plan = decide(
    input({ name: 'p', curPath: cur }),
    deps({ exists: existsFrom(new Set([cur])) }),
  );
  assert.deepEqual(plan, { action: 'write', target: cur, backup: true });
});

test('이름 정화 실패(구분자/../빈값)는 needName으로 떨어진다', () => {
  for (const bad of ['a/b', 'a\\b', '..', '   ', '']) {
    const plan = decide(input({ name: bad }), deps());
    assert.equal(plan.action, 'needName', `"${bad}" → needName`);
  }
});

// ===== suggest 유니크화 =====
test('suggest가 기존 파일과 겹치면 " 2"로 유니크하게 만든다', () => {
  const taken = new Set([path.join(PROJ, 'report.wcproj')]);
  const plan = decide(
    input({ snapshot: { files: { left: '/x/report.pdf', right: null } } }),
    deps({ exists: existsFrom(taken) }),
  );
  assert.deepEqual(plan, { action: 'needName', suggest: 'report 2' });
});

test('suggest: cur 이름 기반, 겹치지 않으면 그대로', () => {
  const plan = decide(
    input({ saveAs: true, curPath: path.join(PROJ, 'chap.wcproj') }),
    deps({ exists: () => false }),
  );
  assert.equal(plan.suggest, 'chap');
});

// ===== 순수 헬퍼 단위 =====
test('sanitizeName: trim 후 통과, 불량은 null', () => {
  assert.equal(sanitizeName('  hello  '), 'hello');
  assert.equal(sanitizeName('a/b'), null);
  assert.equal(sanitizeName('a\\b'), null);
  assert.equal(sanitizeName('..'), null);
  assert.equal(sanitizeName('a..b'), null);
  assert.equal(sanitizeName('.'), null); // '.' → '..wcproj'로 isInside 판정이 어긋나는 엣지
  assert.equal(sanitizeName('.hidden'), '.hidden'); // 점을 포함하는 일반 이름은 통과
  assert.equal(sanitizeName('x\0y'), null);
  assert.equal(sanitizeName('   '), null);
  assert.equal(sanitizeName(''), null);
  assert.equal(sanitizeName('a'.repeat(81)), null);
  assert.equal(sanitizeName(123), null);
});

test('pairsEqual: null끼리 같음 / 한쪽만 있으면 다름 / norm 적용', () => {
  assert.equal(pairsEqual({ left: null, right: null }, { left: null, right: null }, id), true);
  assert.equal(pairsEqual({ left: '/a', right: null }, { left: null, right: null }, id), false);
  assert.equal(pairsEqual({ left: '/a', right: '/b' }, { left: '/a', right: '/b' }, id), true);
  // norm이 두 경로를 같게 만들면 같다고 본다(realpath 차이 흡수)
  const norm = (p) => p.replace('/private', '');
  assert.equal(pairsEqual({ left: '/private/a', right: null }, { left: '/a', right: null }, norm), true);
});

test('uniqueName: 겹치면 뒤에 숫자, 처음이 비면 그대로', () => {
  assert.equal(uniqueName('base', () => false), 'base');
  const taken = new Set(['base', 'base 2']);
  assert.equal(uniqueName('base', (n) => taken.has(n)), 'base 3');
});

// ===== writeProjectFile: 백업(1개 로테이션) + 원자 기록 =====
test('writeProjectFile: 새 파일은 tmp+rename으로만 쓰고 .bak/.tmp를 남기지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-wr-'));
  const target = path.join(dir, 'p.wcproj');
  writeProjectFile(target, 'FIRST', { backup: false });
  assert.equal(fs.readFileSync(target, 'utf8'), 'FIRST');
  assert.ok(!fs.existsSync(`${target}.bak`), '새 파일엔 .bak이 없다');
  assert.ok(!fs.existsSync(`${target}.tmp`), 'rename 후 .tmp는 없다');
});

test('writeProjectFile: 덮어쓰기는 먼저 .bak으로 복사한 뒤 원자 기록한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-wr-'));
  const target = path.join(dir, 'p.wcproj');
  writeProjectFile(target, 'OLD', { backup: false });
  writeProjectFile(target, 'NEW', { backup: true });
  assert.equal(fs.readFileSync(target, 'utf8'), 'NEW', '본문은 새 내용');
  assert.equal(fs.readFileSync(`${target}.bak`, 'utf8'), 'OLD', '.bak은 직전 내용');
  assert.ok(!fs.existsSync(`${target}.tmp`), '.tmp는 남지 않는다');
});

test('writeProjectFile: 백업은 1개만 유지한다(.bak을 덮어쓴다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-wr-'));
  const target = path.join(dir, 'p.wcproj');
  writeProjectFile(target, 'V1', { backup: false });
  writeProjectFile(target, 'V2', { backup: true }); // .bak = V1
  writeProjectFile(target, 'V3', { backup: true }); // .bak = V2 (V1은 사라진다)
  assert.equal(fs.readFileSync(target, 'utf8'), 'V3');
  assert.equal(fs.readFileSync(`${target}.bak`, 'utf8'), 'V2', '.bak은 항상 직전 1개');
  assert.ok(!fs.existsSync(`${target}.bak.bak`), '.bak.bak 같은 누적은 없다');
});

test('writeProjectFile: backup:true여도 대상이 없으면 .bak을 만들지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-wr-'));
  const target = path.join(dir, 'p.wcproj');
  writeProjectFile(target, 'ONLY', { backup: true });
  assert.equal(fs.readFileSync(target, 'utf8'), 'ONLY');
  assert.ok(!fs.existsSync(`${target}.bak`), '없던 파일엔 백업할 것도 없다');
});
