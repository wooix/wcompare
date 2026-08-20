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
  shortcuts: { dict: 'Cmd+D', fit: 'Alt+F', sync: 'Alt+S', night: 'Alt+N', switch: 'Alt+ArrowRight' },
  translate: { engine: 'agy', agyModel: '', claudeModel: '', agyModels: [], claudeModels: ['sonnet', 'opus', 'haiku'] },
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

// ===== shortcuts (object 타입 키) =====
test('shortcuts: 부분 patch는 나머지 액션을 보존한다', () => {
  const s = store();
  const after = s.set({ shortcuts: { fit: 'Cmd+F' } });
  assert.equal(after.shortcuts.fit, 'Cmd+F', '준 값은 반영');
  assert.equal(after.shortcuts.dict, 'Cmd+D', '안 준 액션은 기본값 보존');
  assert.equal(after.shortcuts.switch, 'Alt+ArrowRight');
  assert.deepEqual(s.get().shortcuts, after.shortcuts, '다시 읽어도 같다');
});

test('shortcuts: 두 번의 부분 patch가 누적된다', () => {
  const s = store();
  s.set({ shortcuts: { fit: 'Cmd+F' } });
  const after = s.set({ shortcuts: { sync: 'Cmd+S' } });
  assert.equal(after.shortcuts.fit, 'Cmd+F', '이전 patch 유지');
  assert.equal(after.shortcuts.sync, 'Cmd+S');
});

test('shortcuts: 알 수 없는 하위 키는 무시한다', () => {
  const s = store();
  const after = s.set({ shortcuts: { hacker: 'Cmd+X', dict: 'Cmd+K' } });
  assert.equal(after.shortcuts.hacker, undefined, '허용 목록에 없는 하위 키는 버린다');
  assert.equal(after.shortcuts.dict, 'Cmd+K');
  assert.deepEqual(Object.keys(after.shortcuts).sort(), Object.keys(DEFAULTS.shortcuts).sort());
});

test('shortcuts: 비문자열 하위값은 거부하고 기존값을 유지한다', () => {
  const s = store();
  const after = s.set({ shortcuts: { dict: 123, fit: null, sync: 'Alt+X' } });
  assert.equal(after.shortcuts.dict, 'Cmd+D', '숫자는 거부');
  assert.equal(after.shortcuts.fit, 'Alt+F', 'null은 거부');
  assert.equal(after.shortcuts.sync, 'Alt+X', '문자열은 통과');
});

test('shortcuts: 빈 문자열은 허용한다(단축키 없음)', () => {
  const s = store();
  const after = s.set({ shortcuts: { dict: '' } });
  assert.equal(after.shortcuts.dict, '', '빈 문자열 = 단축키 해제');
});

test('shortcuts: shortcuts가 object가 아니면 무시한다', () => {
  const s = store();
  const after = s.set({ shortcuts: 'not-an-object' });
  assert.deepEqual(after.shortcuts, DEFAULTS.shortcuts, '문자열 patch는 기본값 유지');
});

// ===== translate (object 하위값으로 문자열 배열을 허용) =====
test('translate: 문자열 배열 하위값(agyModels)을 통째로 교체한다', () => {
  const s = store();
  const after = s.set({ translate: { agyModels: ['a', 'b'] } });
  assert.deepEqual(after.translate.agyModels, ['a', 'b']);
  assert.equal(after.translate.engine, 'agy', '건드리지 않은 하위값은 기본값 보존');
  assert.deepEqual(s.get().translate.agyModels, ['a', 'b'], '다시 읽어도 같다');

  const replaced = s.set({ translate: { agyModels: ['c'] } });
  assert.deepEqual(replaced.translate.agyModels, ['c'], '이전 원소는 남지 않고 통째로 교체된다');
});

test('translate: 원소가 문자열이 아닌 배열은 거부하고 기존값을 유지한다', () => {
  const s = store();
  s.set({ translate: { claudeModels: ['x'] } });
  const after = s.set({ translate: { claudeModels: ['ok', 123, null] } });
  assert.deepEqual(after.translate.claudeModels, ['x'], '원소 하나라도 문자열이 아니면 배열 전체를 거부');
});

test('translate: 문자열 하위값(agyModel/engine)은 기존 shortcuts와 동일하게 문자열만 허용한다', () => {
  const s = store();
  const after = s.set({ translate: { engine: 'claude', agyModel: 'gemini-3.6-flash-low', claudeModel: 42 } });
  assert.equal(after.translate.engine, 'claude');
  assert.equal(after.translate.agyModel, 'gemini-3.6-flash-low');
  assert.equal(after.translate.claudeModel, '', '숫자는 거부하고 기본값 유지');
});

test('원자 기록: 임시파일을 남기지 않고 파일 하나만 만든다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-set-'));
  const file = path.join(dir, 'settings.json');
  const s = createSettingsStore(file, DEFAULTS);
  s.set({ archivePdfOnOpen: true });
  assert.ok(fs.existsSync(file), 'settings.json 생성됨');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'rename 후 .tmp는 남지 않는다');
});

// ===== object 키 하위의 불리언 =====
// 토글 설정(ui.wordWrap 같은)은 불리언이 자연스러운데, 하위값 검사가 문자열과 문자열
// 배열만 통과시키면 set이 조용히 무시된다. 오류도 안 나고 저장만 안 되므로, 창을 새로
// 열 때마다 토글이 초기화되는 형태로만 드러난다 — 여기서 잡는다.
const UI_DEFAULTS = {
  storageDir: DEFAULTS.storageDir,
  ui: { theme: 'dark', wordWrap: false },
};
const uiStore = () =>
  createSettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ui-')), 'settings.json'),
                      UI_DEFAULTS);

test('object 키: 불리언 하위값이 저장되고 다시 읽힌다', () => {
  const s = uiStore();
  const after = s.set({ ui: { wordWrap: true } });
  assert.equal(after.ui.wordWrap, true, 'set 결과에 반영되지 않았다');
  assert.equal(s.get().ui.wordWrap, true, '파일에서 다시 읽으면 사라졌다');
  assert.equal(after.ui.theme, 'dark', '형제 키는 보존');
});

test('object 키: 불리언 자리에 딴 타입이 오면 무시한다', () => {
  // 타입 검사를 통째로 여는 게 아니라, defaults의 타입과 같을 때만 받는 규칙은 유지한다.
  const s = uiStore();
  s.set({ ui: { wordWrap: true } });
  const after = s.set({ ui: { wordWrap: 'yes' } });
  assert.equal(after.ui.wordWrap, true, '문자열이 불리언 자리를 덮어썼다');
});

test('object 키: 불리언 하위값을 다시 끌 수 있다', () => {
  // false는 "값 없음"이 아니다. falsy라는 이유로 건너뛰면 한 번 켠 뒤 끌 수 없게 된다.
  const s = uiStore();
  s.set({ ui: { wordWrap: true } });
  assert.equal(s.set({ ui: { wordWrap: false } }).ui.wordWrap, false);
  assert.equal(s.get().ui.wordWrap, false);
});
