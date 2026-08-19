const test = require('node:test');
const assert = require('node:assert');
const {
  nextBuildVersion, readBuildVersion, windowTitle, isValid, today, UNKNOWN,
} = require('../src/main/version.js');

test('nextBuildVersion: 같은 날이면 순번을 올린다', () => {
  assert.strictEqual(nextBuildVersion('2026-08-19-001', '2026-08-19'), '2026-08-19-002');
  assert.strictEqual(nextBuildVersion('2026-08-19-009', '2026-08-19'), '2026-08-19-010');
  assert.strictEqual(nextBuildVersion('2026-08-19-099', '2026-08-19'), '2026-08-19-100');
});

test('nextBuildVersion: 날이 바뀌면 001부터 다시 센다', () => {
  assert.strictEqual(nextBuildVersion('2026-08-19-042', '2026-08-20'), '2026-08-20-001');
  // 과거로 되돌린 시계에서도 그날 기준으로 셈한다 — 미래 날짜를 이어받지 않는다
  assert.strictEqual(nextBuildVersion('2026-09-01-005', '2026-08-19'), '2026-08-19-001');
});

test('nextBuildVersion: 값이 없거나 망가졌으면 오늘 001로 시작한다', () => {
  // 망가진 값 하나로 패키징이 멈추는 것보다 새로 세는 편이 낫다
  for (const bad of [undefined, null, '', '  ', 'v1.2.3', '2026-8-9-1', '2026-08-19', {}]) {
    assert.strictEqual(nextBuildVersion(bad, '2026-08-19'), '2026-08-19-001');
  }
});

test('nextBuildVersion: 순번이 세 자리를 넘으면 자리수가 늘 뿐 깨지지 않는다', () => {
  assert.strictEqual(nextBuildVersion('2026-08-19-999', '2026-08-19'), '2026-08-19-1000');
});

test('nextBuildVersion: 결과는 언제나 스스로 유효하다', () => {
  // 다음 빌드가 이번 결과를 다시 입력으로 받으므로, 이 성질이 깨지면 순번이 매일 1로 굳는다
  let v = 'rubbish';
  for (let i = 0; i < 5; i += 1) {
    v = nextBuildVersion(v, '2026-08-19');
    assert.ok(isValid(v), `${v} 가 유효하지 않다`);
  }
  assert.strictEqual(v, '2026-08-19-005');
});

test('today: 로컬 날짜를 0채움 yyyy-mm-dd로 낸다', () => {
  // UTC로 계산하면 한국 시간 오전 9시 이전 빌드가 전날로 찍힌다
  assert.strictEqual(today(new Date(2026, 0, 5, 3, 0, 0)), '2026-01-05');
  assert.strictEqual(today(new Date(2026, 11, 31, 23, 59, 0)), '2026-12-31');
});

test('readBuildVersion: package.json의 값을 읽는다', () => {
  const v = readBuildVersion();
  assert.ok(isValid(v), `package.json의 buildVersion이 형식에 맞지 않는다: ${v}`);
});

test('readBuildVersion: 파일이 없으면 눈에 띄는 표식을 낸다', () => {
  // 조용히 빈 문자열을 내면 제목에 아무것도 안 붙어, 기능이 죽은 것을 알 길이 없다
  assert.strictEqual(readBuildVersion('/nonexistent/package.json'), UNKNOWN);
  assert.ok(UNKNOWN.length > 0);
});

test('windowTitle: 이름 뒤에 공백 하나로 버전을 붙인다', () => {
  assert.strictEqual(windowTitle('2026-08-19-003'), 'wcompare 2026-08-19-003');
});
