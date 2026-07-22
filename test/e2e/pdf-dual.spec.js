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

test('줌 단축키: Ctrl+휠 / Cmd·Ctrl +,- 로 배율 변경', async () => {
  const { a, b } = writePair('zk' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });
  const pct = () => win.evaluate(() => { const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || ''); return m ? +m[1] : 0; });
  const base = await pct();
  // Ctrl + wheel up → 확대
  await win.evaluate((sel) => document.querySelector(sel).dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true })), leftC);
  await win.waitForFunction((b0) => { const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || ''); return m && +m[1] > b0; }, base, { timeout: 5000 });
  const afterWheel = await pct();
  // Cmd/Ctrl + '=' → 확대
  await win.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })));
  await win.waitForFunction((b0) => { const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || ''); return m && +m[1] > b0; }, afterWheel, { timeout: 5000 });
  const afterPlus = await pct();
  // Cmd/Ctrl + '-' → 축소
  await win.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })));
  await win.waitForFunction((b0) => { const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || ''); return m && +m[1] < b0; }, afterPlus, { timeout: 5000 });
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

const pct = (win) => win.evaluate(() => {
  const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || '');
  return m ? +m[1] : 0;
});

test('Switch: 좌우 문서가 서로 바뀐다', async () => {
  const a = path.join(os.tmpdir(), `wc-sw-a-${Date.now()}.pdf`);
  const b = path.join(os.tmpdir(), `wc-sw-b-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900 })); // 좌: 5쪽
  fs.writeFileSync(b, makePdf(3, { height: 900 })); // 우: 3쪽
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await win.waitForFunction(() => /L 1\/5\s+R 1\/3/.test(document.getElementById('pdf-status').textContent || ''), null, { timeout: 10000 });

  await win.click('#btn-switch');
  await win.waitForFunction(() => /L 1\/3\s+R 1\/5/.test(document.getElementById('pdf-status').textContent || ''), null, { timeout: 10000 });

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('Fit: 줌하면 꺼지고 다시 켜면 너비에 맞춰 복귀', async () => {
  const { a, b } = writePair('fit' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await expect(win.locator('#btn-fit')).toHaveText('Fit: ON');
  const base = await pct(win);

  await win.click('#btn-zoom-in');
  await expect(win.locator('#btn-fit')).toHaveText('Fit: OFF'); // 직접 배율 지정 → fit 해제
  expect(await pct(win)).toBeGreaterThan(base);

  await win.click('#btn-fit');
  await expect(win.locator('#btn-fit')).toHaveText('Fit: ON');
  expect(await pct(win)).toBe(base); // 원래 page-width 배율로 복귀

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('Fit ON이면 창 크기를 바꿔도 너비에 계속 맞춘다 (OFF면 고정)', async () => {
  const { a, b } = writePair('resize' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  const wide = await pct(win);

  const setSize = (w, h) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), [w, h]);

  await setSize(760, 700); // 창을 좁히면 fit이 다시 계산되어 배율이 줄어야 한다
  await win.waitForFunction((b0) => {
    const m = /([0-9]+)%/.exec(document.getElementById('pdf-status').textContent || '');
    return m && +m[1] < b0;
  }, wide, { timeout: 5000 });
  const narrow = await pct(win);

  await win.click('#btn-fit'); // Fit OFF → 배율 고정
  await expect(win.locator('#btn-fit')).toHaveText('Fit: OFF');
  await setSize(1180, 800);
  await win.waitForTimeout(600);
  expect(await pct(win)).toBe(narrow); // 창을 넓혀도 그대로

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('Sync ON: 확대로 생긴 가로 스크롤도 반대편이 따라온다', async () => {
  const { a, b } = writePair('hsync' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  for (let i = 0; i < 4; i++) await win.click('#btn-zoom-in'); // 가로가 넘치게
  // 중앙확대로 양쪽이 이미 같은 가로 위치에 있으므로, 왼쪽을 다른 값으로 옮긴 뒤
  // 오른쪽이 "따라와 수렴"하는지를 기다린다(align은 rAF 뒤에 일어나 한 프레임 지연).
  await win.evaluate((s) => { document.querySelector(s).scrollLeft = 300; }, leftC);
  await win.waitForFunction((sels) => {
    const l = document.querySelector(sels[0]).scrollLeft;
    const r = document.querySelector(sels[1]).scrollLeft;
    return l > 200 && Math.abs(l - r) < 5; // 왼쪽이 옮겨졌고 오른쪽이 따라왔다
  }, [leftC, rightC], { timeout: 5000 });

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('확대: 가로가 넘칠 때 왼쪽이 아니라 중앙을 기준으로 커진다', async () => {
  const { a, b } = writePair('zc' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  // 뷰포트 가로 중앙이 가리키는 지점이 콘텐츠 전체에서 차지하는 비율
  const centerRatio = (sel) => win.evaluate((s) => {
    const el = document.querySelector(s);
    return (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth;
  }, sel);
  const overflowX = (sel) => win.evaluate((s) => {
    const el = document.querySelector(s);
    return el.scrollWidth - el.clientWidth;
  }, sel);

  expect(await overflowX(leftC)).toBeLessThanOrEqual(1); // Fit 상태: 가로로 넘치지 않음
  expect(await centerRatio(leftC)).toBeCloseTo(0.5, 2);

  for (let i = 0; i < 3; i++) await win.click('#btn-zoom-in'); // 가로가 확실히 넘치게

  expect(await overflowX(leftC)).toBeGreaterThan(10); // 이제 가로 스크롤이 생겼다
  // 왼쪽 고정이면 이 값이 0.5보다 뚜렷하게 작아진다(중앙이 왼쪽으로 밀림)
  expect(await centerRatio(leftC)).toBeCloseTo(0.5, 1);
  expect(await centerRatio(rightC)).toBeCloseTo(0.5, 1);
  expect(await win.evaluate((s) => document.querySelector(s).scrollLeft, leftC)).toBeGreaterThan(0);

  // 축소해서 되돌아와도 중앙 유지
  for (let i = 0; i < 3; i++) await win.click('#btn-zoom-out');
  expect(await centerRatio(leftC)).toBeCloseTo(0.5, 1);

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('Sync OFF: 휠 줌이 대상 side에만 적용되고 반대편은 그대로다', async () => {
  const { a, b } = writePair('zoomoff' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  await win.click('#btn-sync');
  await expect(win.locator('#btn-sync')).toHaveText('Sync: OFF');

  const overflowX = (sel) => win.evaluate((s) => {
    const el = document.querySelector(s);
    return el.scrollWidth - el.clientWidth;
  }, sel);

  expect(await overflowX(leftC)).toBeLessThanOrEqual(1);
  expect(await overflowX(rightC)).toBeLessThanOrEqual(1);

  // 왼쪽 pane 위에서 Ctrl+휠 → 왼쪽만 확대되어야 한다(휠 리스너가 자기 side를 zoom에 전달)
  for (let i = 0; i < 4; i++) {
    await win.evaluate((sel) => document.querySelector(sel).dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }),
    ), leftC);
  }
  await win.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return (el.scrollWidth - el.clientWidth) > 10;
  }, leftC, { timeout: 5000 });

  expect(await overflowX(leftC)).toBeGreaterThan(10);
  expect(await overflowX(rightC)).toBeLessThanOrEqual(1); // Sync OFF → 반대편은 불변

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('검색: 양쪽에서 동시에 찾고 일치 수를 보여준다', async () => {
  const { a, b } = writePair('find' + Date.now()); // 5쪽짜리 두 개, 각 쪽에 "Page N"
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  const count = win.locator('#pdf-find-count');

  // 새 검색은 "지금 보고 있는 쪽"에서 시작한다(pdf.js 기본 동작) → 1쪽에서 시작하므로 1/5
  await win.fill('#pdf-find', 'Page');
  await expect(count).toHaveText('L 1/5  R 1/5', { timeout: 10000 }); // 5쪽 모두 일치
  await win.click('#btn-find-next');
  await expect(count).toHaveText('L 2/5  R 2/5', { timeout: 10000 }); // 다음 일치로 이동
  await win.click('#btn-find-prev');
  await expect(count).toHaveText('L 1/5  R 1/5', { timeout: 10000 });

  await win.fill('#pdf-find', 'Page 3');
  await expect(count).toHaveText('L 1/1  R 1/1', { timeout: 10000 }); // 문서당 한 번만 등장

  await win.fill('#pdf-find', 'zzzz'); // 없는 문자열
  await expect(count).toHaveText('L 0/0  R 0/0', { timeout: 10000 });
  await expect(count).toHaveClass(/miss/);

  await win.fill('#pdf-find', '');
  await expect(count).toHaveText('', { timeout: 10000 }); // 지우면 표시도 사라진다

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('링크 히스토리: 링크로 튄 뒤 뒤로/앞으로 (버튼 + ⌘←/→)', async () => {
  const a = path.join(os.tmpdir(), `wc-link-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900, linkTo: 4 })); // 1쪽에 4쪽으로 가는 내부 링크
  const app = await electron.launch({ args: [MAIN, a] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });

  const onPage = (n) => win.waitForFunction(
    (p) => new RegExp(`L ${p}/5`).test(document.getElementById('pdf-status').textContent || ''),
    n, { timeout: 10000 },
  );
  await onPage(1);
  await expect(win.locator('#btn-back')).toBeDisabled(); // 히스토리 없음

  await win.click(`${leftC} .annotationLayer a`); // 문서 내부 링크 클릭 → 4쪽
  await onPage(4);
  await expect(win.locator('#btn-back')).toBeEnabled();

  await win.click('#btn-back'); // 뒤로 → 1쪽
  await onPage(1);
  await expect(win.locator('#btn-forward')).toBeEnabled();

  await win.click('#btn-forward'); // 앞으로 → 4쪽
  await onPage(4);

  // ⌘←(Cmd/Ctrl + ArrowLeft) 로도 뒤로 간다
  await win.evaluate(() => window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowLeft', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }),
  ));
  await onPage(1);

  await app.close();
  fs.rmSync(a, { force: true });
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
