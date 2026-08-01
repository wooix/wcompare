// test/e2e/settings-summary-prompt.spec.js — 설정창 3탭 재편 + 요약 프롬프트 편집.
// 여기서 지키려는 계약은 네 가지다:
//   (1) 탭을 눌렀을 때 해당 패널'만' 보인다 — 숨은 탭의 입력이 남아 있으면 Playwright의
//       actionability(가시성) 검사에 걸려 다른 spec까지 무너진다(실제로 shortcuts.spec이 그랬다).
//   (2) 편집칸에는 기본 프롬프트 원문이 채워져 보인다. 여러 줄짜리 긴 글이라 placeholder로는
//       보여줄 수 없어 값으로 채우는 설계라, "빈 칸이 아니다"가 곧 회귀 감시선이다.
//   (3) 화면은 기본값 원문을 보여주지만 저장은 "기본값과 같으면 ''"다. 이 변환이 깨지면
//       손대지 않은 사용자에게 지금 문구가 박제돼, 나중에 기본 프롬프트를 고쳐도 반영되지 않는다.
//   (4) 고친 프롬프트가 실제로 CLI argv까지 간다. 설정에만 저장되고 요약 경로가 그것을 읽지
//       않으면 사용자 눈에는 "고쳤는데 아무것도 안 바뀌는" 버그가 된다.
// 실제 LLM은 부르지 않는다: pdf-summary.spec.js와 같은 가짜 agy seam(WCOMPARE_AGY)을 쓰되,
// 받은 프롬프트를 파일로 받아 적게 해 argv를 눈으로 확인한다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { makePdf } = require('../helpers/makePdf.js');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const L = '.pdf-pane[data-side=left]';
const S = '.pdf-summary';

// 편집칸 7개: DOM id ↔ settings.summaryPrompts 하위 키.
const FIELDS = [
  ['#set-prompt-common', 'common'],
  ['#set-prompt-overview-spec', 'overviewSpec'],
  ['#set-prompt-overview-tail', 'overviewTail'],
  ['#set-prompt-sections-spec', 'sectionsSpec'],
  ['#set-prompt-sections-tail', 'sectionsTail'],
  ['#set-prompt-flow-spec', 'flowSpec'],
  ['#set-prompt-flow-tail', 'flowTail'],
];

// userData는 spec마다 따로 잡는다. 설정 파일(userData/settings.json)에 프롬프트 override가
// 남으므로, 공유 프로필을 쓰면 이 spec이 고친 프롬프트가 다른 spec의 요약 테스트로 새어 나간다.
function setup(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-sp-${tag}-`));
  return { dir, userData: path.join(dir, 'userData'), storageDir: path.join(dir, 'storage') };
}

// main settings 모듈(모듈 캐시 공유)의 storageDir를 임시 폴더로 교체 — 실제 ~/.local/wcompare 오염 방지.
const setStorage = (app, dir) => app.evaluate((_electron, d) => {
  const cache = process.mainModule.require('module')._cache;
  const key = Object.keys(cache).find((k) => k.replace(/\\/g, '/').endsWith('/src/main/settings.js'));
  cache[key].exports.set({ storageDir: d });
}, dir);

async function launch({ userData, storageDir }, args = [], env = undefined) {
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`, ...args], env });
  const win = await app.firstWindow();
  await win.waitForSelector('#toolbar', { timeout: 20000 });
  // 대형 번들(app.js)은 정적 #toolbar보다 늦게 실행된다 → 프롬프트 칸에 change 핸들러가
  // 붙을 때까지 기다린다(app.js 최상위는 동기 실행이라 이게 붙었으면 초기화가 다 끝난 것).
  await win.waitForFunction(
    () => typeof document.getElementById('set-prompt-common')?.onchange === 'function',
    null, { timeout: 20000 });
  await setStorage(app, storageDir);
  return { app, win };
}

