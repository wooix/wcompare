const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.resolve(__dirname, '../../src/main/main.js');
const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `wc-reload-${name}-`));
const launch = (dir, files = []) => electron.launch({ args: [MAIN, `--user-data-dir=${path.join(dir, 'ud')}`, ...files] });
const choice = (app, response) => app.evaluate(({ dialog }, value) => {
  dialog.showMessageBox = async () => ({ response: value });
}, response);
const reloadFromMenu = (app) => app.evaluate(({ Menu, BrowserWindow }) => {
  const file = Menu.getApplicationMenu().items.find(item => item.label === 'File');
  const reload = file.submenu.items.find(item => item.label === 'Reload Files');
  reload.click(reload, BrowserWindow.getAllWindows()[0]);
});

test('비교 파일 두 개를 다시 읽고 미저장 편집은 취소·버림·저장을 선택한다', async () => {
  const dir = temp('diff');
  const left = path.join(dir, 'left.txt');
  const right = path.join(dir, 'right.txt');
  fs.writeFileSync(left, 'left v1\n');
  fs.writeFileSync(right, 'right v1\n');
  const app = await launch(dir, [left, right]);
  try {
    const win = await app.firstWindow();
    await expect.poll(() => win.evaluate(() => window.__wc?.editorApi.getState('right').path)).toBe(fs.realpathSync(right));
    await expect(win.locator('#btn-reload-files')).toBeEnabled();
    const accelerator = await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu().items.find(item => item.label === 'File');
      return file.submenu.items.find(item => item.label === 'Reload Files').accelerator;
    });
    expect(accelerator).toBe('CmdOrCtrl+R');
    fs.writeFileSync(left, 'left v2\n');
    fs.writeFileSync(right, 'right v2\n');
    // Playwright CDP 키 입력은 macOS 네이티브 메뉴 accelerator를 통과하지 않는다.
    // 메뉴의 ⌘R 배정과 실제 메뉴 액션 경로를 나눠 확인한다.
    await reloadFromMenu(app);
    await expect.poll(() => win.evaluate(() => [window.__wc.editorApi.getValue('left'), window.__wc.editorApi.getValue('right')]))
      .toEqual(['left v2\n', 'right v2\n']);

    await win.evaluate(() => window.__wc.editorApi.modelOf('left').setValue('unsaved draft'));
    fs.writeFileSync(left, 'left v3\n');
    await choice(app, 2); // 취소
    await win.click('#btn-reload-files');
    expect(await win.evaluate(() => window.__wc.editorApi.getValue('left'))).toBe('unsaved draft');

    await choice(app, 1); // 저장하지 않고 갱신
    await win.click('#btn-reload-files');
    await expect.poll(() => win.evaluate(() => window.__wc.editorApi.getValue('left'))).toBe('left v3\n');
    expect(fs.readFileSync(left, 'utf8')).toBe('left v3\n');

    await win.evaluate(() => window.__wc.editorApi.modelOf('left').setValue('save then reload'));
    await choice(app, 0); // 저장 후 갱신
    await win.click('#btn-reload-files');
    await expect.poll(() => fs.readFileSync(left, 'utf8')).toBe('save then reload');
    await expect.poll(() => win.evaluate(() => window.__wc.editorApi.getState('left').dirty)).toBe(false);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PDF 두 개를 갱신하고 페이지 위치를 유지하며 변경된 원문의 오래된 요약을 지운다', async () => {
  const dir = temp('pdf');
  const left = path.join(dir, 'left.pdf');
  const right = path.join(dir, 'right.pdf');
  fs.writeFileSync(left, makePdf(3, { height: 900 }));
  fs.writeFileSync(right, makePdf(2, { height: 900 }));
  const app = await launch(dir, [left, right]);
  try {
    const win = await app.firstWindow();
    await win.locator('.pdf-pane[data-side=right] canvas').first().waitFor({ timeout: 20000 });
    await win.locator('.pdf-pane[data-side=left] .textLayer span').first().waitFor();
    await win.evaluate(() => {
      const span = document.querySelector('.pdf-pane[data-side=left] .textLayer span');
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'H', shiftKey: true, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
    await expect(win.locator('.pdf-pane[data-side=left] .wc-mark-highlight')).toHaveCount(1);
    await win.evaluate(async p => window.wcompare.summary.save(p, { overview: 'Old summary' }, {}), left);
    await win.fill('#pdf-page', '2');
    await win.locator('#pdf-page').dispatchEvent('change');
    await expect(win.locator('#pdf-page')).toHaveValue('2');

    fs.writeFileSync(left, makePdf(5, { height: 900, lines: 2 }));
    fs.writeFileSync(right, makePdf(4, { height: 900, lines: 2 }));
    await win.click('#btn-reload-files');
    await expect(win.locator('#pdf-total')).toHaveText('5');
    await expect(win.locator('#pdf-status')).toContainText('/4');
    await expect(win.locator('#pdf-page')).toHaveValue('2');
    await win.waitForTimeout(200); // 지연된 pdf.js 스크롤 이벤트가 페이지를 되돌리지 않아야 한다
    await expect(win.locator('#pdf-page')).toHaveValue('2');
    await win.fill('#pdf-page', '1');
    await win.locator('#pdf-page').dispatchEvent('change');
    await expect(win.locator('.pdf-pane[data-side=left] .wc-mark-highlight')).toHaveCount(1);
    await expect.poll(() => win.evaluate(async p => (await window.wcompare.summary.load(p)).parts.overview, left)).toBe('');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PDF 페이지 입력 후 갱신해도 Sync OFF의 오른쪽 페이지와 읽던 위치가 유지된다', async () => {
  const dir = temp('pdf-position');
  const left = path.join(dir, 'left.pdf');
  const right = path.join(dir, 'right.pdf');
  fs.writeFileSync(left, makePdf(30, { height: 900 }));
  fs.writeFileSync(right, makePdf(25, { height: 900 }));
  const app = await launch(dir, [left, right]);
  try {
    const win = await app.firstWindow();
    await win.locator('.pdf-pane[data-side=right] canvas').first().waitFor({ timeout: 20000 });
    await win.click('#btn-sync');
    await win.fill('#pdf-page', '10');
    await win.locator('#pdf-page').dispatchEvent('change');
    await win.evaluate(() => {
      const pane = document.querySelector('.pdf-pane[data-side=right] .pdf-container');
      const page = pane.querySelector('.page[data-page-number="17"]');
      pane.scrollTop = page.offsetTop + 300;
    });
    await expect(win.locator('#pdf-status')).toContainText('L 10/30   R 17/25');
    const before = await win.evaluate(() => ({
      left: document.querySelector('.pdf-pane[data-side=left] .pdf-container').scrollTop,
      right: document.querySelector('.pdf-pane[data-side=right] .pdf-container').scrollTop,
    }));

    await win.click('#btn-reload-files');
    await expect(win.locator('#toolbar-status')).toContainText('다시 불러왔습니다');
    await expect(win.locator('#pdf-status')).toContainText('L 10/30   R 17/25');
    const after = await win.evaluate(() => ({
      left: document.querySelector('.pdf-pane[data-side=left] .pdf-container').scrollTop,
      right: document.querySelector('.pdf-pane[data-side=right] .pdf-container').scrollTop,
    }));
    expect(Math.abs(after.left - before.left)).toBeLessThan(40);
    expect(Math.abs(after.right - before.right)).toBeLessThan(40);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('메모 원문과 번역본을 함께 다시 읽고 미저장 문구는 취소 시 보존한다', async () => {
  const dir = temp('memo');
  const app = await launch(dir);
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => !!window.__wc?.getMode);
    await app.evaluate((_electron, storageDir) => {
      const cache = process.mainModule.require('module')._cache;
      const key = Object.keys(cache).find(k => k.endsWith('/src/main/settings.js'));
      cache[key].exports.set({ storageDir });
    }, path.join(dir, 'storage'));
    await win.click('#btn-mode-memo');
    await win.click('#btn-memo-new');
    const source = await win.evaluate(async () => (await window.wcompare.memo.list())[0].path);
    const translation = await win.evaluate(async p => window.wcompare.memo.translationPath(p), source);
    fs.writeFileSync(source, '# Source on disk\n');
    fs.writeFileSync(translation, '# Translation on disk\n');
    await win.click('#btn-reload-files');
    await expect.poll(() => win.evaluate(() => [window.__wc.memoValue('source'), window.__wc.memoValue('translation')]))
      .toEqual(['# Source on disk\n', '# Translation on disk\n']);

    await win.click('.memo-src .monaco-editor');
    await win.keyboard.type('draft');
    fs.writeFileSync(source, '# Updated on disk\n');
    await choice(app, 2);
    await win.click('#btn-reload-files');
    expect(await win.evaluate(() => window.__wc.memoValue('source'))).toContain('draft');
    await choice(app, 1);
    await win.click('#btn-reload-files');
    await expect.poll(() => win.evaluate(() => window.__wc.memoValue('source'))).toBe('# Updated on disk\n');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
