// test/e2e/theme.spec.js — 시작 모드(PDF) + 설정창의 테마 선택.
// 테마는 툴바 버튼이 아니라 설정창에서 고르고, 값은 settings(ui.theme)에 저장돼 다음 실행까지 간다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const L = '.pdf-pane[data-side=left]';

// 같은 userData를 두 번 쓰면 "다시 켜도 유지되는가"를 검증할 수 있다.
async function launch(userData) {
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] });
  const win = await app.firstWindow();
  await win.waitForSelector('#toolbar', { timeout: 20000 });
  // 대형 번들(app.js)이 정적 DOM보다 늦게 실행된다 → 초기화가 끝날 때까지 기다린다.
  await win.waitForFunction(
    () => typeof document.getElementById('btn-mode-pdf').onclick === 'function', null, { timeout: 20000 });
  return { app, win };
}

const themeOf = (win) => win.evaluate(() => document.documentElement.dataset.theme || 'dark');
const bodyBg = (win) => win.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('앱은 PDF 모드로 시작하고 빈 왼쪽 pane에 URL 입력창이 보인다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-start-'));
  const { app, win } = await launch(path.join(dir, 'ud'));

  expect(await win.evaluate(() => window.__wc.getMode())).toBe('pdf');
  await expect(win.locator('#pdfview')).toBeVisible();
  await expect(win.locator('#diff-wrap')).toBeHidden();
  await expect(win.locator(`${L} .pdf-url-input`)).toBeVisible(); // 시작 화면이 곧 URL 입력이다
  await expect(win.locator('#pdf-controls')).toBeVisible();

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('툴바에 Theme 버튼이 없고 설정창에서 테마를 고른다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-theme-'));
  const ud = path.join(dir, 'ud');
  const { app, win } = await launch(ud);

  await expect(win.locator('#btn-theme')).toHaveCount(0); // 버튼은 설정창으로 옮겨졌다
  expect(await themeOf(win)).toBe('dark');
  const darkBg = await bodyBg(win);

  await win.evaluate(() => document.getElementById('settings-dialog').showModal());
  await expect(win.locator('#set-theme')).toBeVisible();
  await expect(win.locator('#set-theme')).toHaveValue('dark');

  // 설정창 안의 모든 텍스트 입력이 테마를 따른다 — type을 생략한 입력만 네이티브 흰색으로
  // 남아 다크에서 구멍처럼 보이던 회귀를 막는다(체크박스는 네이티브가 맞으므로 제외).
  const nativeInputs = await win.evaluate(() => [...document.querySelectorAll('#settings-dialog input')]
    .filter((el) => el.type !== 'checkbox')
    .filter((el) => getComputedStyle(el).backgroundColor === 'rgb(255, 255, 255)')
    .map((el) => el.id));
  expect(nativeInputs).toEqual([]);

  await win.selectOption('#set-theme', 'light');
  expect(await themeOf(win)).toBe('light');
  // 클래스만 바뀌고 실제 색이 안 변하면 의미가 없다 — 계산된 배경색이 실제로 달라졌는지 본다
  expect(await bodyBg(win)).not.toBe(darkBg);
  // 설정에 저장됐다
  await expect
    .poll(() => win.evaluate(async () => (await window.wcompare.settings.get()).ui.theme))
    .toBe('light');

  await app.close();

  // 같은 userData로 다시 켜면 라이트로 시작한다
  const again = await launch(ud);
  await expect.poll(() => themeOf(again.win), { timeout: 10000 }).toBe('light');
  await expect(again.win.locator('#set-theme')).toHaveCount(1);
  await again.app.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('라이트 테마에서도 툴바·상태바·빈 pane 안내가 배경에 묻히지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-theme-contrast-'));
  const { app, win } = await launch(path.join(dir, 'ud'));

  await win.evaluate(() => document.getElementById('settings-dialog').showModal());
  await win.selectOption('#set-theme', 'light');
  await win.evaluate(() => document.getElementById('settings-dialog').close());

  // 야간 모드는 PDF 바닥을 테마와 무관하게 어둡게 고정한다 —
  // 그 위에 겹치는 URL 안내가 라이트에서 읽히지 않던 회귀를 여기서 잡는다.
  await win.click('#btn-night');
  await expect(win.locator('#btn-night')).toHaveText('Night: ON');

  const contrast = await win.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+/g).slice(0, 3).map((n) => {
        const s = Number(n) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const panel = document.querySelector('.pdf-pane[data-side=left] .pdf-url');
    const cs = getComputedStyle(panel);
    const a = lum(cs.color);
    const b = lum(cs.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThan(4.5); // WCAG AA

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
