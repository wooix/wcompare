// src/renderer/dnd.js — 좌/우 패널에 파일을 드롭하면 연다.
// 파일 1개: 드롭 위치(x)로 side 결정. 2개 이상: 이름순 정렬 → 좌=첫째, 우=둘째.
import { orderByName } from './dropOrder.js';

export function setupDnd(rootEl, onDropFile) {
  for (const ev of ['dragover', 'drop']) {
    window.addEventListener(ev, (e) => e.preventDefault());
  }
  rootEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files.map((f) => window.wcompare.getDropPath(f)).filter(Boolean);
    if (paths.length === 0) return;
    if (paths.length === 1) {
      const side = e.clientX < rootEl.clientWidth / 2 ? 'left' : 'right';
      onDropFile(side, paths[0]);
      return;
    }
    // 2개 이상: 이름순 앞 두 개를 좌/우로
    const [a, b] = orderByName(paths);
    onDropFile('left', a);
    onDropFile('right', b);
  });
}
