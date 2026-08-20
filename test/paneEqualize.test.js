// 비교 창 좌우 균등의 순수 부분.
//
// Monaco는 전체 폭을 분할선으로 가른 다음, 가운데 거터(되돌리기 화살표가 놓이는 35px)를
// 왼쪽 몫에서만 깎는다. 그래서 손대지 않으면 왼쪽이 늘 거터만큼 좁다. 폭이 다르면 접히는
// 자리도 달라져, 같은 문장이 좌우에서 다른 지점에서 끊긴다 — 비교 도구에서는 곧 오독이다.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalize, equalizeRatio, editorOptions, withRememberedRatio, buttonLabel,
} = require('../src/renderer/paneEqualize.js');

// 실제로 측정된 기본 상태(창 1280px). 왼쪽 590 / 오른쪽 625, 분할선 625.
const MEASURED = { originalWidth: 590, modifiedWidth: 625, sashLeft: 625 };

test('normalize: 설정에 값이 없으면 켜짐 — 어긋난 폭은 기본이 아니라 버그다', () => {
  for (const v of [undefined, null]) assert.strictEqual(normalize(v), true);
});

test('normalize: 불리언은 그대로', () => {
  assert.strictEqual(normalize(true), true);
  assert.strictEqual(normalize(false), false);
});

test('normalize: 손으로 고친 설정 파일의 이상한 값도 견딘다', () => {
  // settings.json은 사람이 열어 고칠 수 있는 파일이다. 'off'만 끔으로 읽고 나머지는
  // 기본값(켬)으로 떨어뜨려, 오타 하나에 비교 창이 어긋난 채 뜨지 않게 한다.
  assert.strictEqual(normalize('off'), false);
  assert.strictEqual(normalize('on'), true);
  assert.strictEqual(normalize('아무말'), true);
});

test('equalizeRatio: 실측값에서 좌우가 같아지는 비율을 낸다', () => {
  // 거터 폭도 개요 눈금 폭도 몰라도 된다. Monaco의 두 식
  //   originalWidth = sashLeft - 거터,  modifiedWidth = 전체폭 - sashLeft - 개요눈금
  // 에서 sashLeft를 소거하면 분할선이 나눈 폭 = sashLeft + modifiedWidth 이다.
  const r = equalizeRatio(MEASURED);
  const content = MEASURED.sashLeft + MEASURED.modifiedWidth; // 1250
  assert.strictEqual(r, (625 + 17.5) / content); // 0.514
  // 그 비율을 Monaco가 쓰면 좌우 차이가 1px 안으로 들어온다. Monaco의 두 식을
  // 그대로 되짚어 본다: 새 왼쪽 폭 = 분할선 - 거터, 새 오른쪽 폭 = 나눌 폭 - 분할선.
  const sash = Math.floor(r * content);          // Monaco가 정수로 내림한다
  const gutter = MEASURED.sashLeft - MEASURED.originalWidth; // 35
  assert.ok(Math.abs((sash - gutter) - (content - sash)) <= 1,
    `${sash - gutter} vs ${content - sash}`);
});

test('equalizeRatio: 이미 같으면 건드리지 않는다', () => {
  // null은 "손댈 것 없음"이다. 매번 옵션을 새로 넣으면 Monaco가 다시 배치하고,
  // 그 배치가 다시 우리 관찰자를 깨워 끝나지 않는다.
  assert.strictEqual(equalizeRatio({ originalWidth: 600, modifiedWidth: 600, sashLeft: 640 }), null);
});

test('equalizeRatio: 1px 차이는 같은 것으로 본다', () => {
  // 분할선은 정수 픽셀이라, 나눌 폭이 홀수면 한쪽이 1px 남는다. 없앨 수 없는 차이를
  // 쫓아다니면 창 크기를 바꿀 때마다 두 값 사이를 오간다.
  assert.strictEqual(equalizeRatio({ originalWidth: 600, modifiedWidth: 601, sashLeft: 640 }), null);
  assert.strictEqual(equalizeRatio({ originalWidth: 601, modifiedWidth: 600, sashLeft: 640 }), null);
});

test('equalizeRatio: 왼쪽이 더 넓어도 반대로 맞춘다', () => {
  // 사용자가 분할선을 끌어 놓은 뒤 잠금을 켜는 경우다.
  const r = equalizeRatio({ originalWidth: 700, modifiedWidth: 500, sashLeft: 735 });
  assert.ok(r < 735 / (735 + 500), '분할선이 왼쪽으로 와야 한다');
});

