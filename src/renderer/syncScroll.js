// src/renderer/syncScroll.js — 순수. DOM/pdf 미import.
function syncTargetTop(from, to) {
  const fromRange = from.scrollHeight - from.clientHeight;
  const toRange = to.scrollHeight - to.clientHeight;
  if (fromRange <= 0 || toRange <= 0) return 0;
  const ratio = from.scrollTop / fromRange;
  const target = ratio * toRange;
  return Math.max(0, Math.min(toRange, target));
}
module.exports = { syncTargetTop };
