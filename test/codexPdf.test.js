const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { translate } = require('../src/main/transpaper');
const { translatePdf } = require('../src/main/codexPdf');
const { makePdf } = require('./helpers/makePdf');
function setup(mode='ok') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wc-direct-test-'));
  const input=path.join(dir,'input.pdf'), output=path.join(dir,'out.pdf'), bin=path.join(dir,'codex');
  fs.writeFileSync(input,makePdf(1)); fs.writeFileSync(output,'existing result');
  fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('fs');let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{fs.writeFileSync(process.env.LOG,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),prompt,source:fs.readFileSync('source.pdf').toString('base64')}));if(process.env.MODE==='hang'){setInterval(()=>{},1000);return;}if(process.env.MODE==='error'){process.stderr.write('unsupported model');process.exitCode=1;return;}if(process.env.MODE==='missing')return;if(process.env.MODE==='copy'){fs.copyFileSync('source.pdf','translated.pdf');return;}fs.writeFileSync('translated.pdf',process.env.MODE==='bad'?'not a pdf':Buffer.from(process.env.RESULT,'base64'));});`,{mode:0o755});
  return {dir,input,output,env:{...process.env,WCOMPARE_TRANSPAPER:'/missing/transpaper',WCOMPARE_CODEX:bin,MODE:mode,LOG:path.join(dir,'log'),RESULT:makePdf(1,{lines:2}).toString('base64')}};
}
test('Codex gets the complete PDF and explicit model, bypassing even a broken transpaper installation',async()=>{
 const s=setup();try{
  const result=await translate(s.input,{output:s.output,env:s.env,translateSettings:{engine:'codex'}}).promise;
  const log=JSON.parse(fs.readFileSync(s.env.LOG));
  assert.ok(log.args.includes('gpt-6-astra'));assert.ok(log.args.includes('model_reasoning_effort="low"'));assert.ok(log.args.includes('workspace-write'));
  assert.ok(log.prompt.includes('원본과 동일한 형태'));assert.equal(log.source,fs.readFileSync(s.input).toString('base64'));
  assert.equal(result.output,s.output);assert.equal(result.partial,false);assert.ok(!fs.existsSync(log.cwd));
  assert.deepEqual(fs.readFileSync(s.output),Buffer.from(s.env.RESULT,'base64'));
 }finally{fs.rmSync(s.dir,{recursive:true,force:true});}
});
for(const mode of ['error','missing','bad','copy'])test(`Codex ${mode}: preserve previous output and reject`,async()=>{
 const s=setup(mode);try{
  await assert.rejects(translatePdf(s.input,s).promise);
  assert.equal(fs.readFileSync(s.output,'utf8'),'existing result');
  const log=JSON.parse(fs.readFileSync(s.env.LOG));assert.ok(!fs.existsSync(log.cwd));
 }finally{fs.rmSync(s.dir,{recursive:true,force:true});}
});
test('cancel and timeout stop Codex and preserve the existing result',async()=>{
 for(const cancel of [true,false]){
 const s=setup('hang');try{
  const job=translatePdf(s.input,{...s,timeoutMs:cancel?5000:150});
  const check=assert.rejects(job.promise,cancel?/취소/:/초과/);
  if(cancel)setTimeout(()=>job.cancel(),100);
  await check;assert.equal(fs.readFileSync(s.output,'utf8'),'existing result');
 }finally{fs.rmSync(s.dir,{recursive:true,force:true});}
 }
});
