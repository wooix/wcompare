// test/e2e/dict-shortcut.spec.js — 사전 외부앱 위임(diff 모드):
// Dict OFF 게이트 / ON 시 1회 트리거 / 같은 선택 중복 전송 방지.
// 실제 osascript·외부 앱은 부르지 않는다(WCOMPARE_DICT_FAKE로 main이 성공만 흉내).
// 호출 횟수는 렌더러 훅 window.__wc.dictCalls()로 센다 — contextBridge 객체는 동결되어
// 페이지에서 window.wcompare.dict.external을 스텁으로 덮어쓸 수 없기 때문(접근 방식 명시).
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');
const ENV = { ...process.env, WCOMPARE_DICT_FAKE: '1' };

// 3행·5행 모두 정확히 "apple" — 서로 다른 선택 이벤트가 같은 텍스트를 내므로
// lastSent 중복 방지 로직을 실제로 밟게 된다(단순 no-op 이벤트가 아니라).
const MD_LEFT = ['# Dict test', '', 'apple', '', 'apple'].join('\n');

function tmpMd(body) {
  const p = path.join(os.tmpdir(), `wc-dictx-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(p, body);
  return p;
}
const valueHas = (win, side, s) => win.waitForFunction(
  ([sd, str]) => window.__wc?.editorApi.getValue(sd).includes(str), [side, s], { timeout: 20000 });

async function selectLine(win, line) {
  await win.evaluate((ln) => {
    const ed = window.__wc.editorApi.innerOf('left');
    const endCol = ed.getModel().getLineMaxColumn(ln);
    ed.setSelection({ startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: endCol });
  }, line);
}
async function setDict(win, want) {
  const on = /ON/.test((await win.locator('#btn-dict').textContent()) || '');
  if (on !== want) await win.click('#btn-dict');
  await expect(win.locator('#btn-dict')).toHaveText(want ? 'Dict: ON' : 'Dict: OFF');
}
const dictCalls = (win) => win.evaluate(() => window.__wc.dictCalls());

async function launch() {
  const a = tmpMd(MD_LEFT);
  const b = tmpMd('plain right side\n');
  const app = await electron.launch({ args: [MAIN, a, b], env: ENV });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'apple');
  return { app, win, files: [a, b] };
}

test('Dict OFF에서는 텍스트를 선택해도 external을 호출하지 않는다', async () => {
  const { app, win, files } = await launch();
  await setDict(win, false);

  await selectLine(win, 3);
  await win.waitForTimeout(700); // 디바운스(300ms)+IPC가 지나도록 넉넉히 기다린 뒤
  expect(await dictCalls(win)).toBe(0);

  await app.close();
  files.forEach((f) => fs.rmSync(f, { force: true }));
});

test('Dict ON에서 선택하면 external 1회, 같은 선택 반복은 추가 호출이 없다', async () => {
  const { app, win, files } = await launch();
  await setDict(win, true);

  // ② 첫 선택 → 1회 호출
  await selectLine(win, 3);
  await win.waitForFunction(() => window.__wc.dictCalls() === 1, null, { timeout: 8000 });

  // ③ 같은 텍스트("apple")를 다른 행에서 다시 선택 → lastSent 중복 방지로 추가 호출 없음
  await selectLine(win, 5);
  await win.waitForTimeout(700);
  expect(await dictCalls(win)).toBe(1);

  await app.close();
  files.forEach((f) => fs.rmSync(f, { force: true }));
});
