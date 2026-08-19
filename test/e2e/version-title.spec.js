// test/e2e/version-title.spec.js — 창 제목에 붙는 빌드 버전.
// 제목은 사용자가 "지금 보고 있는 것이 어느 빌드인가"를 확인하는 유일한 자리다.
// 옛 배포본을 새 것으로 착각한 적이 있어서 붙였다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = path.join(ROOT, 'src', 'main', 'main.js');

async function launch() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ver-'));
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] });
  const win = await app.firstWindow();
  await win.waitForSelector('#toolbar', { timeout: 20000 });
  return { app, win };
}

// OS 창 제목은 문서 제목과 다른 값이다. win.title()은 document.title을 읽으므로
// 메인 프로세스의 BrowserWindow에 직접 물어야 한다.
const osTitle = (app) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());

test('창 제목은 "wcompare <yyyy-mm-dd-XXX>" 형식이다', async () => {
  const { app } = await launch();
  try {
    const title = await osTitle(app);
    expect(title).toMatch(/^wcompare \d{4}-\d{2}-\d{2}-\d{3,}$/);
  } finally {
    await app.close();
  }
});

test('제목의 버전은 package.json의 buildVersion과 같다', async () => {
  // 두 값이 갈리면 사용자가 보는 번호와 저장소가 기록한 번호가 달라진다.
  const { buildVersion } = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { app } = await launch();
  try {
    expect(await osTitle(app)).toBe(`wcompare ${buildVersion}`);
  } finally {
    await app.close();
  }
});

test('index.html에는 <title>이 없다 — 있으면 문서 제목이 창 제목을 덮는다', async () => {
  // 이 규칙이 깨지면 버전이 조용히 사라진다. 소스가 아니라 실제로 로드되는
  // dist/ 번들을 본다.
  const html = fs.readFileSync(
    path.join(ROOT, 'dist', 'renderer', 'index.html'), 'utf8');
  expect(html).not.toMatch(/<title[\s>]/i);
});
