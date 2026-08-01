// test/e2e/pdf-m1.spec.js — M1 quick wins + 미러 점프(3.2) + TOC 패널.
// 미러 점프의 전제: 원문↔번역본(<이름>.pdf ↔ <이름>.ko.pdf)은 페이지 지오메트리를 공유한다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

// e2e 공통: 렌더러가 localStorage에 남기는 UI 상태(보기 형태 wc-layout, Night, Dict)가
// spec 사이로 새지 않도록 userData를 이 파일 전용 임시 폴더로 격리한다. 공유 프로필을 쓰면
// 요약 패널이 열린 채로 시작해 pane 폭이 달라지고, 배율·스크롤을 재는 테스트가 실행 순서에 따라 흔들린다.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ud-'));
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

test('야간 모드: 페이지 canvas만 반전되고 상태가 저장된다', async () => {
  const a = path.join(os.tmpdir(), `wc-m1-night-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(2, { height: 900 }));
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a] });
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
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a, ko] });
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

test('TOC 패널: 목차가 뜨고 클릭하면 그 페이지로 이동하며 히스토리에 쌓인다', async () => {
  const a = path.join(os.tmpdir(), `wc-m1-toc-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900, outline: true }));
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });

  const pageW = () => win.locator(`${L} .pdfViewer .page`).first().evaluate((el) => el.clientWidth);
  const before = await pageW();

  await win.click('#btn-toc');
  await expect(win.locator('.pdf-outline')).toBeVisible();
  await expect(win.locator('.pdf-outline .toc-item')).toHaveCount(5);
  // 드로어는 겹치지 않고 pane을 나눈다 → fit(page-width)이 좁아진 폭으로 재계산된다
  await expect.poll(pageW, { timeout: 5000 }).toBeLessThan(before);

  await win.locator('.pdf-outline .toc-item', { hasText: 'Section 4' }).click();
  await expect(win.locator('#pdf-page')).toHaveValue('4', { timeout: 5000 });
  await expect(win.locator('#btn-back')).toBeEnabled(); // goToDestination 경유 → 히스토리 자동 연동

  await win.click('#btn-toc'); // 닫으면 폭 복원
  await expect(win.locator('.pdf-outline')).toBeHidden();
  await expect.poll(pageW, { timeout: 5000 }).toBeGreaterThanOrEqual(before - 2);

  await app.close();
  fs.rmSync(a, { force: true });
});

test('목차 없는 PDF는 TOC 패널에 (목차 없음)을 보여준다', async () => {
  const a = path.join(os.tmpdir(), `wc-m1-notoc-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(2, { height: 900 }));
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });

  await win.click('#btn-toc');
  await expect(win.locator('.pdf-outline .toc-empty')).toHaveText('(목차 없음)');

  await app.close();
  fs.rmSync(a, { force: true });
});

test('TOC 드로어는 왼쪽 pane에만 열린다 (양쪽에 PDF가 있어도)', async () => {
  // 왼쪽 전용 규칙은 diff 모드의 md TOC와 PDF 모드가 같아야 한다. 예전에는 setOutline이 두 pane을
  // 모두 켜서 오른쪽에도 드로어가 떴다 — 오른쪽은 대조 대상일 뿐 순서대로 읽어 내려가는 문서가
  // 아니라, 양쪽에 띄우면 좁아진 폭만 두 번 잃는다.
  const a = path.join(os.tmpdir(), `wc-m1-rtoc-a-${Date.now()}.pdf`);
  const b = path.join(os.tmpdir(), `wc-m1-rtoc-b-${Date.now()}.pdf`);
  fs.writeFileSync(a, makePdf(3, { height: 900, outline: true }));
  fs.writeFileSync(b, makePdf(3, { height: 900, outline: true }));
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${R} canvas`, { timeout: 20000 });

  await win.click('#btn-toc');
  await expect(win.locator('.pdf-outline')).toBeVisible();
  // 드로어 '개수'로 센다 — toBeHidden()은 DOM에 없는 요소에도 참이라, 승격 뒤에는 감시가 죽는다.
  await expect(win.locator('#pdfview.outline-open')).toHaveCount(1);
  await expect(win.locator('.pdf-outline')).toHaveCount(1); // 앱 전체에 하나뿐이다
  // pane 안에는 목차가 남아 있지 않다(4열 재편으로 밖으로 나갔다).
  await expect(win.locator(`${L} .pdf-outline`)).toHaveCount(0);
  await expect(win.locator(`${R} .pdf-outline`)).toHaveCount(0);

  // 목차는 두 pane '왼쪽 바깥'에 온다 — 뷰어를 가리지 않고 첫 열을 차지한다.
  const outline = await win.locator('.pdf-outline').boundingBox();
  const lHost = await win.locator(`${L} .pdf-viewer-host`).boundingBox();
  expect(outline.x).toBeLessThan(lHost.x);

  // 목표의 핵심: 두 뷰어 폭이 같다. 목차를 연 상태에서도 성립해야 한다
  // (예전에는 목차가 든 pane만 200px 좁아져 같은 페이지가 서로 다른 배율로 보였다).
  const lPane = await win.locator(L).boundingBox();
  const rPane = await win.locator(R).boundingBox();
  expect(Math.abs(lPane.width - rPane.width)).toBeLessThanOrEqual(2);

  // 좌우를 바꿔도 목차는 여전히 왼쪽에만 — 문서 교체 경로에서도 규칙이 유지된다.
  await win.click('#btn-switch');
  await expect(win.locator('#pdfview.outline-open')).toHaveCount(1);
  await expect(win.locator('.pdf-outline')).toHaveCount(1); // 드로어는 앱 전체에 하나뿐이다
  await expect(win.locator('.pdf-outline')).toBeVisible();

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('전체 텍스트 복사 IPC: main 경유로 클립보드에 기록된다', async () => {
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`] });
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
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a] });
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
