// test/e2e/pdf-url.spec.js — 빈 왼쪽 pane의 URL 입력으로 PDF를 내려받아 연다.
// 실제 네트워크 대신 127.0.0.1 로컬 서버를 띄우고, 보관 폴더는 임시 디렉터리로 돌린다.
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const L = '.pdf-pane[data-side=left]';

// main settings 모듈(모듈 캐시 공유)의 storageDir를 임시 폴더로 교체 — pdf-close-settings.spec.js와 동일.
const setStorage = (app, dir) => app.evaluate((_electron, d) => {
  const cache = process.mainModule.require('module')._cache;
  const key = Object.keys(cache).find((k) => k.replace(/\\/g, '/').endsWith('/src/main/settings.js'));
  cache[key].exports.set({ storageDir: d });
}, dir);

// /paper.pdf → 진짜 PDF, 그 밖 → HTML(오류 페이지를 200으로 돌려주는 흔한 서버 흉내).
function startServer(pdf) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/paper.pdf')) {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length });
      res.end(pdf);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><h1>not a pdf</h1>');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// 앱을 띄우고 PDF 모드로 들어가 URL 패널이 보이는 상태까지 만든다.
async function openPdfMode(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-url-${tag}-`));
  const storageDir = path.join(dir, 'storage');
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(dir, 'userData')}`] });
  const win = await app.firstWindow();
  await win.waitForSelector('#toolbar', { timeout: 20000 });
  // 대형 번들(app.js)은 정적 #toolbar보다 늦게 실행된다 → 핸들러가 붙을 때까지 기다린다.
  await win.waitForFunction(
    () => typeof document.getElementById('btn-mode').onclick === 'function', null, { timeout: 20000 });
  await setStorage(app, storageDir);
  await win.click('#btn-mode'); // diff → pdf (여기서 dualView와 URL 패널이 만들어진다)
  await expect(win.locator(`${L} .pdf-url-input`)).toBeVisible();
  return { dir, storageDir, app, win };
}

test('URL 입력으로 PDF를 내려받아 왼쪽 pane에 연다', async () => {
  const pdf = makePdf(3, { height: 900 });
  const { server, base } = await startServer(pdf);
  const { dir, storageDir, app, win } = await openPdfMode('ok');

  await win.fill(`${L} .pdf-url-input`, `${base}/paper.pdf`);
  await win.click(`${L} .pdf-url-go`);

  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });
  await expect(win.locator(L)).toHaveClass(/loaded/);
  // 문서가 열리면 URL 패널은 사라진다(.pdf-pane.loaded .pdf-url { display:none })
  await expect(win.locator(`${L} .pdf-url`)).toBeHidden();

  // 받은 파일은 보관 폴더 downloads/에 남는다 → 프로젝트 저장·번역·마커가 로컬 파일과 동일하게 동작
  const saved = path.join(storageDir, 'downloads', 'paper.pdf');
  expect(fs.existsSync(saved)).toBe(true);
  expect(fs.readFileSync(saved).equals(pdf)).toBe(true);

  // 닫으면 URL 패널이 다시 나타난다
  await win.click(`${L} .pdf-close`);
  await expect(win.locator(`${L} .pdf-url-input`)).toBeVisible();

  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PDF가 아닌 응답은 입력창 아래에 오류로 표시되고 pane은 비어 있다', async () => {
  const { server, base } = await startServer(makePdf(1));
  const { dir, storageDir, app, win } = await openPdfMode('bad');

  await win.fill(`${L} .pdf-url-input`, `${base}/nope.pdf`);
  await win.click(`${L} .pdf-url-go`);

  // 정확히 main이 쓴 문장만 나온다 — ipcRenderer.invoke가 덧씌우는 "Error invoking remote method…" 껍데기 없이.
  await expect(win.locator(`${L} .pdf-url-msg`))
    .toHaveText('PDF가 아닙니다 (응답에서 %PDF- 헤더를 찾지 못했습니다)', { timeout: 20000 });
  await expect(win.locator(L)).not.toHaveClass(/loaded/);
  // 고쳐서 다시 시도할 수 있게 입력값은 남아 있다
  await expect(win.locator(`${L} .pdf-url-input`)).toHaveValue(`${base}/nope.pdf`);
  expect(fs.existsSync(path.join(storageDir, 'downloads', 'nope.pdf'))).toBe(false);

  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('http/https가 아닌 URL은 다운로드를 시도하지 않고 거부한다', async () => {
  const { dir, app, win } = await openPdfMode('scheme');

  await win.fill(`${L} .pdf-url-input`, 'file:///etc/passwd');
  await win.click(`${L} .pdf-url-go`);

  await expect(win.locator(`${L} .pdf-url-msg`))
    .toHaveText('http/https URL만 열 수 있습니다', { timeout: 10000 });
  await expect(win.locator(L)).not.toHaveClass(/loaded/);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
