// test/memoTranslate.test.js — 메모 번역의 순수 로직(main/memoTranslate.js).
// 실제 CLI는 부르지 않는다(그 경로는 e2e가 가짜 agy로 덮는다).
const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildTranslatePrompt, clipSource, cleanTranslation, MAX_INPUT_CHARS,
} = require('../src/main/memoTranslate.js');

test('buildTranslatePrompt: 구조 보존 규칙과 원문이 모두 실린다', () => {
  const p = buildTranslatePrompt('# 제목\n\n본문입니다.');
  assert.ok(p.includes('마크다운 구조를 한 글자도 바꾸지 않는다'));
  assert.ok(p.includes('코드블록'), '코드블록을 번역하지 말라는 지시가 있어야 한다');
  assert.ok(p.includes('URL은 그대로'), '링크 규칙이 있어야 한다');
  assert.ok(p.split('\n').includes('[원문]'));
  assert.ok(p.includes('# 제목') && p.includes('본문입니다.'));
  assert.ok(p.trimEnd().endsWith('설명을 붙이지 마라.'), '마무리 지시가 맨 뒤에 온다');
});

test('clipSource: 상한 안이면 그대로, 넘치면 앞에서부터 남기고 표식을 붙인다', () => {
  const short = clipSource('짧은 글');
  assert.deepEqual(short, { text: '짧은 글', truncated: false });

  const long = clipSource(`${'가'.repeat(MAX_INPUT_CHARS + 500)}끝`);
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= MAX_INPUT_CHARS);
  // 요약(clipText)과 달리 앞뒤를 이어 붙이지 않는다 — 번역본의 가운데가 사라지면
  // 사용자는 어디가 빠졌는지 알 수 없다. 앞에서 자르면 "여기까지"가 눈에 보인다.
  assert.ok(long.text.startsWith('가'.repeat(100)));
  assert.ok(long.text.trimEnd().endsWith('…'), '잘렸다는 표식이 끝에 있어야 한다');
  assert.ok(!long.text.includes('끝'), '뒤쪽을 이어 붙이지 않는다');
});

test('clipSource: 제어문자를 없앤다 (NUL 하나로 spawn이 argv를 거부한다)', () => {
  const { text } = clipSource('a\x00b\x07c');
  assert.ok(!text.includes('\x00'));
  assert.ok(!/[\x00-\x08]/.test(text));
  // 개행·탭은 마크다운 구조라 살린다.
  assert.equal(clipSource('a\nb\tc').text, 'a\nb\tc');
});

test('clipSource: 문자열이 아닌 값도 던지지 않는다', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.equal(typeof clipSource(v).text, 'string');
  }
});

test('cleanTranslation: 전체를 감싼 코드펜스를 벗긴다', () => {
  assert.equal(cleanTranslation('```markdown\n# 제목\n```'), '# 제목');
  assert.equal(cleanTranslation('```\n# 제목\n```'), '# 제목');
  assert.equal(cleanTranslation('  # 제목  '), '# 제목', '앞뒤 공백을 걷는다');
});

test('cleanTranslation: 안쪽에 코드블록이 있으면 벗기지 않는다', () => {
  // 코드블록이 든 문서를 망치는 것보다 바깥 펜스 한 겹이 남는 편이 낫다.
  const withCode = '```markdown\n# 제목\n\n```js\nconst a = 1;\n```\n```';
  assert.equal(cleanTranslation(withCode), withCode);
});

test('cleanTranslation: 펜스가 없으면 그대로', () => {
  assert.equal(cleanTranslation('# 제목\n\n본문'), '# 제목\n\n본문');
  assert.equal(cleanTranslation(''), '');
  assert.equal(cleanTranslation(null), '');
});