// 설정창은 반드시 openSettings 경로로 연다. showModal()로 곧장 띄우는 다른 spec의 지름길은
// 값을 채우는 코드를 건너뛰어 프롬프트 칸이 빈 채로 열린다 — 여기서는 그 채우기가 시험 대상이다.
async function openSettings(app, win) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:settings'));
  await win.waitForSelector('#settings-dialog[open]', { timeout: 10000 });
}

const getPrompts = (win) => win.evaluate(async () => (await window.wcompare.settings.get()).summaryPrompts);
const getDefaults = (win) => win.evaluate(() => window.wcompare.summary.promptDefaults());

// textarea 저장은 change(포커스 상실) 시점이다. fill이 change를 쏘지만, "포커스를 잃을 때"라는
// 설계 의도까지 태우려고 blur를 한 번 더 준다(같은 값이면 두 번 저장돼도 결과는 같다).
async function edit(win, sel, value) {
  await win.fill(sel, value);
  await win.locator(sel).blur();
}

test('설정창: 탭 3개가 있고 누른 탭의 패널만 보인다', async () => {
  const s = setup('tabs');
  const { app, win } = await launch(s);
  await openSettings(app, win);

  const general = win.locator('#set-panel-general');
  const translate = win.locator('#set-panel-translate');
  const prompts = win.locator('#set-panel-prompts');

  // 처음 열리는 탭은 index.html의 .on 클래스가 정한다 — 일반.
  await expect(general).toBeVisible();
  await expect(translate).toBeHidden();
  await expect(prompts).toBeHidden();
  await expect(win.locator('#set-tab-general')).toHaveClass(/on/);

  await win.click('#set-tab-translate');
  await expect(translate).toBeVisible();
  await expect(general).toBeHidden();
  await expect(prompts).toBeHidden();
  await expect(win.locator('#set-tab-translate')).toHaveClass(/on/);
  await expect(win.locator('#set-tab-general')).not.toHaveClass(/on/);
  // 번역 항목이 "보인다"까지 봐야 의미가 있다: selectOption/fill은 가시성을 요구하므로
  // 숨은 패널 안에 있으면 조작 자체가 타임아웃한다.
  await expect(win.locator('#set-translate-engine')).toBeVisible();
  await expect(win.locator('#set-claude-model')).toBeVisible();

  await win.click('#set-tab-prompts');
  await expect(prompts).toBeVisible();
  await expect(general).toBeHidden();
  await expect(translate).toBeHidden();
  await expect(win.locator('#set-prompt-common')).toBeVisible();

  // 하위 탭(Overview / 절별 요약 / 흐름도)도 같은 규칙이다.
  const sub = (k) => win.locator(`#set-prompt-panel-${k}`);
  await expect(sub('overview')).toBeVisible();
  await expect(sub('sections')).toBeHidden();
  await expect(sub('flow')).toBeHidden();

  await win.click('#set-prompt-tab-sections');
  await expect(sub('sections')).toBeVisible();
  await expect(sub('overview')).toBeHidden();
  await expect(win.locator('#set-prompt-sections-spec')).toBeVisible();

  await win.click('#set-prompt-tab-flow');
  await expect(sub('flow')).toBeVisible();
  await expect(sub('sections')).toBeHidden();
  await expect(win.locator('#set-prompt-flow-tail')).toBeVisible();

  // 하위 탭을 옮겨도 바깥 탭은 그대로다(두 pickTab이 서로를 건드리지 않는다).
  await expect(prompts).toBeVisible();
  await expect(general).toBeHidden();

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('요약 프롬프트 탭: 7칸 모두 내장 기본 프롬프트 원문으로 채워져 열린다', async () => {
  const s = setup('defaults');
  const { app, win } = await launch(s);
  await openSettings(app, win);
  await win.click('#set-tab-prompts');

  const defs = await getDefaults(win);
  // IPC가 7칸을 다 돌려주는지부터 본다 — 한 칸이라도 빠지면 그 칸은 빈 화면으로 열린다.
  expect(Object.keys(defs).sort()).toEqual(FIELDS.map(([, k]) => k).sort());

  for (const [sel, key] of FIELDS) {
    const v = await win.inputValue(sel);
    expect(v.length, `${key} 칸이 비어 있다`).toBeGreaterThan(0);
    expect(v, `${key} 칸이 기본값과 다르다`).toBe(defs[key]);
  }
  // 값의 정체가 맞는지 한 군데는 실제 문구로 못 박는다(빈 문자열 7개를 서로 비교해도 위 단언은 통과한다).
  expect(await win.inputValue('#set-prompt-common')).toContain('반드시 한국어로 답한다');
  expect(await win.inputValue('#set-prompt-flow-spec')).toContain('mermaid');

  // 화면만 채웠을 뿐 저장은 여전히 ''다 — 손대지 않은 사용자에게 지금 문구가 박제되면 안 된다.
  expect(await getPrompts(win)).toEqual({
    common: '', overviewSpec: '', overviewTail: '', sectionsSpec: '', sectionsTail: '', flowSpec: '', flowTail: '',
  });

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('공통 규칙을 고치면 저장되고, 설정창을 닫았다 열어도·앱을 껐다 켜도 남는다', async () => {
  const s = setup('edit');
  const { app, win } = await launch(s);
  await openSettings(app, win);
  await win.click('#set-tab-prompts');

  const defs = await getDefaults(win);
  const mine = '너는 깐깐한 논문 리뷰어다.\n- 반드시 한국어로 답한다.\n- 근거 없는 주장은 쓰지 않는다.';
  await edit(win, '#set-prompt-common', mine);

  await expect.poll(async () => (await getPrompts(win)).common, { timeout: 5000 }).toBe(mine);
  // 다른 여섯 칸은 건드리지 않았으므로 여전히 ''여야 한다(patch가 형제 칸을 덮어쓰지 않는다).
  const after = await getPrompts(win);
  expect(after.overviewSpec).toBe('');
  expect(after.flowTail).toBe('');

  // 닫았다 다시 연다 — 저장된 override가 화면에 그대로 돌아와야 한다.
  await win.click('#settings-close');
  await expect(win.locator('#settings-dialog')).not.toHaveAttribute('open', '');
  await openSettings(app, win);
  await win.click('#set-tab-prompts');
  expect(await win.inputValue('#set-prompt-common')).toBe(mine);
  // 고치지 않은 칸은 여전히 기본값 원문을 보여준다(저장은 '', 화면은 원문).
  expect(await win.inputValue('#set-prompt-overview-spec')).toBe(defs.overviewSpec);

  // 앱을 껐다 켜도 남는다 — userData/settings.json에 실제로 쓰였다는 뜻.
  await app.close();
  const again = await launch(s);
  await openSettings(again.app, again.win);
  await again.win.click('#set-tab-prompts');
  expect((await getPrompts(again.win)).common).toBe(mine);
  expect(await again.win.inputValue('#set-prompt-common')).toBe(mine);

  await again.app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test("'기본값' 버튼: 화면은 원문으로 되돌리고 저장은 ''로 비운다", async () => {
  const s = setup('reset');
  const { app, win } = await launch(s);
  await openSettings(app, win);
  await win.click('#set-tab-prompts');

  const defs = await getDefaults(win);
  await edit(win, '#set-prompt-common', '엉뚱한 지시문');
  // 흐름도 칸은 하위 탭 안에 있다 — 먼저 그 탭을 열지 않으면 fill이 가시성 검사에서 멈춘다.
  await win.click('#set-prompt-tab-flow');
  await edit(win, '#set-prompt-flow-tail', '엉뚱한 마무리');
  await expect.poll(async () => (await getPrompts(win)).common, { timeout: 5000 }).toBe('엉뚱한 지시문');

  // 공통 규칙만 되돌린다 — 짝이 맞는 칸 하나만 건드리는지 함께 본다.
  // (공통 규칙 칸은 하위 탭 바깥이라 흐름도 탭이 열린 채로도 보인다.)
  await win.click('.set-prompt-reset[data-key="common"]');
  expect(await win.inputValue('#set-prompt-common')).toBe(defs.common);
  await expect.poll(async () => (await getPrompts(win)).common, { timeout: 5000 }).toBe('');
  expect((await getPrompts(win)).flowTail).toBe('엉뚱한 마무리'); // 다른 칸은 그대로

  // 하위 탭 안의 버튼도 같은 방식으로 짝을 찾는다.
  await win.click('.set-prompt-reset[data-key="flowTail"]');
  expect(await win.inputValue('#set-prompt-flow-tail')).toBe(defs.flowTail);
  await expect.poll(async () => (await getPrompts(win)).flowTail, { timeout: 5000 }).toBe('');

  // 되돌린 뒤 다시 열어도 기본값 원문이다(빈 문자열이 화면까지 빈 칸으로 새지 않는다).
  await win.click('#settings-close');
  await openSettings(app, win);
  await win.click('#set-tab-prompts');
  expect(await win.inputValue('#set-prompt-common')).toBe(defs.common);

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

// 가짜 agy: 받은 프롬프트($2)를 그대로 파일로 남긴 뒤, pdf-summary.spec.js와 같은 규칙으로
// 종류를 갈라 고정 응답을 돌려준다. 세 종류가 동시에 돌므로 파일 이름은 PID로 나눈다
// (한 파일에 몰아 쓰면 12만자짜리 프롬프트끼리 뒤섞여 판독이 불가능해진다).
// 기록 폴더 경로는 env가 아니라 스크립트에 직접 박는다 — spawn 쪽 env 전달 방식에 기대지 않는다.
function stubAgyRecording(dir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(dir, 'agy');
  fs.writeFileSync(p, [
    '#!/bin/sh',
    'prompt="$2"',
    `printf '%s' "$prompt" > "${outDir}/$$.txt"`,
    'case "$prompt" in',
    '  *"흐름도를 mermaid"*)',
    "    printf '```mermaid\\nflowchart TD\\n  A[\"문제 제기\"] --> B[\"핵심 아이디어\"]\\n```\\n'",
    '    ;;',
    '  *"절 단위로 나누어"*)',
    "    printf '## 1. 서론\\n첫째 절 요약 본문.\\n'",
    '    ;;',
    '  *)',
    "    printf '**무엇을 푸는 문제인가**\\n한 줄짜리 개요 본문.\\n'",
    '    ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  return p;
}

test('고친 프롬프트가 실제 요약 CLI 인자에 실린다', async () => {
  const s = setup('argv');
  const pdf = path.join(s.dir, 'paper.pdf');
  fs.writeFileSync(pdf, makePdf(4, { height: 900, lines: 6 }));
  const outDir = path.join(s.dir, 'argv');
  const agy = stubAgyRecording(s.dir, outDir);

  const { app, win } = await launch(s, [pdf], { ...process.env, WCOMPARE_AGY: agy });
  await win.waitForSelector(`${L} canvas`, { timeout: 20000 });

  // 공통 규칙과 Overview 마무리 지시를 눈에 띄는 문구로 갈아 끼운다.
  await openSettings(app, win);
  await win.click('#set-tab-prompts');
  const MARK_COMMON = 'WCTEST-COMMON-7f3a 이 문장은 공통 규칙 자리에서 왔다.';
  const MARK_TAIL = 'WCTEST-TAIL-7f3a 이 문장은 Overview 마무리 자리에서 왔다.';
  await edit(win, '#set-prompt-common', MARK_COMMON);
  await edit(win, '#set-prompt-overview-tail', MARK_TAIL);
  await expect.poll(async () => (await getPrompts(win)).overviewTail, { timeout: 5000 }).toBe(MARK_TAIL);
  await win.click('#settings-close');

  // 요약을 실제로 돌린다(가짜 CLI가 프롬프트를 받아 적는다).
  await win.click('#btn-layout-summary');
  await win.click(`${S} .sum-empty-go`);
  await expect(win.locator(`${S} .sum-pane[data-kind=overview]`))
    .toContainText('한 줄짜리 개요 본문', { timeout: 25000 });
  await expect.poll(() => fs.readdirSync(outDir).length, { timeout: 25000 }).toBe(3); // overview/sections/flow

  const seen = fs.readdirSync(outDir).map((f) => fs.readFileSync(path.join(outDir, f), 'utf8'));
  // 공통 규칙은 세 종류 모두에 실린다.
  for (const prompt of seen) {
    expect(prompt).toContain(MARK_COMMON);
    // 갈아 끼운 것이지 덧붙인 것이 아니다 — 기본 공통 규칙의 첫 문장이 남아 있으면 안 된다.
    expect(prompt).not.toContain('너는 학술 논문을 정확하게 읽고 한국어로 정리해 주는 조수다.');
  }
  // 마무리 지시는 그 종류(overview)에만 실린다.
  expect(seen.filter((p) => p.includes(MARK_TAIL))).toHaveLength(1);

  const overview = seen.find((p) => p.includes(MARK_TAIL));
  // 고치지 않은 칸은 기본값 그대로 간다.
  expect(overview).toContain('[할 일] 이 논문 전체를 최대한 간략히 요약한다.');
  // 코드가 쥐고 있는 부분은 프롬프트를 아무리 고쳐도 그대로 붙는다.
  expect(overview).toContain('[논문 제목]');
  expect(overview).toContain('[본문]');
  // 마무리 지시는 본문 뒤, 즉 맨 끝에 온다(순서가 뒤집히면 긴 본문에 지시가 묻힌다).
  expect(overview.indexOf(MARK_TAIL)).toBeGreaterThan(overview.indexOf('[본문]'));
  expect(overview.trimEnd().endsWith(MARK_TAIL)).toBe(true);

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('단축키 캡처 중 탭을 옮겨도 프롬프트 칸에 타자할 수 있다', async () => {
  // 회귀 감시: 캡처 중에는 document capture 단계 리스너가 모든 키를 삼킨다. 예전에는 캡처를
  // 켠 채 다른 탭으로 가면 그 상태가 그대로 남아, 프롬프트 칸에 아무리 쳐도 한 글자도 안
  // 들어가고(⌘V는 붙여넣기 대신 단축키로 저장) "키 입력 대기…" 표시는 숨은 탭 안이라 단서도
  // 없었다. pickTab이 캡처를 끝내는 것이 고침이다.
  const s = setup('capture');
  const { app, win } = await launch(s);
  await openSettings(app, win);

  await win.locator('#shortcut-rows .sc-row [data-role=change]').first().click();
  const keyBox = win.locator('#shortcut-rows .sc-row [data-role=key]').first();
  await expect(keyBox).toHaveClass(/capturing/);

  await win.click('#set-tab-prompts');
  await expect(keyBox).not.toHaveClass(/capturing/); // 탭 전환이 캡처를 끝냈다

  // 이제 키가 삼켜지지 않는다 — 타자가 실제로 칸에 들어간다.
  await win.click('#set-prompt-common');
  await win.keyboard.type('CAPTURE-REGRESSION');
  await expect(win.locator('#set-prompt-common')).toHaveValue(/CAPTURE-REGRESSION/);

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('툴바 끝의 톱니 버튼으로 설정창이 열린다', async () => {
  // 톱니는 menu:settings와 같은 openSettings 경로를 타야 한다 — showModal() 지름길로 열면
  // 값 채우기를 건너뛰어 프롬프트 칸이 빈 채 열리는 창이 된다. "칸이 채워져 있다"가 그 감시선이다.
  const s = setup('gear');
  const { app, win } = await launch(s);

  await win.click('#btn-settings');
  await win.waitForSelector('#settings-dialog[open]', { timeout: 10000 });
  expect((await win.inputValue('#set-prompt-common')).length).toBeGreaterThan(0);

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});
