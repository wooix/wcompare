// test/e2e/pdf-marker-persist.spec.js — PDF 하이라이트 자동 영속화.
// 마커를 찍으면 <storageDir>/markers/ 에 자동 저장되고, 같은 PDF를 다시 열면 자동 복원된다.
// 프로젝트(.wcproj)와 무관 — 단순 열기만으로 동작한다. 실제 보관 폴더를 오염시키지 않도록
// main settings의 storageDir를 테스트용 임시 폴더로 바꾼다(settings.json에 영속 → 재실행에도 유지).
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const L = '.pdf-pane[data-side=left]';

function setup(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-mp-${tag}-`));
  const a = path.join(dir, 'a.pdf');
  fs.writeFileSync(a, makePdf(3, { height: 900 }));
  const userData = path.join(dir, 'userData');
  const storageDir = path.join(dir, 'storage');
  return { dir, a, userData, storageDir };
}

const launch = (args, userData) => electron.launch({ args: [MAIN, `--user-data-dir=${userData}`, ...args] });

// main settings 모듈(모듈 캐시 공유)의 storageDir를 임시 폴더로 교체 — project.spec와 동일한 심.
const setStorage = (app, dir) => app.evaluate((_electron, d) => {
  const cache = process.mainModule.require('module')._cache;
  const key = Object.keys(cache).find((k) => k.replace(/\\/g, '/').endsWith('/src/main/settings.js'));
  cache[key].exports.set({ storageDir: d });
}, dir);

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

const markersDirFiles = (storageDir) => {
  try { return fs.readdirSync(path.join(storageDir, 'markers')).filter((f) => f.endsWith('.json')); }
  catch { return []; }
};

test('하이라이트를 찍으면 자동 저장되고, 같은 PDF를 다시 열면 복원된다', async () => {
  const { dir, a, userData, storageDir } = setup('rt');

  // --- 1회차: PDF를 열고 마커를 찍는다 → storageDir/markers/ 에 자동 저장(디바운스 500ms)
  {
    const app = await launch([a], userData);
    const win = await app.firstWindow();
    await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });
    await setStorage(app, storageDir);

    await selectFirstSpan(win, L);
    await markHighlight(win);
    await expect(win.locator(`${L} .wc-mark-highlight`)).toHaveCount(1);

    // 디바운스 저장이 파일로 떨어질 때까지 기다린다
    await expect.poll(() => markersDirFiles(storageDir).length, { timeout: 10000 }).toBe(1);
    await app.close();
  }

  // 저장 파일 내용 검증(형식·마커)
  const file = path.join(storageDir, 'markers', markersDirFiles(storageDir)[0]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(saved.format).toBe('wcompare-markers');
  expect(saved.markers).toHaveLength(1);
  expect(saved.markers[0].kind).toBe('highlight');

  // --- 2회차: 같은 PDF를 다시 연다(프로젝트 아님) → 마커가 자동 복원된다
  {
    const app = await launch([a], userData); // storageDir는 settings.json에 영속되어 있다
    const win = await app.firstWindow();
    await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });
    // reset()이 지운 오버레이가 아니라, markers:load로 붙은 복원 마커가 보여야 한다
    await expect(win.locator(`${L} .wc-mark-highlight`)).toHaveCount(1, { timeout: 10000 });
    await app.close();
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('세션에서 열지 않은 경로로 markers:save 하면 거부된다', async () => {
  const { dir, a, userData, storageDir } = setup('deny');
  const app = await launch([a], userData);
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} .textLayer span`, { timeout: 20000 });
  await setStorage(app, storageDir);

  const err = await win.evaluate(async () => {
    try {
      await window.wcompare.markers.save('/etc/hosts', [
        { id: 'x', page: 1, kind: 'highlight', color: '#ffd64a', rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] },
      ]);
      return null;
    } catch (e) { return String(e.message || e); }
  });
  expect(err).toContain('denied');
  // /etc/hosts 를 이름으로 삼는 마커 파일은 생기지 않는다
  expect(markersDirFiles(storageDir).some((f) => f.startsWith('hosts.'))).toBe(false);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
