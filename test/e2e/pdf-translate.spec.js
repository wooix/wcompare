// test/e2e/pdf-translate.spec.js — 번역 버튼 게이팅 + 번역 결과가 반대편 pane에 열리는지.
// 실제 transpaper(LLM 호출, 페이지당 수십 초) 대신 스텁 실행 파일을 WCOMPARE_TRANSPAPER로 주입한다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const leftC = '.pdf-pane[data-side=left] .pdf-container';
const rightC = '.pdf-pane[data-side=right] .pdf-container';

// transpaper 계약: `transpaper <input> -o <output> -v`
//   - 페이지마다 stdout에 "page N: ..." 을 흘리고
//   - <output>에 번역된 PDF를 쓰고 exit 0
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
    'echo "page 1: translated 4 blocks, 0 overflowed"',
    `sleep ${delay}`,
    'cp "$input" "$out"',
    'echo "wrote $out"',
  ].join('\n'), { mode: 0o755 });
  return p;
}

function setup(tag, delay = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-tr-${tag}-`));
  const src = path.join(dir, 'paper.pdf');
  fs.writeFileSync(src, makePdf(5, { height: 900 }));
  return { dir, src, env: { ...process.env, WCOMPARE_TRANSPAPER: stubTranspaper(dir, delay) } };
}

test('PDF 한 개만 열면 번역 버튼이 활성화된다', async () => {
  const { dir, src, env } = setup('one');
  const app = await electron.launch({ args: [MAIN, src], env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });
  await expect(win.locator('#btn-translate')).toBeEnabled();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PDF 두 개를 열면 번역 버튼이 비활성화된다', async () => {
  const { dir, src, env } = setup('two');
  const b = path.join(dir, 'other.pdf');
  fs.writeFileSync(b, makePdf(5, { height: 900 }));
  const app = await electron.launch({ args: [MAIN, src, b], env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await expect(win.locator('#btn-translate')).toBeDisabled();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('번역 중이라는 표시가 비어 있는 쪽 창에 뜬다', async () => {
  const { dir, src, env } = setup('busy', 2); // 페이지 사이 2초 지연 → 진행 중 상태를 관찰
  const app = await electron.launch({ args: [MAIN, src], env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });

  const busy = win.locator('.pdf-pane[data-side=right] .pdf-busy');
  await expect(busy).toBeHidden(); // 시작 전에는 없다

  await win.click('#btn-translate');
  await expect(busy).toBeVisible({ timeout: 5000 });
  await expect(busy).toContainText('한국어 번역 중…');
  await expect(busy).toContainText('/ 5 페이지', { timeout: 8000 }); // 원본 쪽 페이지 수를 분모로
  // 원본이 있는 왼쪽에는 오버레이가 뜨지 않는다
  await expect(win.locator('.pdf-pane[data-side=left] .pdf-busy')).toBeHidden();
  await expect(win.locator('#btn-translate')).toHaveText('번역 취소');
  await expect(win.locator('#btn-switch')).toBeDisabled();

  // 끝나면 오버레이가 사라지고 번역본이 렌더된다
  await expect(busy).toBeHidden({ timeout: 20000 });
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('번역하면 결과가 반대편 pane에 열린다', async () => {
  const { dir, src, env } = setup('run');
  const app = await electron.launch({ args: [MAIN, src], env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });

  await win.click('#btn-translate');

  // 우측 pane에 번역본이 렌더된다
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  // 상태바가 진행률에서 통상 표시로 복귀 + 양쪽 페이지 수가 잡힌다
  await win.waitForFunction(
    () => /L 1\/5\s+R 1\/5/.test(document.getElementById('pdf-status').textContent || ''),
    null, { timeout: 10000 },
  );
  // 번역본이 원본 옆에 .ko.pdf 로 저장된다
  expect(fs.existsSync(path.join(dir, 'paper.ko.pdf'))).toBe(true);
  // 양쪽이 다 찼으므로 버튼은 다시 비활성
  await expect(win.locator('#btn-translate')).toBeDisabled();

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
