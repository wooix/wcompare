// test/e2e/open-file.spec.js — Finder에서 연 파일(PDF 기본 앱) 경로.
// macOS는 Finder로 연 파일을 argv가 아니라 'open-file' 이벤트로 보낸다. 실제 Finder를 띄울 수는
// 없으므로 main 프로세스에서 그 이벤트를 그대로 발생시켜, 우리 핸들러가 하는 일을 검증한다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const leftC = '.pdf-pane[data-side=left] .pdf-container';
const rightC = '.pdf-pane[data-side=right] .pdf-container';
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-of-ud-'));

function setup(tag, n = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-of-${tag}-`));
  const mk = (name) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, makePdf(n, { height: 900 }));
    return p;
  };
  return { dir, mk };
}

// macOS가 보내는 것과 같은 모양으로 이벤트를 발생시킨다(핸들러가 preventDefault를 부른다).
const emitOpenFile = (app, p) => app.evaluate(({ app: a }, file) => {
  a.emit('open-file', { preventDefault() {} }, file);
}, p);

test('열린 문서가 하나면 Finder에서 연 PDF가 빈 쪽에 들어간다', async () => {
  const { dir, mk } = setup('empty');
  const a = mk('a.pdf');
  const b = mk('b.pdf');
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${leftC} canvas`, { timeout: 20000 });
  await expect(win.locator(`${rightC} canvas`)).toHaveCount(0); // 오른쪽은 아직 비었다

  await emitOpenFile(app, b);

  // 대조가 본업인 앱이므로 두 번째 문서는 옆 칸에 붙는다
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await win.waitForFunction(
    () => /L 1\/3\s+R 1\/3/.test(document.getElementById('pdf-status').textContent || ''),
    null, { timeout: 10000 },
  );
  expect(app.windows().length).toBe(1); // 새 창을 만들지 않았다

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('양쪽이 다 찼으면 새 창에 열린다 (보던 문서를 밀어내지 않는다)', async () => {
  const { dir, mk } = setup('full');
  const a = mk('a.pdf');
  const b = mk('b.pdf');
  const c = mk('c.pdf');
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });

  await emitOpenFile(app, c);

  // 두 번째 창이 생기고, 그 창의 왼쪽에 c가 열린다
  const next = await app.waitForEvent('window', { timeout: 20000 });
  await next.waitForSelector(`${leftC} canvas`, { timeout: 20000 });
  expect(app.windows().length).toBe(2);
  // 원래 창은 그대로 두 문서를 유지한다
  await expect(win.locator(`${leftC} canvas`)).not.toHaveCount(0);
  await expect(win.locator(`${rightC} canvas`)).not.toHaveCount(0);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('두 파일이 잇달아 오면 한 창에 좌우로 나란히 열린다', async () => {
  const { dir, mk } = setup('pair');
  const a = mk('a.pdf');
  const b = mk('b.pdf');
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`] });
  const win = await app.firstWindow();
  await win.waitForSelector('.pdf-pane[data-side=left]', { timeout: 20000 });

  // Finder에서 두 개를 함께 열면 이벤트가 연달아 온다 — 모아서 한 창에 배치해야 한다.
  await emitOpenFile(app, a);
  await emitOpenFile(app, b);

  await win.waitForSelector(`${rightC} canvas`, { timeout: 20000 });
  await win.waitForFunction(
    () => /L 1\/3\s+R 1\/3/.test(document.getElementById('pdf-status').textContent || ''),
    null, { timeout: 10000 },
  );
  expect(app.windows().length).toBe(1);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
