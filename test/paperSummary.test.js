const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  summarize, resolveEngineBin, buildSummaryArgs, clipText, buildPrompt, cleanResponse, extractMermaid,
  keepTailLines,
  KINDS, MAX_TEXT_CHARS, MAX_MERMAID_CHARS, MAX_STDERR_BUF_CHARS,
} = require('../src/main/paperSummary.js');

// transpaper.test.js:tmpExec와 같은 관용구 — 실제 LLM 대신 셸스크립트를 끼운다.
function tmpExec(name, body = '#!/bin/sh\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ps-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return { dir, p };
}

// 정화 결과를 손으로 적은 기대 문자열과만 비교하면, 기대값 자체가 틀렸을 때 아무도 못 잡는다.
// (실제로 A[] 나 정화 안 된 subgraph 제목이 초록불 아래 숨어 있었다.) 그래서 진짜 mermaid 파서에
// 통과시킨다. mermaid는 브라우저용이라 node에서는 문법을 통과한 뒤 DOM 정화 단계에서 다른 오류가
// 나므로, 문법 오류 계열만 실패로 본다.
const SYNTAX_ERR_RE = /Parse error|Expecting|Lexical error|Syntax error/i;
async function assertMermaidParses(text, msg) {
  const { default: mermaid } = await import('mermaid');
  try {
    await mermaid.parse(text);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (SYNTAX_ERR_RE.test(m)) assert.fail(`${msg}: mermaid 문법 오류\n${text}\n--- ${m.split('\n')[0]}`);
  }
}

// 라벨을 하나하나 확인한다. match가 null이면 루프가 0회 돌고 아무 단언도 안 한 채 통과하므로
// 최소 개수를 함께 못박는다 — 예전 테스트가 따옴표 없는 출력(A[], A[()])을 통과시킨 구멍이 여기였다.
function assertLabelsClean(out, minCount, msg) {
  assert.ok(out, `${msg}: 결과가 비어 있다`);
  const labels = out.match(/"[^"]*"/g) || [];
  assert.ok(labels.length >= minCount, `${msg}: 큰따옴표 라벨 ${minCount}개 이상이어야 하는데 ${labels.length}개\n${out}`);
  for (const label of labels) assert.ok(!/[()[\]{}]/.test(label), `${msg}: 라벨에 괄호가 남았다: ${label}`);
  assert.ok(!/[[({]\s*[\])}]/.test(out), `${msg}: 빈 라벨이 남았다\n${out}`);
}

// ===== resolveEngineBin =====
test('resolveEngineBin: engine별 env override가 최우선', () => {
  const { p: agy } = tmpExec('agy');
  const { p: claude } = tmpExec('claude');
  const env = { WCOMPARE_AGY: agy, WCOMPARE_CLAUDE: claude, PATH: '' };
  assert.equal(resolveEngineBin('agy', env, []), agy);
  assert.equal(resolveEngineBin('claude', env, []), claude);
});

test('resolveEngineBin: override가 실행 불가면 오류(조용히 폴백하지 않는다)', () => {
  assert.throws(() => resolveEngineBin('agy', { WCOMPARE_AGY: '/nope/agy', PATH: '' }, []), /WCOMPARE_AGY/);
  assert.throws(
    () => resolveEngineBin('claude', { WCOMPARE_CLAUDE: '/nope/claude', PATH: '' }, []),
    /실행 가능한 파일이 아닙니다/,
  );
});

test('resolveEngineBin: PATH에서 탐색, 없으면 null', () => {
  const { dir, p } = tmpExec('agy');
  assert.equal(resolveEngineBin('agy', { PATH: dir }, []), p);
  assert.equal(resolveEngineBin('claude', { PATH: dir }, []), null, '같은 폴더에 claude는 없다');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ps-empty-'));
  assert.equal(resolveEngineBin('agy', { PATH: empty }, []), null);
});

// ===== buildSummaryArgs (순수 함수) =====
test('buildSummaryArgs: -p 프롬프트로 시작하고 engine별로 다른 모델 키를 본다', () => {
  const s = { agyModel: 'gemini-3.6-flash-low', claudeModel: 'claude-sonnet-4-6' };
  assert.deepEqual(buildSummaryArgs('agy', 'PROMPT', s), ['-p', 'PROMPT', '--model', 'gemini-3.6-flash-low']);
  assert.deepEqual(buildSummaryArgs('claude', 'PROMPT', s), ['-p', 'PROMPT', '--model', 'claude-sonnet-4-6']);
});

