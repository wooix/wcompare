// test/e2e/pdf-m1.spec.js — M1 quick wins + 미러 점프(3.2) + 마커 미러링(3.1) + TOC 패널.
// 미러 계열의 전제: 원문↔번역본(<이름>.pdf ↔ <이름>.ko.pdf)은 페이지 지오메트리를 공유한다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const L = '.pdf-pane[data-side=left]';
const R = '.pdf-pane[data-side=right]';

// transpaper 출력 규칙(<이름>.ko.pdf)을 따르는 원문/번역본 쌍
function writeKoPair(tag) {
  const a = path.join(os.tmpdir(), `wc-m1-${tag}.pdf`);
  const ko = path.join(os.tmpdir(), `wc-m1-${tag}.ko.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900, lines: 4 }));
  fs.writeFileSync(ko, makePdf(5, { height: 900, lines: 4 }));
  return { a, ko };
}

const selectFirstSpan = (win, pane) => win.evaluate((sel) => {
  const span = document.querySelector(`${sel} .textLayer span`);
  const range = document.createRange();
  range.selectNodeContents(span);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
}, pane);

const markHighlight = (win) => win.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'H', shiftKey: true, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true,
})));

test('야간 모드: 페이지 canvas만 반전되고 상태가 저장된다', async () => {
  const a = path.join(os.tmpdir(), `wc-m1-night-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(2, { height: 900 }));
  const app = await electron.launch({ args: [MAIN, a] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });

  await win.click('#btn-night');
  await expect(win.locator('#pdfview')).toHaveClass(/night/);
  await expect(win.locator('#btn-night')).toHaveText('Night: ON');
  const filter = await win.locator(`${L} .pdfViewer .page canvas`).first()
    .evaluate((el) => getComputedStyle(el).filter);
  expect(filter).toContain('invert'); // canvas에만 필터 — 마커 레이어는 형제라 원색 유지

  // localStorage에 저장되어 다음 세션에도 이어진다
  expect(await win.evaluate(() => localStorage.getItem('wc-night'))).toBe('1');

  await win.click('#btn-night');
  await expect(win.locator('#pdfview')).not.toHaveClass(/night/);

  await app.close();
  fs.rmSync(a, { force: true });
});

test('미러 점프: Alt+클릭으로 반대편이 같은 위치로 이동하고 펄스가 뜬다', async () => {
  const { a, ko } = writeKoPair('jump' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, ko] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${R} .textLayer span`, { timeout: 20000 });

  // Sync를 끄고 오른쪽을 문서 끝으로 보내 어긋난 상태를 만든다
  await win.click('#btn-sync');
  await win.evaluate((sel) => {
    const el = document.querySelector(`${sel} .pdf-container`);
    el.scrollTop = el.scrollHeight;
  }, R);
  await win.waitForTimeout(200);
  const before = await win.evaluate((sel) => document.querySelector(`${sel} .pdf-container`).scrollTop, R);
  expect(before).toBeGreaterThan(1000);

  // 왼쪽 1쪽 텍스트 위를 Alt+클릭 → 오른쪽이 1쪽 근처로 되돌아온다
  await win.locator(`${L} .textLayer span`).first().click({ modifiers: ['Alt'] });
  await expect
    .poll(() => win.evaluate((sel) => document.querySelector(`${sel} .pdf-container`).scrollTop, R), { timeout: 5000 })
    .toBeLessThan(before / 2);
  await expect(win.locator(`${R} .wc-pulse`)).toHaveCount(1); // 도착 지점 펄스

  // 이동 직전 위치가 링크 히스토리에 쌓여 뒤로가기가 활성화된다
  await expect(win.locator('#btn-back')).toBeEnabled();

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(ko, { force: true });
});

test('마커 미러링: 원문에 형광펜을 그으면 번역본 같은 자리에 미러가 생긴다', async () => {
  const { a, ko } = writeKoPair('mir' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, ko] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${R} .textLayer span`, { timeout: 20000 });

  await selectFirstSpan(win, L);
  await markHighlight(win);
  await expect(win.locator(`${L} .wc-mark-highlight`)).toHaveCount(1);
  // 반대편(.ko.pdf)에 자동 미러 — 점선 스타일로 구분된다
  await expect(win.locator(`${R} .wc-mark[data-origin="mirror"]`)).toHaveCount(1);

  // 미러도 문서에 묶인다 → Switch 하면 문서를 따라간다
  await win.click('#btn-switch');
  await expect(win.locator(`${L} .wc-mark[data-origin="mirror"]`)).toHaveCount(1, { timeout: 10000 });
  await expect(win.locator(`${R} .wc-mark-highlight:not([data-origin])`)).toHaveCount(1);

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(ko, { force: true });
});

