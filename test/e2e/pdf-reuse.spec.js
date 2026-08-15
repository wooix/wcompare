// test/e2e/pdf-reuse.spec.js — 같은 일을 두 번 하지 않는다: URL 재다운로드 방지 + 번역본 재사용.
// 두 낭비는 원인이 하나였다. URL을 다시 열 때마다 새로 받으면 내용이 조금만 달라도 paper-2.pdf로
// 비켜 저장되고, 그러면 번역 출력 경로가 paper-2.ko.pdf라는 새 경로가 되어 이미 만들어 둔
// paper.ko.pdf를 못 찾고 번역(페이지마다 LLM 호출)을 처음부터 다시 돌린다.
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const L = '.pdf-pane[data-side=left]';
const R = '.pdf-pane[data-side=right]';

const setStorage = (app, dir) => app.evaluate((_electron, d) => {
  const cache = process.mainModule.require('module')._cache;
  const key = Object.keys(cache).find((k) => k.replace(/\\/g, '/').endsWith('/src/main/settings.js'));
  cache[key].exports.set({ storageDir: d });
}, dir);

// 요청 횟수를 세는 로컬 서버. "다시 받지 않는다"를 증명하려면 이 카운터가 유일하게 믿을 신호다.
// state.body를 바꾸면 같은 URL이 다른 내용을 주는 상황(버전 없는 arXiv 주소 등)을 흉내 낼 수 있다.
function startServer(pdf) {
  const state = { hits: 0, body: pdf };
  const server = http.createServer((req, res) => {
    state.hits++;
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': state.body.length });
    res.end(state.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// 실행될 때마다 카운터 파일에 한 줄씩 남기는 transpaper 스텁 —
// "다시 번역하지 않았다"를 파일 존재가 아니라 실행 횟수로 증명한다.
function stubTranspaper(dir, countFile) {
  const p = path.join(dir, 'transpaper');
  fs.writeFileSync(p, [
    '#!/bin/sh',
    'input="$1"; shift',
    'out=""',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi',
    'done',
    `echo run >> "${countFile}"`,
    'echo "page 0: translated 3 blocks, 0 overflowed"',
    'cp "$input" "$out"',
    'echo "wrote $out"',
  ].join('\n'), { mode: 0o755 });
  return p;
}

const runCount = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0);

async function launch(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-reuse-${tag}-`));
  const storageDir = path.join(dir, 'storage');
  const countFile = path.join(dir, 'runs.txt');
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${path.join(dir, 'userData')}`],
    env: { ...process.env, WCOMPARE_TRANSPAPER: stubTranspaper(dir, countFile) },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#toolbar', { timeout: 20000 });
  await win.waitForFunction(
    () => typeof document.getElementById('btn-mode-pdf').onclick === 'function', null, { timeout: 20000 });
  await setStorage(app, storageDir);
  if (await win.evaluate(() => window.__wc.getMode()) !== 'pdf') await win.click('#btn-mode-pdf');
  return { dir, storageDir, countFile, app, win };
}

const openUrl = async (win, url) => {
  await win.fill(`${L} .pdf-url-input`, url);
  await win.click(`${L} .pdf-url-go`);
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });
};

