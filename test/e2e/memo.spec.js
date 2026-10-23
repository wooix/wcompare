// test/e2e/memo.spec.js — memo 모드(마크다운 에디터 + 번역 + 미리보기 3열).
//
// 이 spec이 지키려는 계약은 넷이다:
//  (1) 모드 3종이 서로를 밀어낸다 — 한 번에 하나만 보인다.
//  (2) 번역창·미리보기는 서로 독립이다. 닫힌 열의 스플리터도 함께 숨는다(허공에 손잡이 금지).
//  (3) 좌우 스왑은 '배치만' 바꾼다 — 미리보기는 새 메인을 렌더하고, 저장 대상은 흐트러지지 않는다.
//  (4) 번역본을 손본 뒤 재번역하면 되묻고, 안 건드렸으면 조용히 진행한다.
// 실제 LLM은 부르지 않는다: pdf-summary.spec.js와 같은 가짜 agy seam(WCOMPARE_AGY)을 쓴다.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

// 가짜 agy: 무엇이 오든 고정 번역본을 돌려준다. 프롬프트를 파일로 받아 적어
// "구조 보존 지시가 실제로 실렸는가"를 눈으로 확인할 수 있게 한다.
function stubAgy(dir, logFile, delaySec = 0) {
  const p = path.join(dir, 'agy');
  fs.writeFileSync(p, [
    '#!/bin/sh',
    logFile ? `printf '%s' "$2" > "${logFile}"` : ':',
    // 지연을 주면 진행 오버레이가 화면에 머무는 동안 관측할 수 있다. 0이면 즉시 끝난다.
    `sleep ${delaySec}`,
    "printf '# 번역된 제목\\n\\n번역된 본문입니다.\\n'",
  ].join('\n'), { mode: 0o755 });
  return p;
}

function setup(tag, delaySec = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-memo-${tag}-`));
  return {
    dir,
    userData: path.join(dir, 'userData'),
    storageDir: path.join(dir, 'storage'),
    log: path.join(dir, 'agy-prompt.txt'),
    agy: stubAgy(dir, path.join(dir, 'agy-prompt.txt'), delaySec),
  };
}

const setStorage = (app, d) => app.evaluate((_e, dir) => {
  const cache = process.mainModule.require('module')._cache;
  const key = Object.keys(cache).find((k) => k.replace(/\\/g, '/').endsWith('/src/main/settings.js'));
  cache[key].exports.set({ storageDir: dir, translate: { engine: 'agy' } });
}, d);

async function launch(s) {
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${s.userData}`],
    env: { ...process.env, WCOMPARE_AGY: s.agy },
  });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  const win = await app.firstWindow();
  await win.waitForSelector('#toolbar', { timeout: 20000 });
  // 대형 번들(app.js)은 정적 #toolbar보다 늦게 실행된다 → 배선이 끝날 때까지 기다린다.
  await win.waitForFunction(
    () => typeof document.getElementById('btn-mode-memo')?.onclick === 'function',
    null, { timeout: 20000 });
  await setStorage(app, s.storageDir);
  return { app, win };
}

// 새 메모를 만들고 본문을 채운 상태까지 만든다.
async function newMemo(win, text) {
  await win.click('#btn-mode-memo');
  await win.click('#btn-memo-new');
  await expect(win.locator('.memo-src .monaco-editor')).toBeVisible({ timeout: 20000 });
  await win.click('.memo-src .monaco-editor');
  await win.keyboard.type(text);
}

