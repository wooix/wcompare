// test/markdownLite.test.js — parseMarkdown/parseInline 순수 파서 단위 테스트.
// renderMarkdown은 DOM(document)이 필요해 이 프로젝트의 node:test 환경(jsdom 없음)에서는
// 직접 실행할 수 없다 — 대신 "innerHTML을 쓰지 않는다"는 보안 원칙 자체를 소스 코드 검사로
// 회귀 방지한다(아래 마지막 test 참고).
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { parseMarkdown, parseInline } = require('../src/renderer/markdownLite.js');

test('제목: 1~6개 #', () => {
  const md = [
    '# H1',
    '## H2',
    '### H3',
    '###### H6',
  ].join('\n');
  assert.deepEqual(parseMarkdown(md), [
    { type: 'heading', level: 1, text: 'H1' },
    { type: 'heading', level: 2, text: 'H2' },
    { type: 'heading', level: 3, text: 'H3' },
    { type: 'heading', level: 6, text: 'H6' },
  ]);
});

test('제목: 닫는 # 시퀀스는 제거되고, 공백 없는 #hashtag/7개 #은 헤딩이 아니다', () => {
  assert.deepEqual(parseMarkdown('## Title ##'), [
    { type: 'heading', level: 2, text: 'Title' },
  ]);
  const notHeading = parseMarkdown('#hashtag\n\n####### seven');
  assert.equal(notHeading.every((b) => b.type !== 'heading'), true);
});

test('문단: 빈 줄로 분리되고, 연속 줄은 한 블록으로 합쳐진다', () => {
  const md = ['첫째 줄', '둘째 줄', '', '다른 문단'].join('\n');
  assert.deepEqual(parseMarkdown(md), [
    { type: 'paragraph', text: '첫째 줄\n둘째 줄' },
    { type: 'paragraph', text: '다른 문단' },
  ]);
});

test('목록: 비순서(하이픈/별표)', () => {
  const md = ['- a', '- b', '* c'].join('\n');
  // 마커가 -, -, * 로 셋 다 비순서(bullet)라 하나의 리스트로 합쳐진다.
  assert.deepEqual(parseMarkdown(md), [
    { type: 'list', ordered: false, items: ['a', 'b', 'c'] },
  ]);
});

test('목록: 순서(숫자점), 순서/비순서가 섞이면 리스트가 나뉜다', () => {
  const md = ['1. one', '2. two', '- three'].join('\n');
  assert.deepEqual(parseMarkdown(md), [
    { type: 'list', ordered: true, items: ['one', 'two'] },
    { type: 'list', ordered: false, items: ['three'] },
  ]);
});

test('코드블록: 언어 지정 포함/미포함', () => {
  const md = [
    '```js',
    'const a = 1;',
    'console.log(a);',
    '```',
    '```',
    'no lang',
    '```',
  ].join('\n');
  assert.deepEqual(parseMarkdown(md), [
    { type: 'code', lang: 'js', text: 'const a = 1;\nconsole.log(a);' },
    { type: 'code', lang: '', text: 'no lang' },
  ]);
});

test('코드블록 내부의 #/* 등은 헤딩/목록/인라인으로 해석되지 않는다', () => {
  const md = ['```', '# not a heading', '- not a list', '```'].join('\n');
  assert.deepEqual(parseMarkdown(md), [
    { type: 'code', lang: '', text: '# not a heading\n- not a list' },
  ]);
});

test('인용: 연속된 > 줄은 하나의 블록으로 합쳐진다', () => {
  const md = ['> 첫줄', '> 둘째줄', '', '본문'].join('\n');
  assert.deepEqual(parseMarkdown(md), [
    { type: 'quote', text: '첫줄\n둘째줄' },
    { type: 'paragraph', text: '본문' },
  ]);
});

test('수평선: 하이픈 3개 이상', () => {
  assert.deepEqual(parseMarkdown('above\n\n---\n\nbelow'), [
    { type: 'paragraph', text: 'above' },
    { type: 'hr' },
    { type: 'paragraph', text: 'below' },
  ]);
});

test('빈 문자열/공백만/null 입력에 안전', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('   \n\t\n   '), []);
  assert.deepEqual(parseMarkdown(null), []);
  assert.deepEqual(parseMarkdown(undefined), []);
});

test('parseInline: 굵게/기울임/코드', () => {
  assert.deepEqual(parseInline('**bold**'), [{ type: 'strong', text: 'bold' }]);
  assert.deepEqual(parseInline('*em*'), [{ type: 'em', text: 'em' }]);
  assert.deepEqual(parseInline('`code`'), [{ type: 'code', text: 'code' }]);
  assert.deepEqual(parseInline('a *b* and **c** and `d`'), [
    { type: 'text', text: 'a ' },
    { type: 'em', text: 'b' },
    { type: 'text', text: ' and ' },
    { type: 'strong', text: 'c' },
    { type: 'text', text: ' and ' },
    { type: 'code', text: 'd' },
  ]);
});

test('parseInline: 별표/백틱이 짝이 안 맞아도 깨지지 않고 리터럴로 남는다', () => {
  assert.deepEqual(parseInline('*a'), [{ type: 'text', text: '*a' }]);
  assert.deepEqual(parseInline('**unterminated'), [{ type: 'text', text: '**unterminated' }]);
  assert.deepEqual(parseInline('a ** b'), [{ type: 'text', text: 'a ** b' }]);
  assert.deepEqual(parseInline('`unterminated code'), [
    { type: 'text', text: '`unterminated code' },
  ]);
  assert.deepEqual(parseInline(''), []);
  assert.deepEqual(parseInline(null), []);
});

test('보안 회귀: HTML 태그 문자열이 섞여도 파서는 태그로 해석하지 않고 평문 그대로 보존한다', () => {
  const md = '앞 문단\n\n<script>alert(1)</script> 그리고 **진짜 강조**';
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks, [
    { type: 'paragraph', text: '앞 문단' },
    { type: 'paragraph', text: '<script>alert(1)</script> 그리고 **진짜 강조**' },
  ]);

  const spans = parseInline('<b>bold-looking html</b> real **strong**');
  assert.deepEqual(spans, [
    { type: 'text', text: '<b>bold-looking html</b> real ' },
    { type: 'strong', text: 'strong' },
  ]);
  // <b>...</b>는 별도 태그로 쪼개지지 않고 하나의 text 조각 안에 리터럴로 남아야 한다.
  assert.equal(spans[0].type, 'text');
  assert.ok(spans[0].text.includes('<b>') && spans[0].text.includes('</b>'));
});

test('보안 회귀: renderMarkdown은 innerHTML을 절대 쓰지 않는다(소스 검사)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'markdownLite.js'),
    'utf8',
  );
  // 소스 상단 주석은 원칙 설명을 위해 "innerHTML"이라는 단어 자체를 언급하므로(정상),
  // 실제 대입 형태(.innerHTML =)만 금지 여부를 검사한다.
  assert.equal(/\.innerHTML\s*=/.test(src), false);
});
