// test/e2e/shortcuts.spec.js — 커스텀 토글 단축키 + ON 버튼 하이라이트 + 설정창 단축키 섹션.
// PDF 전용(fit/sync/switch)은 설정이 무거워, 공통 토글인 night(⌥N)·dict(⌘D)로 발동을 검증한다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

function tmpMd(body) {
  const p = path.join(os.tmpdir(), `wc-sc-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(p, body);
  return p;
}
const valueHas = (win, side, s) => win.waitForFunction(
  ([sd, str]) => window.__wc?.editorApi.getValue(sd).includes(str), [side, s], { timeout: 20000 });

// Monaco textarea가 포커스면 커스텀 단축키가 skip되므로, 발동 검증 전엔 포커스를 body로 옮긴다.
const blur = (win) => win.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); document.body.focus?.(); });

async function launch() {
  const a = tmpMd('# left\n\nhello world\n');
  const b = tmpMd('# right\n\nplain right side\n');
  // 실제 ~/.local·userData를 오염시키지 않도록 settings.json을 임시 userData로 격리한다.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sc-ud-'));
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'hello world');
  // 커스텀 단축키 로드가 끝날 때까지(startup loadShortcuts 비동기) 기다린다.
  await win.waitForFunction(() => window.__wc?.getShortcuts()?.night === 'Alt+N', null, { timeout: 20000 });
  return { app, win, files: [a, b], userData };
}
const cleanup = ({ files, userData }) => {
  files.forEach((f) => fs.rmSync(f, { force: true }));
  fs.rmSync(userData, { recursive: true, force: true });
};

test('기본 단축키 ⌥N으로 Night 토글이 켜지고 꺼진다 (+ .on 하이라이트)', async () => {
  const ctx = await launch();
  const { app, win } = ctx;

  await expect(win.locator('#btn-night')).toHaveText('Night: OFF');
  await expect(win.locator('#btn-night')).not.toHaveClass(/\bon\b/);

  await blur(win);
  await win.keyboard.press('Alt+N');
  await expect(win.locator('#btn-night')).toHaveText('Night: ON');
  await expect(win.locator('#btn-night')).toHaveClass(/\bon\b/);
  expect(await win.evaluate(() => window.__wc.isNight())).toBe(true);

  await blur(win);
  await win.keyboard.press('Alt+N');
  await expect(win.locator('#btn-night')).toHaveText('Night: OFF');
  await expect(win.locator('#btn-night')).not.toHaveClass(/\bon\b/);

  await app.close();
  cleanup(ctx);
});

test('기본 단축키 ⌘D로 Dict 토글이 켜진다 (+ .on 하이라이트)', async () => {
  const ctx = await launch();
  const { app, win } = ctx;

  await expect(win.locator('#btn-dict')).toHaveText('Dict: OFF');
  await blur(win);
  await win.keyboard.press('Meta+D'); // Cmd+D
  await expect(win.locator('#btn-dict')).toHaveText('Dict: ON');
  await expect(win.locator('#btn-dict')).toHaveClass(/\bon\b/);
  expect(await win.evaluate(() => window.__wc.isDictOn())).toBe(true);

  await app.close();
  cleanup(ctx);
});

test('설정창에 단축키 5행이 있고 기본 표현이 표시된다', async () => {
  const ctx = await launch();
  const { app, win } = ctx;

  // menu:settings를 직접 보내 openSettings를 태운다(행 값 채우기 포함).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:settings'));
  await win.waitForSelector('#settings-dialog[open]', { timeout: 10000 });

  await expect(win.locator('#shortcut-rows .sc-row')).toHaveCount(5);
  await expect(win.locator('.sc-row[data-action=dict] .sc-key')).toHaveValue('⌘D');
  await expect(win.locator('.sc-row[data-action=fit] .sc-key')).toHaveValue('⌥F');
  await expect(win.locator('.sc-row[data-action=switch] .sc-key')).toHaveValue('⌥→');

  await app.close();
  cleanup(ctx);
});

test('설정창에서 키 캡처로 단축키를 바꾸면 표시·저장·경고가 반영된다', async () => {
  const ctx = await launch();
  const { app, win } = ctx;

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:settings'));
  await win.waitForSelector('#settings-dialog[open]', { timeout: 10000 });

  // fit 행 "변경" → 대기 표시 → ⌘F 입력(예약된 '찾기'라 경고가 뜨지만 저장은 허용)
  await win.click('.sc-row[data-action=fit] button[data-role=change]');
  await expect(win.locator('.sc-row[data-action=fit] .sc-key')).toHaveValue('키 입력 대기…');
  await win.keyboard.press('Meta+F');

  await expect(win.locator('.sc-row[data-action=fit] .sc-key')).toHaveValue('⌘F');
  await expect(win.locator('.sc-row[data-action=fit] .sc-warn')).toContainText('찾기');
  // 저장까지 반영
  await expect
    .poll(() => win.evaluate(async () => (await window.wcompare.settings.get()).shortcuts.fit), { timeout: 8000 })
    .toBe('Cmd+F');
  // 현재 창 변수도 즉시 갱신
  expect(await win.evaluate(() => window.__wc.getShortcuts().fit)).toBe('Cmd+F');

  await app.close();
  cleanup(ctx);
});
