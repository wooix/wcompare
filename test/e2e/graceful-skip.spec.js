// test/e2e/graceful-skip.spec.js
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');

test('linter 미설치(PATH 비움)에서도 앱이 크래시 없이 뜨고 diff가 보인다', async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', 'src', 'main', 'main.js')],
    env: { ...process.env, PATH: '' }, // ruff/eslint를 찾지 못하게
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#editor');
  await expect(win.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 });
  await app.close();
});
