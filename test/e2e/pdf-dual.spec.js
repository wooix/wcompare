// test/e2e/pdf-dual.spec.js
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

function writePair(tag) {
  const a = path.join(os.tmpdir(), `wc-pdf-a-${tag}.pdf`);
  const b = path.join(os.tmpdir(), `wc-pdf-b-${tag}.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900 }));
  fs.writeFileSync(b, makePdf(5, { height: 900 }));
  return { a, b };
}
const leftC = '.pdf-pane[data-side=left] .pdf-container';
const rightC = '.pdf-pane[data-side=right] .pdf-container';

test('두 PDF 렌더 + 비율 스크롤 동기(양쪽)', async () => {
  const { a, b } = writePair('sync' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  await win.evaluate((sel) => { document.querySelector(sel).scrollTop = 600; }, leftC);
  await win.waitForFunction((sel) => document.querySelector(sel).scrollTop > 50, rightC, { timeout: 5000 });

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('동기 OFF 시 한쪽만 움직인다', async () => {
  const { a, b } = writePair('off' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await win.click('#btn-sync');
  await expect(win.locator('#btn-sync')).toHaveText('Sync: OFF');
  const before = await win.evaluate((sel) => document.querySelector(sel).scrollTop, rightC);
  await win.evaluate((sel) => { document.querySelector(sel).scrollTop = 600; }, leftC);
  await win.waitForTimeout(400);
  const after = await win.evaluate((sel) => document.querySelector(sel).scrollTop, rightC);
  expect(after).toBe(before); // 동기 OFF → 우측 불변
  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('줌+ 시 배율 증가(양쪽)', async () => {
  const { a, b } = writePair('zoom' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  const pct = () => win.evaluate(() => { const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || ''); return m ? +m[1] : 0; });
  const before = await pct();
  await win.click('#btn-zoom-in');
  await win.waitForFunction((b0) => { const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || ''); return m && +m[1] > b0; }, before, { timeout: 5000 });
  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('페이지 점프: 양쪽 이동', async () => {
  const { a, b } = writePair('page' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await win.fill('#pdf-page', '3');
  await win.locator('#pdf-page').press('Enter');
  await win.waitForFunction(() => /L 3\//.test(document.getElementById('pdf-status').textContent || ''), null, { timeout: 5000 });
  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('회귀: 텍스트 2개는 diff 모드', async () => {
  const a = path.join(os.tmpdir(), 'wc-txt-a-' + Date.now() + '.txt');
  const b = path.join(os.tmpdir(), 'wc-txt-b-' + Date.now() + '.txt');
  fs.writeFileSync(a, 'hello\n'); fs.writeFileSync(b, 'world\n');
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await expect(win.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 });
  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});
