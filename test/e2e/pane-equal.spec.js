// test/e2e/pane-equal.spec.js — 비교 창 좌우 균등.
//
// 요구는 "좌우가 세로 스크롤바까지 포함해 항상 같은 폭"이고, 그렇게 해야 하는 이유는
// 폭이 다르면 같은 문장이 좌우에서 다른 지점에서 접히기 때문이다. 그래서 폭만 재고
// 끝내지 않고, 마지막에 실제로 접히는 자리가 같은지를 직접 본다 — 그게 요구의 목적이다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

function files(tag, left, right) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-eq-${tag}-`));
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, left);
  fs.writeFileSync(b, right);
  return [a, b];
}

const launch = (args, udBase = 'wc-eq-ud-') => electron.launch({
  args: [MAIN, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), udBase))}`, ...args],
});

const ready = async (app) => {
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
  await win.waitForTimeout(700); // 첫 배치 + 균등 맞춤이 끝나기를 기다린다
  return win;
};

const setSize = (app, w, h) => app.evaluate(
  ({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), [w, h],
);

// 좌우 각각의 창 폭과 글자 칸 폭, 그리고 화면에 그려진 줄들.
//
// width  — .editor.original / .editor.modified 의 폭. Monaco가 레이아웃 계산 결과를
//          그대로 넣는 값이고, 세로 스크롤바와 개요 눈금이 이 안에 들어 있다.
// content— .monaco-scrollable-element 의 clientWidth. 여백(글리프·줄번호)과 스크롤바를
//          뺀, 글자가 실제로 놓이는 칸이다. 접히는 자리를 정하는 건 이 값이다.
// rows   — 그려진 줄들의 글자. DOM 순서가 아니라 top 좌표로 정렬해야 한다. Monaco는
//          스크롤하며 줄 엘리먼트를 재활용해서 문서 순서와 DOM 순서가 어긋난다.
const geom = (win) => win.evaluate(() => {
  const root = document.querySelector('.monaco-diff-editor');
  const side = (s) => {
    const ed = root.querySelector('.editor.' + s);
    const sc = ed.querySelector('.monaco-scrollable-element');
    return {
      width: Math.round(ed.getBoundingClientRect().width),
      content: sc ? sc.clientWidth : 0,
      rows: [...ed.querySelectorAll('.view-line')]
        .map((l) => ({ top: Math.round(l.getBoundingClientRect().top), text: l.textContent }))
        .sort((a, b) => a.top - b.top)
        .map((r) => r.text),
    };
  };
  return { root: Math.round(root.getBoundingClientRect().width), left: side('original'), right: side('modified') };
});

// 분할선은 정수 픽셀로 내림되므로, 나눌 폭이 홀수면 1px은 어떤 비율로도 남는다.
const SAME = 1;

test('기본 상태에서 좌우 창이 같은 폭이다', async () => {
  const app = await launch(files('base', 'hello\n', 'world\n'));
  try {
    const g = await geom(await ready(app));
    // 손대지 않은 Monaco는 여기서 590 대 625로 벌어진다 — 가운데 거터 35px 때문이다.
    expect(Math.abs(g.left.width - g.right.width),
      `창 폭 ${g.left.width} vs ${g.right.width}`).toBeLessThanOrEqual(SAME);
    // 폭이 같아도 여백이 다르면 글자 칸이 어긋난다. 왼쪽에만 켜지는 글리프 여백(18px)을
    // 오른쪽에도 켜 두었기 때문에 여기까지 맞아야 한다.
    expect(Math.abs(g.left.content - g.right.content),
      `글자 칸 ${g.left.content} vs ${g.right.content}`).toBeLessThanOrEqual(SAME);
  } finally { await app.close(); }
});

test('창 크기를 바꿔도 자동으로 다시 맞춘다', async () => {
  const app = await launch(files('resize', 'hello\n', 'world\n'));
  try {
    const win = await ready(app);
    // 홀수·짝수를 섞는다. 나눌 폭의 홀짝에 따라 1px이 남을 수 있어서, 한 폭만 재면
    // 우연히 맞은 것을 통과로 착각한다.
    for (const w of [980, 1101, 1202, 1367, 1440]) {
      await setSize(app, w, 800);
      await win.waitForTimeout(450);
      const g = await geom(win);
      expect(Math.abs(g.left.width - g.right.width),
        `창 ${w}px에서 ${g.left.width} vs ${g.right.width}`).toBeLessThanOrEqual(SAME);
      expect(Math.abs(g.left.content - g.right.content),
        `창 ${w}px 글자 칸 ${g.left.content} vs ${g.right.content}`).toBeLessThanOrEqual(SAME);
    }
  } finally { await app.close(); }
});

test('버튼으로 끄면 풀리고, 다시 누르면 강제로 맞춰진다', async () => {
  const app = await launch(files('toggle', 'hello\n', 'world\n'));
  try {
    const win = await ready(app);
    const btn = win.locator('#btn-equal');
    await expect(btn).toHaveText('좌우균등: ON');

    await btn.click(); // 끈다 — Monaco 기본으로 돌아가 거터만큼 어긋나야 한다
    await expect(btn).toHaveText('좌우균등: OFF');
    await win.waitForTimeout(400);
    const off = await geom(win);
    expect(off.right.width - off.left.width,
      `끈 상태에서도 같으면 토글이 아무 일도 안 한 것이다 (${off.left.width} vs ${off.right.width})`)
      .toBeGreaterThan(SAME);

    await btn.click(); // 다시 켠다 — 이게 "수동으로 강제 설정"이다
    await expect(btn).toHaveText('좌우균등: ON');
    await win.waitForTimeout(400);
    const on = await geom(win);
    expect(Math.abs(on.left.width - on.right.width),
      `다시 켠 뒤 ${on.left.width} vs ${on.right.width}`).toBeLessThanOrEqual(SAME);
  } finally { await app.close(); }
});

test('다른 옵션을 건드려도 좌우 폭이 풀리지 않는다', async () => {
  // Monaco의 diff 옵션 검증기는 splitViewDefaultRatio가 빠져 있으면 현재 값이 아니라
  // 상수 0.5로 되돌린다 — 그 목록에서 이 키만 그렇다(diffEditorOptions.js). 그래서
  // 줄바꿈이나 공백 표시처럼 아무 상관 없는 토글 하나로 방금 맞춰 둔 창이 다시
  // 어긋난다. 창 크기를 바꾸지 않고 재는 것이 이 테스트의 핵심이다 — 리사이즈는
  // 균등을 다시 걸어 주므로, 그 뒤에 재면 결함이 가려진다.
  const app = await launch(files('sticky', 'hello\n', 'world\n'));
  try {
    const win = await ready(app);
    for (const [label, id] of [['줄바꿈', '#btn-wrap'], ['공백 표시', '#btn-ws']]) {
      await win.locator(id).click();
      await win.waitForTimeout(450);
      const g = await geom(win);
      expect(Math.abs(g.left.width - g.right.width),
        `${label}을 켠 뒤 ${g.left.width} vs ${g.right.width}`).toBeLessThanOrEqual(SAME);
    }
  } finally { await app.close(); }
});

test('같은 긴 줄은 좌우에서 같은 자리에서 접힌다', async () => {
  // 이 기능이 있어야 하는 이유 그 자체다. 좌우에 똑같은 긴 줄을 넣으면 접히는 자리도
  // 똑같아야 한다 — 한 글자라도 어긋나면 눈이 두 줄을 나란히 읽을 수 없다.
  const long = '설정 파일에서 읽어 들인 값을 검사하는 절차는 다음과 같습니다. '.repeat(8)
    + 'wcompare-gateway/localhost:8080/retries=3/timeout=5000/tags=[alpha,beta,gamma]';
  const app = await launch(files('wrap', `${long}\n`, `${long}\n`));
  try {
    const win = await ready(app);
    await win.locator('#btn-wrap').click(); // 줄바꿈 켜기
    await win.waitForTimeout(500);

    // null은 "창 크기를 그대로 두고" 이다. 반드시 첫 회차여야 한다 — 리사이즈가 균등을
    // 다시 걸어 주기 때문에, 크기를 바꾼 뒤에만 재면 줄바꿈 토글이 비율을 풀어 버리는
    // 결함을 통째로 놓친다. 실제로 그렇게 놓쳐서 배포본에서 드러났다.
    for (const w of [null, 980, 1101, 1202, 1367, 1440]) {
      if (w) { await setSize(app, w, 800); await win.waitForTimeout(500); }
      const at = w ? `창 ${w}px` : '기본 창 폭';
      const g = await geom(win);
      expect(g.left.rows.length, `${at}에서 접히지 않았다`).toBeGreaterThan(1);
      expect(g.left.rows, `${at}에서 접히는 자리가 어긋난다`).toEqual(g.right.rows);
    }
  } finally { await app.close(); }
});

test('좌우균등을 끄면 접히는 자리가 어긋난다 — 이 기능이 있어야 하는 이유', async () => {
  // 위 테스트가 저절로 통과한 게 아님을 못 박는 증인이다. 균등을 끄면 Monaco 기본대로
  // 왼쪽 글자 칸이 거터(35px)와 글리프 여백만큼 좁아지고, 같은 문장인데도 좌우가 다른
  // 지점에서 접힌다. 언젠가 Monaco가 거터 몫을 양쪽에서 나눠 가지도록 고치면 이 테스트가
  // 깨질 텐데, 그때는 이 기능이 더 필요 없어졌다는 뜻이니 그것대로 알아야 할 신호다.
  const long = '설정 파일에서 읽어 들인 값을 검사하는 절차는 다음과 같습니다. '.repeat(8);
  const app = await launch(files('witness', `${long}\n`, `${long}\n`));
  try {
    const win = await ready(app);
    await win.locator('#btn-wrap').click();
    await win.locator('#btn-equal').click(); // 끈다
    await win.waitForTimeout(600);
    const g = await geom(win);
    expect(g.left.rows.length).toBeGreaterThan(1);
    expect(g.left.rows).not.toEqual(g.right.rows);
  } finally { await app.close(); }
});

test('좌우균등 설정은 새 창에서도 유지된다', async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-eq-persist-'));
  const [a, b] = files('persist', 'hello\n', 'world\n');
  const first = await electron.launch({ args: [MAIN, `--user-data-dir=${ud}`, a, b] });
  try {
    const win = await ready(first);
    await win.locator('#btn-equal').click(); // 끄고 저장
    await expect(win.locator('#btn-equal')).toHaveText('좌우균등: OFF');
    await win.waitForTimeout(400);
  } finally { await first.close(); }

  const second = await electron.launch({ args: [MAIN, `--user-data-dir=${ud}`, a, b] });
  try {
    const win = await ready(second);
    await expect(win.locator('#btn-equal')).toHaveText('좌우균등: OFF');
  } finally { await second.close(); }
});
