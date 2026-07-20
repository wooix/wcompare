const { test } = require('node:test');
const assert = require('node:assert');

const { createTranslationJobs } = require('../src/main/translationJobs.js');

// job 스텁 — cancel 호출 여부만 기록한다.
function stubJob() {
  const j = { canceled: 0, cancel() { j.canceled++; } };
  return j;
}

test('서로 다른 wcId는 동시에 add를 허용한다(has=false)', () => {
  const jobs = createTranslationJobs();
  assert.equal(jobs.has(1), false);
  jobs.add(1, '/out/a.ko.pdf', stubJob());
  assert.equal(jobs.has(1), true);
  // 다른 창(wcId 2)은 여전히 비어 있으므로 동시 추가 가능
  assert.equal(jobs.has(2), false);
  jobs.add(2, '/out/b.ko.pdf', stubJob());
  assert.equal(jobs.has(2), true);
});

test('같은 wcId 재시작은 has=true로 거부 판정된다', () => {
  const jobs = createTranslationJobs();
  jobs.add(7, '/out/a.ko.pdf', stubJob());
  assert.equal(jobs.has(7), true, '진행 중이면 같은 창의 재시작은 막을 수 있다');
});

test('outputInUse가 진행 중 같은 output을 잡고, remove 후 해제된다', () => {
  const jobs = createTranslationJobs();
  const out = '/out/shared.ko.pdf';
  assert.equal(jobs.outputInUse(out), false);
  jobs.add(1, out, stubJob());
  assert.equal(jobs.outputInUse(out), true, '같은 output을 다른 창이 쓰면 잡힌다');
  assert.equal(jobs.outputInUse('/out/other.ko.pdf'), false);
  jobs.remove(1);
  assert.equal(jobs.outputInUse(out), false, 'remove 후 해제된다');
});

test('cancel(wcId)이 해당 job.cancel을 호출하고 제거한다', () => {
  const jobs = createTranslationJobs();
  const j = stubJob();
  jobs.add(3, '/out/a.ko.pdf', j);
  assert.equal(jobs.cancel(3), true);
  assert.equal(j.canceled, 1, 'job.cancel 호출됨');
  assert.equal(jobs.has(3), false, '취소 후 제거됨');
  assert.equal(jobs.cancel(3), false, '없는 창 취소는 false');
});

test('cancelAll이 모든 job.cancel을 호출하고 비운다', () => {
  const jobs = createTranslationJobs();
  const a = stubJob();
  const b = stubJob();
  jobs.add(1, '/out/a.ko.pdf', a);
  jobs.add(2, '/out/b.ko.pdf', b);
  jobs.cancelAll();
  assert.equal(a.canceled, 1);
  assert.equal(b.canceled, 1);
  assert.equal(jobs.has(1), false);
  assert.equal(jobs.has(2), false);
});
