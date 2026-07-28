// test/e2e/pdf-translation-delete.spec.js — 한국어 번역본 삭제 버튼.
// 확인 모달은 WCOMPARE_TEST_CONFIRM('delete'|'cancel')로 대신한다(project.spec와 같은 심) —
// 실제 모달은 e2e에서 이벤트 루프를 막는다.
// 삭제 자체는 WCOMPARE_TEST_TRASH=rm으로 바꾼다: 테스트를 돌릴 때마다 사용자의 휴지통에
// 테스트 파일이 쌓이면 안 되기 때문이다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const leftC = '.pdf-pane[data-side=left] .pdf-container';
const rightC = '.pdf-pane[data-side=right] .pdf-container';
const DEL = '#btn-del-translation';

// transpaper 계약: `transpaper <input> -o <output> -v` → 진행 줄을 흘리고 <output>에 PDF를 쓴다.
function stubTranspaper(dir) {
  const p = path.join(dir, 'transpaper');
  fs.writeFileSync(p, [
    '#!/bin/sh',
    'input="$1"; shift',
    'out=""',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi',
    'done',
    'echo "page 0: translated 3 blocks, 0 overflowed"',
    'cp "$input" "$out"',
  ].join('\n'), { mode: 0o755 });
  return p;
}

// 원본 이름을 실행마다 다르게 둔다. 보관 폴더 후보(<storage>/<base>.ko.pdf)가 실제 사용자 파일과
// 이름으로 부딪히는 일을 원천적으로 없애기 위해서다 — 삭제 경로라 우연에 기대지 않는다.
function setup(tag, confirm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-del-${tag}-`));
  const base = `paper-${tag}-${Date.now()}`;
  const src = path.join(dir, `${base}.pdf`);
  fs.writeFileSync(src, makePdf(3, { height: 900 }));
  return {
    dir,
    src,
    ko: path.join(dir, `${base}.ko.pdf`),
    userData: path.join(dir, 'userData'),
    storageDir: path.join(dir, 'storage'),
    env: {
      ...process.env,
      WCOMPARE_TRANSPAPER: stubTranspaper(dir),
      WCOMPARE_TEST_CONFIRM: confirm,
      WCOMPARE_TEST_TRASH: 'rm',
    },
  };
}

// main settings의 storageDir를 임시 폴더로 교체 — 실제 ~/.local/wcompare를 건드리지 않는다
// (pdf-marker-persist.spec와 동일한 심).
const setStorage = (app, d) => app.evaluate((_electron, dir) => {
  const cache = process.mainModule.require('module')._cache;
  const key = Object.keys(cache).find((k) => k.replace(/\\/g, '/').endsWith('/src/main/settings.js'));
  cache[key].exports.set({ storageDir: dir });
}, d);

test('번역본이 없으면 비활성 → 번역하면 활성 → 취소하면 파일이 남는다', async () => {
  const s = setup('cancel', 'cancel');
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${s.userData}`, s.src], env: s.env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });
  await setStorage(app, s.storageDir);

  // 아직 번역본이 없다 → 지울 것이 없으므로 버튼은 잠겨 있다
  await expect(win.locator(DEL)).toBeDisabled();

  await win.click('#btn-translate');
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  expect(fs.existsSync(s.ko)).toBe(true);
  // 번역본이 생겼으니 버튼이 열린다
  await expect(win.locator(DEL)).toBeEnabled({ timeout: 10000 });

  // 확인 모달에서 취소 → 아무것도 지워지지 않고, 번역본은 그대로 열려 있다
  await win.click(DEL);
  await expect(win.locator(DEL)).toBeEnabled();
  expect(fs.existsSync(s.ko)).toBe(true);
  await expect(win.locator(`${rightC} canvas`)).not.toHaveCount(0);

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('삭제를 확인하면 파일이 사라지고, 열려 있던 번역본 pane이 닫힌다', async () => {
  const s = setup('ok', 'delete');
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${s.userData}`, s.src], env: s.env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });
  await setStorage(app, s.storageDir);

  await win.click('#btn-translate');
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await expect(win.locator(DEL)).toBeEnabled({ timeout: 10000 });

  await win.click(DEL);

  // 파일이 사라진다
  await expect.poll(() => fs.existsSync(s.ko), { timeout: 10000 }).toBe(false);
  // 없는 파일을 계속 보여줄 수는 없다 — 번역본이 있던 pane이 닫힌다
  await expect(win.locator(`${rightC} canvas`)).toHaveCount(0, { timeout: 10000 });
  // 원본은 그대로 남아 있다 (삭제 대상은 유도된 .ko.pdf 하나뿐이다)
  expect(fs.existsSync(s.src)).toBe(true);
  await expect(win.locator(`${leftC} canvas`)).not.toHaveCount(0);
  // 지울 것이 없어졌으니 버튼은 다시 잠긴다
  await expect(win.locator(DEL)).toBeDisabled({ timeout: 10000 });
  // 원본만 남았으므로 번역 버튼은 다시 열린다 → 다시 번역할 수 있다
  await expect(win.locator('#btn-translate')).toBeEnabled();

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});