test('buildSummaryArgs: 빈 값·미지정이면 --model을 생략한다', () => {
  assert.deepEqual(buildSummaryArgs('agy', 'P', {}), ['-p', 'P']);
  assert.deepEqual(buildSummaryArgs('agy', 'P'), ['-p', 'P']);
  assert.deepEqual(buildSummaryArgs('claude', 'P', { agyModel: 'x', claudeModel: '' }), ['-p', 'P']);
});

test('buildSummaryArgs: 불량 모델명(선행 -, 공백)은 조용히 생략한다', () => {
  assert.deepEqual(buildSummaryArgs('agy', 'P', { agyModel: '-rf' }), ['-p', 'P']);
  assert.deepEqual(buildSummaryArgs('claude', 'P', { claudeModel: 'has space' }), ['-p', 'P']);
});

// ===== clipText =====
test('clipText: 상한 이하는 그대로 둔다', () => {
  const r = clipText('짧은 본문', 100);
  assert.equal(r.text, '짧은 본문');
  assert.equal(r.truncated, false);
  assert.equal(clipText('', 100).truncated, false);
});

test('clipText: 초과 시 앞뒤가 모두 살아 있고 상한을 넘지 않는다', () => {
  const head = 'HEAD'.repeat(200);
  const mid = 'M'.repeat(2000);
  const tail = 'TAIL'.repeat(200);
  const r = clipText(head + mid + tail, 1000);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1000, '결과 길이는 상한 이하');
  assert.ok(r.text.startsWith('HEADHEAD'), '앞부분(초록·서론)이 살아 있다');
  assert.ok(r.text.endsWith('TAIL'), '뒷부분(결론·한계)이 살아 있다');
  assert.ok(r.text.includes('본문 중간 생략'), '잘렸다는 사실을 모델에게 알린다');
  assert.ok(!r.text.includes(mid), '가운데는 덜어냈다');
});

test('clipText: 두 번 잘라도 결과가 같다(멱등)', () => {
  const once = clipText('X'.repeat(5000), 1000);
  const twice = clipText(once.text, 1000);
  assert.equal(twice.text, once.text);
  assert.equal(twice.truncated, false);
});

test('clipText: 기본 상한은 MAX_TEXT_CHARS', () => {
  assert.equal(clipText('a'.repeat(MAX_TEXT_CHARS)).truncated, false);
  assert.equal(clipText('a'.repeat(MAX_TEXT_CHARS + 1)).truncated, true);
});

// ===== buildPrompt =====
test('buildPrompt: 공통 규칙과 본문이 모든 kind에 들어간다', () => {
  for (const kind of KINDS) {
    const p = buildPrompt(kind, { title: '제목', outline: null, text: '본문내용ABC' });
    assert.ok(p.includes('반드시 한국어로 답한다'), `${kind}: 한국어 지시`);
    assert.ok(p.includes('지어내지 않는다'), `${kind}: 환각 금지 지시`);
    assert.ok(p.includes('본문내용ABC'), `${kind}: 본문 포함`);
    assert.ok(p.includes('제목'), `${kind}: 제목 포함`);
  }
});

test('buildPrompt: kind별 필수 지시문', () => {
  const doc = { title: 'T', outline: null, text: 'BODY' };
  const overview = buildPrompt('overview', doc);
  assert.ok(overview.includes('800자 이내'));
  assert.ok(overview.includes('저자가 밝힌 한계'));
  assert.ok(overview.includes('30초'));

  const sections = buildPrompt('sections', doc);
  assert.ok(sections.includes("'## 제목' 헤딩"));
  assert.ok(sections.includes('3~6문장'));
  assert.ok(sections.includes('해석'));

  const flow = buildPrompt('flow', doc);
  assert.ok(flow.includes('mermaid 코드블록 하나만'));
  assert.ok(flow.includes('flowchart TD'));
  assert.ok(flow.includes('A["텍스트"]'), '라벨 따옴표 규칙');
  assert.ok(flow.includes('8~14개'));
});

test('buildPrompt: outline이 있으면 목차 절이 붙고, null이면 안전하게 생략된다', () => {
  // 지시문 안에도 '[목차]'라는 말이 나오므로, 목차 절이 붙었는지는 "그 줄 하나만 있는 줄"로 판정한다.
  const hasOutlineBlock = (p) => p.split('\n').includes('[목차]');

  const withOutline = buildPrompt('sections', { title: 'T', outline: '1. 서론 (p.1)\n2. 방법 (p.3)', text: 'B' });
  assert.ok(hasOutlineBlock(withOutline));
  assert.ok(withOutline.includes('2. 방법 (p.3)'));

  for (const outline of [null, undefined, '', '   ']) {
    const p = buildPrompt('sections', { title: null, outline, text: 'B' });
    assert.ok(!hasOutlineBlock(p), `outline=${JSON.stringify(outline)}이면 목차 절 없음`);
    assert.ok(p.includes('(제목 미상)'), '제목이 없어도 죽지 않는다');
  }
});

