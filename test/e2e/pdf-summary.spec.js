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
  cache[key].exports.set({ storageDir: d, translate: { engine: 'agy' } });
}, dir);

// 가짜 agy: `agy -p <프롬프트>` 계약만 흉내 낸다. 프롬프트 안의 [할 일] 문구로 종류를 가른다
// (paperSummary.KIND_SPEC이 kind마다 다른 문장을 넣으므로 이걸로 충분히 구분된다).
// delays로 각 종류의 응답 지연을 조절해 "생성 중 레이아웃 전환" 같은 경쟁 상황을 재현한다.
// logFile을 주면 판정한 kind를 한 줄씩 append한다 — "몇 번 불렸는지"와 "어느 kind로 불렸는지"를
// 프롬프트 매칭 결과 그대로 증거로 남겨, 재생성이 활성 탭 하나만 건드렸는지 검증할 수 있게 한다.
function stubAgy(dir, delays = { overview: 0, sections: 0, flow: 0 }, logFile) {
  const p = path.join(dir, 'agy');
  fs.writeFileSync(p, [
    '#!/bin/sh',
    'prompt="$2"',
    'case "$prompt" in',
    '  *"흐름도를 mermaid"*) kind=flow ;;',
    '  *"절 단위로"*) kind=sections ;;',
    '  *"이야기 순서"*) kind=narrative ;;',
    '  *) kind=overview ;;',
    'esac',
    logFile ? `echo "$kind" >> "${logFile}"` : ':',
    'case "$kind" in',
    '  flow)',
    `    sleep ${delays.flow}`,
    "    printf '```mermaid\\nflowchart TD\\n  A[\"문제 제기\"] --> B[\"핵심 아이디어\"]\\n  B --> C[\"실험 결과\"]\\n```\\n'",
    '    ;;',
    '  sections)',
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
  const log = path.join(dir, 'agy-calls.log');
  return { dir, a, b, storageDir: path.join(dir, 'storage'), agy: stubAgy(dir, delays, log), log };
}

// agy 호출 로그를 kind 배열로 읽는다 — pdf-reuse.spec.js의 runCount와 같은 관용구(파일 존재로 세지 않고
// 실행 횟수 자체를 증거로 삼는다).
const callLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);

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
  await win.click(`${S} .sum-all`);

  // Overview가 먼저 완성되고 그 탭이 자동으로 선택된다
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`))
    .toContainText('한 줄짜리 개요 본문', { timeout: 25000 });
  // 마크다운이 표준 태그로 렌더된다(굵은 소제목이 <strong>이 된다)
  await expect(win.locator(`${S} .sum-pane[data-kind=overview] strong`)).toHaveCount(1);

  // 절별 요약: 목차 헤딩이 h2로 렌더된다
  await win.click(`${S} .sum-tab[data-kind=sections]`);
  await expect(win.locator(`${S} .sum-pane[data-kind=sections] h2`))
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

test('재생성: 활성 탭 하나만 다시 만들고 나머지 탭의 캐시는 보존된다', async () => {
  const { dir, a, storageDir, agy, log } = setup('regen-only');
  const { app, win } = await launch(
    { ...process.env, WCOMPARE_AGY: agy }, [a], storageDir);

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-all`);

  // 최초 생성: 세 탭 모두 채워질 때까지 기다린다("다시 생성" 버튼이 풀리면 완료).
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`))
    .toContainText('한 줄짜리 개요 본문', { timeout: 25000 });
  await expect(win.locator(`${S} .sum-regen`)).toBeEnabled({ timeout: 25000 });
  // 최초 생성은 3종 전부 — 로그에 overview/sections/flow 순서로 세 줄이 남는다.
  expect(callLog(log)).toEqual(['overview', 'narrative', 'sections', 'flow']);

  const cacheDir = path.join(storageDir, 'summaries');
  // 저장은 finally에서 await 없이 던져진다 — 버튼이 풀린 시점에 파일이 아직 없을 수 있으므로
  // 파일이 나타날 때까지 기다린 뒤 읽는다(아래 캐시 복원 테스트와 같은 관용구).
  await expect.poll(() => { try { return fs.readdirSync(cacheDir).length; } catch { return 0; } },
    { timeout: 10000 }).toBeGreaterThan(0);
  const cacheFile = () => path.join(cacheDir, fs.readdirSync(cacheDir)[0]);
  const readCache = () => JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  const before = readCache();
  const mtimeBefore = fs.statSync(cacheFile()).mtimeMs;
  expect(before.parts.overview).toContain('한 줄짜리 개요 본문');
  expect(before.parts.sections).toContain('제안 방법');
  expect(before.parts.flow).toContain('flowchart TD');

  // 흐름도 탭으로 옮긴 뒤 "다시 생성" — 지금 보고 있는 탭(흐름도) 하나만 다시 만들어야 한다.
  await win.click(`${S} .sum-tab[data-kind=flow]`);
  await win.click(`${S} .sum-regen`);
  await expect(win.locator(`${S} .sum-regen`)).toBeEnabled({ timeout: 25000 });

  // 가짜 CLI 호출이 정확히 1회만 늘었고, 그 kind는 flow다(KIND_SPEC 문구로 프롬프트에서 구분됨).
  const lines = callLog(log);
  expect(lines.length).toBe(5);
  expect(lines[4]).toBe('flow');

  // 재생성의 저장도 fire-and-forget이다. 가짜 CLI가 매번 같은 내용을 돌려줘 내용 비교로는 저장
  // 완료를 알 수 없으니 파일 mtime이 커질 때까지 기다린다 — 이게 없으면 저장 전의 옛 파일을
  // 읽고도 아래 세 단언이 공허하게 통과해, 캐시 보존이 깨져도 테스트가 초록으로 남는다.
  await expect.poll(() => fs.statSync(cacheFile()).mtimeMs, { timeout: 10000 })
    .toBeGreaterThan(mtimeBefore);
  // overview/sections 캐시는 재생성 전과 완전히 같다 — 흐름도만 재생성했다고 나머지가 날아가지 않았다.
  const after = readCache();
  expect(after.parts.overview).toBe(before.parts.overview);
  expect(after.parts.sections).toBe(before.parts.sections);
  expect(after.parts.flow).toContain('flowchart TD');

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('요약 캐시: 문서를 닫았다 다시 열면 재생성 없이 복원된다', async () => {
  const { dir, a, storageDir, agy } = setup('cache');
  const { app, win } = await launch(
    { ...process.env, WCOMPARE_AGY: agy }, [a], storageDir);

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-all`);
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
  await win.click(`${S} .sum-all`);
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
  await win.click(`${S} .sum-all`);
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
  await win.click(`${S} .sum-all`);
  await expect(win.locator(`${S} .sum-busy`)).toBeVisible({ timeout: 5000 });

  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('요약은 side가 아니라 문서를 따라간다 — Switch해도 읽던 요약이 사라지지 않는다', async () => {
  // 요약을 "왼쪽 pane"에 묶으면 Switch 한 번에 요약 대상이 바뀌어 읽던 내용이 지워진다.
  // 이 앱은 마커를 이미 side가 아닌 문서 경로에 묶어 두었고, 요약도 같은 규칙을 따른다.
  const { dir, a, b, storageDir, agy } = setup('switch');
  const { app, win } = await launch({ ...process.env, WCOMPARE_AGY: agy }, [a, b], storageDir);
  await win.waitForSelector(`${R} canvas`, { timeout: 20000 });

  await win.click('#btn-layout-full');
  await win.click(`${S} .sum-all`); // 왼쪽(a)의 요약을 만든다
  const ov = `${S} .sum-pane[data-kind=overview]`;
  await expect(win.locator(ov)).toContainText('한 줄짜리 개요 본문', { timeout: 25000 });
  await expect(win.locator(`${S} .sum-regen`)).toBeEnabled({ timeout: 25000 });

  // Switch: a가 오른쪽으로 간다. 문서는 여전히 열려 있으므로 요약은 그대로 남아야 한다.
  await win.click('#btn-switch');
  await win.waitForTimeout(500);
  await expect(win.locator(ov)).toContainText('한 줄짜리 개요 본문');
  await expect(win.locator(`${S} .sum-empty`)).toBeHidden();

  // 한 번 더 Switch해도 마찬가지 (왕복해도 안정적이다)
  await win.click('#btn-switch');
  await win.waitForTimeout(500);
  await expect(win.locator(ov)).toContainText('한 줄짜리 개요 본문');

  // 주인 문서(a)가 닫히면 그때 비로소 남은 문서로 갈아 끼운다 — a를 오른쪽에 두고 닫는다.
  await win.click('#btn-switch');
  await win.click(`${R} .pdf-close`);
  await expect(win.locator(R)).not.toHaveClass(/loaded/);
  await expect(win.locator(`${S} .sum-empty-go`)).toBeVisible();
  await expect(win.locator(`${S} .sum-empty-go`)).toBeEnabled();
  await expect(win.locator(ov)).toBeEmpty();

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 수식·표가 섞인 응답을 주는 가짜 agy. 논문 요약에는 $N$ 같은 수식이 흔히 섞여 오는데,
// 예전 자체 렌더러는 이걸 달러 기호째로 노출했다(사용자 신고).
function stubAgyRich(dir) {
  const p = path.join(dir, 'agy');
  const say = (body) => ["cat <<'WCEOF'", body, 'WCEOF'].join('\n');
  fs.writeFileSync(p, [
    '#!/bin/sh',
    'prompt="$2"',
    'case "$prompt" in',
    '  *"흐름도를 mermaid"*)',
    say('```mermaid\nflowchart TD\n  A["문제"] --> B["해법"]\n```'),
    '    ;;',
    '  *"절 단위로"*)',
    say('## 1. 서론\n표본 수는 $N$ 이고 손실은 $$L = \\frac{1}{N} \\sum_i x_i$$ 로 둔다.\n\n| 항목 | 값 |\n|---|---|\n| 정확도 | 91.2 |'),
    '    ;;',
    '  *)',
    say('**핵심**\n토큰 수 $N$ 을 늘리면 성능이 오른다.\n\n- 첫째\n  - 중첩 항목\n- 둘째'),
    '    ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  return p;
}

test('마크다운 뷰어: LaTeX 수식이 글자로 렌더되고 표·중첩목록도 그려진다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sum-math-'));
  const a = path.join(dir, 'paper.pdf');
  fs.writeFileSync(a, makePdf(4, { height: 900, lines: 6 }));
  const storageDir = path.join(dir, 'storage');
  const { app, win } = await launch(
    { ...process.env, WCOMPARE_AGY: stubAgyRich(dir) }, [a], storageDir);

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-all`);

  const ov = `${S} .sum-pane[data-kind=overview]`;
  await expect(win.locator(ov)).toContainText('토큰 수', { timeout: 25000 });
  // 핵심: 달러 기호가 그대로 남지 않고 KaTeX 요소가 된다
  await expect(win.locator(`${ov} .katex`)).not.toHaveCount(0);
  await expect(win.locator(ov)).not.toContainText('$N$');
  // 중첩 목록 — 자체 렌더러가 못 하던 것
  await expect(win.locator(`${ov} li > ul`)).not.toHaveCount(0);

  await win.click(`${S} .sum-tab[data-kind=sections]`);
  const sec = `${S} .sum-pane[data-kind=sections]`;
  await expect(win.locator(`${sec} table th`)).not.toHaveCount(0, { timeout: 25000 });
  await expect(win.locator(`${sec} .katex-display`)).not.toHaveCount(0); // $$…$$ 는 블록 수식
  // 수식이 빈 칸이 아니라 실제로 그려졌다(폰트가 없으면 폭이 0에 가깝다)
  const w = await win.locator(`${sec} .katex-display .katex`).first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeGreaterThan(20);
  // "렌더됐다"가 아니라 "제대로 렌더됐다"를 본다. \frac이 망가지면 KaTeX는 그것을 조용히
  // 'frac'이라는 글자로 그리는데, 위의 존재·폭 단언만으로는 그 상태도 통과한다(실제로 겪음).
  await expect(win.locator(`${sec} .katex-display .mfrac`)).not.toHaveCount(0);
  // 눈에 보이는 부분(.katex-html)만 본다 — .katex-mathml의 <annotation>에는 원본 TeX가
  // 그대로 들어 있어(접근성용, CSS로 숨겨짐) 패널 전체 텍스트로 재면 늘 'frac'이 잡힌다.
  const shown = await win.locator(`${sec} .katex-display .katex-html`).first().innerText();
  expect(shown).not.toMatch(/frac|sum_/);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('요약 뷰어 글씨 크기: A+ / A− / ↺ 가 본문과 제목을 함께 조절하고 유지된다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sum-font-'));
  const a = path.join(dir, 'paper.pdf');
  fs.writeFileSync(a, makePdf(4, { height: 900, lines: 6 }));
  const storageDir = path.join(dir, 'storage');
  const env = { ...process.env, WCOMPARE_AGY: stubAgyRich(dir) };
  const { app, win } = await launch(env, [a], storageDir);

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-all`);
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`)).toContainText('토큰 수', { timeout: 25000 });

  const bodyPx = () => win.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.sum-body')).fontSize));
  const strongPx = () => win.evaluate(() => {
    const el = document.querySelector('.sum-pane[data-kind=overview] strong');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });

  const base = await bodyPx();
  expect(base).toBeGreaterThan(0);

  await win.click(`${S} .sum-font-inc`);
  await win.click(`${S} .sum-font-inc`);
  const bigger = await bodyPx();
  expect(bigger).toBeGreaterThan(base);
  // 제목·강조도 함께 커져야 한다 — px로 박아 두면 본문만 커지고 문서가 어그러진다
  expect(await strongPx()).toBeGreaterThan(0);

  await win.click(`${S} .sum-font-dec`);
  expect(await bodyPx()).toBeLessThan(bigger);

  await win.click(`${S} .sum-font-reset`);
  expect(await bodyPx()).toBe(base);

  // 크기를 키운 뒤 앱을 껐다 켜면 그대로 유지된다
  await win.click(`${S} .sum-font-inc`);
  const kept = await bodyPx();
  await app.close();

  const again = await launch(env, [a], storageDir);
  await again.win.click('#btn-layout-summary');
  await expect
    .poll(() => again.win.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.sum-body')).fontSize)))
    .toBe(kept);
  await again.app.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

// 절별 요약에 h1/h2/h3를 섞어 주는 가짜 agy — 요약 TOC의 depth 필터를 시험하려면 깊이가 필요하다
// (기본 stubAgy는 h2만 두 개라 depth를 바꿔도 항목 수가 변하지 않는다).
// 절마다 긴 filler를 넣는 이유: 목차 항목을 눌렀을 때 실제로 스크롤이 일어나야 검증이 성립한다.
function stubAgyDeep(dir) {
  const p = path.join(dir, 'agy');
  const say = (body) => ["cat <<'WCEOF'", body, 'WCEOF'].join('\n');
  const filler = Array(40).fill('본문을 채우는 줄.').join('\n\n');
  fs.writeFileSync(p, [
    '#!/bin/sh',
    'prompt="$2"',
    'case "$prompt" in',
    '  *"흐름도를 mermaid"*)',
    say('```mermaid\nflowchart TD\n  A["문제"] --> B["해법"]\n```'),
    '    ;;',
    '  *"절 단위로"*)',
    say(['# 논문 전체', filler, '## 1. 서론', filler, '### 1.1 배경', filler, '## 2. 제안 방법', filler].join('\n\n')),
    '    ;;',
    '  *)',
    say('**개요**\n한 줄짜리 개요 본문.'),
    '    ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  return p;
}

test('요약 TOC: 절별 요약 탭에서만 보이고 depth로 항목 수가 달라진다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sum-toc-'));
  const a = path.join(dir, 'paper.pdf');
  fs.writeFileSync(a, makePdf(4, { height: 900, lines: 6 }));
  const { app, win } = await launch(
    { ...process.env, WCOMPARE_AGY: stubAgyDeep(dir) }, [a], path.join(dir, 'storage'));

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-all`);
  await expect(win.locator(`${S} .sum-regen`)).toBeEnabled({ timeout: 25000 });

  const toc = win.locator(`${S} .sum-toc`);
  // 생성이 끝나면 Overview 탭이 선택돼 있다 — 그 탭에서는 목차가 폭을 잡아먹지 않아야 한다.
  await expect(toc).toBeHidden();
  await win.click(`${S} .sum-tab[data-kind=flow]`);
  await expect(toc).toBeHidden();

  await win.click(`${S} .sum-tab[data-kind=sections]`);
  await expect(toc).toBeVisible();

  // depth는 localStorage에 남아 spec 사이로 새므로, 기본값에 기대지 않고 매번 눌러서 정한다.
  const items = win.locator(`${S} .sum-toc .toc-item`);
  const depthBtn = (n) => win.locator(`${S} .toc-depth-btn`).nth(n - 1);
  await depthBtn(3).click();
  await expect(items).toHaveCount(4); // h1 + h2 + h3 + h2
  await depthBtn(1).click();
  await expect(items).toHaveCount(1); // h1 하나만
  await depthBtn(2).click();
  await expect(items).toHaveCount(3); // h1 + h2 둘
  await expect(depthBtn(2)).toHaveClass(/on/);

  // 항목을 누르면 렌더된 본문의 그 헤딩으로 스크롤한다(제목 문자열이 아니라 순번으로 찾는다).
  await win.locator(`${S} .sum-toc .toc-item`, { hasText: '제안 방법' }).click();
  await expect.poll(() => win.evaluate(() => document.querySelector('.sum-body').scrollTop),
    { timeout: 5000 }).toBeGreaterThan(0);

  // 좁은 폭 회귀: 탭바·동작 버튼 줄이 한 줄에 안 들어가면 flex가 아니라 넘침으로 나타나
  // (버튼의 min-width가 auto라 줄지 않는다) 라벨이 잘려 보인다 — 여기서 그걸 숫자로 잡는다.
  // 목차가 본문을 지나치게 밀어내는 것도 함께 본다.
  // 폭을 만드는 방법이 바뀌었다: 예전에는 CSS clamp(300px,30%,560px)라 창만 줄이면 하한까지
  // 따라 내려갔는데, 이제 폭은 사용자 값(paneSplit)이라 창을 줄여도 저장된 폭을 지킨다.
  // 대신 창을 clamp의 상한 아래로 내리면 paneSplit이 resize에서 폭을 다시 조인다 —
  // 620px 창이면 뷰어 몫(MIN_REST=360)을 빼고 260px만 남아 패널이 최소치 근처로 밀린다.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(620, 700));
  await expect.poll(() => win.evaluate(() => document.querySelector('.pdf-summary').clientWidth),
    { timeout: 5000 }).toBeLessThan(320);
  const fit = await win.evaluate(() => {
    const panel = document.querySelector('.pdf-summary');
    const w = (sel) => { const e = panel.querySelector(sel); return [e.scrollWidth, e.clientWidth]; };
    return { tabs: w('.sum-tabs'), acts: w('.sum-acts'), body: w('.sum-body'), panel: panel.clientWidth };
  });
  expect(fit.tabs[0]).toBeLessThanOrEqual(fit.tabs[1]);
  expect(fit.acts[0]).toBeLessThanOrEqual(fit.acts[1]);
  expect(fit.body[1]).toBeGreaterThan(fit.panel * 0.55); // 목차가 본문을 절반 이하로 밀어내지 않는다

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('요약 내보내기: 복사는 클립보드에, 저장은 고른 경로에 마크다운을 남긴다', async () => {
  const { dir, a, storageDir, agy } = setup('export');
  const { app, win } = await launch({ ...process.env, WCOMPARE_AGY: agy }, [a], storageDir);

  await win.click('#btn-layout-summary');
  // 내용이 없을 때는 동작 버튼 줄 자체가 없다 — 빈 요약에 대고 복사·저장할 것이 없다.
  await expect(win.locator(`${S} .sum-copy`)).toBeHidden();
  await win.click(`${S} .sum-all`);
  await expect(win.locator(`${S} .sum-regen`)).toBeEnabled({ timeout: 25000 });

  // 앞선 값이 남아 공허하게 통과하지 않도록 클립보드를 먼저 다른 값으로 덮는다.
  await app.evaluate(({ clipboard }) => clipboard.writeText('__wc-not-copied-yet__'));
  await win.click(`${S} .sum-copy`);
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10000 })
    .toContain('한 줄짜리 개요 본문');
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied).toContain('## 핵심 파악');
  expect(copied).toContain('## 근거 확인');
  expect(copied).toContain('제안 방법');
  // 흐름도는 반드시 mermaid 펜스로 감싸 나간다(안 감싸면 GitHub/Obsidian에서 날 것 코드로 보인다).
  expect(copied).toContain('```mermaid');
  expect(copied).toContain('flowchart TD');
  // 응답에 이미 있던 펜스를 벗기지 않으면 펜스가 두 겹이 되어 그림이 아니라 코드블록이 된다.
  expect(copied).not.toContain('```mermaid\n```');

  // 저장: 실제 showSaveDialog를 띄우면 e2e가 그 자리에서 멈춘다 → main에서 가로채
  // "사용자가 이 경로를 골랐다"만 흉내 낸다(위 캐시 테스트의 showOpenDialog 대체와 같은 관용구).
  const out = path.join(dir, 'saved-summary.md');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, out);
  await win.click(`${S} .sum-save`);
  await expect.poll(() => fs.existsSync(out), { timeout: 10000 }).toBe(true);
  const saved = fs.readFileSync(out, 'utf8');
  expect(saved).toContain('## 근거 확인');
  expect(saved).toContain('flowchart TD');
  expect(saved).toBe(copied); // 복사와 저장은 main의 같은 조립기를 거친다 — 두 경로가 갈리면 안 된다

  // 취소는 조용해야 한다 — 오류 줄이 뜨면 사용자는 저장이 실패한 줄 안다.
  // 클릭 직후에 오류 줄만 보면 안 된다: .sum-err는 클릭 전부터 이미 숨김이라 toBeHidden()이
  // 첫 검사에서 즉시 통과해, IPC 왕복이 끝나기도 전에 초록이 된다. 그러면 취소 시 throw하도록
  // 회귀해도(=사용자에게 빨간 오류가 뜨는 진짜 버그) 이 테스트는 계속 통과한다.
  // 버튼은 클릭 순간 동기적으로 잠기므로(run()의 setLocked), 다시 풀릴 때까지 기다리면
  // 왕복이 끝난 뒤를 관측하게 된다.
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  const before = fs.readFileSync(out, 'utf8');
  await win.click(`${S} .sum-save`);
  await expect(win.locator(`${S} .sum-save`)).toBeEnabled({ timeout: 10000 });
  await expect(win.locator(`${S} > .sum-err`)).toBeHidden();
  expect(fs.readFileSync(out, 'utf8')).toBe(before); // 취소했는데 파일이 다시 쓰이지도 않았다

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('회귀: 라이트 테마에서 흐름도의 글씨가 배경에 묻히지 않는다', async () => {
  // mermaid는 색을 CSS가 아니라 렌더 시점에 SVG 안에 구워 넣는다. 테마를 안 따라가면
  // 라이트 UI 위에 다크 그림이 얹혀 상자는 투명하고 글씨는 밝은 회색이 되어 안 보인다(사용자 신고).
  const { dir, a, storageDir, agy } = setup('flowtheme');
  const { app, win } = await launch({ ...process.env, WCOMPARE_AGY: agy }, [a], storageDir);

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-all`);
  await win.click(`${S} .sum-tab[data-kind=flow]`);
  await expect(win.locator(`${S} .sum-pane[data-kind=flow] svg`)).toHaveCount(1, { timeout: 25000 });

  // 라이트로 바꾼다
  await win.evaluate(() => document.getElementById('settings-dialog').showModal());
  await win.selectOption('#set-theme', 'light');
  await win.evaluate(() => document.getElementById('settings-dialog').close());

  // 다시 그려질 때까지 기다린 뒤 실제 대비비를 잰다
  const contrast = async () => win.evaluate(() => {
    const lum = (c) => {
      const m = (c || '').match(/[\d.]+/g);
      if (!m || m.length < 3) return null;
      const [r, g, b] = m.slice(0, 3).map((n) => {
        const s = Number(n) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const pane = document.querySelector('.sum-pane[data-kind=flow]');
    const label = pane?.querySelector('.nodeLabel');
    if (!label) return null;
    // .sum-body는 배경이 투명이라 그대로 재면 검정으로 잡힌다 → 실제로 색을 칠하는
    // 가장 가까운 조상을 찾아 올라간다(알파가 0이 아닌 첫 배경).
    const effectiveBg = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const m = (c || '').match(/[\d.]+/g);
        if (m && (m.length < 4 || Number(m[3]) > 0)) return c;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    // 글자색은 mermaid가 SVG 안에 구워 넣고, 배경은 패널 CSS가 정한다 — 둘을 맞대어 본다.
    const fg = lum(getComputedStyle(label).color);
    const bg = lum(effectiveBg(label));
    if (fg === null || bg === null) return null;
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });

  await expect.poll(contrast, { timeout: 15000 }).toBeGreaterThan(4.5); // WCAG AA

  // 다크로 되돌려도 마찬가지로 읽혀야 한다
  await win.evaluate(() => document.getElementById('settings-dialog').showModal());
  await win.selectOption('#set-theme', 'dark');
  await win.evaluate(() => document.getElementById('settings-dialog').close());
  await expect.poll(contrast, { timeout: 15000 }).toBeGreaterThan(4.5);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('요약 TOC 접기: 접으면 목록이 숨고 손잡이는 남아 다시 펼 수 있다', async () => {
  // 이 기능의 가장 쉬운 함정은 "접었더니 통째로 사라져 되돌릴 수 없는 것"이다. 접힘 상태가
  // localStorage에 굳으므로 앱을 껐다 켜도 그대로다 → 손잡이가 남는지를 회귀로 못 박는다.
  const { dir, a, storageDir, agy } = setup('tocfold');
  const { app, win } = await launch({ ...process.env, WCOMPARE_AGY: agy }, [a], storageDir);

  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-all`);
  await expect(win.locator(`${S} .sum-regen`)).toBeEnabled({ timeout: 25000 });
  await win.click(`${S} .sum-tab[data-kind=sections]`);

  const toc = win.locator(`${S} .sum-toc`);
  const fold = win.locator(`${S} .toc-fold`);
  await expect(toc).toBeVisible();
  await expect(win.locator(`${S} .sum-toc .toc-item`).first()).toBeVisible();
  const wide = (await toc.boundingBox()).width;

  await fold.click(); // 접기
  await expect(toc).toHaveClass(/collapsed/);
  await expect(win.locator(`${S} .sum-toc .toc-depth-body`)).toBeHidden();
  await expect(fold).toBeVisible(); // 되돌릴 수단이 반드시 남는다
  expect((await toc.boundingBox()).width).toBeLessThan(wide);

  await fold.click(); // 다시 펼치기
  await expect(toc).not.toHaveClass(/collapsed/);
  await expect(win.locator(`${S} .sum-toc .toc-item`).first()).toBeVisible();

  // 접힘은 탭 전환에 씻겨 나가지 않는다 — 두 상태가 별개 축이라는 것의 실제 확인.
  await fold.click();
  await win.click(`${S} .sum-tab[data-kind=overview]`);
  await win.click(`${S} .sum-tab[data-kind=sections]`);
  await expect(toc).toHaveClass(/collapsed/);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('요약 폭 조절: 스플리터를 끌면 폭이 바뀌고 어느 쪽도 0px가 되지 않는다', async () => {
  // 불변식: 뷰어가 0이면 pdf.js page-width가 0으로 나눈 값을 받고, 요약이 0이면 mermaid가
  // 빈 그림을 그린다. 끝까지 끌어도 두 쪽이 모두 살아 있어야 한다.
  const { dir, a, b, storageDir, agy } = setup('split');
  const { app, win } = await launch({ ...process.env, WCOMPARE_AGY: agy }, [a, b], storageDir);
  await win.click('#btn-layout-full');

  const split = win.locator('.pane-split');
  await expect(split).toBeVisible();
  const box = await split.boundingBox();
  const sumW = async () => (await win.locator(S).boundingBox()).width;
  const before = await sumW();

  // 왼쪽으로 200px 끌면 요약이 그만큼 넓어진다.
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 8 });
  await win.mouse.up();
  await expect.poll(sumW, { timeout: 5000 }).toBeGreaterThan(before + 100);

  // 오른쪽 끝까지 끌어도 요약이 사라지지 않는다(최소 폭에서 멈춘다).
  const b2 = await split.boundingBox();
  await win.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await win.mouse.down();
  await win.mouse.move(b2.x + 5000, b2.y + b2.height / 2, { steps: 8 });
  await win.mouse.up();
  await expect.poll(sumW, { timeout: 5000 }).toBeGreaterThan(0);
  // 뷰어도 살아 있다.
  expect((await win.locator(L).boundingBox()).width).toBeGreaterThan(0);

  // 대조형에서는 요약이 숨으므로 손잡이도 함께 숨어야 한다(허공에 손잡이가 남으면 안 된다).
  await win.click('#btn-layout-compare');
  await expect(split).toBeHidden();

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('단계별 읽기: 기본 한 번 생성, 선택한 탭만 추가, 근거 이동과 접힌 답', async () => {
  const { dir, a, b, storageDir, agy, log } = setup('progressive');
  const reply = '**기존 → 제안** 작은 입력을 추적합니다. [p.3](#paper-page-3)\n\n<details><summary>구성요소를 빼면?</summary><p>비교에 필요한 정보가 사라집니다.</p></details>\n\n[잘못된 페이지](#paper-page-999)';
  fs.writeFileSync(path.join(dir, 'reply.md'), reply);
  fs.writeFileSync(agy, '#!/bin/sh\necho call >> "' + log + '"\ncat "' + path.join(dir, 'reply.md') + '"\n', { mode: 0o755 });
  const { app, win } = await launch({ ...process.env, WCOMPARE_AGY: agy }, [a, b], storageDir);
  try {
    await win.click('#btn-layout-summary');
    await win.click(`${S} .sum-empty-go`);
    const overview = win.locator(`${S} .sum-pane[data-kind=overview]`);
    await expect(overview).toContainText('작은 입력');
    await expect(win.locator(`${S} .sum-busy`)).toBeHidden();
    expect(callLog(log)).toEqual(['call']);
    await expect(overview.locator('details')).not.toHaveAttribute('open');
    await overview.locator('summary').click();
    await expect(overview.locator('details')).toHaveAttribute('open', '');
    await overview.locator('a[href="#paper-page-3"]').click();
    await expect(win.locator('#pdf-status')).toContainText('L 3/4');
    await win.click('#btn-back');
    await expect(win.locator('#pdf-status')).toContainText('L 1/4');
    await win.click('#btn-switch');
    await overview.locator('a[href="#paper-page-3"]').click();
    await expect(win.locator('#pdf-status')).toContainText('R 3/4');
    await expect(win.locator('#btn-layout-full')).toHaveClass(/on/);
    await overview.getByText('잘못된 페이지').click();
    await expect(win.locator(`${S} .sum-err`)).toContainText('페이지');
    await win.click(`${S} .sum-tab[data-kind=narrative]`);
    expect(callLog(log)).toEqual(['call']);
    await expect(win.locator(`${S} .sum-empty-go`)).toHaveText('작동 원리 시작');
    await win.click(`${S} .sum-empty-go`);
    await expect(win.locator(`${S} .sum-pane[data-kind=narrative]`)).toContainText('작은 입력');
    await expect(win.locator(`${S} .sum-busy`)).toBeHidden();
    expect(callLog(log)).toEqual(['call', 'call']);
    await expect(overview).toContainText('작은 입력');
    await expect(win.locator(`${S} .sum-version-note`)).toBeEmpty();
    await win.screenshot({ path: path.join(__dirname, '../../release/reading-preview.png') });
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
