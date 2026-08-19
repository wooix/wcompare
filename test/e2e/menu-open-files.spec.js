// test/e2e/menu-open-files.spec.js — File 메뉴 맨 위의 "열린 파일 경로" 줄.
// 메뉴는 main에 있고 열린 파일은 렌더러가 아는 값이라, 둘이 실제로 이어져 있는지는
// 앱을 띄워야만 확인된다. PDF가 아니라 텍스트 파일로 여는 이유는 기능이 모드와
// 무관하기도 하고, testDir 밖의 헬퍼를 require하면 이 환경의 Playwright 변환기가
// 넘어지기 때문이다(makePdf를 쓰는 spec들이 같은 이유로 막혀 있다).
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

// 짧은 경로를 쓴다: os.tmpdir()는 /var/folders/…로 길어서 displayPath가 앞을 잘라내고,
// 그러면 "경로가 보이는가"를 폴더명으로 확인할 수 없다(잘림 자체는 단위 테스트가 지킨다).
function fixtures(tag) {
  const dir = fs.mkdtempSync(`/tmp/wcm${tag}`);
  return (name, body) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body ?? `${name}\n`);
    return p;
  };
}

const launch = (args = []) => electron.launch({
  args: [MAIN,
         `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'wc-menu-ud-'))}`,
         ...args],
});

// 앱 메뉴는 main에만 있으므로 거기서 읽는다.
const fileMenu = (app) => app.evaluate(({ Menu }) => {
  const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File');
  return (file?.submenu?.items || []).map((i) => (i.type === 'separator' ? '---' : i.label));
});

// 렌더러 -> main -> 메뉴 재설정은 몇 틱 걸린다.
async function menuUntil(app, pred) {
  await expect.poll(async () => pred(await fileMenu(app)), { timeout: 10000 }).toBe(true);
  return fileMenu(app);
}

const sendMenu = (app, ch) => app.evaluate(({ BrowserWindow }, c) => {
  BrowserWindow.getAllWindows()[0].webContents.send(c);
}, ch);

test('파일을 열면 File 메뉴 맨 위에 그 경로가 붙는다', async () => {
  const mk = fixtures('one');
  const a = mk('alpha.txt');
  const app = await launch([a]);
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });

    const items = await menuUntil(app, (l) => l.some((x) => x && x.includes('alpha.txt')));
    const line = items.find((x) => x && x.includes('alpha.txt'));
    expect(line).toContain('왼쪽');
    // 파일명이 아니라 경로가 보여야 한다. main은 realpath로 정규화하므로(macOS의
    // /var -> /private/var) 그 기준으로 비교한다.
    expect(line).toContain(path.dirname(fs.realpathSync(a)));
    expect(line.endsWith('alpha.txt')).toBe(true);
    expect(items.indexOf(line)).toBe(0);     // 맨 위 — 아래에 있으면 찾지 않게 된다
    expect(items[1]).toBe('---');            // 실제 동작들과 구분선으로 갈린다
  } finally {
    await app.close();
  }
});

test('두 파일을 열면 줄이 둘, 하나를 닫으면 그 줄만 사라진다', async () => {
  const mk = fixtures('two');
  const a = mk('alpha.txt');
  const b = mk('beta.txt');
  const app = await launch([a, b]);
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('.monaco-diff-editor', { timeout: 20000 });

    const both = await menuUntil(app, (l) => l.some((x) => x && x.includes('beta.txt')));
    expect(both[0]).toContain('alpha.txt');
    expect(both[0]).toContain('왼쪽');
    expect(both[1]).toContain('beta.txt');
    expect(both[1]).toContain('오른쪽');

    await sendMenu(app, 'menu:close-left');
    const after = await menuUntil(app, (l) => !l.some((x) => x && x.includes('alpha.txt')));
    // 남은 문서는 그대로 보인다 — 하나를 닫았다고 목록이 통째로 비면 안 된다
    expect(after.some((x) => x && x.includes('beta.txt'))).toBe(true);
  } finally {
    await app.close();
  }
});

test('아무 파일도 없으면 경로 줄이 아예 없다', async () => {
  // 빈 창에 "(없음)" 줄을 두면 자리만 먹는다. File 메뉴는 New Window로 시작해야 한다.
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('#toolbar', { timeout: 20000 });
    const items = await fileMenu(app);
    expect(items[0]).toBe('New Window');
    expect(items.some((x) => x && x.includes('/'))).toBe(false);
  } finally {
    await app.close();
  }
});

test('허용목록에 없는 경로는 메뉴에 오르지 못한다', async () => {
  // 이 항목은 누르면 Finder를 여는 동작이다. 렌더러가 임의 경로를 얹을 수 있으면
  // 허용목록 원칙이 메뉴를 통해 무너진다.
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('#toolbar', { timeout: 20000 });
    await win.evaluate(() => window.wcompare.setOpenFiles(
      [{ label: '왼쪽', path: '/etc/passwd' }]));
    const items = await fileMenu(app);
    expect(items.some((x) => x && x.includes('passwd'))).toBe(false);
    expect(items[0]).toBe('New Window');
  } finally {
    await app.close();
  }
});
