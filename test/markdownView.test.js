// test/markdownView.test.js — markdownToHtml(순수 함수) 단위 테스트.
// renderMarkdown은 DOM(document)과 DOMPurify가 필요해 이 프로젝트의 node:test 환경(jsdom 없음)에서는
// 직접 실행할 수 없다. 대신
//   (1) markdownToHtml이 만드는 HTML을 문자열로 검증하고,
//   (2) "정화 전 결과에는 위험한 문자열이 남는다"는 사실 자체를 테스트로 못박아
//       정화가 renderMarkdown의 책임임을 문서화하며,
//   (3) 소스 코드 검사로 innerHTML 대입이 DOMPurify.sanitize를 거치는지 회귀 방지한다.
// 실제 DOM에서의 정화 동작은 e2e(Playwright)가 확인한다.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { markdownToHtml } = require('../src/renderer/markdownView.js');

// ===== 기본 마크다운 (markdownLite가 못 하던 것 포함) =====

test('제목: 1~6개 #이 h1~h6이 된다', () => {
  const html = markdownToHtml('# H1\n\n## H2\n\n###### H6');
  assert.match(html, /<h1>H1<\/h1>/);
  assert.match(html, /<h2>H2<\/h2>/);
  assert.match(html, /<h6>H6<\/h6>/);
});

test('문단과 강조', () => {
  const html = markdownToHtml('보통 **굵게** 그리고 *기울임*.');
  assert.match(html, /<p>/);
  assert.match(html, /<strong>굵게<\/strong>/);
  assert.match(html, /<em>기울임<\/em>/);
});

test('목록: 비순서/순서', () => {
  const ul = markdownToHtml('- 하나\n- 둘');
  assert.match(ul, /<ul>/);
  assert.equal((ul.match(/<li>/g) || []).length, 2);

  const ol = markdownToHtml('1. 하나\n2. 둘');
  assert.match(ol, /<ol>/);
  assert.equal((ol.match(/<li>/g) || []).length, 2);
});

test('중첩 목록: markdownLite가 못 하던 것 — 안쪽 ul이 li 안에 생긴다', () => {
  const html = markdownToHtml('- a\n  - b\n    - c');
  // 최상위 ul 1개 + 중첩 ul 2개
  assert.equal((html.match(/<ul>/g) || []).length, 3);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /<li>a<ul>/);
});

test('표: markdownLite가 못 하던 것 — GFM 표가 table/th/td로 그려진다', () => {
  const html = markdownToHtml('| 항목 | 값 |\n|---|---|\n| 정확도 | 0.91 |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>항목<\/th>/);
  assert.match(html, /<td>0\.91<\/td>/);
});

test('링크: markdownLite가 못 하던 것 — a[href]가 생긴다', () => {
  const html = markdownToHtml('[논문](https://arxiv.org/abs/1706.03762)을 보라');
  assert.match(html, /<a href="https:\/\/arxiv\.org\/abs\/1706\.03762"[^>]*>논문<\/a>/);
});

test('코드블록: 언어 표기가 class로 남고 내용은 이스케이프된다', () => {
  const html = markdownToHtml('```js\nconst a = 1 < 2;\n```');
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /1 &lt; 2;/);
  assert.doesNotMatch(html, /1 < 2/);
});

test('인용/수평선', () => {
  const html = markdownToHtml('> 인용문\n\n---\n');
  assert.match(html, /<blockquote>/);
  assert.match(html, /<hr>/);
});

// ===== 수식 =====

test('인라인 수식 $N$이 KaTeX 출력으로 바뀐다', () => {
  const html = markdownToHtml('표본 크기 $N$ 을 고정한다.');
  assert.match(html, /class="katex"/);
  assert.match(html, /<math/);
  // 달러 기호가 화면 문자열로 남지 않는 것이 이 교체의 목적이다(실제 사용자 신고 사항).
  assert.doesNotMatch(html, /\$N\$/);
});

test('디스플레이 수식 $$...$$이 katex-display로 바뀐다', () => {
  const single = markdownToHtml('앞 문단\n\n$$E = mc^2$$\n\n뒤 문단');
  assert.match(single, /class="katex-display"/);
  assert.match(single, /<p>앞 문단<\/p>/);
  assert.match(single, /<p>뒤 문단<\/p>/);

  // 여러 줄로 접힌 형태도 같은 블록으로 잡힌다.
  const multi = markdownToHtml('$$\n\\frac{a}{b}\n$$');
  assert.match(multi, /class="katex-display"/);
  assert.doesNotMatch(multi, /\$\$/);
});

