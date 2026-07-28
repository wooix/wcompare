// test/e2e/pdf-summary.spec.js — 보기 형태 3종(대조/요약/3분할) + 탭형 논문 요약 패널.
// 실제 LLM은 부르지 않는다: 프롬프트에서 요약 종류를 알아내 고정 응답을 돌려주는 가짜 agy를
// WCOMPARE_AGY로 주입한다(transpaper e2e의 stubTranspaper와 같은 관용구).
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

// URL 열기 경로를 태우기 위한 최소 로컬 서버(네트워크를 나가지 않는다).
function startServer(pdf) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length });
    res.end(pdf);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

// e2e 공통: 렌더러가 localStorage에 남기는 UI 상태(보기 형태 wc-layout, Night, Dict)가
// spec 사이로 새지 않도록 userData를 이 파일 전용 임시 폴더로 격리한다. 공유 프로필을 쓰면
// 요약 패널이 열린 채로 시작해 pane 폭이 달라지고, 배율·스크롤을 재는 테스트가 실행 순서에 따라 흔들린다.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ud-'));
const L = '.pdf-pane[data-side=left]';
const R = '.pdf-pane[data-side=right]';
const S = '.pdf-summary';

const setStorage = (app, dir) => app.evaluate((_electron, d) => {
  const cache = process.mainModule.require('module')._cache;
  const key = Object.keys(cache).find((k) => k.replace(/\\/g, '/').endsWith('/src/main/settings.js'));
  cache[key].exports.set({ storageDir: d });
}, dir);

