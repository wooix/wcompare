// src/renderer/syncScroll.js — 순수. DOM/pdf 미import.
// 한 축(가로/세로)의 스크롤을 비율로 환산한다. client/scroll 크기를 넘겨 축 무관하게 쓴다.
function ratioTarget(fromPos, fromClient, fromScroll, toClient, toScroll) {
  const fromRange = fromScroll - fromClient;
  const toRange = toScroll - toClient;
  if (fromRange <= 0 || toRange <= 0) return 0;
  const ratio = fromPos / fromRange;
  return Math.max(0, Math.min(toRange, ratio * toRange));
}

function syncTargetTop(from, to) {
  return ratioTarget(from.scrollTop, from.clientHeight, from.scrollHeight, to.clientHeight, to.scrollHeight);
}

function syncTargetLeft(from, to) {
  return ratioTarget(from.scrollLeft, from.clientWidth, from.scrollWidth, to.clientWidth, to.scrollWidth);
}

module.exports = { syncTargetTop, syncTargetLeft, ratioTarget };
