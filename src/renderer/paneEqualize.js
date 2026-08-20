// src/renderer/paneEqualize.js — 비교 창 좌우 균등의 순수 부분.
//
// 왜 필요한가. Monaco의 diff 편집기는 전체 폭을 분할선(sash)으로 가른 다음, 가운데
// 거터(되돌리기 화살표가 놓이는 35px)를 왼쪽 몫에서만 깎는다(diffEditorWidget.js):
//
//     originalWidth = sashLeft - 거터폭 - 이동블록선폭
//     modifiedWidth = 전체폭 - sashLeft - 개요눈금폭
//
// 그래서 손대지 않으면 왼쪽이 늘 거터만큼 좁다(실측 590 대 625). 폭이 다르면 접히는
// 자리도 달라져 같은 문장이 좌우에서 다른 지점에서 끊긴다 — 비교 도구에서는 그게 곧
// 오독이다. 분할선을 우리가 계산해 넣어 두 폭을 맞춘다.
//
// Monaco를 import 하지 않아 그대로 단위 테스트할 수 있다.

// 분할선은 정수 픽셀로 내림된다(Math.floor). 나눌 폭이 홀수면 한쪽에 1px이 남고, 그건
// 어떤 비율로도 없앨 수 없다. 없앨 수 없는 차이를 쫓으면 두 값 사이를 오갈 뿐이다.
const TOLERANCE_PX = 1;

// splitViewDefaultRatio는 Monaco가 0.1~0.9로 자른다(diffEditorOptions.js).
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

/**
 * 설정에서 읽은 값을 불리언으로. 모르는 값은 켬으로 떨어뜨린다 — 어긋난 폭은
 * 취향이 아니라 버그이므로, 오타 하나 때문에 어긋난 채 뜨면 안 된다.
 */
function normalize(v) {
  if (typeof v === 'boolean') return v;
  return v !== 'off'; // settings.json은 사람이 고칠 수 있는 파일이다
}

const usable = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * 실측한 세 값에서 좌우가 같아지는 splitViewDefaultRatio를 낸다.
 * 손댈 것이 없거나 잴 수 없으면 null.
 *
 * 거터 폭도 개요 눈금 폭도 알 필요가 없다. 위의 두 식에서
 *
 *     나눌 폭(= 전체폭 - 개요눈금폭) = sashLeft + modifiedWidth
 *
 * 가 그대로 떨어지고, 분할선을 (오른쪽 - 왼쪽)/2 만큼 옮기면 두 폭이 그 차이만큼
 * 서로 좁아지고 넓어져 맞물린다. 내부 상수를 흉내 내지 않으므로 Monaco가 거터 폭을
 * 바꾸더라도 따라간다.
 *
 * @param {{originalWidth:number, modifiedWidth:number, sashLeft:number}} m
 */
function equalizeRatio(m) {
  if (!m || !usable(m.originalWidth) || !usable(m.modifiedWidth) || !usable(m.sashLeft)) {
    return null; // 비교 화면이 숨겨져 있으면(PDF 모드) 0으로 재인다
  }
  const gap = m.modifiedWidth - m.originalWidth;
  if (Math.abs(gap) <= TOLERANCE_PX) return null; // 이미 같다
  const contentWidth = m.sashLeft + m.modifiedWidth;
  const ratio = (m.sashLeft + gap / 2) / contentWidth;
  // 잘릴 값을 넣으면 원하는 폭이 나오지 않는데도 고친 줄 알고 다음 회차에 또 넣는다.
  if (!(ratio >= MIN_RATIO && ratio <= MAX_RATIO)) return null;
  return ratio;
}

/**
 * diff 편집기 옵션.
 *
 * 켤 때 분할선을 잠그는(enableSplitViewResizing:false) 이유는 우선순위 때문이다.
 * 사용자가 분할선을 한 번이라도 끌면 Monaco가 그 비율을 _sashRatio에 기억해 두고,
 * 그 값이 splitViewDefaultRatio를 이긴다(diffEditorSash.js). 잠그면 그 갈래 자체가
 * 사라져 우리가 넣은 비율만 남는다 — 어차피 "항상 같은 폭"과 자유로운 끌기는 함께
 * 설 수 없다. 끄면 잠금이 풀려 예전처럼 끌어 옮길 수 있다.
 *
 * 끌 때 비율까지 되돌리는 이유: updateOptions는 준 키만 바꾼다. 비율을 빼면
 * 잠금만 풀린 채 우리가 넣었던 값이 그대로 남는다.
 */
function editorOptions(on, ratio) {
  if (!on) return { enableSplitViewResizing: true, splitViewDefaultRatio: 0.5 };
  const o = { enableSplitViewResizing: false };
  if (usable(ratio) && ratio > 0 && ratio < 1) o.splitViewDefaultRatio = ratio;
  return o;
}

/**
 * updateOptions 한 번 분의 옵션과, 다음 회차에 기억해 둘 비율을 함께 낸다.
 *
 * Monaco의 diff 옵션 검증기는 splitViewDefaultRatio가 빠져 있으면 현재 값이 아니라
 * 상수 0.5로 되돌린다(diffEditorOptions.js):
 *
 *     enableSplitViewResizing: boolean(options.enableSplitViewResizing, defaults.enable...)
 *     splitViewDefaultRatio:   clampedFloat(options.splitViewDefaultRatio, 0.5, 0.1, 0.9)
 *
 * 그 목록에서 이 키만 defaults를 안 본다. 그래서 줄바꿈이나 공백 표시처럼 아무 상관
 * 없는 옵션을 한 번 바꾸는 것만으로 좌우 비율이 조용히 반반으로 풀린다 — 화면에서는
 * 방금 맞춰 둔 창이 다시 어긋나는 모습으로만 드러난다. 마지막 값을 붙들고 매번
 * 같이 넣어 준다.
 */
function withRememberedRatio(options, remembered) {
  const o = options || {};
  if (usable(o.splitViewDefaultRatio)) return { options: o, ratio: o.splitViewDefaultRatio };
  if (!usable(remembered)) return { options: o, ratio: remembered };
  return { options: { ...o, splitViewDefaultRatio: remembered }, ratio: remembered };
}

/** 다른 토글 버튼(줄바꿈/Dict/Fit/Sync)과 같은 "이름: 상태" 꼴. */
function buttonLabel(on) {
  return `좌우균등: ${on ? 'ON' : 'OFF'}`;
}

module.exports = { normalize, equalizeRatio, editorOptions, withRememberedRatio, buttonLabel };
