const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCodexArgs, modelCatalog } = require('../src/main/codexEngine');
const { summarize } = require('../src/main/paperSummary');
const { translateMemo } = require('../src/main/memoTranslate');
const { buildTranslateArgs } = require('../src/main/transpaper');

test('Codex uses stdin, read-only execution, explicit model and effort', () => {
  const args = buildCodexArgs({ codexModel: 'gpt-test', codexEffort: 'high' });
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), '-');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-test');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(!buildCodexArgs().includes('--model'));
  assert.throws(() => buildCodexArgs({ codexEffort: 'invalid' }));
  assert.throws(() => buildCodexArgs({ codexModel: '--other' }));
  assert.ok(!buildTranslateArgs('/a.pdf', '/b.pdf', { engine: 'codex' }).includes('--engine'));
});

test('Codex catalog asks app-server on every call and follows model/list pages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-catalog-'));
  const bin = path.join(dir, 'codex');
  const log = path.join(dir, 'calls');
  try {
    fs.writeFileSync(bin, `#!${process.execPath}\n` + `
const fs=require('node:fs');
fs.appendFileSync(process.env.WC_TEST_LOG, 'start\\n');
let input='';
process.stdin.on('data',chunk=>{
  input+=chunk;
  let end;
  while((end=input.indexOf('\\n'))>=0){
    const request=JSON.parse(input.slice(0,end)); input=input.slice(end+1);
    if(request.method==='initialize') process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');
    if(request.method==='model/list') {
      const page=request.params.cursor ?
        {data:[{id:'gpt-two',model:'gpt-two',displayName:'Second',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null} :
        {data:[{id:'gpt-one',model:'gpt-one',displayName:'First',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'bad'}]},{id:'--bad'},{id:'hidden-model',hidden:true}],nextCursor:'next'};
      process.stdout.write(JSON.stringify({id:request.id,result:page})+'\\n');
    }
  }
});
`, { mode: 0o755 });
    const options = { env: { ...process.env, WCOMPARE_CODEX: bin, WC_TEST_LOG: log } };
    const expected = [
      { id: 'gpt-one', name: 'First', efforts: ['high'], defaultEffort: 'high' },
      { id: 'gpt-two', name: 'Second', efforts: ['low'], defaultEffort: '' },
    ];
    assert.deepEqual(await modelCatalog(options), expected);
    assert.deepEqual(await modelCatalog(options), expected);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
    await assert.rejects(modelCatalog({ env: { ...process.env, WCOMPARE_CODEX: path.join(dir, 'missing') } }), /실행 가능한 파일/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('memo and summary actually send Codex model/effort and prompt to the child process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-codex-'));
  const bin = path.join(dir, 'codex');
  const log = path.join(dir, 'request.json');
  fs.writeFileSync(bin, `#!${process.execPath}\nlet s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d=>s+=d); process.stdin.on('end',()=>{require('fs').writeFileSync(process.env.WC_TEST_LOG,JSON.stringify({args:process.argv.slice(2),prompt:s}));process.stdout.write('한국어 결과');});\n`, { mode: 0o755 });
  const opts = { env: { ...process.env, WCOMPARE_CODEX: bin, WC_TEST_LOG: log }, extraDirs: [], translateSettings: { engine: 'codex', codexModel: 'gpt-test', codexEffort: 'high' } };
  try {
    for (const job of [() => translateMemo('# Hello', opts), () => summarize('overview', { text: 'Paper content' }, opts)]) {
      const result = await job().promise;
      assert.equal(result.content, '한국어 결과');
      const request = JSON.parse(fs.readFileSync(log));
      assert.ok(request.args.includes('gpt-test'));
      assert.ok(request.args.includes('model_reasoning_effort="high"'));
      assert.ok(request.prompt.length > 20);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex cancellation rejects the job instead of returning partial output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-codex-cancel-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);\n`, { mode: 0o755 });
  try {
    const job = translateMemo('Hello', { env: { ...process.env, WCOMPARE_CODEX: bin }, translateSettings: { engine: 'codex' } });
    const check = assert.rejects(job.promise, /취소/);
    job.cancel();
    await check;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
