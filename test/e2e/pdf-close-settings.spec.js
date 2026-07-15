// test/e2e/pdf-close-settings.spec.js — 파일 닫기(✕) + 설정 다이얼로그 + 프로젝트 이름 모달.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-cs-${tag}-`));
  const a = path.join(dir, 'a.pdf');
  const b = path.join(dir, 'b.pdf');
  fs.writeFileSync(a, makePdf(5, { height: 900 }));
  fs.writeFileSync(b, makePdf(3, { height: 900 }));
  const userData = path.join(dir, 'userData');
  const storageDir = path.join(dir, 'storage');
  return { dir, a, b, userData, storageDir };
}

const launch = (args, userData) => electron.launch({ args: [MAIN, `--user-data-dir=${userData}`, ...args] });

// main settings 모듈(모듈 캐시 공유)의 storageDir를 임시 폴더로 교체.
// evaluate 컨텍스트에는 require가 없으므로, 프로세스 전역 모듈 캐시에서 이미 로드된 settings.js를 찾아 set을 부른다.
const setStorage = (app, dir) => app.evaluate((_electron, d) => {
  const cache = process.mainModule.require('module')._cache; // 프로세스 전역 CommonJS 캐시
  const key = Object.keys(cache).find((k) => k.replace(/\\/g, '/').endsWith('/src/main/settings.js'));
  cache[key].exports.set({ storageDir: d });
}, dir);

test('PDF ✕ 닫기: 해당 pane만 닫히고 반대편은 유지되며 재오픈이 정상 동작한다', async () => {
  const { dir, a, b, userData } = setup('close');
  const app = await launch([a, b], userData);
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });
  await win.waitForSelector(`${R} canvas`, { timeout: 20000 });
  await expect(win.locator(L)).toHaveClass(/loaded/);
  await expect(win.locator(R)).toHaveClass(/loaded/);

  // 왼쪽 pane의 ✕ 클릭 → 왼쪽만 닫힌다
  await win.click(`${L} .pdf-close`);
  await expect(win.locator(`${L} canvas`)).toHaveCount(0, { timeout: 5000 });
  await expect(win.locator(L)).not.toHaveClass(/loaded/);
  // 반대편은 그대로 유지
  await expect(win.locator(R)).toHaveClass(/loaded/);
  await expect(win.locator(`${R} canvas`)).not.toHaveCount(0);

  // 재오픈: open 다이얼로그를 스텁하고 Open Left
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, a);
  await win.click('#btn-open-left');
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });
  await expect(win.locator(L)).toHaveClass(/loaded/);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('File 메뉴에 Close Left/Right와 Settings…가 있다', async () => {
  const { dir, userData } = setup('menu');
  const app = await launch([], userData);
  const win = await app.firstWindow();
  await win.waitForSelector('#toolbar', { timeout: 20000 });

  const labels = await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
    return file.submenu.items.map((x) => x.label);
  });
  expect(labels).toContain('Close Left');
  expect(labels).toContain('Close Right');
  expect(labels).toContain('Settings…');

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('설정 다이얼로그: 체크박스를 켜면 settings에 즉시 반영된다', async () => {
  const { dir, userData, storageDir } = setup('settings');
  const app = await launch([], userData);
  const win = await app.firstWindow();
  await win.waitForSelector('#toolbar', { timeout: 20000 });
  // 대형 번들(app.js)은 정적 #toolbar보다 늦게 실행된다 → change 핸들러가 붙을 때까지 기다린다.
  // (app.js 최상위는 동기 실행이라 이 핸들러가 붙었다면 초기화가 전부 끝난 것.)
  await win.waitForFunction(
    () => typeof document.getElementById('set-archive-pdf').onchange === 'function', null, { timeout: 20000 });
  await setStorage(app, storageDir);

  // menu:settings를 직접 누를 수 없으므로 dialog를 직접 띄운다
  await win.evaluate(() => document.getElementById('settings-dialog').showModal());
  await win.check('#set-archive-pdf');
  await expect
    .poll(() => win.evaluate(async () => (await window.wcompare.settings.get()).archivePdfOnOpen))
    .toBe(true);
  await win.check('#set-keep-translations');
  await expect
    .poll(() => win.evaluate(async () => (await window.wcompare.settings.get()).keepTranslationsInStorage))
    .toBe(true);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('프로젝트 이름 모달: 이름 전체가 선택된 채 뜨고, 입력하면 projects/에 저장된다', async () => {
  const { dir, a, b, userData, storageDir } = setup('name');
  const app = await launch([a, b], userData);
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });
  await win.waitForSelector(`${R} canvas`, { timeout: 20000 });
  await setStorage(app, storageDir);

  // 저장 트리거 → 이름 모달이 뜬다
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:project-save'));
  await win.waitForSelector('#project-name-dialog[open]', { timeout: 10000 });

  // 입력이 포커스되고 이름 전체(확장자 제외)가 선택돼 있다 — 요구사항의 핵심
  const sel = await win.evaluate(() => {
    const el = document.getElementById('project-name-input');
    return { focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd, len: el.value.length };
  });
  expect(sel.focused).toBe(true);
  expect(sel.start).toBe(0);
  expect(sel.end).toBe(sel.len);
  expect(sel.len).toBeGreaterThan(0);

  await win.fill('#project-name-input', 'myproj');
  await win.click('#project-name-ok');

  const proj = path.join(storageDir, 'projects', 'myproj.wcproj');
  await expect.poll(() => fs.existsSync(proj), { timeout: 10000 }).toBe(true);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