// 가짜 agy: `agy -p <프롬프트>` 계약만 흉내 낸다. 프롬프트 안의 [할 일] 문구로 종류를 가른다
// (paperSummary.KIND_SPEC이 kind마다 다른 문장을 넣으므로 이걸로 충분히 구분된다).
// delays로 각 종류의 응답 지연을 조절해 "생성 중 레이아웃 전환" 같은 경쟁 상황을 재현한다.
function stubAgy(dir, delays = { overview: 0, sections: 0, flow: 0 }) {
  const p = path.join(dir, 'agy');
  fs.writeFileSync(p, [
    '#!/bin/sh',
    'prompt="$2"',
    'case "$prompt" in',
    '  *"흐름도를 mermaid"*)',
    `    sleep ${delays.flow}`,
    "    printf '```mermaid\\nflowchart TD\\n  A[\"문제 제기\"] --> B[\"핵심 아이디어\"]\\n  B --> C[\"실험 결과\"]\\n```\\n'",
    '    ;;',
    '  *"절 단위로 나누어"*)',
    `    sleep ${delays.sections}`,
    "    printf '## 1. 서론\\n첫째 절 요약 본문.\\n\\n## 2. 제안 방법\\n둘째 절 요약 본문.\\n'",
    '    ;;',
    '  *)',
    `    sleep ${delays.overview}`,
    "    printf '**무엇을 푸는 문제인가**\\n한 줄짜리 개요 본문.\\n'",
    '    ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  return p;
}

function setup(tag, delays) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-sum-${tag}-`));
  const a = path.join(dir, 'paper.pdf');
  const b = path.join(dir, 'paper.ko.pdf');
  fs.writeFileSync(a, makePdf(4, { height: 900, lines: 6 }));
  fs.writeFileSync(b, makePdf(4, { height: 900, lines: 6 }));
  return { dir, a, b, storageDir: path.join(dir, 'storage'), agy: stubAgy(dir, delays) };
}

// 두 PDF를 열고 PDF 모드에 들어간 상태까지 만든다.
async function launch(env, args, storageDir) {
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, ...args], env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });
  await setStorage(app, storageDir);
  return { app, win };
}

test('보기 형태 3종: 대조 / 요약 / 3분할이 열의 표시를 바꾼다', async () => {
  const { dir, a, b, storageDir, agy } = setup('layout');
  const { app, win } = await launch(
    { ...process.env, WCOMPARE_AGY: agy }, [a, b], storageDir);
  await win.waitForSelector(`${R} canvas`, { timeout: 20000 });

  // 대조: 좌우 pane만, 요약 패널은 숨김
  await win.click('#btn-layout-compare');
  await expect(win.locator(L)).toBeVisible();
  await expect(win.locator(R)).toBeVisible();
  await expect(win.locator(S)).toBeHidden();
  await expect(win.locator('#btn-layout-compare')).toHaveClass(/on/);

  // 요약: 오른쪽 pane을 감추고 요약 패널을 보인다
  await win.click('#btn-layout-summary');
  await expect(win.locator(R)).toBeHidden();
  await expect(win.locator(L)).toBeVisible();
  await expect(win.locator(S)).toBeVisible();

  // 3분할: 셋 다
  await win.click('#btn-layout-full');
  await expect(win.locator(L)).toBeVisible();
  await expect(win.locator(R)).toBeVisible();
  await expect(win.locator(S)).toBeVisible();
  expect(await win.evaluate(() => window.__wc.getLayout())).toBe('full');

  // 형태를 오가도 열려 있던 문서는 그대로다 (레이아웃은 표시 여부만 바꾼다)
  await expect(win.locator(`${L} canvas`)).not.toHaveCount(0);
  await expect(win.locator(`${R} canvas`)).not.toHaveCount(0);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('요약 생성: 세 탭이 채워지고 흐름도는 mermaid SVG로 그려진다', async () => {
  const { dir, a, storageDir, agy } = setup('gen');
  const { app, win } = await launch(
    { ...process.env, WCOMPARE_AGY: agy }, [a], storageDir);

  await win.click('#btn-layout-summary');
  await expect(win.locator(`${S} .sum-empty-go`)).toBeVisible();
  await win.click(`${S} .sum-empty-go`);

  // Overview가 먼저 완성되고 그 탭이 자동으로 선택된다
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`))
    .toContainText('한 줄짜리 개요 본문', { timeout: 25000 });
  // 마크다운이 DOM으로 렌더된다(굵은 소제목이 <strong>이 된다)
  await expect(win.locator(`${S} .sum-pane[data-kind=overview] .md-strong`)).toHaveCount(1);

  // 절별 요약: 목차 헤딩이 h2로 렌더된다
  await win.click(`${S} .sum-tab[data-kind=sections]`);
  await expect(win.locator(`${S} .sum-pane[data-kind=sections] .md-h2`))
    .toHaveCount(2, { timeout: 25000 });
  await expect(win.locator(`${S} .sum-pane[data-kind=sections]`)).toContainText('제안 방법');

  // 흐름도: 탭이 드러나는 순간 mermaid가 SVG를 만든다
  await win.click(`${S} .sum-tab[data-kind=flow]`);
  const svg = win.locator(`${S} .sum-pane[data-kind=flow] svg`);
  await expect(svg).toHaveCount(1, { timeout: 25000 });
  await expect(win.locator(`${S} .sum-pane[data-kind=flow]`)).toContainText('핵심 아이디어');
  // 폭 0이면 mermaid가 레이아웃을 못 재 빈 그림이 된다 — 실제로 그려졌는지 확인
  expect(await svg.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(10);
  // 렌더 실패 경로(원본 코드 노출)로 새지 않았다
  await expect(win.locator(`${S} .sum-code`)).toHaveCount(0);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('요약 캐시: 문서를 닫았다 다시 열면 재생성 없이 복원된다', async () => {
  const { dir, a, storageDir, agy } = setup('cache');
  const { app, win } = await launch(
    { ...process.env, WCOMPARE_AGY: agy }, [a], storageDir);

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-empty-go`);
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`))
    .toContainText('한 줄짜리 개요 본문', { timeout: 25000 });
  // 흐름도까지 끝나야 캐시가 세 파트를 다 담는다 — "다시 생성" 버튼이 다시 눌릴 수 있게 되면 완료
  await expect(win.locator(`${S} .sum-regen`)).toBeEnabled({ timeout: 25000 });

  const cacheDir = path.join(storageDir, 'summaries');
  await expect.poll(() => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).length : 0),
    { timeout: 10000 }).toBeGreaterThan(0);

  // 닫았다 다시 연다 — 가짜 agy를 지워 두면 "재생성이 일어났다면 반드시 실패"한다
  await win.click(`${L} .pdf-close`);
  await expect(win.locator(L)).not.toHaveClass(/loaded/);
  await expect(win.locator(`${S} .sum-empty-go`)).toBeVisible(); // 빈 상태로 돌아간다
  fs.rmSync(agy);

  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, a);
  await win.click('#btn-open-left');
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });

  // 캐시에서 즉시 복원 — 생성 버튼 없이 내용이 있다
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`))
    .toContainText('한 줄짜리 개요 본문', { timeout: 15000 });
  await expect(win.locator(`${S} .sum-empty`)).toBeHidden();

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('회귀: 패널이 숨겨진 사이에 도착한 흐름도도 다시 보일 때 그려진다', async () => {
  // 흐름도 응답을 늦춰, 흐름도 탭이 활성인 채로 패널을 감춘 상태에서 결과가 도착하게 만든다.
  // 이때 mermaid는 폭을 0으로 재 렌더를 미루는데, 다시 보일 때 스스로 깨어나야 한다.
  const { dir, a, storageDir, agy } = setup('hidden', { overview: 0, sections: 1, flow: 2 });
  const { app, win } = await launch(
    { ...process.env, WCOMPARE_AGY: agy }, [a], storageDir);

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-empty-go`);
  // Overview가 오면 탭이 overview로 바뀐다 → 그 뒤에 흐름도 탭으로 옮겨 둔다
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`))
    .toContainText('한 줄짜리 개요 본문', { timeout: 25000 });
  await win.click(`${S} .sum-tab[data-kind=flow]`);
  expect(await win.evaluate(() => window.__wc.summaryTab())).toBe('flow');

  // 흐름도가 아직 오기 전에 패널을 감춘다 (대조형)
  await win.click('#btn-layout-compare');
  await expect(win.locator(S)).toBeHidden();

  // 숨어 있는 동안 생성이 끝난다
  await expect.poll(
    () => win.evaluate(() => !!document.querySelector('.sum-regen:not([disabled])')),
    { timeout: 30000 }).toBe(true);

  // 다시 보이게 하면 밀려 있던 흐름도가 그려져야 한다
  await win.click('#btn-layout-full');
  const svg = win.locator(`${S} .sum-pane[data-kind=flow] svg`);
  await expect(svg).toHaveCount(1, { timeout: 15000 });
  expect(await svg.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(10);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('회귀: 요약 생성 중에 문서를 닫으면 잠금이 곧바로 풀린다', async () => {
  // 사용자 신고: "pdf를 열었다 닫았다 한 후 url 호출 시 요약 생성이 활성화되지 않음".
  // 원인은 생성 중 문서를 닫아도 진행 중인 LLM 호출이 계속 돌아, 그 세 번이 다 끝날 때까지
  // run()의 finally가 오지 않아 버튼이 잠긴 채로 남는 것이었다(실제 LLM이면 수 분).
  // 이제 닫기가 (1) main의 요약 job을 취소하고 (2) reset이 잠금을 직접 푼다.
  // 첫 응답을 8초 늦춰, 고쳐지지 않았다면 3초 안에 절대 풀릴 수 없게 만든다.
  const { dir, a, storageDir, agy } = setup('cancel', { overview: 8, sections: 0, flow: 0 });
  const { server, base } = await startServer(makePdf(3, { height: 900, lines: 5 }));
  const { app, win } = await launch({ ...process.env, WCOMPARE_AGY: agy }, [a], storageDir);

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-empty-go`);
  await expect(win.locator(`${S} .sum-empty-go`)).toBeDisabled(); // 실행 중이니 잠기는 게 정상

  // 응답이 오기 전에 문서를 닫는다
  await win.click(`${L} .pdf-close`);
  await expect(win.locator(L)).not.toHaveClass(/loaded/);
  await expect(win.locator(`${S} .sum-empty-go`)).toBeEnabled({ timeout: 3000 });

  // URL로 새 문서를 열어도 여전히 눌린다 (사용자가 실제로 겪은 순서)
  await win.fill(`${L} .pdf-url-input`, `${base}/paper.pdf`);
  await win.click(`${L} .pdf-url-go`);
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });
  await expect(win.locator(`${S} .sum-empty-go`)).toBeEnabled();

  // 눌러서 실제로 새 생성이 시작된다 — 앞 문서의 좀비 실행이 화면을 덮지 않는다
  await win.click(`${S} .sum-empty-go`);
  await expect(win.locator(`${S} .sum-busy`)).toBeVisible({ timeout: 5000 });

  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('회귀: Switch로 문서가 좌우를 옮겨 다녀도 요약은 대상 문서를 정확히 따라간다', async () => {
  // 요약 패널을 side에 묶으면 어긋난다: A를 요약한 뒤 ⇄ Switch를 누르면 A는 오른쪽으로 가는데
  // closeFile의 판정이 side 비교라 'right !== left'로 "요약 side가 아니다"라고 오판했다.
  // 그 결과 A를 닫아도 A의 요약이 남고, 남은 문서용 '논문 요약 생성' 버튼이 사라졌다.
  const { dir, a, b, storageDir, agy } = setup('switch');
  const { app, win } = await launch({ ...process.env, WCOMPARE_AGY: agy }, [a, b], storageDir);
  await win.waitForSelector(`${R} canvas`, { timeout: 20000 });

  await win.click('#btn-layout-full');
  await win.click(`${S} .sum-empty-go`); // 왼쪽(a)의 요약을 만든다
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`))
    .toContainText('한 줄짜리 개요 본문', { timeout: 25000 });
  await expect(win.locator(`${S} .sum-regen`)).toBeEnabled({ timeout: 25000 });

  // Switch — 요약 대상(왼쪽)이 a에서 b로 바뀐다 → 패널은 b의 것으로 갈아 끼워져야 한다
  await win.click('#btn-switch');
  await expect(win.locator(`${S} .sum-empty-go`)).toBeVisible({ timeout: 10000 });
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`)).toBeEmpty();

  // 다시 Switch로 a를 왼쪽에 돌려놓으면 캐시에서 a의 요약이 복원된다 — 요약이 문서를 따라다닌다
  await win.click('#btn-switch');
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`))
    .toContainText('한 줄짜리 개요 본문', { timeout: 15000 });

  // 한 번 더 Switch해서 a를 오른쪽에 둔 뒤 a를 닫는다 — 이것이 원래 깨지던 경로다.
  // 닫힌 a의 요약이 남으면 안 되고, 남은 b를 위한 '논문 요약 생성' 버튼이 살아 있어야 한다.
  await win.click('#btn-switch');
  await win.click(`${R} .pdf-close`);
  await expect(win.locator(R)).not.toHaveClass(/loaded/);
  await expect(win.locator(`${S} .sum-empty-go`)).toBeVisible();
  await expect(win.locator(`${S} .sum-empty-go`)).toBeEnabled();
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`)).toBeEmpty();

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
