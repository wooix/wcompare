// test/e2e/project.spec.js — 프로젝트 저장/열기 + 최근 목록.
// dialog는 main이 띄우므로 Playwright로 클릭할 수 없다 → dialog를 스텁하고 IPC 경로를 그대로 탄다.
// 저장은 네이티브 save dialog가 아니라 렌더러 "이름 모달"을 거친다 → 이름을 입력해 storageDir/projects/에 저장.
// 실제 ~/.local/wcompare를 오염시키지 않도록 main settings의 storageDir를 테스트용 임시 폴더로 바꾼다.
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
  // 보관 폴더도 격리한다 → 프로젝트는 <storageDir>/projects/<이름>.wcproj 로 저장된다
  const storageDir = path.join(dir, 'storage');
  const proj = path.join(storageDir, 'projects', 'p.wcproj');
  return { dir, a, b, proj, storageDir, userData };
}

const launch = (args, userData) => electron.launch({ args: [MAIN, `--user-data-dir=${userData}`, ...args] });

// main의 showSaveDialog/showOpenDialog를 미리 정해둔 경로로 대체 (열기 경로용)
const stubDialogs = (app, savePath, openPath) => app.evaluate(({ dialog }, paths) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.save });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.open] });
}, { save: savePath, open: openPath });

// main settings 모듈(모듈 캐시 공유)의 storageDir를 임시 폴더로 교체 — 실제 보관 폴더 오염 방지.
// evaluate 컨텍스트에는 require가 없으므로, 프로세스 전역 모듈 캐시에서 이미 로드된 settings.js를 찾아 set을 부른다.
const setStorage = (app, dir) => app.evaluate((_electron, d) => {
  const cache = process.mainModule.require('module')._cache; // 프로세스 전역 CommonJS 캐시
  const key = Object.keys(cache).find((k) => k.replace(/\\/g, '/').endsWith('/src/main/settings.js'));
  cache[key].exports.set({ storageDir: d });
}, dir);

// menu:project-save → 이름 모달이 뜨면 이름을 넣고 저장
async function saveViaModal(app, win, name) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:project-save'));
  await win.waitForSelector('#project-name-dialog[open]', { timeout: 10000 });
  await win.fill('#project-name-input', name);
  await win.click('#project-name-ok');
}

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
  const { dir, a, b, proj, storageDir, userData } = setup('rt');

  // --- 1회차: 두 PDF를 열고, 마커를 찍고, Sync를 끄고, 프로젝트로 저장
  {
    const app = await launch([a, b], userData);
    const win = await app.firstWindow();
    // 양쪽 pane이 모두 로드된 뒤 저장해야 files.right 가 스냅샷에 담긴다
    // (왼쪽만 기다리고 저장하면 오른쪽이 아직 없어 프로젝트가 반쪽으로 저장됨)
    await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });
    await win.waitForSelector(`${R} .pdf-container canvas`, { timeout: 20000 });
    await stubDialogs(app, proj, proj);
    await setStorage(app, storageDir);

    await selectFirstSpan(win, L);
    await markHighlight(win);
    await expect(win.locator(`${L} .wc-mark-highlight`)).toHaveCount(1);
    await win.click('#btn-sync');
    await expect(win.locator('#btn-sync')).toHaveText('Sync: OFF');

    // 이름 모달에 'p'를 입력해 <storageDir>/projects/p.wcproj 로 저장
    await saveViaModal(app, win, 'p');
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
  const { dir, a, b, proj, storageDir, userData } = setup('recent');
  const app = await launch([a, b], userData);
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .pdf-container canvas`, { timeout: 20000 });
  await stubDialogs(app, proj, proj);
  await setStorage(app, storageDir);

  await saveViaModal(app, win, 'p');
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

  // 렌더러가 손상돼 임의 경로를 스냅샷에 넣었다고 가정 (이름을 줘도 소유 검증이 먼저 막는다)
  const err = await win.evaluate(async () => {
    try {
      await window.wcompare.project.save({
        mode: 'pdf',
        files: { left: '/etc/hosts', right: null },
        view: {}, markers: { left: [], right: [] },
      }, 'hacked');
      return null;
    } catch (e) { return String(e.message || e); }
  });
  expect(err).toContain('save denied');
  expect(fs.existsSync(proj)).toBe(false);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 보관 폴더(storageDir/projects) 안의 프로젝트는 이름 모달 없이 조용히 재저장된다.
test('보관 폴더 안 프로젝트 재저장은 이름 모달 없이 조용히 이뤄진다', async () => {
  const { dir, a, b, proj, storageDir, userData } = setup('silent');
  const app = await launch([a, b], userData);
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .pdf-container canvas`, { timeout: 20000 });
  await win.waitForSelector(`${R} .pdf-container canvas`, { timeout: 20000 });
  await setStorage(app, storageDir);

  // 1) 이름 모달로 보관 폴더에 최초 저장 → currentPath가 storageDir/projects 하위가 된다
  await saveViaModal(app, win, 'p');
  await expect.poll(() => fs.existsSync(proj), { timeout: 10000 }).toBe(true);

  // 2) 상태줄을 지운 뒤 다시 저장 → 모달 없이 조용히 재저장되고 상태줄이 전체 경로로 되돌아온다
  await win.evaluate(() => { document.getElementById('toolbar-status').textContent = 'RESET'; });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:project-save'));
  await expect(win.locator('#toolbar-status')).toContainText('projects/p.wcproj', { timeout: 10000 });
  await expect(win.locator('#project-name-dialog[open]')).toHaveCount(0);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 실사용 버그: 보관 폴더 밖(레거시) 프로젝트를 저장하면 조용히 재저장하지 않고
