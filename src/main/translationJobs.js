// src/main/translationJobs.js — 창(webContents)별 번역 job 레지스트리. electron 미의존(단위 테스트 가능).
// createTranslationJobs() → { has, outputInUse, add, remove, get, cancel, cancelAll }
//  - 전역 단일 job이 아니라 창마다 하나씩 관리한다: 여러 창에서 동시에 서로 다른 PDF를 번역할 수 있게.
//  - job은 transpaper.translate()가 돌려주는 { cancel, promise, output } 형태를 기대하되,
//    여기서는 cancel()만 호출한다(promise 수명은 호출자가 finally에서 remove로 정리).
function createTranslationJobs() {
  const map = new Map(); // wcId → { job, output }

  function has(wcId) {
    return map.has(wcId);
  }

  // 진행 중인 어떤 job이 같은 출력 경로를 쓰는가 — 같은 PDF를 다른 창에서 동시에 번역하는 것을 막는다.
  function outputInUse(output) {
    for (const entry of map.values()) {
      if (entry.output === output) return true;
    }
    return false;
  }

  function add(wcId, output, job) {
    map.set(wcId, { job, output });
  }

  function remove(wcId) {
    map.delete(wcId);
  }

  function get(wcId) {
    return map.get(wcId);
  }

  function cancel(wcId) {
    const entry = map.get(wcId);
    if (!entry) return false;
    entry.job?.cancel?.();
    map.delete(wcId);
    return true;
  }

  function cancelAll() {
    for (const entry of map.values()) entry.job?.cancel?.();
    map.clear();
  }

  return { has, outputInUse, add, remove, get, cancel, cancelAll };
}

module.exports = { createTranslationJobs };