test('TOC 패널: 목차가 뜨고 클릭하면 그 페이지로 이동하며 히스토리에 쌓인다', async () => {
  const a = path.join(os.tmpdir(), `wc-m1-toc-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900, outline: true }));
  const app = await electron.launch({ args: [MAIN, a] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });

  const pageW = () => win.locator(`${L} .pdfViewer .page`).first().evaluate((el) => el.clientWidth);
  const before = await pageW();

  await win.click('#btn-toc');
  await expect(win.locator(`${L} .pdf-outline`)).toBeVisible();
  await expect(win.locator(`${L} .toc-item`)).toHaveCount(5);
  // 드로어는 겹치지 않고 pane을 나눈다 → fit(page-width)이 좁아진 폭으로 재계산된다
  await expect.poll(pageW, { timeout: 5000 }).toBeLessThan(before);

  await win.locator(`${L} .toc-item`, { hasText: 'Section 4' }).click();
  await expect(win.locator('#pdf-page')).toHaveValue('4', { timeout: 5000 });
  await expect(win.locator('#btn-back')).toBeEnabled(); // goToDestination 경유 → 히스토리 자동 연동

  await win.click('#btn-toc'); // 닫으면 폭 복원
  await expect(win.locator(`${L} .pdf-outline`)).toBeHidden();
  await expect.poll(pageW, { timeout: 5000 }).toBeGreaterThanOrEqual(before - 2);

  await app.close();
  fs.rmSync(a, { force: true });
});

test('목차 없는 PDF는 TOC 패널에 (목차 없음)을 보여준다', async () => {
  const a = path.join(os.tmpdir(), `wc-m1-notoc-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(2, { height: 900 }));
  const app = await electron.launch({ args: [MAIN, a] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });

  await win.click('#btn-toc');
  await expect(win.locator(`${L} .toc-empty`)).toHaveText('(목차 없음)');

  await app.close();
  fs.rmSync(a, { force: true });
});

test('전체 텍스트 복사 IPC: main 경유로 클립보드에 기록된다', async () => {
  const app = await electron.launch({ args: [MAIN] });
  const win = await app.firstWindow();
  await win.waitForSelector('#toolbar', { timeout: 20000 });

  await win.evaluate(() => window.wcompare.copyText('wcompare 전체 텍스트 복사 테스트'));
  const text = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(text).toBe('wcompare 전체 텍스트 복사 테스트');

  await app.close();
});

test('메뉴에 Recent Files 서브메뉴가 있고, 연 파일이 기록된다', async () => {
  const a = path.join(os.tmpdir(), `wc-m1-rf-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(1, { height: 900 }));
  const app = await electron.launch({ args: [MAIN, a] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });

  const found = await app.evaluate(({ Menu }, base) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
    const recent = file.submenu.items.find((i) => i.label === 'Recent Files');
    if (!recent) return { hasMenu: false };
    return {
      hasMenu: true,
      hasEntry: recent.submenu.items.some((i) => i.label === base),
    };
  }, path.basename(a));
  expect(found.hasMenu).toBe(true);
  expect(found.hasEntry).toBe(true); // CLI로 연 파일도 file IPC를 지나며 기록된다

  await app.close();
  fs.rmSync(a, { force: true });
});
