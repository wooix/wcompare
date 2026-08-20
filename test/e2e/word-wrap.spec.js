// test/e2e/word-wrap.spec.js — 비교 모드의 줄바꿈 토글.
//
// 요구는 "긴 줄이라도 가로로 스크롤하지 않고 차이가 한눈에 보일 것"이고, 접히는 줄은
// 새 줄이 아니라 같은 한 줄이어야 한다. 그래서 세 가지를 직접 본다:
//   접혔는가        — 렌더된 .view-line 개수가 1을 넘는가
//   한 줄 그대로인가 — 여백의 줄 번호가 여전히 하나인가(진짜 개행이면 둘 이상이 된다)
//   넘치지 않는가    — 어떤 줄도 편집기 폭을 넘지 않는가
//
// 예시 케이스 셋은 접을 자리가 넉넉한 것부터 아예 없는 것까지 걸쳐 고른다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

// 한 줄짜리 파일을 만든다. 끝에 개행을 붙이지 않는 이유는 논리 줄이 정확히 하나여야
// "접힌 줄"과 "새 줄"을 개수로 구분할 수 있기 때문이다.
function oneLineFiles(tag, left, right) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-wrap-${tag}-`));
  const a = path.join(dir, `a${tag === 'json' ? '.json' : '.txt'}`);
  const b = path.join(dir, `b${tag === 'json' ? '.json' : '.txt'}`);
  fs.writeFileSync(a, left);
  fs.writeFileSync(b, right);
  return [a, b];
}

// --- 예시 케이스 3종 -------------------------------------------------------
// 1) 미니파이 JSON 한 줄. 쉼표·따옴표가 많아 접을 자리가 넉넉하다. 값 두 개만 다르다.
const jsonLine = (port, retries) => `{"service":"wcompare-gateway","host":"localhost","port":${port},"retries":${retries},"timeout":5000,"debug":false,"tags":["alpha","beta","gamma","delta"],"upstream":{"scheme":"https","path":"/api/v1/resources","keepAlive":true},"limits":{"rps":1200,"burst":2400,"concurrency":64}}`;

// 2) 끊을 자리가 아예 없는 긴 토큰. 공백도 구분자도 없어 단어 경계로는 접을 수 없다 —
//    이런 줄도 접히는지가 관건이다(안 접히면 가로 스크롤이 그대로 남는다).
const token = (tail) => `sha256:${'9f2c4ab7e10d83615c7a0be4d29f8martin'.repeat(6)}${tail}`;

// 3) 긴 한국어 산문. 글자 폭이 ASCII와 달라 폭 계산이 어긋나기 쉬운 쪽이다.
const prose = (word) => `이 문서는 비교 모드에서 아주 긴 한 줄이 어떻게 보이는지를 확인하기 위한 예시입니다. `
  + `줄이 길어지면 가로 스크롤을 오래 해야 해서 어디가 달라졌는지 한눈에 들어오지 않습니다. `
  + `그래서 줄바꿈을 켜면 화면 폭에서 접히고, 접힌 줄은 새로운 줄이 아니라 ${word} 같은 줄로 남아야 합니다. `
  + `저장했을 때 파일 내용이 달라지지 않아야 하고, 줄 번호도 하나 그대로여야 합니다.`;

const CASES = [
  { tag: 'json', label: '미니파이 JSON 한 줄',
    left: jsonLine(8080, 3), right: jsonLine(9090, 5) },
  { tag: 'token', label: '끊을 자리 없는 긴 토큰',
    left: token('AAAA'), right: token('BBBB') },
  { tag: 'prose', label: '긴 한국어 산문',
    left: prose('동일한'), right: prose('똑같은') },
];

const launch = (files) => electron.launch({
  args: [MAIN,
         `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'wc-wrap-ud-'))}`,
         ...files],
});

// 오른쪽(modified) 편집기에서 재는 값들. Monaco는 보이는 줄만 DOM에 그리므로
// 개수는 "최소 이만큼"의 의미로만 쓴다.
//
// 글자 폭은 반드시 .view-line이 아니라 그 안의 span에서 재야 한다. Monaco의 CSS는
// `.view-line { position:absolute; width:100% }`이고 글자는 `.view-line > span`에
// 절대 위치로 놓인다 — 즉 .view-line의 rect는 스크롤 폭(컨테이너)이지 글자 폭이 아니다.
// 여기서 한 번 헛짚었다: 한국어 줄이 1945px인데 .view-line은 579px로 재여, 넘치지
// 않는 것처럼 보였다.
//
// 양쪽(original/modified)을 따로 잰다. 비교 도구에서 한쪽만 접히면 두 편집기의 줄 수가
// 어긋나 Monaco가 빗금 채움을 넣고, 정렬이 깨져 오히려 읽기 어려워진다.
const measure = (win, side = 'modified') => win.evaluate((s) => {
  const ed = document.querySelector(`.monaco-diff-editor .editor.${s}`);
  const lines = [...ed.querySelectorAll('.view-line')];
  const nums = [...ed.querySelectorAll('.margin-view-overlays .line-numbers')]
    .map((n) => n.textContent.trim()).filter(Boolean);
  return {
    rendered: lines.length,
    lineNumbers: nums,
    // 실제 글자 폭
    textWidth: Math.max(0, ...[...ed.querySelectorAll('.view-line > span')]
      .map((s) => s.getBoundingClientRect().width)),
    // 가로 스크롤 없이 보이는 영역의 폭
    areaWidth: ed.querySelector('.monaco-scrollable-element')?.clientWidth ?? 0,
    chars: lines[0]?.textContent.length ?? 0, // 진단용 — 글자가 실렸는지
  };
}, side);

for (const c of CASES) {
  test(`${c.label}: 줄바꿈을 켜면 접히고, 줄은 하나 그대로다`, async () => {
    const files = oneLineFiles(c.tag, c.left, c.right);
    const app = await launch(files);
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
      await win.waitForFunction(
        () => document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 0,
        { timeout: 20000 });

      // --- 꺼진 상태: 한 줄이 그대로 뻗어 편집기 밖으로 넘친다 ---
      const btn = win.locator('#btn-wrap');
      await expect(btn).toHaveText('줄바꿈: OFF');
      for (const side of ['original', 'modified']) {
        const off = await measure(win, side);
        expect(off.rendered, side).toBe(1);
        // 한 줄이 그대로 뻗어 보이는 영역을 넘는다 = 가로로 스크롤해야 하는 상태
        expect(off.textWidth, `${side} ${JSON.stringify(off)}`).toBeGreaterThan(off.areaWidth);
      }

      // --- 켠 상태 ---
      await btn.click();
      await expect(btn).toHaveText('줄바꿈: ON');
      await win.waitForFunction(
        () => document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 1,
        { timeout: 5000 });
      for (const side of ['original', 'modified']) {
        const on = await measure(win, side);
        expect(on.rendered, side).toBeGreaterThan(1);   // 양쪽 다 접혔다
        expect(on.lineNumbers, side).toEqual(['1']);    // 그래도 논리 줄은 하나
        // 어느 줄도 보이는 영역을 넘지 않는다 = 가로 스크롤이 사라졌다. 1px 반올림 여유.
        expect(on.textWidth, `${side} ${JSON.stringify(on)}`)
          .toBeLessThanOrEqual(on.areaWidth + 1);
      }

      // --- 다시 끄면 원래대로 ---
      await btn.click();
      await expect(btn).toHaveText('줄바꿈: OFF');
      for (const side of ['original', 'modified']) {
        await win.waitForFunction(
          (s) => document.querySelectorAll(`.monaco-diff-editor .editor.${s} .view-line`).length === 1,
          side, { timeout: 5000 });
      }
    } finally {
      await app.close();
    }
  });
}

test('줄바꿈은 문서를 건드리지 않는다 — 켜도 저장 대상이 되지 않는다', async () => {
  // 접기를 진짜 개행으로 구현하면 모델이 바뀌어 dirty가 되고, 모르는 사이에 파일이
  // 달라진다. 요구사항의 "문장을 끝내는 것이 아니라"가 바로 이 뜻이다.
  const files = oneLineFiles('dirty', jsonLine(8080, 3), jsonLine(9090, 5));
  const app = await launch(files);
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
    const before = await win.evaluate(() =>
      document.querySelector('.monaco-diff-editor .editor.modified').textContent);

    await win.locator('#btn-wrap').click();
    await expect(win.locator('#btn-wrap')).toHaveText('줄바꿈: ON');
    await win.waitForTimeout(300);

    // 디스크의 파일이 그대로다
    expect(fs.readFileSync(files[1], 'utf8')).toBe(jsonLine(9090, 5));
    // 글자도 그대로다(접힘은 그리기일 뿐이라 텍스트가 늘거나 줄지 않는다)
    const after = await win.evaluate(() =>
      document.querySelector('.monaco-diff-editor .editor.modified').textContent);
    expect(after.replace(/\s/g, '')).toBe(before.replace(/\s/g, ''));
  } finally {
    await app.close();
  }
});

test('줄바꿈 상태는 새 창에서도 유지된다', async () => {
  const files = oneLineFiles('persist', jsonLine(8080, 3), jsonLine(9090, 5));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-wrap-ud-'));
  const open = () => electron.launch({ args: [MAIN, `--user-data-dir=${ud}`, ...files] });

  const first = await open();
  try {
    const win = await first.firstWindow();
    await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
    await win.locator('#btn-wrap').click();
    await expect(win.locator('#btn-wrap')).toHaveText('줄바꿈: ON');
    await win.waitForTimeout(400); // 설정 저장은 비동기다
  } finally {
    await first.close();
  }

  const second = await open();
  try {
    const win = await second.firstWindow();
    await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
    await expect(win.locator('#btn-wrap')).toHaveText('줄바꿈: ON');
    await win.waitForFunction(
      () => document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 1,
      { timeout: 5000 });
  } finally {
    await second.close();
  }
});

// 여백의 줄넘김 표시. Monaco는 이어진 줄의 여백을 통째로 비워 두므로(lineNumbers.js에서
// 이어짐 줄이면 줄 번호가 '') :empty로 집어 ↳를 넣는다. 표시가 "이어진 줄에만" 붙는지가
// 핵심 — 모든 줄에 붙으면 표시로서 의미가 없다.
const marginMarks = (win) => win.evaluate(() => {
  const ed = document.querySelector('.monaco-diff-editor .editor.modified');
  return [...ed.querySelectorAll('.margin-view-overlays > div')].map((r) => ({
    num: r.querySelector('.line-numbers')?.textContent.trim() || '',
    mark: getComputedStyle(r, '::after').content,
    kids: r.childElementCount,
    html: r.innerHTML.slice(0, 90), // 진단용 — :empty가 안 맞는 이유를 바로 본다
  }));
});

test('접힌 줄에만 줄넘김 표시가 붙는다', async () => {
  const files = oneLineFiles('mark', jsonLine(8080, 3), jsonLine(9090, 5));
  const app = await launch(files);
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });
    await win.waitForFunction(
      () => document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 0,
      { timeout: 20000 });

    // 끈 상태에서는 접힌 줄이 없으니 표시도 없다
    const off = await marginMarks(win);
    expect(off.every((r) => !r.mark.includes('↳')), JSON.stringify(off)).toBe(true);

    await win.locator('#btn-wrap').click();
    await win.waitForFunction(
      () => document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 1,
      { timeout: 5000 });
    const on = await marginMarks(win);

    const numbered = on.filter((r) => r.num);
    const continued = on.filter((r) => !r.num);
    expect(numbered.length, JSON.stringify(on)).toBe(1);          // 논리 줄은 하나
    expect(continued.length).toBeGreaterThan(0);                  // 이어진 줄이 생겼다
    expect(numbered.every((r) => !r.mark.includes('↳'))).toBe(true);  // 첫 줄엔 안 붙고
    expect(continued.every((r) => r.mark.includes('↳')),
           JSON.stringify(continued.slice(0, 3))).toBe(true);         // 이어진 줄엔 붙는다
  } finally {
    await app.close();
  }
});
