// test/e2e/compare.spec.js
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const hasRuff = (() => { try { execSync('which ruff'); return true; } catch { return false; } })();

test.describe('compare', () => {
  test.skip(!hasRuff, 'requires ruff installed');

  test('두 .py 열기 → diff + ruff 진단 마커', async () => {
    const a = path.join(os.tmpdir(), 'wc-e2e-a-' + Date.now() + '.py');
    const b = path.join(os.tmpdir(), 'wc-e2e-b-' + Date.now() + '.py');
    fs.writeFileSync(a, 'import os\nx = 1\n');
    fs.writeFileSync(b, 'import sys\ny = 2\n');

    const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), a, b] });
    const win = await app.firstWindow();
    await win.waitForSelector('.monaco-diff-editor', { timeout: 15000 });

    // ruff F401(import unused) → squiggly 마커
    await win.waitForFunction(
      () => document.querySelectorAll('.monaco-editor .squiggly-warning, .monaco-editor .squiggly-error').length > 0,
      { timeout: 15000 }
    );

    await app.close();
    fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
  });

  test('vim insert + :w 로 저장되어 디스크에 반영된다', async () => {
    const b = path.join(os.tmpdir(), 'wc-e2e-save-' + Date.now() + '.py');
    fs.writeFileSync(b, 'y = 2\n');
    const a = path.join(os.tmpdir(), 'wc-e2e-savea-' + Date.now() + '.py');
    fs.writeFileSync(a, 'x = 1\n');

    const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), a, b] });
    const win = await app.firstWindow();
    await win.waitForSelector('.monaco-diff-editor', { timeout: 15000 });

    // 우측(modified=b) 에디터 포커스 → activeSide=right
    await win.locator('.monaco-diff-editor .editor.modified .view-lines').click();
    await win.waitForTimeout(300);
    // vim: Shift+O(위에 새 줄 + insert) → 주석 입력 → Esc
    await win.keyboard.press('Shift+O');
    await win.keyboard.type('# edited by wcompare');
    await win.keyboard.press('Escape');
    await win.waitForTimeout(150);
    // :w — monaco-vim은 ':' 입력 시 ex <input>을 비동기 생성하므로 분리 입력
    await win.keyboard.press('Shift+Semicolon'); // ':'
    await win.waitForSelector('#vim-right input', { timeout: 3000 });
    await win.keyboard.type('w');
    await win.keyboard.press('Enter');

    // 디스크 반영 대기
    await expect.poll(() => fs.readFileSync(b, 'utf8'), { timeout: 8000 })
      .toContain('# edited by wcompare');

    await app.close();
    fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
  });
});
