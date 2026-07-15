const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSettingsStore } = require('../src/main/settingsStore.js');

const DEFAULTS = {
  storageDir: path.join(os.homedir(), '.local', 'wcompare'),
  archivePdfOnOpen: false,
  keepTranslationsInStorage: false,
};

const store = (name = 'settings.json') =>
  createSettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-set-')), name), DEFAULTS);

test('파일이 없으면 defaults를 돌려준다', () => {
  const s = store();
  assert.deepEqual(s.get(), DEFAULTS);
});

test('set 왕복: 저장한 값이 그대로 읽힌다', () => {
  const s = store();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-storage-'));
  const res = s.set({ storageDir: dir, archivePdfOnOpen: true, keepTranslationsInStorage: true });
  assert.equal(res.storageDir, dir);
  assert.equal(res.archivePdfOnOpen, true);
  assert.equal(res.keepTranslationsInStorage, true);
  assert.deepEqual(s.get(), res, '다시 읽어도 같다');
});

test('부분 set은 나머지 키를 보존한다', () => {
  const s = store();
  s.set({ archivePdfOnOpen: true });
  const after = s.set({ keepTranslationsInStorage: true });
  assert.equal(after.archivePdfOnOpen, true, '이전에 켠 값이 유지됨');
  assert.equal(after.keepTranslationsInStorage, true);
});

test('알 수 없는 키는 무시한다', () => {
  const s = store();
  const res = s.set({ hacker: '/etc/passwd', archivePdfOnOpen: true });
  assert.equal(res.hacker, undefined, '허용 목록에 없는 키는 저장되지 않는다');
  assert.equal(res.archivePdfOnOpen, true);
  assert.deepEqual(Object.keys(s.get()).sort(), Object.keys(DEFAULTS).sort());
});

test('boolean 아닌 값은 거부하고 기본값을 유지한다', () => {
  const s = store();
  const res = s.set({ archivePdfOnOpen: 'yes', keepTranslationsInStorage: 1 });
  assert.equal(res.archivePdfOnOpen, false, '문자열은 거부');
  assert.equal(res.keepTranslationsInStorage, false, '숫자는 거부');
});

test('storageDir은 절대경로 문자열만 허용한다', () => {
  const s = store();
  const res = s.set({ storageDir: 'relative/path' });
  assert.equal(res.storageDir, DEFAULTS.storageDir, '상대경로는 거부하고 기본값 유지');
});

test('깨진 JSON에서도 죽지 않고 defaults를 돌려준다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-set-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ 이건 JSON이 아니다');
  const s = createSettingsStore(file, DEFAULTS);
  assert.deepEqual(s.get(), DEFAULTS, '조용히 기본값으로 복구');
  const after = s.set({ archivePdfOnOpen: true });
  assert.equal(after.archivePdfOnOpen, true, '그 뒤로는 정상 동작');
});

test('원자 기록: 임시파일을 남기지 않고 파일 하나만 만든다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-set-'));
  const file = path.join(dir, 'settings.json');
  const s = createSettingsStore(file, DEFAULTS);
  s.set({ archivePdfOnOpen: true });
  assert.ok(fs.existsSync(file), 'settings.json 생성됨');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'rename 후 .tmp는 남지 않는다');
});
