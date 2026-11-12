const { test, expect, _electron: electron } = require('@playwright/test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { explanationFixture } = require('../helpers/explanationFixture');

test('MCP opens arXiv, executes app pipelines, displays outputs and reports cancel/failure', async () => {
  test.setTimeout(60000);
  const s = explanationFixture();
  const socket = path.join(os.tmpdir(), `wc-${randomUUID().slice(0, 8)}.sock`);
  const userData = path.join(s.dir, 'profile');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ storageDir: s.cache }));
  const bin = path.join(s.dir, 'ai');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
  fs.appendFileSync(process.env.EXPLANATION_LOG,'call\\n');
  if(process.env.MCP_TEST_MODE==='hang'){setInterval(()=>{},1000);return;}
  if(process.env.MCP_TEST_MODE==='error'){process.stderr.write('engine failed');process.exitCode=1;return;}
  if(prompt.includes('translated.pdf')){fs.copyFileSync(process.env.MCP_TRANSLATED,'translated.pdf');return;}
  if(prompt.includes('paper-helper/SKILL.md')){const p=JSON.parse(fs.readFileSync(process.env.EXPLANATION_FIXTURE));fs.writeFileSync('paper.json',JSON.stringify(p));fs.writeFileSync('source-inventory.json',JSON.stringify(p.sourceInventory));return;}
  process.stdout.write('검증 요약입니다.');
});`, { mode: 0o755 });
  const env = { ...s.env, WCOMPARE_CODEX: bin, WCOMPARE_CONTROL_SOCKET: socket, MCP_TRANSLATED: s.translated };
  const executablePath = process.env.WCOMPARE_APP_EXECUTABLE;
  if (executablePath) delete env.WCOMPARE_NODE;
  const app = await electron.launch({ executablePath,
    args: [...(executablePath ? [] : [path.resolve(__dirname, '../../src/main/main.js')]), `--user-data-dir=${userData}`], env });
  const client = new Client({ name: 'wcompare-integration-test', version: '1.0.0' });
  try {
    await app.firstWindow();
    await expect.poll(() => fs.existsSync(socket)).toBe(true);
    await app.evaluate(({ net }, bytes) => {
      const original = net.fetch;
      net.fetch = (url, options) => String(url).startsWith('https://arxiv.org/')
        ? Promise.resolve(new Response(Buffer.from(bytes, 'base64'), { headers: { 'Content-Type': 'application/pdf' } }))
        : original(url, options);
    }, fs.readFileSync(s.input).toString('base64'));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.resolve(__dirname, '../../dist/mcp/server.cjs')], env }));
    expect((await client.listTools()).tools).toHaveLength(10);
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name: 'wcompare_' + name, arguments: args });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      return response.structuredContent;
    };
    const opened = await call('open_arxiv', { url: 'https://arxiv.org/abs/2401.00001v2' });
    expect(opened.url).toBe('https://arxiv.org/pdf/2401.00001v2');
    const id = opened.window_id;
    const win = app.windows().find(win => win !== app.windows()[0]);
    await call('set_view', { window_id: id, layout: 'explain' });
    await expect(win.locator('.explanation-generate')).toBeEnabled();
    expect(fs.existsSync(s.log)).toBe(false);
    const explained = await call('explain', { window_id: id });
    const explanation = await call('wait_job', { job_id: explained.id, seconds: 20 });
    expect(explanation.status).toBe('succeeded');
    await expect(win.frameLocator('.pdf-explanation iframe').locator('#reader h1')).toBeVisible();
    const translated = await call('translate', { window_id: id });
    const translation = await call('wait_job', { job_id: translated.id, seconds: 20 });
    expect(translation.status).toBe('succeeded');
    expect(translation.result.output).toMatch(/\.ko\.pdf$/);
    const summary = await call('summarize', { window_id: id, kinds: ['overview'] });
    expect((await call('wait_job', { job_id: summary.id, seconds: 20 })).status).toBe('succeeded');
    await expect(win.locator('.pdf-summary')).toBeVisible();
    await expect(win.locator('.sum-pane[data-kind=overview]')).toContainText('검증 요약');
    await app.evaluate(() => { process.env.MCP_TEST_MODE = 'hang'; });
    const pending = await call('explain', { window_id: id, force: true });
    await expect(win.locator('.explanation-cancel')).toBeVisible();
    await call('cancel_job', { job_id: pending.id });
    expect((await call('wait_job', { job_id: pending.id, seconds: 20 })).status).toBe('cancelled');
    await app.evaluate(() => { process.env.MCP_TEST_MODE = 'error'; });
    const failed = await call('explain', { window_id: id, force: true });
    expect((await call('wait_job', { job_id: failed.id, seconds: 20 })).status).toBe('failed');
    const state = await call('get_state');
    expect(state.windows.find(win => win.window_id === id).files).toHaveLength(2);
    await expect(win.frameLocator('.pdf-explanation iframe').locator('#reader h1')).toBeVisible();
  } finally {
    await client.close();
    await app.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
    fs.rmSync(socket, { force: true });
  }
});
