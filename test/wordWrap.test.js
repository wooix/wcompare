// 비교 모드 줄바꿈 토글의 순수 부분.
// 토글은 세 곳에서 눌린다 — 툴바 버튼, View 메뉴, 시작 시 설정 복원. 셋이 각자
// 옵션을 만들면 어긋나므로(하나만 wrappingIndent를 빼먹는 식) 여기 한 곳으로 모은다.
const { test } = require('node:test');
const assert = require('node:assert');
const { normalize, editorOptions, buttonLabel } = require('../src/renderer/wordWrap.js');

test('normalize: 설정에 값이 없으면 꺼짐', () => {
  // 없는 설정 하나 때문에 시작이 막히면 안 된다 — 모르면 지금까지의 동작(끔)을 유지한다.
  for (const v of [undefined, null]) assert.strictEqual(normalize(v), false);
});

test('normalize: 불리언은 그대로', () => {
  assert.strictEqual(normalize(true), true);
  assert.strictEqual(normalize(false), false);
});

test('normalize: 손으로 고친 설정 파일의 이상한 값도 견딘다', () => {
  // settings.json은 사람이 열어 고칠 수 있는 파일이다. 'on'을 참으로 읽어 주면
  // 의도대로 켜지고, 나머지는 꺼짐으로 떨어뜨려 예외 없이 시작한다.
  assert.strictEqual(normalize('on'), true);
  assert.strictEqual(normalize('off'), false);
  assert.strictEqual(normalize('아무말'), false);
  assert.strictEqual(normalize(0), false);
  assert.strictEqual(normalize({}), false);
});

test('editorOptions: 켜면 화면 폭에서 접고, 이어진 줄은 들여쓴다', () => {
  // wrappingIndent가 없으면 이어진 줄이 원줄과 같은 위치에서 시작해, 새 논리 줄인지
  // 접힌 줄인지 눈으로 구분되지 않는다.
  assert.deepStrictEqual(editorOptions(true), {
    wordWrap: 'on', wrappingIndent: 'indent', diffWordWrap: 'on',
    wordWrapOverride2: 'inherit',
  });
});

test('editorOptions: 끄면 예전 그대로 접지 않는다', () => {
  assert.deepStrictEqual(editorOptions(false), {
    wordWrap: 'off', wrappingIndent: 'none', diffWordWrap: 'off',
    wordWrapOverride2: 'inherit',
  });
});

test('editorOptions: 원본 쪽에 박혀 있는 override를 풀어 준다', () => {
  // Monaco의 우선순위는 wordWrapOverride2 > wordWrapOverride1 > wordWrap이다.
  // diff 편집기는 side-by-side가 아닐 때 두 override를 'off'로 박는데(창이 아직 좁던
  // 시작 순간에도 그렇다), 다시 side-by-side가 되면 override1만 되돌린다. 그래서
  // 원본 쪽 override2가 'off'로 남아 wordWrap='on'을 통째로 이겨 버린다 — 실측으로
  // 확인했다(왼쪽 ov2:'off' / 오른쪽 ov2:'inherit'). 우리가 직접 풀어 준다.
  for (const on of [true, false]) {
    assert.strictEqual(editorOptions(on).wordWrapOverride2, 'inherit');
  }
});

test('editorOptions: diffWordWrap이 있어야 양쪽이 함께 접힌다', () => {
  // diff 편집기는 양쪽 하위 편집기의 wordWrapOverride1에 diffWordWrap을 씌운다
  // (monaco diffEditorEditors.js). 그래서 wordWrap만 주면 override가 그대로 남아
  // 한쪽이 안 접히고, 줄 수가 어긋나 빗금 채움이 생긴다.
  for (const on of [true, false]) {
    assert.strictEqual(editorOptions(on).diffWordWrap, editorOptions(on).wordWrap,
      'diffWordWrap과 wordWrap이 어긋나면 한쪽만 접힌다');
  }
});

test('editorOptions: 끌 때 wordWrap만 되돌리면 들여쓰기가 남는다', () => {
  // updateOptions는 준 키만 바꾼다. 켤 때 wrappingIndent를 넣었으면 끌 때도 되돌려야
  // 한다 — 안 그러면 접지 않는데 들여쓰기 설정만 남아 다음에 켤 때 상태가 뒤엉킨다.
  assert.ok('wrappingIndent' in editorOptions(false));
});

test('buttonLabel: 다른 토글 버튼과 같은 "이름: 상태" 꼴', () => {
  assert.strictEqual(buttonLabel(false), '줄바꿈: OFF');
  assert.strictEqual(buttonLabel(true), '줄바꿈: ON');
});