test('buildPrompt: 본문이 상한을 넘으면 프롬프트 안에서도 잘린다', () => {
  const p = buildPrompt('overview', { title: 'T', outline: null, text: 'x'.repeat(MAX_TEXT_CHARS + 5000) });
  assert.ok(p.includes('본문 중간 생략'));
  assert.ok(p.length < MAX_TEXT_CHARS + 4000, '프롬프트가 본문 상한 + 지시문 수준으로 유지된다');
});

// ===== cleanResponse =====
test('cleanResponse: 앞뒤 공백·빈 줄을 정리한다', () => {
  assert.equal(cleanResponse('\n\n  ## 요약\n내용  \n\n\n'), '## 요약\n내용');
  assert.equal(cleanResponse(''), '');
  assert.equal(cleanResponse(undefined), '');
});

test('cleanResponse: 전체를 감싼 코드펜스를 벗긴다', () => {
  assert.equal(cleanResponse('```markdown\n## 요약\n내용\n```'), '## 요약\n내용');
  assert.equal(cleanResponse('```\n## 요약\n```'), '## 요약');
});

test('cleanResponse: 본문 중간의 코드블록은 건드리지 않는다', () => {
  const s = '## 요약\n\n```python\nx = 1\n```\n\n끝';
  assert.equal(cleanResponse(s), s);
});

// ===== extractMermaid =====
test('extractMermaid: mermaid 펜스 안의 코드만 뽑는다', () => {
  const raw = '알겠습니다. 아래와 같습니다.\n\n```mermaid\nflowchart TD\n  A["문제"] --> B["해법"]\n```\n\n설명 끝.';
  assert.equal(extractMermaid(raw), 'flowchart TD\n  A["문제"] --> B["해법"]');
});

test('extractMermaid: 펜스가 없으면 시작 키워드 줄부터 끝까지', () => {
  const raw = '다음은 흐름도입니다.\nflowchart TD\n  A["문제"] --> B["해법"]';
  assert.equal(extractMermaid(raw), 'flowchart TD\n  A["문제"] --> B["해법"]');
});

test('extractMermaid: 펜스가 여러 개면 첫 mermaid 블록', () => {
  const raw = '```mermaid\nflowchart TD\n  A["첫째"]\n```\n\n```mermaid\nflowchart LR\n  B["둘째"]\n```';
  assert.equal(extractMermaid(raw), 'flowchart TD\n  A["첫째"]');
});

test('extractMermaid: 닫는 펜스를 빠뜨려도 살려 낸다', () => {
  assert.equal(extractMermaid('```mermaid\nflowchart TD\n  A["문제"]'), 'flowchart TD\n  A["문제"]');
});

test('extractMermaid: 라벨 안의 괄호·따옴표·대괄호를 정리해 파싱이 깨지지 않게 한다', async () => {
  const raw = [
    '```mermaid',
    'flowchart TD',
    '  A[지도 미세조정 (SFT)] --> B["강화 학습 (RLHF)"]',
    '  B --> C{성능 향상?}',
    '  C -->|예| D["그는 "끝"이라 말했다"]',
    '  D --> E[[요약 [최종]]]',
    '```',
  ].join('\n');
  const out = extractMermaid(raw);
  assert.equal(out, [
    'flowchart TD',
    '  A["지도 미세조정 SFT"] --> B["강화 학습 RLHF"]',
    '  B --> C{"성능 향상?"}',
    '  C -->|예| D["그는 끝 이라 말했다"]',
    '  D --> E[["요약 최종"]]',
  ].join('\n'), '라벨만 정화하고 화살표·도형 구조는 그대로 둔다');
  assertLabelsClean(out, 5, '괄호 정화');
  await assertMermaidParses(out, '괄호 정화');
});

test('extractMermaid: mermaid를 못 찾으면 빈 문자열', () => {
  assert.equal(extractMermaid('죄송합니다. 흐름도를 만들 수 없습니다.'), '');
  assert.equal(extractMermaid('```\nx = 1\n```'), '');
  assert.equal(extractMermaid(''), '');
  assert.equal(extractMermaid(null), '');
});

// ===== extractMermaid 회귀: 적대적 검증이 실제로 재현해 낸 결함들 =====

