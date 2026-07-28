// test/e2e/graceful-skip.spec.js
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// e2e 공통: 렌더러가 localStorage에 남기는 UI 상태(보기 형태 wc-layout, Night, Dict)가
// spec 사이로 새지 않도록 userData를 이 파일 전용 임시 폴더로 격리한다.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ud-'));


test('linter 미설치(PATH 비움)에서도 앱이 크래시 없이 뜨고 diff가 보인다', async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), `--user-data-dir=${USER_DATA}`],
    env: { ...process.env, PATH: '' }, // ruff/eslint를 찾지 못하게
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#editor');
  // 앱은 PDF 모드로 시작하므로 diff 편집기를 보려면 모드를 바꾼다.
  // 이 테스트의 관심사는 "linter가 없어도 편집기가 뜨는가"이지 시작 모드가 아니다.
  await win.waitForFunction(
    () => typeof document.getElementById('btn-mode').onclick === 'function', null, { timeout: 20000 });
  if (await win.evaluate(() => window.__wc.getMode()) !== 'diff') await win.click('#btn-mode');
  await expect(win.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 });
  await app.close();
});
