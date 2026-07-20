// test/dict.test.js — dict.js 팩토리: 정규화/굴절 폴백, MT 캐시 상한, 엔진 폴백, cancel.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDict, normalizeTerm, inflections } = require('../src/main/dict.js');

// 각 굴절 규칙을 정확히 하나씩 되짚게끔 원형만 담은 소형 사전.
const DICT = {
  version: 1,
  entries: {
    cat: [['고양이', 'noun']],
    box: [['상자', 'noun']],
    city: [['도시', 'noun']],
    study: [['공부', 'noun']],
    walk: [['걷다', 'verb']],
    small: [['작은', 'adj']],
    happy: [['행복한', 'adj']],
    make: [['만들다', 'verb']],
  },
};
function dictFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-dict-'));
  const p = path.join(dir, 'en-ko.json');
  fs.writeFileSync(p, JSON.stringify(DICT));
  return p;
}

test('normalizeTerm: 양끝 문장부호 제거 + 소문자, 내부 어깻점/하이픈 보존', () => {
  assert.equal(normalizeTerm('  Cats! '), 'cats');
  assert.equal(normalizeTerm('"Hello,"'), 'hello');
  assert.equal(normalizeTerm("don't"), "don't", '내부 어깻점은 남긴다');
  assert.equal(normalizeTerm('well-known.'), 'well-known', '내부 하이픈은 남긴다');
  assert.equal(normalizeTerm('   '), '');
});

test('lookup: 원형 히트', () => {
  const d = createDict({ dictFile: dictFile() });
  assert.deepEqual(d.lookup('cat'), [['고양이', 'noun']]);
  assert.deepEqual(d.lookup('Cat.'), [['고양이', 'noun']], '정규화 후 히트');
});

test('lookup: 복수형 폴백 (s / es / ies→y)', () => {
  const d = createDict({ dictFile: dictFile() });
  assert.deepEqual(d.lookup('cats'), [['고양이', 'noun']], 's 제거');
  assert.deepEqual(d.lookup('boxes'), [['상자', 'noun']], 'es 제거');
  assert.deepEqual(d.lookup('cities'), [['도시', 'noun']], 'ies→y');
});

test('lookup: 진행/과거 폴백 (ing / ed / ied→y / e 복원)', () => {
  const d = createDict({ dictFile: dictFile() });
  assert.deepEqual(d.lookup('studying'), [['공부', 'noun']], 'ing 제거');
  assert.deepEqual(d.lookup('making'), [['만들다', 'verb']], 'ing→e 복원');
  assert.deepEqual(d.lookup('walked'), [['걷다', 'verb']], 'ed 제거');
  assert.deepEqual(d.lookup('studied'), [['공부', 'noun']], 'ied→y');
});

test('lookup: 비교급/최상급 폴백 (er / est / ier→y / iest→y)', () => {
  const d = createDict({ dictFile: dictFile() });
  assert.deepEqual(d.lookup('smaller'), [['작은', 'adj']], 'er 제거');
  assert.deepEqual(d.lookup('smallest'), [['작은', 'adj']], 'est 제거');
  assert.deepEqual(d.lookup('happier'), [['행복한', 'adj']], 'ier→y');
  assert.deepEqual(d.lookup('happiest'), [['행복한', 'adj']], 'iest→y');
});

test('lookup: 미스는 null, 빈 문자열도 null', () => {
  const d = createDict({ dictFile: dictFile() });
  assert.equal(d.lookup('zzzzz'), null);
  assert.equal(d.lookup('ran'), null, '불규칙형은 못 잡는다(best-effort)');
  assert.equal(d.lookup('   '), null);
});

test('lookup: 사전 파일이 없으면 빈 사전으로 취급하고 null', () => {
  const d = createDict({ dictFile: '/no/such/dict.json' });
  assert.equal(d.lookup('cat'), null);
});

test('inflections: 원형이 항상 첫 후보', () => {
  assert.equal(inflections('running')[0], 'running');
  assert.ok(inflections('boxes').includes('box'));
});