// [M1] 프롬프트가 "용어는 한국어(English) 병기"를 지시하므로 subgraph 제목에 괄호가 들어올 확률이
// 구조적으로 높다. 예전에는 id[...] 형태만 정화해서, 괄호 하나로 흐름도 전체가 파싱 에러를 냈다.
test('extractMermaid[M1]: subgraph 제목의 괄호도 정화한다', async () => {
  const raw = [
    '```mermaid',
    'flowchart TD',
    'subgraph 전처리 (preprocessing)',
    '  A["입력"] --> B["토큰화"]',
    'end',
    '```',
  ].join('\n');
  const out = extractMermaid(raw);
  assert.equal(out, [
    'flowchart TD',
    'subgraph "전처리 preprocessing"',
    '  A["입력"] --> B["토큰화"]',
    'end',
  ].join('\n'));
  assert.ok(!/subgraph[^\n]*[()]/.test(out), 'subgraph 줄에 괄호가 남으면 안 된다');
  await assertMermaidParses(out, 'M1 subgraph 제목');
});

test('extractMermaid[M1]: subgraph id [제목] 형태는 id를 살린 채 제목만 정화한다', async () => {
  const out = extractMermaid('flowchart TD\nsubgraph sg1 [전처리 (preprocessing)]\n  A["x"] --> B["y"]\nend');
  assert.equal(out.split('\n')[1], 'subgraph sg1 ["전처리 preprocessing"]');
  await assertMermaidParses(out, 'M1 subgraph id 형태');
});

// [M3] 예전에는 '```mermaid' 펜스일 때만 닫는 펜스에서 끊었다. 언어 표기가 없거나 속성이 붙으면
// 끝까지 읽어, 뒤에 붙은 설명 문장이 다이어그램에 섞였다 — mermaid는 그 문장을 "오류 없이"
// 노드로 그려 버리므로 사용자 화면에 산문이 노드로 나타난다(파서로는 절대 못 잡는 결함).
test('extractMermaid[M3]: 언어 표기 없는 펜스도 닫는 펜스에서 끊는다', async () => {
  const raw = [
    '```',
    'flowchart TD',
    '  A["문제"] --> B["해법"]',
    '```',
    '',
    '위 그림은 핵심 아이디어를 나타냅니다.',
  ].join('\n');
  const out = extractMermaid(raw);
  assert.equal(out, 'flowchart TD\n  A["문제"] --> B["해법"]');
  assert.ok(!out.includes('위 그림은'), '펜스 뒤 산문이 다이어그램에 섞이면 안 된다');
  await assertMermaidParses(out, 'M3 무표기 펜스');
});

test('extractMermaid[M3]: 펜스에 속성이 붙어도 닫는 펜스에서 끊는다', () => {
  const raw = '```mermaid title=x\nflowchart TD\n  A["문제"] --> B["해법"]\n```\n\n위 그림은 핵심 아이디어를 나타냅니다.';
  assert.equal(extractMermaid(raw), 'flowchart TD\n  A["문제"] --> B["해법"]');
});

test('extractMermaid[M3]: 펜스가 아예 없으면 뒤쪽 산문을 걷어낸다', () => {
  const raw = 'flowchart TD\n  A["문제"] --> B["해법"]\n\n위 그림은 핵심 아이디어를 나타냅니다.';
  assert.equal(extractMermaid(raw), 'flowchart TD\n  A["문제"] --> B["해법"]');
});

test('extractMermaid[M3]: 다른 언어 코드블록이 앞에 있어도 진짜 다이어그램을 찾는다', () => {
  const raw = '```python\nx = 1\n```\n\n```mermaid\nflowchart TD\n  A["문제"]\n```';
  assert.equal(extractMermaid(raw), 'flowchart TD\n  A["문제"]');
});

// [M4] 지우는 문자만으로 된 라벨은 정화 결과가 빈 문자열이 되고, 예전에는 A[] 같은 괄호 쌍만
// 남아 파싱이 깨졌다. 이제는 노드 id를 라벨로 써서 항상 유효한 라벨이 남는다.
test('extractMermaid[M4]: 빈 라벨이 되면 노드 id를 라벨로 쓴다', async () => {
  for (const [raw, expected] of [
    ['flowchart TD\nA[()] --> B["()"]', 'flowchart TD\nA[("A")] --> B["B"]'],
    ['flowchart TD\nA[""] --> B[  ]', 'flowchart TD\nA["A"] --> B["B"]'],
  ]) {
    const out = extractMermaid(raw);
    assert.equal(out, expected);
    assertLabelsClean(out, 2, `M4 ${raw}`);
    await assertMermaidParses(out, `M4 ${raw}`);
  }
});