test('문장 중간의 $$...$$도 디스플레이로 렌더된다(문단이 잘리지 않는다)', () => {
  const html = markdownToHtml('식은 $$a+b$$ 처럼 쓴다');
  assert.match(html, /class="katex-display"/);
  assert.equal((html.match(/<p>/g) || []).length, 1);
});

test('회귀 방지 — 코드블록 안의 $x$는 수식이 되지 않는다', () => {
  const fenced = markdownToHtml('```python\ncost = $x$ + $$y$$\n```');
  assert.doesNotMatch(fenced, /class="katex"/);
  assert.match(fenced, /cost = \$x\$ \+ \$\$y\$\$/);

  // 4칸 들여쓴 코드블록도 마찬가지다.
  const indented = markdownToHtml('    $$x$$');
  assert.doesNotMatch(indented, /class="katex"/);
  assert.match(indented, /<pre><code>\$\$x\$\$/);

  // 인라인 코드 안도 건드리지 않는다.
  const inline = markdownToHtml('`$x$` 라고 적는다');
  assert.doesNotMatch(inline, /class="katex"/);
  assert.match(inline, /<code>\$x\$<\/code>/);
});

test('통화 표기는 수식으로 오인되지 않는다', () => {
  // 여는 $ 하나뿐 — 닫는 $가 없다
  assert.doesNotMatch(markdownToHtml('가격은 $5 입니다'), /class="katex"/);
  // 닫는 $ 바로 앞이 공백
  assert.doesNotMatch(markdownToHtml('It costs $5 and $10 total.'), /class="katex"/);
  // 닫는 $ 바로 뒤가 숫자
  assert.doesNotMatch(markdownToHtml('range $5and$10 wide'), /class="katex"/);
  // 여는 $ 바로 뒤가 공백
  assert.doesNotMatch(markdownToHtml('a $ b $ c'), /class="katex"/);
  // 원문 달러 기호는 그대로 남는다
  assert.match(markdownToHtml('가격은 $5 입니다'), /\$5/);
});

test('역슬래시로 이스케이프한 \\$는 수식 시작으로 보지 않는다', () => {
  const html = markdownToHtml('가격은 \\$5 입니다');
  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /\$5/);
  assert.doesNotMatch(html, /\\\$/); // 역슬래시는 화면에 남지 않는다
});

test('잘못된 LaTeX는 전체를 깨뜨리지 않고 원문을 빨간 글씨로 남긴다', () => {
  const html = markdownToHtml('앞말 $\\frac{$ 뒷말\n\n다음 문단');
  assert.match(html, /katex-error/);
  assert.match(html, /#cc0000/);
  assert.match(html, /앞말/);
  assert.match(html, /뒷말/);
  assert.match(html, /<p>다음 문단<\/p>/); // 뒤 내용이 살아 있다
});

test('여러 수식이 한 문서에 섞여도 각각 렌더된다', () => {
  const html = markdownToHtml('- $a_1$\n- $b_2$\n\n$$\\sum_{i=1}^{n} x_i$$');
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
  assert.equal((html.match(/class="katex-display"/g) || []).length, 1);
});

// ===== 방어적 입력 =====

test('빈 문자열/null/undefined/공백만 입력에 안전하다', () => {
  assert.equal(markdownToHtml(''), '');
  assert.equal(markdownToHtml(null), '');
  assert.equal(markdownToHtml(undefined), '');
  assert.equal(markdownToHtml('   \n\t\n  '), '');
  // 문자열이 아닌 값도 던지지 않는다(문자열로 바꿔 처리한다).
  assert.doesNotThrow(() => markdownToHtml(0));
  assert.doesNotThrow(() => markdownToHtml({}));
  assert.equal(typeof markdownToHtml(0), 'string');
});

test('아주 긴 입력도 상한에서 잘려 돌아온다', () => {
  const html = markdownToHtml('가'.repeat(300000));
  assert.ok(html.length > 0);
  assert.ok(html.length < 260000, `상한을 넘겼다: ${html.length}`);
});

// ===== 보안 =====
// markdownToHtml은 **정화 전** 결과다. 아래 두 테스트는 "무엇이 남고 무엇이 안 남는지"를 못박는다.
//   - 링크 스킴은 markdownToHtml 단계에서 이미 막는다(정화 전 문자열에도 javascript:가 없다).
//   - raw HTML은 마크다운 명세상 그대로 통과한다 → 이것을 지우는 것은 renderMarkdown의 책임이며,
//     renderMarkdown은 DOMPurify.sanitize를 거친 뒤에만 innerHTML에 대입한다.

test('위험한 스킴의 링크는 정화 전에도 앵커가 되지 않는다', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox(1)']) {
    const html = markdownToHtml(`[클릭](${url})`);
    assert.doesNotMatch(html, /<a /, `앵커가 생기면 안 된다: ${url}`);
    assert.doesNotMatch(html, /javascript:/i, `javascript 스킴이 남으면 안 된다: ${url}`);
  }
  // 정상 링크는 살아 있어야 한다.
  assert.match(markdownToHtml('[ok](https://example.com)'), /<a href="https:\/\/example\.com"[^>]*>/);
  assert.match(markdownToHtml('[mail](mailto:a@b.c)'), /<a href="mailto:a@b\.c"[^>]*>/);
});

