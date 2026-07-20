// test/e2e/multi-window.spec.js — New Window(⌘N)로 창을 여러 개 띄우고, 창별 번역이 독립인지.
// 창별 job 독립성(동시 번역 허용)은 단위 test/translationJobs.test.js가 촘촘히 커버하므로,
// e2e는 (a) New Window로 창이 2개가 되는지 (b) 두 번째 창이 있어도 기존 창의 번역이 회귀 없이
// 동작하는지 로 축소한다(두 창 동시 번역은 e2e에서 flaky해 단위 테스트로 대신 검증).
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const leftC = '.pdf-pane[data-side=left] .pdf-container';
const rightC = '.pdf-pane[data-side=right] .pdf-container';

function stubTranspaper(dir, delay = 0) {
  const p = path.join(dir, 'transpaper');
  fs.writeFileSync(p, [
    '#!/bin/sh',
    'input="$1"; shift',
    'out=""',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi',
    'done',
    'echo "page 0: translated 3 blocks, 0 overflowed"',
    `sleep ${delay}`,
    'cp "$input" "$out"',
    'echo "wrote $out"',
  ].join('\n'), { mode: 0o755 });
  return p;
}

function setup(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-mw-${tag}-`));
  const src = path.join(dir, 'paper.pdf');
  fs.writeFileSync(src, makePdf(5, { height: 900 }));
  return { dir, src, env: { ...process.env, WCOMPARE_TRANSPAPER: stubTranspaper(dir) } };
}

// 메인 프로세스에서 File → New Window 메뉴 항목의 click 핸들러를 직접 호출한다(단축키 합성 불가).
async function triggerNewWindow(app) {
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const file = menu.items.find((i) => i.label === 'File');
    const item = file.submenu.items.find((i) => i.label === 'New Window');
    item.click();
  });
}

test('New Window로 BrowserWindow가 2개가 된다', async () => {
  const { dir, src, env } = setup('count');
  const app = await electron.launch({ args: [MAIN, src], env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });

  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await triggerNewWindow(app);
  await expect.poll(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    { timeout: 10000 },
  ).toBe(2);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('두 번째 창이 있어도 기존 창의 번역이 회귀 없이 동작한다', async () => {
  const { dir, src, env } = setup('regress');
  const app = await electron.launch({ args: [MAIN, src], env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });

  await triggerNewWindow(app);
  await expect.poll(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    { timeout: 10000 },
  ).toBe(2);

  // 첫 창에서 번역 → 결과가 우측 pane에 열리고 .ko.pdf가 저장된다(전역 차단이 사라졌다).
  await win.click('#btn-translate');
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  expect(fs.existsSync(path.join(dir, 'paper.ko.pdf'))).toBe(true);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