// [L6] 논문 요약이라 인용 표기 [1]이 라벨에 섞일 여지가 있다. 예전에는 "닫는 문자 뒤가 공백"이면
// 곧장 라벨 끝으로 봐서, 원문에 없던 '참조]'가 화면에 남았다.
test('extractMermaid[L6]: 라벨 안의 대괄호에서 조기에 끊기지 않는다', async () => {
  const out = extractMermaid('flowchart TD\nA[선행 연구 [1] 참조]');
  assert.equal(out, 'flowchart TD\nA["선행 연구 1 참조"]');
  assert.ok(!out.includes('참조]'), '라벨 밖으로 새어 나온 조각이 없다');
  await assertMermaidParses(out, 'L6 인용 표기');
});

// [L7] 개행이 없는 한 줄 입력이면 예전 절단 로직(줄 경계에서 자르기)이 빈 문자열을 돌려줬고,
// 그러면 호출측이 "모델이 형식을 어겼다"는 틀린 원인을 사용자에게 보고했다. mermaid는
// 'graph TD; A-->B;' 한 줄 문법을 허용하므로 이건 멀쩡한 다이어그램이다.
test('extractMermaid[L7]: 개행 없는 한 줄 flowchart가 상한 절단에서 사라지지 않는다', async () => {
  const one = `graph TD; ${Array.from({ length: 200 }, (_, i) => `N${i}["${'가'.repeat(90)}"]-->M${i};`).join(' ')}`;
  assert.ok(one.length > MAX_MERMAID_CHARS, '전제: 입력이 상한을 넘는다');
  const out = extractMermaid(one);
  assert.ok(out.length > 0, '유효한 다이어그램이 통째로 사라지면 안 된다');
  assert.ok(out.length <= MAX_MERMAID_CHARS, '상한은 지킨다');
  assert.ok(out.startsWith('graph TD;'), '시작 키워드가 살아 있다');
  assert.ok(out.endsWith(';'), '세미콜론 경계에서 끊어 파싱 가능한 상태로 남긴다');
  await assertMermaidParses(out, 'L7 한 줄 절단');
});

// ===== keepTailLines =====
// [M2] 예전 구현은 "최근 40줄만 남긴다"고 했지만 개행이 한 번도 오지 않으면 미완성 줄이 통째로
// 버퍼에 쌓여 상한이 전혀 작동하지 않았다(실측 3초에 heapUsed +89.4MB, 기본 타임아웃 5분).
test('keepTailLines[M2]: 개행 없이 폭주해도 버퍼가 상한을 넘지 않는다', () => {
  const stream = new EventEmitter();
  stream.setEncoding = () => {};
  const tail = [];
  const state = keepTailLines(stream, tail, 40, 1024);
  for (let i = 0; i < 500; i += 1) stream.emit('data', 'A'.repeat(1000)); // 총 50만자, 개행 0개
  assert.ok(state.pending() <= 1024, `버퍼 상한 초과: ${state.pending()}`);
  assert.equal(tail.length, 0, '개행이 없으니 완성된 줄도 없다');
  // 개행이 섞여도 상한은 유지되고, 최근 줄만 남는다.
  stream.emit('data', `\nfirst\n${'B'.repeat(5000)}`);
  assert.ok(state.pending() <= 1024, `개행 이후에도 상한 유지: ${state.pending()}`);
  assert.ok(tail.length <= 40 && tail.includes('first'));
  stream.emit('end');
  assert.equal(state.pending(), 0, '끝나면 남은 조각을 꼬리표로 넘긴다');
});

test('keepTailLines[M2]: 기본 상한은 MAX_STDERR_BUF_CHARS', () => {
  const stream = new EventEmitter();
  stream.setEncoding = () => {};
  const state = keepTailLines(stream, []);
  for (let i = 0; i < 40; i += 1) stream.emit('data', 'A'.repeat(10000)); // 40만자, 개행 0개
  assert.ok(state.pending() <= MAX_STDERR_BUF_CHARS, `버퍼 상한 초과: ${state.pending()}`);
});

// ===== summarize (가짜 실행 파일 주입) =====
test('summarize: stdout을 정화해 { kind, content, truncated }로 돌려준다', async () => {
  const { p: bin } = tmpExec('agy', "#!/bin/sh\nprintf '```markdown\\n## 개요\\n내용\\n```\\n'\n");
  const job = summarize('overview', { title: 'T', text: '본문' }, { env: { WCOMPARE_AGY: bin, PATH: '' } });
  assert.deepEqual(await job.promise, { kind: 'overview', content: '## 개요\n내용', truncated: false });
});