test('모드 3종: 비교 / PDF / 메모가 서로를 밀어낸다', async () => {
  const s = setup('modes');
  const { app, win } = await launch(s);

  await win.click('#btn-mode-memo');
  await expect(win.locator('#memoview')).toBeVisible();
  await expect(win.locator('#diff-wrap')).toBeHidden();
  await expect(win.locator('#pdfview')).toBeHidden();
  await expect(win.locator('#btn-mode-memo')).toHaveClass(/on/);
  // 툴바 묶음도 함께 갈린다 — memo 컨트롤만 보인다.
  await expect(win.locator('#btn-memo-new')).toBeVisible();
  await expect(win.locator('#btn-translate')).toBeHidden(); // pdf 전용

  await win.click('#btn-mode-diff');
  await expect(win.locator('#diff-wrap')).toBeVisible();
  await expect(win.locator('#memoview')).toBeHidden();
  await expect(win.locator('#btn-memo-new')).toBeHidden();

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('메모 만들기·저장: memos/에 .md로 남는다', async () => {
  const s = setup('save');
  const { app, win } = await launch(s);
  await newMemo(win, '# 안녕\n\n본문입니다.');

  await expect(win.locator('#btn-memo-save')).toBeEnabled(); // dirty가 켜졌다
  await win.click('#btn-memo-save');
  await expect(win.locator('#btn-memo-save')).toBeDisabled(); // 저장하면 다시 잠긴다

  const memoDir = path.join(s.storageDir, 'memos');
  await expect.poll(() => fs.readdirSync(memoDir).filter((f) => f.endsWith('.md')).length,
    { timeout: 10000 }).toBe(1);
  const f = fs.readdirSync(memoDir)[0];
  expect(fs.readFileSync(path.join(memoDir, f), 'utf8')).toContain('본문입니다.');

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('번역창·미리보기는 서로 독립으로 열고 닫히며, 닫힌 열의 스플리터도 숨는다', async () => {
  const s = setup('toggle');
  const { app, win } = await launch(s);
  await newMemo(win, '# 제목');

  const trans = win.locator('.memo-trans');
  const preview = win.locator('.memo-preview');
  const split = win.locator('.memo-view .pane-split');

  // 처음에는 둘 다 닫혀 있다 — 에디터 한 칸.
  await expect(trans).toBeHidden();
  await expect(preview).toBeHidden();
  await expect(split).toBeHidden(); // 허공에 손잡이가 남으면 안 된다

  await win.click('#btn-memo-toggle-preview');
  await expect(preview).toBeVisible();
  await expect(trans).toBeHidden(); // 서로 독립이다
  await expect(split).toBeVisible();

  await win.click('#btn-memo-toggle-trans');
  await expect(trans).toBeVisible();
  await expect(preview).toBeVisible();

  await win.click('#btn-memo-toggle-preview');
  await expect(preview).toBeHidden();
  await expect(trans).toBeVisible(); // 미리보기를 닫아도 번역창은 남는다
  await expect(split).toBeHidden();

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('미리보기는 메인을 렌더하고, 스왑하면 새 메인을 따라간다', async () => {
  const s = setup('swap');
  const { app, win } = await launch(s);
  await newMemo(win, '# 원문제목');

  await win.click('#btn-memo-toggle-preview');
  await expect(win.locator('.memo-preview')).toContainText('원문제목');

  // 번역을 돌려 번역창을 채운다(가짜 agy가 고정 결과를 준다).
  await win.click('#btn-memo-translate');
  await expect(win.locator('.memo-trans')).toBeVisible({ timeout: 25000 });
  await expect.poll(() => win.evaluate(() => window.__wc?.memoValue?.('translation') || ''),
    { timeout: 25000 }).toContain('번역된 제목');

  // 스왑 전: 미리보기는 원문. 스왑 후: 번역본.
  await expect(win.locator('.memo-preview')).toContainText('원문제목');
  await win.click('#btn-memo-swap');
  await expect(win.locator('.memo-preview')).toContainText('번역된 제목');
  await expect(win.locator('.memo-preview')).not.toContainText('원문제목');

  // 스왑은 '배치만' 바꾼다 — 각 에디터가 들고 있는 내용은 그대로여야 한다.
  // (내용을 맞바꾸는 구현이면 path와 내용이 어긋나 저장이 엉뚱한 파일로 나간다.)
  expect(await win.evaluate(() => window.__wc.memoValue('source'))).toContain('원문제목');
  expect(await win.evaluate(() => window.__wc.memoValue('translation'))).toContain('번역된 제목');

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('번역: 구조 보존 지시가 실제 CLI 인자에 실리고 결과가 번역창에 들어간다', async () => {
  const s = setup('trans');
  const { app, win } = await launch(s);
  await newMemo(win, '# 제목\n\n- 항목');

  await win.click('#btn-memo-translate');
  await expect.poll(() => win.evaluate(() => window.__wc?.memoValue?.('translation') || ''),
    { timeout: 25000 }).toContain('번역된 본문');
  // 번역창은 결과가 들어갈 자리로 자동으로 열린다.
  await expect(win.locator('.memo-trans')).toBeVisible();

  const prompt = fs.readFileSync(s.log, 'utf8');
  expect(prompt).toContain('마크다운 구조를 한 글자도 바꾸지 않는다');
  expect(prompt).toContain('# 제목'); // 원문이 실렸다
  expect(prompt).toContain('- 항목');

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('번역 진행 표현이 PDF와 같다: 버튼이 취소로 바뀌고 오버레이에 경과 시간이 뜬다', async () => {
  // 같은 종류의 기다림은 같아 보여야 한다는 것이 이 앱의 방침이다. PDF 번역과 같은 세 가지를 본다:
  // (1) 버튼이 '한국어 번역 ▶' ↔ '번역 취소' 토글, (2) 결과가 들어올 자리 위의 오버레이,
  // (3) 진행 중 관련 버튼 잠금 + 이유를 담은 툴팁.
  const s = setup('progress', 3); // 3초 지연 — 오버레이가 머무는 동안 관측한다
  const { app, win } = await launch(s);
  await newMemo(win, '# 제목');

  const btn = win.locator('#btn-memo-translate');
  await expect(btn).toHaveText('한국어 번역 ▶');

  await btn.click();
  // 버튼이 취소로 바뀐다
  await expect(btn).toHaveText('번역 취소');
  await expect(btn).toHaveAttribute('title', /취소/);
  // 오버레이가 번역창 위에 뜬다
  const busy = win.locator('.memo-busy');
  await expect(busy).toBeVisible();
  await expect(win.locator('.memo-busy-title')).toHaveText('한국어 번역 중…');
  await expect(win.locator('.memo-busy-hint')).toContainText('경과');
  // 진행 단위가 없으므로 막대는 숨는다(PDF는 페이지 수로 분모를 알지만 여기는 LLM 호출 1회다)
  await expect(win.locator('.memo-busy-bar')).toBeHidden();
  // 진행 중에는 관련 버튼이 이유와 함께 잠긴다
  await expect(win.locator('#btn-memo-save')).toBeDisabled();
  await expect(win.locator('#btn-memo-new')).toBeDisabled();
  await expect(win.locator('#btn-memo-swap')).toHaveAttribute('title', /번역 중에는/);

  // 끝나면 오버레이가 걷히고 버튼이 되돌아온다
  await expect(busy).toBeHidden({ timeout: 25000 });
  await expect(btn).toHaveText('한국어 번역 ▶');
  expect(await win.evaluate(() => window.__wc.memoValue('translation'))).toContain('번역된 제목');

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('번역 취소: 진행 중 버튼을 다시 누르면 멈추고 원래 상태로 돌아온다', async () => {
  const s = setup('cancel', 10); // 취소할 시간을 벌어 둔다
  const { app, win } = await launch(s);
  await newMemo(win, '# 제목');

  const btn = win.locator('#btn-memo-translate');
  await btn.click();
  await expect(btn).toHaveText('번역 취소');
  await expect(win.locator('.memo-busy')).toBeVisible();

  await btn.click(); // 취소
  await expect(win.locator('.memo-busy')).toBeHidden({ timeout: 20000 });
  await expect(btn).toHaveText('한국어 번역 ▶');
  await expect(win.locator('#btn-memo-new')).toBeEnabled(); // 잠금이 풀렸다
  // 취소했으므로 번역창은 비어 있다
  expect(await win.evaluate(() => window.__wc.memoValue('translation'))).toBe('');

  await app.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('경로 없는 초안: 내용으로 번역 활성화, 지우면 비활성화, 저장으로 원문·번역 보존', async () => {
  const s = setup('draft'); const { app, win } = await launch(s);
  try {
    await win.click('#btn-mode-memo');
    await expect(win.locator('#btn-memo-translate')).toBeDisabled();
    await win.click('.memo-src .monaco-editor'); await win.keyboard.type('Draft before saving');
    await expect(win.locator('#btn-memo-translate')).toBeEnabled();
    await win.keyboard.press('Meta+A'); await win.keyboard.press('Backspace');
    await expect(win.locator('#btn-memo-translate')).toBeDisabled();
    await win.keyboard.type('Draft before saving');
    await win.click('#btn-memo-translate');
    await expect.poll(() => win.evaluate(() => window.__wc.memoValue('translation'))).toContain('번역된 본문');
    expect(fs.readFileSync(s.log,'utf8')).toContain('Draft before saving');
    await expect(win.locator('#btn-memo-save')).toBeEnabled();
    await win.click('#btn-memo-save');
    await expect(win.locator('#btn-memo-save')).toBeDisabled();
    const files = fs.readdirSync(path.join(s.storageDir,'memos'));
    expect(files.filter(f => f.endsWith('.md'))).toHaveLength(2);
    expect(files.some(f => fs.readFileSync(path.join(s.storageDir,'memos',f),'utf8') === 'Draft before saving')).toBe(true);
  } finally { await app.close(); fs.rmSync(s.dir,{recursive:true,force:true}); }
});

test('File > Close Window (⌘W): 취소하면 유지, 다른 탭에서도 저장 선택 시 초안 저장 후 닫기', async () => {
  const s = setup('close-save'); const { app, win } = await launch(s);
  try {
    // Playwright의 CDP 키 입력은 macOS 네이티브 메뉴 accelerator를 거치지 않는다.
    // 메뉴의 ⌘W 배정은 pdf-close-settings에서 확인하고, 여기서는 메뉴 액션을 실행한다.
    const closeFromMenu = () => app.evaluate(({ Menu, BrowserWindow }) => {
      const file = Menu.getApplicationMenu().items.find(item => item.label === 'File');
      const close = file.submenu.items.find(item => item.label === 'Close Window');
      close.click(close, BrowserWindow.getAllWindows()[0]);
    });
    await win.click('#btn-mode-memo'); await win.click('.memo-src .monaco-editor'); await win.keyboard.type('Keep this draft');
    await win.click('#btn-mode-diff');
    await app.evaluate(({dialog}) => { global.memoPrompts = []; dialog.showMessageBox = async (_w,opts) => { global.memoPrompts.push(opts); return { response: 2 }; }; });
    await closeFromMenu();
    await expect.poll(() => app.evaluate(() => global.memoPrompts.length)).toBe(1);
    expect(win.isClosed()).toBe(false);
    expect(await win.evaluate(() => window.__wc.memoValue('source'))).toBe('Keep this draft');
    await app.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response:0}); });
    const closed = win.waitForEvent('close');
    await closeFromMenu();
    await closed;
    const files=fs.readdirSync(path.join(s.storageDir,'memos'));
    expect(files.some(f => fs.readFileSync(path.join(s.storageDir,'memos',f),'utf8') === 'Keep this draft')).toBe(true);
  } finally { await app.close(); fs.rmSync(s.dir,{recursive:true,force:true}); }
});

test('다른 메모로 교체: 취소는 내용 보존, 저장 안 함은 새 메모로 이동', async () => {
  const s=setup('replace'); const {app,win}=await launch(s);
  try {
    await win.click('#btn-mode-memo'); await win.click('.memo-src .monaco-editor'); await win.keyboard.type('Unsaved old draft');
    await app.evaluate(({dialog}) => { dialog.showMessageBox=async()=>({response:2}); });
    await win.click('#btn-memo-new');
    expect(await win.evaluate(()=>window.__wc.memoValue('source'))).toBe('Unsaved old draft');
    await app.evaluate(({dialog}) => { dialog.showMessageBox=async()=>({response:1}); });
    await win.click('#btn-memo-new');
    await expect.poll(()=>win.evaluate(()=>window.__wc.memoValue('source'))).toBe('');
    await expect(win.locator('#btn-memo-translate')).toBeDisabled();
  } finally {await app.close();fs.rmSync(s.dir,{recursive:true,force:true});}
});

test('저장 실패 시 창을 닫지 않고 초안을 유지한다', async () => {
  const s=setup('close-failure'); const {app,win}=await launch(s);
  try {
    await win.click('#btn-mode-memo'); await win.click('.memo-src .monaco-editor'); await win.keyboard.type('Do not lose me');
    await app.evaluate(({dialog,ipcMain}) => {
      dialog.showMessageBox=async()=>({response:0});
      ipcMain.removeHandler('file:write'); ipcMain.handle('file:write',()=>{throw new Error('disk unavailable');});
    });
    await win.evaluate(() => { window.memoLastError = ''; window.alert = text => { window.memoLastError = text; }; });
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => win.evaluate(() => window.memoLastError)).toContain('저장하지 못했습니다');
    expect(win.isClosed()).toBe(false);
    expect(await win.evaluate(()=>window.__wc.memoValue('source'))).toBe('Do not lose me');
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
  } finally {await app.close();fs.rmSync(s.dir,{recursive:true,force:true});}
});

test('앱 종료도 저장 확인을 거치며 저장 안 함은 종료를 완료한다', async () => {
  const s=setup('quit'); const {app,win}=await launch(s); let exited = false;
  try {
    await win.click('#btn-mode-memo'); await win.click('.memo-src .monaco-editor'); await win.keyboard.type('Discard on quit');
    await app.evaluate(({dialog})=>{ global.memoPrompts=0;dialog.showMessageBox=async()=>{global.memoPrompts++;return {response:2};};});
    await app.evaluate(({app})=>app.quit());
    await expect.poll(()=>app.evaluate(()=>global.memoPrompts)).toBe(1);
    expect(win.isClosed()).toBe(false);
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
    const closed=app.waitForEvent('close');
    await app.evaluate(({app})=>app.quit()); await closed; exited = true;
    expect(fs.existsSync(path.join(s.storageDir,'memos')) ? fs.readdirSync(path.join(s.storageDir,'memos')).filter(f=>f.endsWith('.md')) : []).toEqual([]);
  } finally {if(!exited) await app.close();fs.rmSync(s.dir,{recursive:true,force:true});}
});
