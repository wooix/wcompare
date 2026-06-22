// src/renderer/dropOrder.js — 드롭된 경로를 이름순으로 정렬. 순수(CommonJS, 테스트 대상).
const basename = (p) => String(p).split(/[\\/]/).pop();

// basename 기준 이름순(숫자 자연 정렬).
function orderByName(paths) {
  return [...paths].sort((a, b) =>
    basename(a).localeCompare(basename(b), undefined, { numeric: true, sensitivity: 'base' }));
}

module.exports = { orderByName, basename };
