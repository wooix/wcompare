const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { identity, load, generate } = require('../src/main/paperExplanation');
const { exposeReader, resolveReaderFile, sourceForReaderUrl } = require('../src/main/explanationProtocol');
const { explanationFixture } = require('./helpers/explanationFixture');

test('generation builds the fixed reader, records whole-PDF instructions, and reuses verified cache', async t => {
  const s = explanationFixture();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const id = identity(s.input);
  const result = await generate(s.input, { dir: s.cache, env: s.env }).promise;
  assert.equal(result.report.sourceUnits, result.report.translatedUnits);
  assert.ok(result.report.sourceUnits > 0);
  assert.equal(load(s.cache, id).generation, result.generation);
  assert.equal(s.calls().length, 1);
  assert.ok(s.calls()[0].args.includes('workspace-write'));
  assert.match(s.calls()[0].prompt, /전체.*PDF|source\.pdf 전체/);
  assert.ok(!fs.existsSync(s.calls()[0].cwd));
  const exposed = exposeReader(result, s.input);
  assert.equal(resolveReaderFile(exposed.url), fs.realpathSync(path.join(result.site, 'index.html')));
  assert.equal(resolveReaderFile(exposed.url.replace('index.html', '../paper.json')), null);
  assert.equal(resolveReaderFile(exposed.url.replace('index.html', '%2e%2e%2fpaper.json')), null);
  assert.equal(resolveReaderFile(exposed.url.replace('paper:', 'app:')), null);
  const sourceUrl = exposed.url.replace('index.html', 'source.pdf#page=2');
  assert.deepEqual(sourceForReaderUrl(sourceUrl), { path: s.input, page: 2 });
  assert.equal(sourceForReaderUrl(sourceUrl.replace('/source.pdf', '/other.pdf')), null);
  fs.appendFileSync(path.join(result.site, 'app.js'), 'tampered');
  assert.equal(load(s.cache, id), null);
});

test('changed PDF bytes invalidate the reader even when its path stays the same', async t => {
  const s = explanationFixture();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const id = identity(s.input);
  await generate(s.input, { dir: s.cache, env: s.env }).promise;
  fs.appendFileSync(s.input, '\n% changed');
  assert.notEqual(identity(s.input).key, id.key);
  assert.equal(load(s.cache, identity(s.input)), null);
  assert.ok(load(s.cache, id));
});

test('failed regeneration keeps the previously published reader', async t => {
  const s = explanationFixture();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const before = await generate(s.input, { dir: s.cache, env: s.env }).promise;
  await assert.rejects(generate(s.input, { dir: s.cache, env: { ...s.env, EXPLANATION_MODE: 'error' } }).promise);
  assert.equal(load(s.cache, identity(s.input)).generation, before.generation);
});

test('cancel and timeout stop the generator and leave no partial reader', async t => {
  const s = explanationFixture();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const options = { dir: s.cache, env: { ...s.env, EXPLANATION_MODE: 'hang' } };
  const job = generate(s.input, options);
  const rejection = assert.rejects(job.promise, /취소/);
  setTimeout(() => job.cancel(), 150);
  await rejection;
  await assert.rejects(generate(s.input, { ...options, timeoutMs: 150 }).promise, /초과/);
  assert.equal(load(s.cache, identity(s.input)), null);
  assert.deepEqual(fs.readdirSync(s.cache), []);
});
