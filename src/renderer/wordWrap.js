// src/renderer/wordWrap.js — 비교 모드 줄바꿈 토글의 순수 부분.
//
// 토글은 세 곳에서 눌린다: 툴바 버튼, View 메뉴, 시작 시 설정 복원. 옵션과 라벨을
// 각자 만들면 어긋나므로(하나만 wrappingIndent를 빼먹는 식) 여기 한 곳에 둔다.
// Monaco를 import 하지 않아 그대로 단위 테스트할 수 있다.

/** 설정에서 읽은 값을 불리언으로. 모르는 값은 지금까지의 동작(끔)으로 떨어뜨린다. */
function normalize(v) {
  if (typeof v === 'boolean') return v;
  return v === 'on'; // settings.json은 사람이 고칠 수 있는 파일이다
}

/**
 * Monaco diff 편집기 옵션. wordWrap 하나로는 부족해서 네 키가 함께 간다.
 *
 * Monaco의 줄바꿈 해석 우선순위는 wordWrapOverride2 > wordWrapOverride1 > wordWrap이고,
 * diff 편집기가 두 override를 직접 건드린다(monaco diffEditorEditors.js):
 *
 *   diffWordWrap        - 양쪽 하위 편집기의 override1에 그대로 씌워진다. 그래서 이 값을
 *                         빼면 wordWrap을 켜도 override1이 이겨 아무 일도 일어나지 않는다.
 *   wordWrapOverride2   - side-by-side가 아닐 때 override1·2가 함께 'off'로 박히는데,
 *                         다시 side-by-side가 되면 override1만 되돌아온다. 창이 아직 좁던
 *                         시작 순간에 한 번만 그 경로를 지나도 원본 쪽 override2가 'off'로
 *                         남아, wordWrap='on'을 통째로 이긴다. 실측: 왼쪽 ov2 'off',
 *                         오른쪽 'inherit' — 그래서 원본 쪽만 안 접혔다. 우리가 풀어 준다.
 *
 * 끌 때도 네 키를 모두 되돌린다. updateOptions는 준 키만 바꾸므로, 안 되돌리면 접지도
 * 않으면서 들여쓰기 설정만 남는다.
 */
function editorOptions(on) {
  const mode = on ? 'on' : 'off';
  return {
    wordWrap: mode,
    wrappingIndent: on ? 'indent' : 'none',
    diffWordWrap: mode,
    wordWrapOverride2: 'inherit',
  };
}

/** 다른 토글 버튼(Dict/Fit/Sync/Night)과 같은 "이름: 상태" 꼴. */
function buttonLabel(on) {
  return `줄바꿈: ${on ? 'ON' : 'OFF'}`;
}

module.exports = { normalize, editorOptions, buttonLabel };
