// test/e2e/project.spec.js — 프로젝트 저장/열기 + 최근 목록.
// dialog는 main이 띄우므로 Playwright로 클릭할 수 없다 → dialog를 스텁하고 IPC 경로를 그대로 탄다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const L = '.pdf-pane[data-side=left]';
const R = '.pdf-pane[data-side=right]';

function setup(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-pj-${tag}-`));
  const a = path.join(dir, 'a.pdf');
  const b = path.join(dir, 'b.pdf');
  fs.writeFileSync(a, makePdf(5, { height: 900 }));
  fs.writeFileSync(b, makePdf(3, { height: 900 }));
  // 최근 목록이 테스트끼리 섞이지 않게 userData를 격리한다
  const userData = path.join(dir, 'userData');
  return { dir, a, b, proj: path.join(dir, 'p.wcproj'), userData };
}

const launch = (args, userData) => electron.launch({ args: [MAIN, `--user-data-dir=${userData}`, ...args] });

// main의 showSaveDialog/showOpenDialog를 미리 정해둔 경로로 대체
const stubDialogs = (app, savePath, openPath) => app.evaluate(({ dialog }, paths) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.save });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.open] });
}, { save: savePath, open: openPath });

const selectFirstSpan = (win, pane) => win.evaluate((sel) => {
  const span = document.querySelector(`${sel} .textLayer span`);
  const range = document.createRange();
  range.selectNodeContents(span);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
}, pane);

const markHighlight = (win) => win.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'H', shiftKey: true, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true,
})));

test('프로젝트 저장 → 다시 열면 파일·뷰상태·마커가 복원된다', async () => {
  const { dir, a, b, proj, userData } = setup('rt');

  // --- 1회차: 두 PDF를 열고, 마커를 찍고, Sync를 끄고, 프로젝트로 저장
  {
    const app = await launch([a, b], userData);
    const win = await app.firstWindow();
    // 양쪽 pane이 모두 로드된 뒤 저장해야 files.right 가 스냅샷에 담긴다
    // (왼쪽만 기다리고 저장하면 오른쪽이 아직 없어 프로젝트가 반쪽으로 저장됨)
    await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });
    await win.waitForSelector(`${R} .pdf-container canvas`, { timeout: 20000 });
    await stubDialogs(app, proj, proj);

    await selectFirstSpan(win, L);
    await markHighlight(win);
    await expect(win.locator(`${L} .wc-mark-highlight`)).toHaveCount(1);
    await win.click('#btn-sync');
    await expect(win.locator('#btn-sync')).toHaveText('Sync: OFF');

    // 메뉴 클릭과 같은 경로: main이 menu:project-save 를 push → 렌더러가 스냅샷을 만들어 invoke
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:project-save'));
    await expect.poll(() => fs.existsSync(proj), { timeout: 10000 }).toBe(true);
    await app.close();
  }

  const saved = JSON.parse(fs.readFileSync(proj, 'utf8'));
  expect(saved.format).toBe('wcompare-project');
  expect(saved.mode).toBe('pdf');
  expect(saved.view.sync).toBe(false);
  // 양쪽 파일이 모두 저장돼야 한다 (반쪽 저장이면 여기서 바로 실패해 원인이 드러난다)
  expect(saved.files.left).not.toBeNull();
  expect(saved.files.right).not.toBeNull();
  expect(saved.markers.left).toHaveLength(1);
  expect(saved.markers.left[0].kind).toBe('highlight');

  // --- 2회차: 빈 앱으로 띄워 프로젝트를 연다
  {
    const app = await launch([], userData);
    const win = await app.firstWindow();
    await win.waitForSelector('#btn-open-left'); // 렌더러가 project:load 리스너를 걸 때까지
    await stubDialogs(app, proj, proj);
    await win.evaluate(() => window.wcompare.project.open());

    await win.waitForSelector(`${L} .pdf-container canvas`, { timeout: 20000 });
    await win.waitForSelector(`${R} .pdf-container canvas`, { timeout: 20000 });
    // 파일이 좌/우로 복원됐다 (a=5쪽, b=3쪽)
    await win.waitForFunction(() => /L 1\/5\s+R 1\/3/.test(document.getElementById('pdf-status').textContent || ''), null, { timeout: 10000 });
    // 뷰 상태 복원
    await expect(win.locator('#btn-sync')).toHaveText('Sync: OFF');
    // 마커 복원
    await expect(win.locator(`${L} .wc-mark-highlight`)).toHaveCount(1, { timeout: 10000 });
    await expect(win.locator(`${R} .wc-mark`)).toHaveCount(0);
    await app.close();
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('최근 프로젝트 목록에 쌓이고 id로 열 수 있다', async () => {
  const { dir, a, b, proj, userData } = setup('recent');
  const app = await launch([a, b], userData);
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .pdf-container canvas`, { timeout: 20000 });
  await stubDialogs(app, proj, proj);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:project-save'));
  await expect.poll(() => fs.existsSync(proj), { timeout: 10000 }).toBe(true);

  // 렌더러에는 경로가 아니라 id/이름만 내려간다
  const recents = await win.evaluate(() => window.wcompare.project.recents());
  expect(recents).toHaveLength(1);
  expect(recents[0].name).toBe('p');
  expect(recents[0].path).toBeUndefined(); // 경로는 노출하지 않는다

  // 메뉴에도 들어갔다
  const labels = await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
    const recent = file.submenu.items.find((i) => i.label === 'Recent Projects');
    return recent.submenu.items.map((x) => x.label);
  });
  expect(labels).toContain('p');

  // id로 다시 열기
  const res = await win.evaluate(async () => {
    const [r] = await window.wcompare.project.recents();
    return window.wcompare.project.openRecent(r.id);
  });
  expect(res.ok).toBe(true);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('세션에서 열지 않은 파일은 프로젝트에 심어 저장할 수 없다', async () => {
  const { dir, a, b, proj, userData } = setup('deny');
  const app = await launch([a, b], userData);
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .pdf-container canvas`, { timeout: 20000 });
  await stubDialogs(app, proj, proj);

  // 렌더러가 손상돼 임의 경로를 스냅샷에 넣었다고 가정
  const err = await win.evaluate(async () => {
    try {
      await window.wcompare.project.save({
        mode: 'pdf',
        files: { left: '/etc/hosts', right: null },
        view: {}, markers: { left: [], right: [] },
      });
      return null;
    } catch (e) { return String(e.message || e); }
  });
  expect(err).toContain('save denied');
  expect(fs.existsSync(proj)).toBe(false);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