test('raw HTML은 정화 전 결과에 그대로 남는다 — 지우는 것은 renderMarkdown(DOMPurify)의 책임', () => {
  const script = markdownToHtml('<script>alert(1)</script>');
  const img = markdownToHtml('<img src=x onerror=alert(1)>');
  // 이 테스트는 "여기서는 안 막힌다"는 사실을 명시적으로 기록한다.
  assert.match(script, /<script>/);
  assert.match(img, /onerror/);
  // 그래서 renderMarkdown이 DOMPurify를 반드시 통과시켜야 한다(아래 소스 검사 테스트 참고).
});

test('수식 오류 메시지에도 원문 HTML이 태그로 새지 않는다', () => {
  const html = markdownToHtml('$\\frac{<script>alert(1)</script>$');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('보안 회귀: renderMarkdown의 innerHTML 대입은 DOMPurify.sanitize를 거친다(소스 검사)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'markdownView.js'),
    'utf8',
  );
  const assigns = src.match(/\.innerHTML\s*=\s*[^;\n]+/g) || [];
  assert.ok(assigns.length > 0, 'innerHTML 대입이 있어야 한다(없으면 이 테스트가 무의미)');
  for (const line of assigns) {
    assert.match(line, /sanitize\(/, `정화를 거치지 않은 innerHTML 대입: ${line}`);
  }
  // DOMPurify 설정에 script/iframe/object/embed가 명시적으로 막혀 있어야 한다.
  for (const tag of ['script', 'iframe', 'object', 'embed', 'annotation-xml']) {
    assert.match(src, new RegExp(`'${tag}'`), `FORBID_TAGS에 ${tag}가 없다`);
  }
});

test('markdownToHtml만 부르면 DOMPurify는 로드되지 않는다(node에서 테스트가 돌 수 있는 이유)', () => {
  // require 캐시에 dompurify가 올라오지 않아야 한다 — 지연 초기화가 살아 있다는 증거.
  const loaded = Object.keys(require.cache).some((k) => k.includes(`${path.sep}dompurify${path.sep}`));
  assert.equal(loaded, false, 'markdownToHtml 경로에서 dompurify가 로드됐다');
});

test('GFM 체크리스트: 체크 여부가 화면에서 구분된다', () => {
  // marked는 - [x] / - [ ] 를 <input type=checkbox>로 만드는데, 정화 설정이 input을 지운다.
  // 그대로 두면 두 항목이 글자 하나 다르지 않게 되어 "완료/미완료"를 읽을 수 없다.
  const html = markdownToHtml('- [x] 끝난 일\n- [ ] 남은 일');
  assert.ok(html.includes('☑'), '체크된 항목은 ☑');
  assert.ok(html.includes('☐'), '안 된 항목은 ☐');
  assert.ok(!/<input/i.test(html), '정화에 지워질 input을 애초에 만들지 않는다');
  // 두 항목이 서로 다르다 — 이게 이 테스트의 핵심
  const items = html.match(/<li>[\s\S]*?<\/li>/g) || [];
  assert.equal(items.length, 2);
  assert.notEqual(items[0], items[1]);
});

test('수식 크기 상한: \\rule 레이아웃 폭탄이 패널을 덮지 않는다', () => {
  // maxSize가 크면 신뢰할 수 없는 LaTeX 한 줄로 화면을 가릴 수 있다.
  const html = markdownToHtml('$\\rule{9999em}{9999em}$');
  const m = html.match(/border-right-width:\s*([\d.]+)em/);
  assert.ok(m, 'rule이 em 단위 폭으로 렌더된다');
  assert.ok(Number(m[1]) <= 5, `상한 5em을 넘지 않아야 하는데 ${m[1]}em`);
});

test('링크: 외부 브라우저로 열리도록 target이 붙는다', () => {
  // target이 없으면 main.js의 will-navigate preventDefault에 막혀 "눌러도 아무 일 없는" 링크가 된다.
  const html = markdownToHtml('[논문](https://arxiv.org/abs/1706.03762)');
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
  // 위험 스킴은 여전히 링크가 되지 않는다
  assert.ok(!/<a /.test(markdownToHtml('[클릭](javascript:alert(1))')));
});