test('translate: 엔진 폴백 — agy 실패 시 claude로 1회 폴백', async () => {
  const calls = [];
  const runEngine = ({ name }) => {
    calls.push(name);
    if (name === 'agy') return Promise.reject(new Error('agy 죽음'));
    return Promise.resolve('클로드 번역 결과\n');
  };
  const d = createDict({
    dictFile: dictFile(),
    resolveEngines: () => [{ bin: 'agy', name: 'agy' }, { bin: 'claude', name: 'claude' }],
    runEngine,
  });
  const res = await d.translate('a whole english sentence here');
  assert.deepEqual(calls, ['agy', 'claude'], 'agy 먼저, 실패하면 claude');
  assert.equal(res.engine, 'claude');
  assert.equal(res.ko, '클로드 번역 결과', 'stdout은 trim된다');
});

test('translate: 두 엔진 모두 실패하면 마지막 오류를 던진다', async () => {
  const runEngine = ({ name }) => Promise.reject(new Error(`${name} 실패`));
  const d = createDict({
    dictFile: dictFile(),
    resolveEngines: () => [{ bin: 'agy', name: 'agy' }, { bin: 'claude', name: 'claude' }],
    runEngine,
  });
  await assert.rejects(d.translate('boom'), /claude 실패/);
});

test('translate: 엔진이 하나도 없으면 즉시 오류', async () => {
  const d = createDict({ dictFile: dictFile(), resolveEngines: () => [] });
  await assert.rejects(d.translate('x'), /찾을 수 없습니다/);
});

test('translate: 결과를 캐시하고 재요청 시 엔진을 다시 부르지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-dcache-'));
  const cacheFile = path.join(dir, 'dict-cache.json');
  let n = 0;
  const runEngine = () => Promise.resolve(`번역#${++n}`);
  const d = createDict({ dictFile: dictFile(), cacheFile, resolveEngines: () => [{ bin: 'e', name: 'e' }], runEngine });

  const first = await d.translate('same text');
  const second = await d.translate('same text');
  assert.equal(n, 1, '엔진은 한 번만 호출된다');
  assert.equal(first.ko, second.ko);
  assert.equal(second.cached, true, '두 번째는 캐시 히트');
  assert.ok(fs.existsSync(cacheFile), '캐시 파일이 원자 기록된다');
});

test('translate: 캐시 상한을 넘기면 오래된 항목부터 제거된다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-dcap-'));
  const cacheFile = path.join(dir, 'dict-cache.json');
  const runEngine = ({ text }) => Promise.resolve('ko:' + text);
  const d = createDict({ dictFile: dictFile(), cacheFile, maxCache: 3, resolveEngines: () => [{ bin: 'e', name: 'e' }], runEngine });

  for (const t of ['one', 'two', 'three', 'four', 'five']) await d.translate(t);
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(Object.keys(saved.entries).length, 3, '상한(3)을 넘지 않는다');

  // 가장 오래된 'one','two'는 밀려나고 'five'는 남는다 → 'one'은 다시 엔진을 타고, 'five'는 캐시 히트.
  const five = await d.translate('five');
  assert.equal(five.cached, true, '최근 항목은 남아 캐시 히트');
});

test('translate: cancel()이 진행 중 요청을 취소 오류로 정리한다', async () => {
  // signal.abort 시 canceled 오류로 reject 하는 엔진 — 실제 child kill을 흉내낸다.
  const runEngine = ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { const e = new Error('aborted'); e.canceled = true; reject(e); });
  });
  const d = createDict({ dictFile: dictFile(), resolveEngines: () => [{ bin: 'e', name: 'e' }], runEngine });

  const p = d.translate('long running translation');
  d.cancel();
  await assert.rejects(p, (e) => e.canceled === true);
});

test('translate: 새 요청이 오면 이전 진행 요청이 취소된다', async () => {
  let firstReject = null;
  const runEngine = ({ text, signal }) => new Promise((resolve, reject) => {
    if (text === 'first') { firstReject = reject; signal.addEventListener('abort', () => { const e = new Error('a'); e.canceled = true; reject(e); }); }
    else resolve('두번째 결과');
  });
  const d = createDict({ dictFile: dictFile(), resolveEngines: () => [{ bin: 'e', name: 'e' }], runEngine });

  const p1 = d.translate('first');   // 대기 상태로 남는다
  const p2 = await d.translate('second'); // 이 호출이 첫 요청을 취소한다
  assert.equal(p2.ko, '두번째 결과');
  await assert.rejects(p1, (e) => e.canceled === true, '이전 요청은 취소 오류로 마감');
});
