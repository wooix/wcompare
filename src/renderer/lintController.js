// src/renderer/lintController.js
// 순수 스케줄러: 디바운스 + 버전 가드. monaco를 import하지 않는다(테스트 가능).
function makeScheduler({ getVersion, runLint, apply, debounceMs = 600 }) {
  let timer = null;
  async function request() {
    const captured = getVersion();
    const markers = await runLint();
    if (getVersion() !== captured) return; // stale → 폐기
    apply(markers);
  }
  function schedule() { cancel(); timer = setTimeout(request, debounceMs); }
  function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
  return { request, schedule, cancel };
}

// monaco 결합부: 한 side의 lint를 배선한다.
function wireLintController(monaco, editorApi, side, opts = {}) {
  const { toMarker } = require('../shared/diagnostics.js');
  const model = editorApi.modelOf(side);
  const owner = 'wcompare-lint-' + side;
  const sched = makeScheduler({
    getVersion: () => model.getVersionId(),
    runLint: async () => {
      const languageId = editorApi.languageOf(side);
      const path = editorApi.getState(side).path || 'untitled';
      const res = await window.wcompare.lint({ languageId, content: model.getValue(), path });
      return (res.diagnostics || []).map(toMarker);
    },
    apply: (markers) => monaco.editor.setModelMarkers(model, owner, markers),
    debounceMs: opts.debounceMs ?? 600,
  });
  model.onDidChangeContent(() => sched.schedule());
  return sched; // 저장/로드 시 caller가 sched.cancel()+sched.request() 호출
}

module.exports = { makeScheduler, wireLintController };