test('equalizeRatio: 잴 수 없는 상태에서는 아무것도 하지 않는다', () => {
  // 비교 화면이 숨겨져 있으면(PDF 모드) 폭이 0으로 재인다. 0으로 나눈 비율을
  // Monaco에 넣으면 0.1로 잘려, 돌아왔을 때 창이 한쪽으로 쏠린 채 뜬다.
  for (const m of [
    null, undefined, {},
    { originalWidth: 0, modifiedWidth: 0, sashLeft: 0 },
    { originalWidth: 590, modifiedWidth: 625, sashLeft: 0 },
    { originalWidth: NaN, modifiedWidth: 625, sashLeft: 625 },
    { originalWidth: -5, modifiedWidth: 625, sashLeft: 625 },
  ]) assert.strictEqual(equalizeRatio(m), null, JSON.stringify(m));
});

test('equalizeRatio: Monaco가 잘라 버릴 비율은 내지 않는다', () => {
  // splitViewDefaultRatio는 0.1~0.9로 잘린다(diffEditorOptions.js). 잘릴 값을 넣으면
  // 원하는 폭이 나오지 않는데도 "고쳤다"고 여겨 다음 회차에서 또 같은 값을 넣는다.
  assert.strictEqual(equalizeRatio({ originalWidth: 1, modifiedWidth: 100, sashLeft: 420 }), null);
  assert.strictEqual(equalizeRatio({ originalWidth: 100, modifiedWidth: 10, sashLeft: 50 }), null);
});

test('editorOptions: 켜면 분할선을 잠근다', () => {
  // 잠그지 않으면 사용자가 한 번 끈 비율(_sashRatio)이 splitViewDefaultRatio를 이겨,
  // 그 뒤로는 우리가 계산한 비율이 통째로 무시된다(diffEditorSash.js).
  assert.deepStrictEqual(editorOptions(true), { enableSplitViewResizing: false });
  assert.deepStrictEqual(editorOptions(true, 0.514),
    { enableSplitViewResizing: false, splitViewDefaultRatio: 0.514 });
});

test('editorOptions: 끄면 Monaco 기본값으로 되돌린다', () => {
  // updateOptions는 준 키만 바꾼다. 비율을 되돌리지 않으면 잠금만 풀린 채
  // 우리가 넣었던 비율이 그대로 남는다.
  assert.deepStrictEqual(editorOptions(false),
    { enableSplitViewResizing: true, splitViewDefaultRatio: 0.5 });
  assert.deepStrictEqual(editorOptions(false, 0.514),
    { enableSplitViewResizing: true, splitViewDefaultRatio: 0.5 });
});

test('editorOptions: 쓸 수 없는 비율은 빼고 잠금만 건다', () => {
  for (const bad of [null, undefined, NaN, 0, 1, -0.2, 1.4, '0.5']) {
    assert.deepStrictEqual(editorOptions(true, bad), { enableSplitViewResizing: false },
      String(bad));
  }
});

test('withRememberedRatio: 상관없는 옵션을 바꿔도 비율이 따라간다', () => {
  // 이걸 놓쳐서 실제로 깨졌다. 배포본에서 줄바꿈 버튼을 누르는 것만으로 방금 맞춰
  // 둔 좌우 폭이 590/625로 되돌아갔다. Monaco의 검증기가 이 키만 현재 값이 아니라
  // 상수 0.5로 떨어뜨리기 때문이다(diffEditorOptions.js).
  const r = withRememberedRatio({ wordWrap: 'on' }, 0.514);
  assert.deepStrictEqual(r.options, { wordWrap: 'on', splitViewDefaultRatio: 0.514 });
  assert.strictEqual(r.ratio, 0.514);
});

test('withRememberedRatio: 새 비율이 들어오면 그게 새 기억이다', () => {
  const r = withRememberedRatio({ splitViewDefaultRatio: 0.52 }, 0.514);
  assert.deepStrictEqual(r.options, { splitViewDefaultRatio: 0.52 });
  assert.strictEqual(r.ratio, 0.52);
});

test('withRememberedRatio: 아직 맞춘 적 없으면 넣지 않는다', () => {
  // 시작 직후에는 Monaco 기본값(0.5)이 맞다. 없는 기억을 지어내면 안 된다.
  const r = withRememberedRatio({ wordWrap: 'on' }, null);
  assert.deepStrictEqual(r.options, { wordWrap: 'on' });
  assert.strictEqual(r.ratio, null);
});

test('withRememberedRatio: 원래 옵션 객체를 건드리지 않는다', () => {
  // 부르는 쪽이 상수처럼 재사용하는 객체일 수 있다(wordWrap.js의 editorOptions 같은).
  const given = { wordWrap: 'on' };
  withRememberedRatio(given, 0.514);
  assert.deepStrictEqual(given, { wordWrap: 'on' });
});

test('withRememberedRatio: 옵션이 비어 있어도 견딘다', () => {
  assert.deepStrictEqual(withRememberedRatio(undefined, 0.514),
    { options: { splitViewDefaultRatio: 0.514 }, ratio: 0.514 });
});

test('buttonLabel: 다른 토글 버튼과 같은 "이름: 상태" 꼴', () => {
  assert.strictEqual(buttonLabel(true), '좌우균등: ON');
  assert.strictEqual(buttonLabel(false), '좌우균등: OFF');
});