test('같은 URL을 다시 열면 서버에 다시 요청하지 않고 같은 파일을 연다', async () => {
  const pdf = makePdf(3, { height: 900 });
  const { server, state, base } = await startServer(pdf);
  const { dir, storageDir, app, win } = await launch('dl');
  const url = `${base}/paper.pdf`;

  await openUrl(win, url);
  expect(state.hits).toBe(1);

  // 닫고 같은 URL을 다시 연다
  await win.click(`${L} .pdf-close`);
  await expect(win.locator(L)).not.toHaveClass(/loaded/);
  await openUrl(win, url);

  expect(state.hits).toBe(1); // 네트워크를 타지 않았다
  // 사본이 쌓이지 않았다 — paper-2.pdf 같은 파일이 생기면 번역 경로까지 어긋난다
  const files = fs.readdirSync(path.join(storageDir, 'downloads')).filter((f) => f.endsWith('.pdf'));
  expect(files).toEqual(['paper.pdf']);

  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('URL로 연 PDF도 이미 만든 번역본이 있으면 다시 번역하지 않는다', async () => {
  const pdf = makePdf(3, { height: 900 });
  const { server, state, base } = await startServer(pdf);
  const { dir, countFile, app, win } = await launch('tr');
  const url = `${base}/paper.pdf`;

  // 1회차: 내려받고 번역한다
  await openUrl(win, url);
  await expect(win.locator('#btn-translate')).toBeEnabled();
  await win.click('#btn-translate');
  await win.waitForSelector(`${R} canvas`, { timeout: 30000 });
  expect(runCount(countFile)).toBe(1);

  // 양쪽을 닫고 같은 URL을 다시 열어 또 번역을 누른다 (사용자가 실제로 겪은 흐름)
  await win.click(`${R} .pdf-close`);
  await win.click(`${L} .pdf-close`);
  await expect(win.locator(L)).not.toHaveClass(/loaded/);
  await openUrl(win, url);
  await expect(win.locator('#btn-translate')).toBeEnabled();
  await win.click('#btn-translate');
  await win.waitForSelector(`${R} canvas`, { timeout: 30000 });

  // 핵심: transpaper가 다시 돌지 않았다 (묻지도 않고 기존 번역본을 열었다)
  expect(runCount(countFile)).toBe(1);
  expect(state.hits).toBe(1);
  await expect(win.locator('#toolbar-status')).toContainText('기존 번역본을 재사용');

  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('⌥+열기는 캐시를 무시하고 서버에서 다시 받는다 (갱신된 문서용 탈출구)', async () => {
  const v1 = makePdf(3, { height: 900 });
  const { server, state, base } = await startServer(v1);
  const { dir, storageDir, app, win } = await launch('force-dl');
  const url = `${base}/paper.pdf`;

  await openUrl(win, url);
  expect(state.hits).toBe(1);

  // 서버 쪽 문서가 갱신됐다. 그냥 열면 캐시 그대로여야 하고, ⌥+열기면 새로 받아야 한다.
  state.body = makePdf(9, { height: 900 });
  await win.click(`${L} .pdf-close`);
  await openUrl(win, url);
  expect(state.hits).toBe(1); // 기본은 여전히 재사용

  await win.click(`${L} .pdf-close`);
  await win.fill(`${L} .pdf-url-input`, url);
  await win.click(`${L} .pdf-url-go`, { modifiers: ['Alt'] });
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });
  expect(state.hits).toBe(2); // ⌥가 캐시를 건너뛰었다

  // 갱신본이 실제로 보관 폴더에 들어왔다(기존 파일은 덮지 않으므로 이름이 비켜난다)
  const files = fs.readdirSync(path.join(storageDir, 'downloads')).filter((f) => f.endsWith('.pdf')).sort();
  expect(files.length).toBe(2);

  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('⌥+클릭하면 번역본이 있어도 다시 번역한다', async () => {
  const { dir, countFile, app, win } = await launch('force');
  const src = path.join(dir, 'local.pdf');
  fs.writeFileSync(src, makePdf(3, { height: 900 }));

  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, src);
  await win.click('#btn-open-left');
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });

  await win.click('#btn-translate');
  await win.waitForSelector(`${R} canvas`, { timeout: 30000 });
  expect(runCount(countFile)).toBe(1);

  // 오른쪽만 닫고 ⌥+클릭 → 강제 재번역
  await win.click(`${R} .pdf-close`);
  await expect(win.locator(R)).not.toHaveClass(/loaded/);
  await win.click('#btn-translate', { modifiers: ['Alt'] });
  await win.waitForSelector(`${R} canvas`, { timeout: 30000 });
  expect(runCount(countFile)).toBe(2);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
