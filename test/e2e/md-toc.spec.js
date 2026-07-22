// test/e2e/md-toc.spec.js — Markdown TOC 모드(diff): 토글·헤딩 렌더·라인 이동·오른쪽 부착·비활성.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

// 헤딩 사이에 filler 본문을 넣어 아래쪽 헤딩 클릭 시 실제로 스크롤이 일어나게 한다.
const filler = Array(15).fill('lorem ipsum body line').join('\n');
const MD_A = ['# Alpha', filler, '## Beta', filler, '### Gamma', filler, '## Delta', filler].join('\n');
const MD_B = ['# One', '## Two', '## Three'].join('\n');
const deltaLine = MD_A.split('\n').findIndex((l) => l === '## Delta') + 1;

function tmp(name, body) {
  const p = path.join(os.tmpdir(), `wc-mdtoc-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.${name.endsWith('txt') ? 'txt' : 'md'}`);
  fs.writeFileSync(p, body);
  return p;
}
const valueHas = (win, side, s) => win.waitForFunction(
  ([sd, str]) => window.__wc?.editorApi.getValue(sd).includes(str), [side, s], { timeout: 20000 });

test('MD TOC: 토글로 드로어가 뜨고 헤딩을 보여주며 항목 클릭 시 해당 라인으로 이동한다', async () => {
  const a = tmp('a', MD_A);
  const b = tmp('b', MD_B);
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'Alpha');
  await valueHas(win, 'right', 'Three');

  // 두 파일 모두 markdown → 버튼 활성화
  await expect(win.locator('#btn-toc')).toBeEnabled();

  // 토글 → 라벨 "TOC ✓", 양쪽 드로어 표시
  await win.click('#btn-toc');
  await expect(win.locator('#btn-toc')).toHaveText('TOC ✓');
  await expect(win.locator('#md-toc-left')).toBeVisible();
  await expect(win.locator('#md-toc-right')).toBeVisible();

  // 왼쪽 4개(Alpha/Beta/Gamma/Delta), 오른쪽 3개(One/Two/Three)
  await expect(win.locator('#md-toc-left .toc-item')).toHaveCount(4);
  await expect(win.locator('#md-toc-right .toc-item')).toHaveCount(3);

  // 오른쪽 드로어는 #editor보다 오른쪽, 왼쪽 드로어는 왼쪽(DOM 순서로 우측 부착)
  const edBox = await win.locator('#editor').boundingBox();
  const rBox = await win.locator('#md-toc-right').boundingBox();
  const lBox = await win.locator('#md-toc-left').boundingBox();
  expect(rBox.x).toBeGreaterThan(edBox.x);
  expect(lBox.x).toBeLessThan(edBox.x);

  // "Delta" 클릭 → 왼쪽 에디터 커서가 해당 라인으로, 스크롤도 내려간다
  await win.locator('#md-toc-left .toc-item', { hasText: 'Delta' }).click();
  await expect.poll(() => win.evaluate(() => {
    const p = window.__wc.editorApi.innerOf('left').getPosition();
    return p ? p.lineNumber : 0;
  }), { timeout: 5000 }).toBe(deltaLine);
  expect(await win.evaluate(() => window.__wc.editorApi.innerOf('left').getScrollTop())).toBeGreaterThan(0);

  // 다시 토글 → 드로어 숨김
  await win.click('#btn-toc');
  await expect(win.locator('#md-toc-left')).toBeHidden();
  await expect(win.locator('#md-toc-right')).toBeHidden();

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('MD TOC: markdown 파일이 한쪽도 없으면 버튼이 비활성화된다', async () => {
  const a = tmp('txt', 'plain text left\n');
  const b = tmp('txt', 'plain text right\n');
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'plain text left');
  await valueHas(win, 'right', 'plain text right');
  await expect(win.locator('#btn-toc')).toBeDisabled();

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('MD TOC: 한쪽만 markdown이면 그 side 드로어만 보인다', async () => {
  const a = tmp('a', MD_A);
  const b = tmp('txt', 'plain right side\n');
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'Alpha');
  await valueHas(win, 'right', 'plain right side');

  await expect(win.locator('#btn-toc')).toBeEnabled(); // 왼쪽이 markdown
  await win.click('#btn-toc');
  await expect(win.locator('#md-toc-left')).toBeVisible();
  await expect(win.locator('#md-toc-right')).toBeHidden(); // 오른쪽은 비-md라 숨김

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});