test('summarize: 본문이 상한을 넘으면 truncated=true', async () => {
  const { p: bin } = tmpExec('agy', "#!/bin/sh\nprintf '요약\\n'\n");
  const job = summarize('overview', { text: 'x'.repeat(MAX_TEXT_CHARS + 1) }, { env: { WCOMPARE_AGY: bin, PATH: '' } });
  const res = await job.promise;
  assert.equal(res.truncated, true);
  assert.equal(res.content, '요약');
});

test('summarize: 프롬프트를 -p 인자로 넘긴다', async () => {
  // $1='-p', $2=프롬프트 — 프롬프트를 그대로 되돌려 주는 가짜 CLI
  const { p: bin } = tmpExec('agy', '#!/bin/sh\n[ "$1" = "-p" ] || exit 3\nprintf \'%s\' "$2"\n');
  const job = summarize('sections', { title: '제목X', outline: '1. 서론', text: '본문Y' }, {
    env: { WCOMPARE_AGY: bin, PATH: '' },
  });
  const { content } = await job.promise;
  assert.ok(content.includes('본문Y'), '본문이 프롬프트에 실렸다');
  assert.ok(content.includes('[목차]'), '목차가 프롬프트에 실렸다');
  assert.ok(content.includes('제목X'));
});

test('summarize: engine=claude면 claude 실행 파일과 claudeModel을 쓴다', async () => {
  const { p: bin } = tmpExec('claude', '#!/bin/sh\nprintf \'%s\' "$3 $4"\n');
  const job = summarize('overview', { text: 'B' }, {
    engine: 'claude',
    translateSettings: { agyModel: 'gemini-3.6-flash-low', claudeModel: 'claude-sonnet-4-6' },
    env: { WCOMPARE_CLAUDE: bin, PATH: '' },
  });
  assert.equal((await job.promise).content, '--model claude-sonnet-4-6');
});

test('summarize: kind=flow면 mermaid만 뽑아 준다', async () => {
  const { p: bin } = tmpExec('agy',
    "#!/bin/sh\nprintf '흐름도입니다.\\n```mermaid\\nflowchart TD\\n  A[문제 (핵심)] --> B[해법]\\n```\\n'\n");
  const job = summarize('flow', { text: 'B' }, { env: { WCOMPARE_AGY: bin, PATH: '' } });
  const { content } = await job.promise;
  assert.equal(content, 'flowchart TD\n  A["문제 핵심"] --> B["해법"]');
});

test('summarize: exit!=0이면 stderr 꼬리를 붙인 한국어 오류', async () => {
  const { p: bin } = tmpExec('agy', "#!/bin/sh\necho 'rate limit exceeded' >&2\nexit 7\n");
  const job = summarize('overview', { text: 'B' }, { env: { WCOMPARE_AGY: bin, PATH: '' } });
  await assert.rejects(job.promise, (e) => {
    assert.match(e.message, /agy 오류 \(exit 7\)/);
    assert.match(e.message, /rate limit exceeded/);
    return true;
  });
});

test('summarize: 빈 응답이면 오류로 알린다', async () => {
  const { p: bin } = tmpExec('agy', '#!/bin/sh\n');
  const job = summarize('overview', { text: 'B' }, { env: { WCOMPARE_AGY: bin, PATH: '' } });
  await assert.rejects(job.promise, /비어 있습니다/);
});

test('summarize: flow인데 mermaid가 없으면 오류로 알린다', async () => {
  const { p: bin } = tmpExec('agy', "#!/bin/sh\nprintf '죄송합니다. 그릴 수 없습니다.\\n'\n");
  const job = summarize('flow', { text: 'B' }, { env: { WCOMPARE_AGY: bin, PATH: '' } });
  await assert.rejects(job.promise, /흐름도/);
});

test('summarize: 응답이 상한을 넘으면 죽이고 오류', async () => {
  const { p: bin } = tmpExec('agy', "#!/bin/sh\nwhile :; do printf 'AAAAAAAAAAAAAAAA'; done\n");
  const job = summarize('overview', { text: 'B' }, { env: { WCOMPARE_AGY: bin, PATH: '' }, maxOutputBytes: 4096 });
  await assert.rejects(job.promise, /너무 깁니다/);
});

// sleep은 셸 빌트인이 아니라 /bin에 있는 실행 파일이라, 가짜 CLI에는 PATH를 최소한으로 열어 준다.
const SLEEP_ENV_PATH = '/bin:/usr/bin';

