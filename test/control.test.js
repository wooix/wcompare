const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { arxivPdfUrl } = require('../src/main/arxiv');
const { createControlJobs } = require('../src/main/controlJobs');

test('arXiv URLs preserve old and new versioned identifiers', () => {
  for (const value of ['2401.12345v2', 'https://arxiv.org/abs/2401.12345v2', 'https://arxiv.org/pdf/2401.12345v2.pdf', 'https://arxiv.org/html/2401.12345v2']) {
    assert.equal(arxivPdfUrl(value), 'https://arxiv.org/pdf/2401.12345v2');
  }
  assert.equal(arxivPdfUrl('https://arxiv.org/abs/hep-th/9901001v3'), 'https://arxiv.org/pdf/hep-th/9901001v3');
  for (const value of ['https://arxiv.org.evil/abs/2401.12345', 'https://user@arxiv.org/abs/2401.12345', 'file:///tmp/paper.pdf', 'https://arxiv.org/help']) {
    assert.throws(() => arxivPdfUrl(value));
  }
});

test('MCP jobs track completion, reject same-window overlap, preserve history and support cancellation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-jobs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.json');
  const jobs = createControlJobs(file);
  let finish;
  const first = jobs.start(1, 'explain', () => new Promise(resolve => { finish = resolve; }), () => finish({ cancelled: true }));
  assert.throws(() => jobs.start(1, 'translate', async () => ({}), () => {}), /진행 중/);
  await new Promise(resolve => setImmediate(resolve));
  jobs.progress(1, { operation: 'explain', message: 'writing' });
  assert.equal(jobs.get(first.id).progress.message, 'writing');
  await jobs.cancel(first.id);
  assert.equal((await jobs.wait(first.id, 1)).status, 'cancelled');
  const second = jobs.start(1, 'translate', async () => ({ output: '/paper.ko.pdf' }), () => {});
  assert.equal((await jobs.wait(second.id, 1)).status, 'succeeded');
  const failed = jobs.start(2, 'explain', async () => { throw new Error('engine failed'); }, () => {});
  assert.equal((await jobs.wait(failed.id, 1)).error, 'engine failed');
  assert.equal(createControlJobs(file).get(second.id).status, 'succeeded');
  const hanging = jobs.start(3, 'explain', () => new Promise(() => {}), () => {});
  assert.equal(createControlJobs(file).get(hanging.id).status, 'interrupted');
});
