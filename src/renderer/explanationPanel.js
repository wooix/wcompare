// The reader owns its terminology, highlights and reading position on a separate origin.
export function createExplanationPanel(host, { getPages }) {
  const el = document.createElement('section');
  el.className = 'pdf-explanation';
  el.setAttribute('aria-label', '논문 설명');
  el.innerHTML = `<header class="explanation-header"><strong>설명</strong><span class="explanation-status" role="status"></span><button class="explanation-generate">설명 생성</button><button class="explanation-cancel" hidden>취소</button></header>
    <div class="explanation-empty">PDF를 열면 paper-helper 설명을 함께 볼 수 있습니다.</div>
    <iframe title="paper-helper 논문 설명" sandbox="allow-scripts allow-same-origin allow-popups" hidden></iframe>`;
  host.append(el);
  const status = el.querySelector('.explanation-status');
  const empty = el.querySelector('.explanation-empty');
  const generateButton = el.querySelector('.explanation-generate');
  const cancelButton = el.querySelector('.explanation-cancel');
  const frame = el.querySelector('iframe');
  let documentKey = '';
  let documentPath = null;
  let revision = 0;
  let result = null;
  let loading = false;
  let running = null;
  let pendingLoad = Promise.resolve();
  let cancelCollection = null;

  function controls(busy = false) {
    generateButton.textContent = result ? '다시 생성' : '설명 생성';
    generateButton.disabled = !documentPath || loading || busy;
    cancelButton.hidden = !busy;
  }
  function show(next) {
    result = next;
    frame.src = next.url + '?revision=' + encodeURIComponent(next.savedAt);
    frame.hidden = false;
    empty.hidden = true;
    status.textContent = '저장된 설명';
  }
  async function generate(force = false, { strict = false } = {}) {
    await pendingLoad;
    if (!documentPath || running) {
      if (strict) throw new Error(running ? '설명 생성이 이미 진행 중입니다.' : '먼저 PDF를 여세요.');
      return;
    }
    const ticket = revision;
    status.textContent = 'Codex로 설명 생성 준비 중…';
    controls(true);
    const sourcePath = documentPath;
    running = (async () => {
      const sourcePages = await Promise.race([
        getPages(sourcePath),
        new Promise((_resolve, reject) => { cancelCollection = () => reject(new Error('설명 생성이 취소되었습니다.')); }),
      ]);
      cancelCollection = null;
      if (ticket !== revision) throw new Error('문서가 바뀌어 설명 생성을 취소했습니다.');
      return window.wcompare.explanation.generate({ path: sourcePath, force, sourcePages });
    })();
    try {
      const next = await running;
      if (ticket === revision) show(next);
      return next;
    } catch (error) {
      if (ticket === revision) status.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
      if (strict) throw error;
    } finally {
      cancelCollection = null;
      running = null;
      if (ticket === revision) controls();
    }
  }
  async function loadDocument(doc) {
    const key = doc ? `${doc.path}:${doc.hash}` : '';
    if (key === documentKey) return;
    const ticket = ++revision;
    documentKey = key;
    documentPath = doc?.path || null;
    result = null;
    frame.hidden = true;
    frame.removeAttribute('src');
    empty.hidden = false;
    empty.textContent = documentPath ? '설명 생성 버튼을 누르면 이 논문의 설명을 만듭니다.' : 'PDF를 열면 paper-helper 설명을 함께 볼 수 있습니다.';
    status.textContent = '';
    loading = true;
    controls();
    if (running) {
      cancelCollection?.();
      await window.wcompare.explanation.cancel();
      try { await running; } catch { /* Cancellation belongs to the previous document. */ }
    }
    if (ticket !== revision) return;
    try {
      const cached = documentPath && await window.wcompare.explanation.load(documentPath);
      if (ticket !== revision) return;
      if (cached) show(cached);
      else if (documentPath) status.textContent = '저장된 설명이 없습니다.';
    } catch (error) {
      if (ticket === revision) status.textContent = error.message || String(error);
    } finally {
      if (ticket === revision) {
        loading = false;
        controls();
      }
    }
  }
  function setDocument(doc) {
    const key = doc ? `${doc.path}:${doc.hash}` : '';
    if (key === documentKey) return pendingLoad;
    pendingLoad = loadDocument(doc);
    return pendingLoad;
  }
  window.wcompare.explanation.onProgress(progress => {
    if (progress.path === documentPath && running) status.textContent = progress.message;
  });
  generateButton.onclick = () => void generate(!!result);
  function cancel() {
    cancelCollection?.();
    return window.wcompare.explanation.cancel();
  }
  cancelButton.onclick = cancel;
  controls();
  return { el, setDocument, generate, cancel };
}
