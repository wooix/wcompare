const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAIN = path.resolve(__dirname, '../../src/main/main.js');

test('macOS focus shade covers each display and clears on app switch and Escape', async () => {
  test.skip(process.platform !== 'darwin');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-focus-'));
  const app = await electron.launch({
    args: [MAIN, '--user-data-dir=' + path.join(dir, 'ud')],
    env: { ...process.env, WCOMPARE_HIDE_WINDOW: '' },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    await page.click('#btn-reading-focus');
    await expect(page.locator('#btn-reading-focus')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolbar')).toBeHidden();
    const getWindows = () => app.evaluate(({ app, BrowserWindow, screen }) => {
      const windows = BrowserWindow.getAllWindows();
      const overlays = windows.filter(win => win._wcompareFocusOverlay);
      const documents = windows.filter(win => win._wcompareDocument);
      return {
        active: app.isActive(),
        displays: screen.getAllDisplays().length,
        overlays: overlays.length,
        shown: overlays.filter(win => win.isVisible()).length,
        documents: documents.length,
        documentTop: documents.every(win => win.isAlwaysOnTop()),
      };
    });
    const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().length);
    await expect.poll(getWindows).toMatchObject({ active: true, overlays: displays, shown: displays, documents: 1, documentTop: true });

    await app.evaluate(({ app }) => app.hide());
    await expect.poll(getWindows).toMatchObject({ active: false, shown: 0, documentTop: false });
    await app.evaluate(({ app, BrowserWindow }) => {
      app.show();
      app.focus({ steal: true });
      BrowserWindow.getAllWindows().find(win => win._wcompareDocument).focus();
    });
    await expect.poll(getWindows).toMatchObject({ active: true, shown: displays, documentTop: true });
    await page.keyboard.press('Escape');
    await expect(page.locator('#btn-reading-focus')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toolbar')).toBeVisible();
    await expect.poll(getWindows).toMatchObject({ overlays: 0, documentTop: false });
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