// 이름 모달을 거쳐 보관 폴더로 옮겨 저장하고, 상태줄에 전체 경로를 보여준다.
test('보관 폴더 밖(레거시) 프로젝트 저장은 이름 모달로 보관 폴더에 옮겨 저장된다', async () => {
  const { dir, a, b, storageDir, userData } = setup('legacy');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const inStore = path.join(storageDir, 'projects', 'legacy.wcproj');
  const legacyPath = path.join(outside, 'legacy.wcproj');

  // --- 1회차: 보관 폴더에 유효한 프로젝트를 만든 뒤 그 파일을 보관 폴더 밖으로 복사 → 레거시 파일
  {
    const app = await launch([a, b], userData);
    const win = await app.firstWindow();
    await win.waitForSelector(`${L} .pdf-container canvas`, { timeout: 20000 });
    await win.waitForSelector(`${R} .pdf-container canvas`, { timeout: 20000 });
    await setStorage(app, storageDir);
    await saveViaModal(app, win, 'legacy');
    await expect.poll(() => fs.existsSync(inStore), { timeout: 10000 }).toBe(true);
    fs.copyFileSync(inStore, legacyPath);
    await app.close();
  }

  // --- 2회차: 빈 앱으로 띄워 레거시 파일을 연다 → currentPath가 보관 폴더 밖이 된다.
  // (빈 앱에서 여는 이유: launch 인자로 미리 a·b를 띄우면 pdf-status가 이미 'L 1/5 R 1/3'이라
  //  로드 완료 신호가 stale 매치되어 열기 중 setMode('pdf')의 상태줄 비움이 저장 뒤에 덮어씀.)
  {
    const app = await launch([], userData);
    const win = await app.firstWindow();
    await win.waitForSelector('#btn-open-left', { timeout: 20000 }); // 렌더러가 project:load 리스너를 걸 때까지
    await setStorage(app, storageDir);
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    }, legacyPath);
    await win.evaluate(() => window.wcompare.project.open());
    // 빈 앱 → a=5쪽,b=3쪽으로의 실제 전이를 기다린다. 이 신호가 나오면 onProjectLoad의
    // setMode('pdf')(상태줄 비움)가 이미 끝났으므로 이후 저장의 상태 표시가 덮이지 않는다.
    await win.waitForFunction(() => /L 1\/5\s+R 1\/3/.test(document.getElementById('pdf-status').textContent || ''), null, { timeout: 15000 });

    // 저장 트리거 → 보관 폴더 밖이므로 조용히 재저장하지 않고 이름 모달이 뜬다
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:project-save'));
    await win.waitForSelector('#project-name-dialog[open]', { timeout: 10000 });

    // 이름을 입력해 저장 → storageDir/projects/<이름>.wcproj 생성 + 상태줄에 전체 경로 표시
    await win.fill('#project-name-input', 'moved');
    await win.click('#project-name-ok');
    const moved = path.join(storageDir, 'projects', 'moved.wcproj');
    await expect.poll(() => fs.existsSync(moved), { timeout: 10000 }).toBe(true);
    await expect(win.locator('#toolbar-status')).toContainText('projects/moved.wcproj', { timeout: 10000 });
    await app.close();
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

// 안전장치: 보관 폴더 안 프로젝트라도 파일 쌍이 바뀌면(= 사실상 다른 프로젝트) 조용히 덮어쓰지 않는다.
// 왼쪽 파일을 닫아 (a,b)→(null,b)로 쌍을 바꾼 뒤 저장 → 이름 모달이 뜨고 기존 p.wcproj는 그대로여야 한다.
test('파일 쌍이 바뀌면 조용히 재저장하지 않고 이름 모달을 띄우며 기존 .wcproj는 그대로다', async () => {
  const { dir, a, b, proj, storageDir, userData } = setup('pairchg');
  const app = await launch([a, b], userData);
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .pdf-container canvas`, { timeout: 20000 });
  await win.waitForSelector(`${R} .pdf-container canvas`, { timeout: 20000 });
  await setStorage(app, storageDir);

  // 1) 보관 폴더에 (a,b) 쌍으로 최초 저장
  await saveViaModal(app, win, 'p');
  await expect.poll(() => fs.existsSync(proj), { timeout: 10000 }).toBe(true);
  const before = fs.readFileSync(proj, 'utf8');
  const beforeJson = JSON.parse(before);
  expect(beforeJson.files.left).not.toBeNull();
  expect(beforeJson.files.right).not.toBeNull();

  // 2) 왼쪽 파일을 닫아 쌍을 (null, b)로 바꾼다
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:close-left'));
  await expect(win.locator('.pdf-pane[data-side=left].loaded')).toHaveCount(0, { timeout: 10000 });

  // 3) 저장 → 조용히 덮어쓰지 않고 이름 모달이 떠야 한다
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:project-save'));
  await win.waitForSelector('#project-name-dialog[open]', { timeout: 10000 });

  // 4) 기존 p.wcproj는 손대지 않았다(여전히 a,b를 가리킨다) — 조용한 덮어쓰기가 없었음을 증명
  expect(fs.readFileSync(proj, 'utf8')).toBe(before);
  expect(fs.existsSync(`${proj}.bak`)).toBe(false); // 백업조차 만들지 않았다

  await win.keyboard.press('Escape'); // 모달 취소
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 덮어쓰기 확인을 취소(WCOMPARE_TEST_CONFIRM=cancel)하면 기존 파일을 덮어쓰지 않는다.
test('덮어쓰기 확인 취소 시 기존 프로젝트 파일을 덮어쓰지 않는다', async () => {
  const { dir, a, b, storageDir, userData } = setup('confirm-cancel');
  // 다른 이름(occupied)의 프로젝트가 이미 보관 폴더에 있다고 가정하고 미리 만들어 둔다.
  const occupied = path.join(storageDir, 'projects', 'occupied.wcproj');
  fs.mkdirSync(path.dirname(occupied), { recursive: true });
  fs.writeFileSync(occupied, 'SENTINEL'); // 덮어써지면 이 내용이 바뀐다

  // 다이얼로그가 이벤트 루프를 막지 않도록 테스트 심으로 '취소'를 강제한다.
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userData}`, a, b],
    env: { ...process.env, WCOMPARE_TEST_CONFIRM: 'cancel' },
  });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .pdf-container canvas`, { timeout: 20000 });
  await win.waitForSelector(`${R} .pdf-container canvas`, { timeout: 20000 });
  await setStorage(app, storageDir);

  // "다른 이름으로 저장" → 이름 모달에 기존 이름(occupied)을 입력 → 덮어쓰기 확인이 뜨지만 취소된다
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:project-save-as'));
  await win.waitForSelector('#project-name-dialog[open]', { timeout: 10000 });
  await win.fill('#project-name-input', 'occupied');
  await win.click('#project-name-ok');

  // 취소되었으므로: 파일 내용 불변 + 백업도 없음 + 모달은 닫힘
  await expect(win.locator('#project-name-dialog[open]')).toHaveCount(0, { timeout: 10000 });
  expect(fs.readFileSync(occupied, 'utf8')).toBe('SENTINEL');
  expect(fs.existsSync(`${occupied}.bak`)).toBe(false);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
