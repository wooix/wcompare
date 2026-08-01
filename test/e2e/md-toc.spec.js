// test/e2e/md-toc.spec.js — Markdown TOC 모드(diff): 토글·헤딩 렌더·라인 이동·왼쪽 전용(오른쪽 미표시)·비활성.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

// e2e 공통: 렌더러가 localStorage에 남기는 UI 상태(보기 형태 wc-layout, Night, Dict)가
// spec 사이로 새지 않도록 userData를 이 파일 전용 임시 폴더로 격리한다. 공유 프로필을 쓰면
// 요약 패널이 열린 채로 시작해 pane 폭이 달라지고, 배율·스크롤을 재는 테스트가 실행 순서에 따라 흔들린다.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ud-'));

// 헤딩 사이에 filler 본문을 넣어 아래쪽 헤딩 클릭 시 실제로 스크롤이 일어나게 한다.
const filler = Array(15).fill('lorem ipsum body line').join('\n');
const MD_A = ['# Alpha', filler, '## Beta', filler, '### Gamma', filler, '## Delta', filler].join('\n');
const MD_B = ['# One', '## Two', '## Three'].join('\n');
const deltaLine = MD_A.split('\n').findIndex((l) => l === '## Delta') + 1;

function tmp(name, body) {
  const p = path.join(os.tmpdir(), `wc-mdtoc-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.${name.endsWith('txt') ? 'txt' : 'md'}`);
  fs.writeFileSync(p, body);
  return p;
}
const valueHas = (win, side, s) => win.waitForFunction(
  ([sd, str]) => window.__wc?.editorApi.getValue(sd).includes(str), [side, s], { timeout: 20000 });

test('MD TOC: 토글로 드로어가 뜨고 헤딩을 보여주며 항목 클릭 시 해당 라인으로 이동한다', async () => {
  const a = tmp('a', MD_A);
  const b = tmp('b', MD_B);
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'Alpha');
  await valueHas(win, 'right', 'Three');

  // 두 파일 모두 markdown → 버튼 활성화
  await expect(win.locator('#btn-toc')).toBeEnabled();

  // 토글 → 라벨 "TOC ✓", 왼쪽 드로어만 표시(TOC는 왼쪽 전용 — 오른쪽 드로어는 없앴다)
  await win.click('#btn-toc');
  await expect(win.locator('#btn-toc')).toHaveText('TOC ✓');
  await expect(win.locator('#md-toc-left')).toBeVisible();
  // 회귀 감시: 오른쪽 파일도 markdown(One/Two/Three)이지만 드로어는 왼쪽 하나뿐이다.
  // toBeHidden()으로 쓰면 안 된다 — Playwright는 "붙어 있지 않은 요소"도 hidden으로 치므로,
  // #md-toc-right를 삭제한 지금은 오른쪽 드로어를 딴 이름(.md-toc.right 등)으로 되살려도
  // 그 단언이 그대로 통과한다. 드로어의 '개수'를 세야 이름과 무관하게 감시가 선다.
  await expect(win.locator('.md-toc')).toHaveCount(1);
  await expect(win.locator('#md-toc-right')).toHaveCount(0);

  // 왼쪽 4개(Alpha/Beta/Gamma/Delta). 드로어가 하나뿐이니 전체 항목 수도 그 넷이 전부다.
  await expect(win.locator('#md-toc-left .toc-item')).toHaveCount(4);
  await expect(win.locator('.md-toc .toc-item')).toHaveCount(4);

  // 왼쪽 드로어는 #editor보다 왼쪽에 붙는다(DOM 순서). 오른쪽 드로어는 표시되지 않으므로
  // boundingBox() 비교에서 제외한다(숨김/미부착 요소는 boundingBox()가 null이라 비교 자체가 안 된다).
  const edBox = await win.locator('#editor').boundingBox();
  const lBox = await win.locator('#md-toc-left').boundingBox();
  expect(lBox.x).toBeLessThan(edBox.x);

  // "Delta" 클릭 → 왼쪽 에디터 커서가 해당 라인으로, 스크롤도 내려간다
  await win.locator('#md-toc-left .toc-item', { hasText: 'Delta' }).click();
  await expect.poll(() => win.evaluate(() => {
    const p = window.__wc.editorApi.innerOf('left').getPosition();
    return p ? p.lineNumber : 0;
  }), { timeout: 5000 }).toBe(deltaLine);
  expect(await win.evaluate(() => window.__wc.editorApi.innerOf('left').getScrollTop())).toBeGreaterThan(0);

  // 다시 토글 → 드로어 숨김. 드로어는 여전히 왼쪽 하나뿐이다(숨겼다고 개수가 변하진 않는다).
  await win.click('#btn-toc');
  await expect(win.locator('#md-toc-left')).toBeHidden();
  await expect(win.locator('.md-toc')).toHaveCount(1);

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('MD TOC: markdown 파일이 한쪽도 없으면 버튼이 비활성화된다', async () => {
  const a = tmp('txt', 'plain text left\n');
  const b = tmp('txt', 'plain text right\n');
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'plain text left');
  await valueHas(win, 'right', 'plain text right');
  await expect(win.locator('#btn-toc')).toBeDisabled();

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

test('MD TOC: 왼쪽만 markdown이면 왼쪽 드로어만 보인다(오른쪽은 항상 숨김)', async () => {
  const a = tmp('a', MD_A);
  const b = tmp('txt', 'plain right side\n');
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'Alpha');
  await valueHas(win, 'right', 'plain right side');

  await expect(win.locator('#btn-toc')).toBeEnabled(); // 왼쪽이 markdown
  await win.click('#btn-toc');
  await expect(win.locator('#md-toc-left')).toBeVisible();
  await expect(win.locator('.md-toc')).toHaveCount(1); // 드로어는 왼쪽 하나뿐(왼쪽 전용화)

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});

// 회귀 감시: 예전 코드는 "markdown인 side에 그 side의 TOC가 붙는다"는 규칙이라 오른쪽만
// markdown이면 오른쪽에 자체 TOC 드로어가 떴다. 왼쪽 전용화 이후에는 이 경우에도 오른쪽엔
// 절대 TOC가 뜨지 않아야 한다 — 버튼 활성 여부(통합 담당의 anyMd 판단)와 무관하게 성립해야 한다.
test('MD TOC: 오른쪽만 markdown이어도 오른쪽에는 TOC가 뜨지 않는다', async () => {
  const a = tmp('txt', 'plain left side\n');
  const b = tmp('b', MD_B);
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${USER_DATA}`, a, b] });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await valueHas(win, 'left', 'plain left side');
  await valueHas(win, 'right', 'One');

  // 드로어가 왼쪽뿐이므로 버튼도 "왼쪽이 markdown일 때"만 열린다 — 오른쪽만 markdown인 지금은
  // 눌러도 아무 일이 없을 버튼이라 아예 잠겨야 한다. 이것이 이 테스트의 본 단언이다
  // (예전 규칙이었다면 여기서 버튼이 열리고 오른쪽 드로어가 떴다).
  await expect(win.locator('#btn-toc')).toBeDisabled();
  // 그리고 드로어는 어떤 상태에서도 왼쪽 하나뿐이다. 개수로 세야 이름을 바꿔 되살려도 잡힌다.
  await expect(win.locator('.md-toc')).toHaveCount(1);
  await expect(win.locator('.md-toc .toc-item')).toHaveCount(0); // 왼쪽이 비-md라 항목도 없다

  await app.close();
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
});
