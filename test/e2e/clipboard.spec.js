// test/e2e/clipboard.spec.js — 클립보드(붙여넣기/복사). Edit role 메뉴가 없으면 macOS에서 ⌘V/⌘C가 앱에 닿지 않는다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const leftC = '.pdf-pane[data-side=left] .pdf-container';
const rightC = '.pdf-pane[data-side=right] .pdf-container';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function writePair(tag) {
  const a = path.join(os.tmpdir(), `wc-clip-a-${tag}.pdf`);
  const b = path.join(os.tmpdir(), `wc-clip-b-${tag}.pdf`);
  fs.writeFileSync(a, makePdf(5, { height: 900 }));
  fs.writeFileSync(b, makePdf(5, { height: 900 }));
  return { a, b };
}

// ⚠️ 이 파일의 키 입력은 CDP로 렌더러에 직접 주입되므로 네이티브 메뉴 accelerator 경로를 "우회"한다.
// 따라서 아래 붙여넣기/복사 테스트만으로는 Edit 메뉴 누락 버그를 잡지 못한다(메뉴가 없어도 통과함).
// 실제 회귀를 막는 것은 이 메뉴 구조 검사다.
test('애플리케이션 메뉴에 Edit(복사/붙여넣기) 역할이 있다', async () => {
  const app = await electron.launch({ args: [MAIN] });
  await app.firstWindow();
  // Electron은 role 이름을 소문자로 정규화해 돌려준다 (selectAll → selectall)
  const roles = await app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((i) => i.role === 'editmenu');
    return edit ? edit.submenu.items.map((x) => x.role).filter(Boolean) : [];
  });
  // 이게 없으면 macOS에서 ⌘V/⌘C 가 앱에 전달되지 않는다
  expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectall']));
  await app.close();
});

test('검색창에 붙여넣기가 된다', async () => {
  const { a, b } = writePair('paste' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  await app.evaluate(({ clipboard }) => clipboard.writeText('Page 3'));
  await win.click('#pdf-find');
  await win.keyboard.press(`${MOD}+V`);

  await expect(win.locator('#pdf-find')).toHaveValue('Page 3');
  // 붙여넣은 값으로 실제 검색까지 돌아야 한다
  await expect(win.locator('#pdf-find-count')).toHaveText('L 1/1  R 1/1', { timeout: 10000 });

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('PDF 텍스트를 드래그 선택하고 복사한다', async () => {
  const { a, b } = writePair('copy' + Date.now());
  const app = await electron.launch({ args: [MAIN, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} .textLayer span`, { timeout: 20000 });

  await app.evaluate(({ clipboard }) => clipboard.writeText('')); // 이전 값 제거
  // textLayer의 선택은 평범한 DOM Selection이다
  await win.evaluate((sel) => {
    const span = document.querySelector(`${sel} .textLayer span`);
    const range = document.createRange();
    range.selectNodeContents(span);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, leftC);
  await win.keyboard.press(`${MOD}+C`);

  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5000 })
    .toContain('Page 1');

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});
