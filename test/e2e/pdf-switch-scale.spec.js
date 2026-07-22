// test/e2e/pdf-switch-scale.spec.js
// 회귀: 사용자가 직접 정한 줌 배율이 Switch(좌우 교체) 후에도 유지되는지 검증한다.
// setDocument가 pdf.js 내부 배율을 초기화하므로, switchSides가 교체 전에 배율을 캡처해 다시 적용해야 한다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const rightC = '.pdf-pane[data-side=right] .pdf-container';

function writePair(tag) {
  const a = path.join(os.tmpdir(), `wc-swscale-a-${tag}.pdf`);
  const b = path.join(os.tmpdir(), `wc-swscale-b-${tag}.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900 }));
  fs.writeFileSync(b, makePdf(5, { height: 900 }));
  return { a, b };
}

const pct = (win) => win.evaluate(() => {
  const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || '');
  return m ? +m[1] : 0;
});

test('Switch: 사용자가 정한 줌 배율이 좌우 교체 후에도 유지된다', async () => {
  const { a, b } = writePair('keep' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  // 줌+ 3회 → fit 해제 + 배율 상승. 마지막 클릭이 상태에 반영될 때까지 기다린다.
  const base = await pct(win);
  for (let i = 0; i < 3; i++) await win.click('#btn-zoom-in');
  await expect(win.locator('#btn-fit')).toHaveText('Fit: OFF'); // 직접 배율 지정 → fit 해제
  await win.waitForFunction((b0) => {
    const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || '');
    return m && +m[1] > b0;
  }, base, { timeout: 5000 });
  const zoomed = await pct(win);
  expect(zoomed).toBeGreaterThan(base);

  await win.click('#btn-switch');
  // 교체가 끝났는지: switch는 문서 객체를 맞바꾸므로 우측 canvas가 다시 렌더된다.
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await win.waitForTimeout(400); // setScale/emit 반영 여유

  expect(await pct(win)).toBe(zoomed); // 배율이 초기화되지 않고 그대로 유지되어야 한다

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('Switch (Sync OFF): 배율은 side가 아니라 문서를 따라 좌우로 맞바뀐다', async () => {
  const { a, b } = writePair('swoff' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  await win.click('#btn-sync');
  await expect(win.locator('#btn-sync')).toHaveText('Sync: OFF');

  const overflowX = (sel) => win.evaluate((s) => {
    const el = document.querySelector(s);
    return el.scrollWidth - el.clientWidth;
  }, sel);
  const leftC = '.pdf-pane[data-side=left] .pdf-container';

  // 왼쪽 문서만 확대 — Sync OFF이므로 오른쪽은 그대로여야 한다
  for (let i = 0; i < 4; i++) {
    await win.evaluate((sel) => document.querySelector(sel).dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }),
    ), leftC);
  }
  await win.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return (el.scrollWidth - el.clientWidth) > 10;
  }, leftC, { timeout: 5000 });
  expect(await overflowX(rightC)).toBeLessThanOrEqual(1);

  await win.click('#btn-switch');
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await win.waitForTimeout(400); // setScale/emit 반영 여유

  // 확대했던 문서는 이제 right에 있으니 right가 커져 있어야 하고, left는 원래(작은) 배율이어야 한다
  expect(await overflowX(rightC)).toBeGreaterThan(10);
  expect(await overflowX(leftC)).toBeLessThanOrEqual(1);

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('Switch: Fit ON 상태에서는 교체 후에도 Fit이 유지된다', async () => {
  const { a, b } = writePair('fiton' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await expect(win.locator('#btn-fit')).toHaveText('Fit: ON'); // 최초 로드는 page-width(fit ON)

  await win.click('#btn-switch');
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await expect(win.locator('#btn-fit')).toHaveText('Fit: ON'); // 교체 후에도 fit 유지

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});