test('summarize: timeoutMs를 넘기면 죽이고 오류', async () => {
  const { p: bin } = tmpExec('agy', '#!/bin/sh\nsleep 30\n');
  const job = summarize('overview', { text: 'B' }, {
    env: { WCOMPARE_AGY: bin, PATH: SLEEP_ENV_PATH }, timeoutMs: 200,
  });
  await assert.rejects(job.promise, /오지 않아 중단/);
});

test('summarize: cancel()은 프로세스 그룹째 정리하고 취소 오류로 끝난다', async () => {
  const { p: bin } = tmpExec('agy', '#!/bin/sh\nsleep 30\n');
  const job = summarize('overview', { text: 'B' }, { env: { WCOMPARE_AGY: bin, PATH: SLEEP_ENV_PATH } });
  setTimeout(() => job.cancel(), 50);
  await assert.rejects(job.promise, /취소되었습니다/);
});

// [M2] 실제 CLI로도 확인한다: 개행 없이 stderr를 300KB 쏟아부어도 메시지가 부풀지 않고,
// 개행 없이 끝난 마지막 조각("BOOM")은 꼬리표에 실린다.
test('summarize[M2]: 개행 없는 대용량 stderr에도 오류 메시지가 부풀지 않는다', async () => {
  const { p: bin } = tmpExec('agy', [
    '#!/bin/sh',
    's=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    's=$s$s$s$s', 's=$s$s$s$s', 's=$s$s', // 1024자
    'i=0',
    'while [ $i -lt 300 ]; do printf \'%s\' "$s" >&2; i=$((i+1)); done',
    "printf 'BOOM' >&2",
    'exit 7',
    '',
  ].join('\n'));
  const job = summarize('overview', { text: 'B' }, { env: { WCOMPARE_AGY: bin, PATH: '' } });
  await assert.rejects(job.promise, (e) => {
    assert.match(e.message, /agy 오류 \(exit 7\)/);
    assert.match(e.message, /BOOM/, '개행 없이 끝난 마지막 조각도 꼬리표에 실린다');
    assert.ok(e.message.length < 2000, `오류 메시지가 부풀었다: ${e.message.length}자`);
    return true;
  });
});

// [M5] SIGTERM을 무시하는 프로세스에서는 close가 영영 오지 않아, 예전에는 promise가 resolve도
// reject도 되지 않은 채 남아 UI가 스피너에 영구히 갇혔다. 이제는 kill 성공 여부와 무관하게
// 즉시 매듭짓고, 유예 뒤에도 살아 있으면 SIGKILL로 올린다.
// trap 설치를 마쳤다는 신호를 파일로 남긴다. 신호를 기다리지 않고 죽이면 SIGTERM이 그냥 먹혀서
// 에스컬레이션 경로가 검증되지 않은 채 초록불이 켜진다(이 파일이 원래 앓던 병이다).
const TRAP_TERM_SCRIPT = [
  '#!/bin/sh',
  "trap '' TERM",
  ': > "$WC_READY"',
  'while :; do sleep 30; done',
  '',
].join('\n');

function trapTermJob(extra = {}) {
  const { dir, p: bin } = tmpExec('agy', TRAP_TERM_SCRIPT);
  const ready = path.join(dir, 'ready');
  const job = summarize('overview', { text: 'B' }, {
    env: { WCOMPARE_AGY: bin, PATH: SLEEP_ENV_PATH, WC_READY: ready }, ...extra,
  });
  return { job, ready };
}

const isAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };

