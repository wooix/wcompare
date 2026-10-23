const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MAIN = path.resolve(__dirname, '../../src/main/main.js');

test('workspace navigation, engine-specific settings, model/effort persistence and responsive layout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-modern-'));
  const bin = path.join(dir, 'codex');
  const modelLog = path.join(dir, 'model-calls');
  fs.writeFileSync(bin, `#!${process.execPath}\n` + `
const fs=require('node:fs');
let input='';
process.stdin.on('data',chunk=>{
  input+=chunk;
  let end;
  while((end=input.indexOf('\\n'))>=0){
    const msg=JSON.parse(input.slice(0,end)); input=input.slice(end+1);
    if(msg.method==='initialize') process.stdout.write(JSON.stringify({id:msg.id,result:{}})+'\\n');
    if(msg.method==='model/list') {
      const file=process.env.WC_MODEL_LOG;
      const n=fs.existsSync(file) ? Number(fs.readFileSync(file,'utf8'))+1 : 1;
      fs.writeFileSync(file,String(n));
      if(n===3) {
        process.stdout.write(JSON.stringify({id:msg.id,error:{code:-1,message:'temporary failure'}})+'\\n');
        continue;
      }
      const data=[{id:'gpt-test',model:'gpt-test',displayName:'Test model',supportedReasoningEfforts:n>=4?[{reasoningEffort:'low'}]:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}];
      if(n>1) data.push({id:'gpt-next',model:'gpt-next',displayName:'New model',supportedReasoningEfforts:[{reasoningEffort:'medium'}]});
      process.stdout.write(JSON.stringify({id:msg.id,result:{data,nextCursor:null}})+'\\n');
    }
  }
});
`, { mode: 0o755 });
  const launch = () => electron.launch({ args: [MAIN, '--user-data-dir=' + path.join(dir, 'ud')], env: { ...process.env, WCOMPARE_CODEX: bin, WC_MODEL_LOG: modelLog } });
  let app = await launch();
  try {
    let w = await app.firstWindow();
    await expect(w.locator('#workspace-header')).toBeVisible();
    await expect(w.locator('.welcome-open')).toBeVisible();
    await w.click('#btn-reading-focus');
    await expect(w.locator('#toolbar')).toBeHidden();
    await w.keyboard.press('Escape');
    await expect(w.locator('#toolbar')).toBeVisible();
    await w.click('#ai-settings-shortcut');
    await expect(w.locator('#set-translate-engine')).toHaveValue('codex');
    await expect(w.locator('#set-agy-model')).toBeHidden();
    await expect(w.locator('#set-codex-model')).toBeEnabled();
    await expect(w.locator('#set-codex-model option')).toHaveCount(2); // 저장된 이전 모델 + Codex 응답
    await w.selectOption('#set-codex-model', 'gpt-test');
    await expect(w.locator('#ai-save-status')).toContainText('저장됨');
    await w.selectOption('#set-codex-effort', 'high');
    await expect.poll(() => w.evaluate(async () => (await window.wcompare.settings.get()).translate.codexEffort)).toBe('high');
    await w.selectOption('#set-translate-engine', 'claude');
    await expect(w.locator('#set-codex-model')).toBeHidden();
    await expect(w.locator('#set-claude-model')).toBeVisible();
    await w.selectOption('#set-translate-engine', 'codex');
    await expect(w.locator('#set-codex-effort')).toHaveValue('high');
    await w.locator('#settings-dialog').press('Escape');
    await w.click('#ai-settings-shortcut');
    await expect(w.locator('#set-codex-model option[value="gpt-next"]')).toHaveCount(1);
    await expect.poll(() => Number(fs.readFileSync(modelLog, 'utf8'))).toBe(2);
    await w.click('#set-codex-refresh');
    await expect(w.locator('#set-codex-model-status')).toContainText('조회 실패');
    await expect(w.locator('#set-codex-model')).toBeDisabled();
    await expect(w.locator('#set-codex-model option[value="gpt-next"]')).toHaveCount(0);
    await app.close();
    app = await launch(); w = await app.firstWindow();
    await w.click('#ai-settings-shortcut');
    await expect(w.locator('#set-codex-model')).toHaveValue('gpt-test');
    await expect(w.locator('#set-codex-effort')).toHaveValue('high');
    await expect(w.locator('#effort-help')).toContainText('지원 목록에 없습니다');
    await w.locator('#settings-dialog').press('Escape');
    for (const mode of ['diff', 'memo', 'pdf']) {
      await w.click('#btn-mode-' + mode);
      await expect(w.locator('#btn-mode-' + mode)).toHaveAttribute('aria-pressed', 'true');
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
    await expect.poll(() => w.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await w.screenshot({ path: path.join(dir, 'workspace.png') });
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
