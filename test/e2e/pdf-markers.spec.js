// test/e2e/pdf-markers.spec.js — 형광펜/밑줄 마커.
// 핵심 리스크: 줌하면 PDFPageView.reset()이 페이지 div의 "pdf.js가 모르는 자식"을 전부 지운다.
// 마커가 pagerendered에서 다시 붙지 않으면 확대하는 순간 사라진다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const L = '.pdf-pane[data-side=left]';
const R = '.pdf-pane[data-side=right]';

function writePair(tag) {
  const a = path.join(os.tmpdir(), `wc-mk-a-${tag}.pdf`);
  const b = path.join(os.tmpdir(), `wc-mk-b-${tag}.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900 }));
  fs.writeFileSync(b, makePdf(3, { height: 900 }));
  return { a, b };
}

// 1쪽의 "Page 1" 텍스트를 선택한다 (textLayer의 선택은 평범한 DOM Selection)
const selectFirstSpan = (win, pane) => win.evaluate((sel) => {
  const span = document.querySelector(`${sel} .textLayer span`);
  const range = document.createRange();
  range.selectNodeContents(span);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
}, pane);

const mark = (win, kind) => win.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', {
  key: k, shiftKey: true, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true,
})), kind === 'highlight' ? 'H' : 'U');

test('드래그 선택 후 형광펜/밑줄 마커가 생긴다', async () => {
  const { a, b } = writePair('add' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });

  await selectFirstSpan(win, L);
  await mark(win, 'highlight');
  await expect(win.locator(`${L} .wc-mark-highlight`)).toHaveCount(1);

  await selectFirstSpan(win, L);
  await mark(win, 'underline');
  await expect(win.locator(`${L} .wc-mark-underline`)).toHaveCount(1);

  // 반대편에는 생기지 않는다
  await expect(win.locator(`${R} .wc-mark`)).toHaveCount(0);

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('여러 줄 선택: 줄당 사각형 하나로 합쳐 겹치지 않는다', async () => {
  // getClientRects()는 한 줄마다 거의 같은 사각형을 2개씩 준다 → 그대로 그리면
  // 형광펜이 진해지고 밑줄이 굵어진다. 저장 전에 줄당 하나로 합쳐야 한다.
  const a = path.join(os.tmpdir(), `wc-mk-ml-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(1, { height: 900, lines: 6 })); // 여러 줄 본문
  const app = await electron.launch({ args: [MAIN, a] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });

  // 페이지의 모든 줄을 한 번에 선택
  await win.evaluate((sel) => {
    const spans = [...document.querySelectorAll(`${sel} .textLayer span`)];
    const range = document.createRange();
    range.setStartBefore(spans[0]);
    range.setEndAfter(spans[spans.length - 1]);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, L);
  await mark(win, 'highlight');

  const geo = await win.evaluate((sel) => {
    const rc = [...document.querySelectorAll(`${sel} .wc-mark`)]
      .map((e) => e.getBoundingClientRect()).sort((x, y) => x.top - y.top);
    let overlaps = 0;
    for (let i = 1; i < rc.length; i++) if (rc[i].top < rc[i - 1].bottom - 1) overlaps++;
    return { count: rc.length, overlaps };
  }, L);
  expect(geo.count).toBeGreaterThanOrEqual(6); // 줄 수만큼 (2배가 아니라)
  expect(geo.overlaps).toBe(0);                // 세로로 겹치는 사각형이 없다

  await app.close();
  fs.rmSync(a, { force: true });
});

test('마커는 페이지 안의 상대 위치로 저장된다 (줌해도 비율 유지)', async () => {
  const { a, b } = writePair('geo' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });

  await selectFirstSpan(win, L);
  await mark(win, 'highlight');
  await expect(win.locator(`${L} .wc-mark-highlight`)).toHaveCount(1);

  // 마커가 덮은 영역이 textLayer 대비 차지하는 비율
  const ratio = () => win.evaluate((sel) => {
    const tl = document.querySelector(`${sel} .textLayer`).getBoundingClientRect();
    const m = document.querySelector(`${sel} .wc-mark`).getBoundingClientRect();
    return {
      x: +((m.left - tl.left) / tl.width).toFixed(3),
      w: +(m.width / tl.width).toFixed(3),
      y: +((m.top - tl.top) / tl.height).toFixed(3),
    };
  }, L);
  const before = await ratio();

  for (let i = 0; i < 3; i++) await win.click('#btn-zoom-in');
  await win.waitForTimeout(500);

  // ⚠️ 여기가 핵심: reset()이 지운 오버레이를 pagerendered에서 다시 붙였는가
  await expect(win.locator(`${L} .wc-mark-highlight`)).toHaveCount(1);
  const after = await ratio();
  expect(after.x).toBeCloseTo(before.x, 2);
  expect(after.w).toBeCloseTo(before.w, 2);
  expect(after.y).toBeCloseTo(before.y, 2);

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('Switch 하면 마커가 문서를 따라 반대편으로 간다', async () => {
  const { a, b } = writePair('sw' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${R} .textLayer span`, { timeout: 20000 });

  await selectFirstSpan(win, L);
  await mark(win, 'highlight');
  await expect(win.locator(`${L} .wc-mark`)).toHaveCount(1);
  await expect(win.locator(`${R} .wc-mark`)).toHaveCount(0);

  await win.click('#btn-switch');
  // 마커는 side가 아니라 "문서"에 묶여 있으므로 문서를 따라 오른쪽으로 이동한다
  await expect(win.locator(`${R} .wc-mark`)).toHaveCount(1, { timeout: 10000 });
  await expect(win.locator(`${L} .wc-mark`)).toHaveCount(0);

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('마커는 텍스트 선택과 링크 클릭을 가로막지 않는다', async () => {
  const { a, b } = writePair('pe' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });

  await selectFirstSpan(win, L);
  await mark(win, 'highlight');
  await expect(win.locator(`${L} .wc-mark`)).toHaveCount(1);

  // 레이어는 렌더된 페이지마다 하나씩 생긴다 → 첫 번째로 확인
  const events = await win.locator(`${L} .wc-marker-layer`).first()
    .evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(events).toBe('none'); // 오버레이가 마우스를 먹으면 드래그 선택이 죽는다

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});