async function waitFor(cond, ms = 5000) {
  for (let i = 0; i * 25 < ms && !cond(); i += 1) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

test('summarize[M5]: SIGTERM을 무시해도 cancel()이 즉시 reject되고 결국 SIGKILL로 정리된다', async () => {
  const { job, ready } = trapTermJob({ killGraceMs: 500 });
  assert.ok(await waitFor(() => fs.existsSync(ready)), 'trap 설치를 기다린다');
  const t0 = Date.now();
  job.cancel();
  await assert.rejects(job.promise, /취소되었습니다/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `close를 기다리지 않고 즉시 매듭지어야 한다 (${elapsed}ms)`);
  assert.ok(isAlive(job.pid), '전제: SIGTERM을 무시하므로 이 시점에는 아직 살아 있다');
  assert.ok(await waitFor(() => !isAlive(job.pid)), '유예 뒤 SIGKILL로 올려 프로세스 그룹을 정리한다');
});

test('summarize[M5]: SIGTERM을 무시해도 timeout이 유한 시간 안에 reject된다', async () => {
  // 타임아웃은 spawn 시점부터 재기 시작하므로 trap 설치를 기다렸다 죽일 수가 없다. 대신 넉넉한
  // 타임아웃을 주고, 신호 파일로 "그 시점에 이미 SIGTERM을 무시하는 상태였다"를 사후 확인한다.
  const { job, ready } = trapTermJob({ timeoutMs: 1000, killGraceMs: 500 });
  const t0 = Date.now();
  await assert.rejects(job.promise, /오지 않아 중단/);
  const elapsed = Date.now() - t0;
  assert.ok(fs.existsSync(ready), '전제: 타임아웃 시점에 이미 SIGTERM을 무시하고 있었다');
  assert.ok(isAlive(job.pid), '전제: SIGTERM으로는 죽지 않았다');
  assert.ok(elapsed < 1500, `"시간 안에 끝낸다"는 계약을 kill 성공 여부와 무관하게 지킨다 (${elapsed}ms)`);
  assert.ok(await waitFor(() => !isAlive(job.pid)), 'timeout 경로에서도 프로세스 그룹이 남지 않는다');
});

test('summarize: 알 수 없는 kind와 CLI 부재는 즉시 reject', async () => {
  const { p: bin } = tmpExec('agy', '#!/bin/sh\n');
  await assert.rejects(
    summarize('nope', { text: 'B' }, { env: { WCOMPARE_AGY: bin, PATH: '' } }).promise,
    /알 수 없는 요약 종류/,
  );
  // extraDirs: [] — 이 기계에 진짜 agy가 깔려 있어도 테스트가 그걸 실행하지 않도록 탐색 경로를 막는다.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ps-none-'));
  await assert.rejects(
    summarize('overview', { text: 'B' }, { env: { PATH: empty }, extraDirs: [] }).promise,
    /찾을 수 없습니다/,
  );
});

// ===== 제어문자 (실제 사용자 신고: arXiv 2203.15556 요약이 통째로 실패) =====
// pdf.js는 폰트의 ToUnicode 맵이 불완전하면 매핑 안 된 글리프를 제어문자로 흘려보낸다.
// node의 spawn은 argv에 NUL이 하나라도 있으면 인자를 통째로 거부한다(ERR_INVALID_ARG_VALUE)
// → 정화하지 않으면 Overview·절별·흐름도가 한꺼번에 실패한다.
// 소스에 제어문자를 직접 쓰지 않고 코드로 만든다(파일에 보이지 않는 바이트를 남기지 않으려고).
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

test('제어문자: NUL이 섞인 본문도 프롬프트에서 제거된다', () => {
  const prompt = buildPrompt('overview', {
    title: `제${NUL}목`,
    outline: `1.${BEL} 서론`,
    text: `본문에 NUL${NUL}이 있고 DEL${DEL}도 있다`,
  });
  assert.ok(!prompt.includes(NUL), 'NUL이 남으면 spawn이 거부한다');
  assert.ok(!prompt.includes(BEL));
  assert.ok(!prompt.includes(DEL));
  // 지우지 않고 공백으로 바꾼다 — 지우면 앞뒤 단어가 붙어 뜻이 달라진다
  assert.ok(prompt.includes('제 목'));
  assert.ok(prompt.includes('본문에 NUL 이 있고'));
  // 줄바꿈·탭은 문단 구조라 살아남는다
  const kept = buildPrompt('overview', { title: 't', outline: null, text: 'a\nb\tc' });
  assert.ok(kept.includes('a\nb\tc'));
});

test('제어문자: buildSummaryArgs가 최후 방어선으로 한 번 더 막는다', () => {
  const args = buildSummaryArgs('agy', `프롬${NUL}프트`, {});
  assert.ok(!args[1].includes(NUL));
  assert.equal(args[1], '프롬 프트');
});

test('제어문자: 정화한 인자를 spawn이 실제로 받아들인다', () => {
  // "제거됐다"가 아니라 "spawn이 통과시킨다"를 본다 — 원래 결함이 spawn에서 났기 때문이다.
  const { execFileSync } = require('node:child_process');
  const args = buildSummaryArgs('agy', `본문${NUL}에 NUL${NUL}이 있다`, {});
  const out = execFileSync('/bin/echo', [args[1]], { encoding: 'utf8' });
  assert.match(out, /본문 에 NUL 이 있다/);
  // 정화 전이라면 여기서 ERR_INVALID_ARG_VALUE가 났을 것이다
  assert.throws(() => execFileSync('/bin/echo', [`raw${NUL}`]), /null bytes|ERR_INVALID_ARG_VALUE/);
});
