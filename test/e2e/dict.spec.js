// test/e2e/dict.spec.js — 실시간 사전(diff 모드): 사전 히트/엔진 번역/OFF 게이트/ESC 닫힘.
// 실제 agy/claude 대신 가짜 엔진(WCOMPARE_DICT_ENGINE)과 소형 사전(WCOMPARE_DICT_FILE)을 주입한다.
// PDF 쪽 텍스트 선택 시뮬은 flaky해 생략하고, 선택을 결정적으로 넣을 수 있는 diff 쪽으로 검증한다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const ENGINE = path.join(__dirname, '..', 'fixtures', 'fake-dict-engine.sh');
const DICT = path.join(__dirname, '..', 'fixtures', 'dict-en-ko.json');
const ENV = { ...process.env, WCOMPARE_DICT_ENGINE: ENGINE, WCOMPARE_DICT_FILE: DICT };

// 3행 "apple"(사전 히트), 5행 긴 문장(4토큰 이상 → 엔진 번역).
const MD_LEFT = ['# Dict test', '', 'apple', '', 'this is a long english sentence'].join('\n');

function tmpMd(body) {
  const p = path.join(os.tmpdir(), `wc-dict-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(p, body);
  return p;
}
const valueHas = (win, side, s) => win.waitForFunction(
  ([sd, str]) => window.__wc?.editorApi.getValue(sd).includes(str), [side, s], { timeout: 20000 });

// 왼쪽 diff 에디터의 한 행 전체를 선택한다(API 선택 → onDidChangeCursorSelection 발화).
async function selectLine(win, line) {
  await win.evaluate((ln) => {
    const ed = window.__wc.editorApi.innerOf('left');
    const endCol = ed.getModel().getLineMaxColumn(ln);
    ed.setSelection({ startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: endCol });
  }, line);
}
// Dict 토글을 원하는 상태로 맞춘다(localStorage가 세션 간 남을 수 있어 라벨 기준으로 보정).
async function setDict(win, want) {
  const on = /ON/.test((await win.locator('#btn-dict').textContent()) || '');
  if (on !== want) await win.click('#btn-dict');
  await expect(win.locator('#btn-dict')).toHaveText(want ? 'Dict: ON' : 'Dict: OFF');
}

async function launch() {
  const a = tmpMd(MD_LEFT);
  const b = tmpMd('plain right side\n');
  const app = await electron.launch({ args: [MAIN, a, b], env: ENV });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'apple');
  return { app, win, files: [a, b] };
}

test('사전에 있는 단어는 뜻을, 긴 문장은 엔진 번역을 보여주고 ESC로 닫힌다', async () => {
  const { app, win, files } = await launch();
  const popup = win.locator('.wc-dict-popup');
  await setDict(win, true);

  // ① 사전 히트: "apple" → 사과 (품사 배지 noun)
  await selectLine(win, 3);
  await expect(popup).toBeVisible({ timeout: 8000 });
  await expect(popup).toContainText('사과');
  await expect(popup.locator('.wc-dict-pos')).toHaveText('noun');

  // ② 4토큰 이상 문장 → 가짜 엔진 번역
  await selectLine(win, 5);
  await expect(popup).toContainText('가짜 번역 결과', { timeout: 8000 });

  // ④ ESC로 닫힘
  await win.keyboard.press('Escape');
  await expect(popup).toBeHidden();

  await app.close();
  files.forEach((f) => fs.rmSync(f, { force: true }));
});

test('Dict OFF에서는 단어를 선택해도 팝업이 뜨지 않는다', async () => {
  const { app, win, files } = await launch();
  const popup = win.locator('.wc-dict-popup');
  await setDict(win, false);

  await selectLine(win, 3);
  await win.waitForTimeout(700); // 디바운스(300ms)+IPC가 지나도록 넉넉히 기다린 뒤
  await expect(popup).toBeHidden();

  await app.close();
  files.forEach((f) => fs.rmSync(f, { force: true }));
});

test('한글이 섞인 선택은 무시한다(영→한 게이트)', async () => {
  const a = tmpMd(['# g', '', 'apple 사과 mixed', ''].join('\n'));
  const b = tmpMd('plain\n');
  const app = await electron.launch({ args: [MAIN, a, b], env: ENV });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'mixed');
  const popup = win.locator('.wc-dict-popup');
  await setDict(win, true);

  await selectLine(win, 3); // "apple 사과 mixed" — 한글 포함 → 무시
  await win.waitForTimeout(700);
  await expect(popup).toBeHidden();

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});
