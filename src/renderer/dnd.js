// src/renderer/dnd.js — 좌/우 패널에 파일을 드롭하면 해당 side로 연다.
// 기본 동작(네비게이션) 차단. drop 위치(x)로 side 결정.
export function setupDnd(rootEl, onDropFile) {
  for (const ev of ['dragover', 'drop']) {
    window.addEventListener(ev, (e) => e.preventDefault());
  }
  rootEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const side = e.clientX < rootEl.clientWidth / 2 ? 'left' : 'right';
    const path = window.wcompare.getDropPath(f);
    if (path) onDropFile(side, path);
  });
}
