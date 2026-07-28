// src/renderer/markdownView.js — 논문 요약 패널(Overview/절별 요약)의 마크다운 + LaTeX 수식 렌더러.
// 자체 최소 렌더러(markdownLite)를 대체한다. 직접 만든 파서는 표·링크·중첩 목록을 지원하지 못했고,
// 무엇보다 논문 요약에 흔히 섞여 오는 `$N$`, `$$...$$` 를 그대로 노출해 사용자 화면에 달러 기호가
// 보였다. 그래서 marked(파싱) + KaTeX(수식) + DOMPurify(정화) 조합으로 바꾼다.
//
// 보안 원칙(반드시 지킬 것): text 인자는 LLM 출력이라 신뢰할 수 없는 입력이다.
// markdownLite는 innerHTML을 아예 쓰지 않는 방식으로 이걸 막았지만, marked는 HTML "문자열"을
// 돌려주므로 innerHTML이 불가피하다. 그래서 방어선을 renderMarkdown 한 곳으로 모은다:
//   markdownToHtml() 결과는 **정화 전**이고(마크다운 원문의 raw HTML이 그대로 살아 있다),
//   DOM에 들어가기 직전 DOMPurify.sanitize를 반드시 통과한다. 정화는 renderMarkdown의 책임이다.
// DOMPurify를 못 얻으면 HTML을 넣지 않고 원문을 textContent로만 보여준다(fail-closed).
//
// 모듈 형태: mdToc.js/markdownLite.js와 같은 module.exports 관용구다. 덕분에
//   - node 단위 테스트가 require('...').markdownToHtml 로 순수 함수만 검증할 수 있고,
//   - summaryPanel.js는 esbuild 번들에서 `import { renderMarkdown }` 으로 그대로 가져온다.
// DOMPurify만 DOM(window)을 요구하므로 지연 초기화한다 — markdownToHtml만 부르는 node 테스트는
// DOMPurify를 아예 로드하지 않는다.

const markedMod = require('marked');
const katexMod = require('katex');

// marked/katex는 배포 형태(ESM/CJS)에 따라 네임스페이스로 들어올 수 있다. esbuild 번들과
// node require에서 같은 값을 얻도록 한 겹 벗겨 준다.
function interop(mod) {
  return mod && mod.default && !mod.Marked && !mod.renderToString ? mod.default : mod;
}
const { Marked } = interop(markedMod);
const katex = interop(katexMod);

// LLM 출력이 비정상적으로 길 때(반복·폭주) 렌더가 통째로 멎는 것을 막는 상한.
// summaryPanel도 같은 값으로 자르지만, 이 모듈만 따로 불릴 수 있으니 여기서도 지킨다.
const MAX_INPUT_CHARS = 200000;

// 링크에 허용할 스킴. 논문 요약에 나올 수 있는 것은 http(s)/mailto와 문서 내 앵커뿐이다.
// javascript:, data:, file:, vbscript: 는 전부 여기서 걸린다. DOMPurify도 같은 것을 막지만,
// 정화 전 문자열(markdownToHtml 결과)에도 위험 스킴이 남지 않게 이중으로 건다.
const SAFE_HREF = /^(?:https?:|mailto:|#)/i;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

// ===== 수식 =====

// KaTeX 옵션을 한 곳에 모은다.
//  - throwOnError:false — 잘못된 LaTeX 하나가 요약 전체를 날리면 안 된다. KaTeX가 원문을
//    errorColor(#cc0000) 빨간 글씨로 남기고 넘어간다.
//  - trust:false(기본값이지만 명시) — \href, \url, \includegraphics 같이 URL/리소스를 만드는
//    명령을 전부 막는다. 신뢰할 수 없는 입력이므로 수식이 링크를 만들 수 있어선 안 된다.
//  - strict:'ignore' — LLM 출력엔 사소한 문법 경고가 흔하다. 콘솔을 채우기만 하고 사용자에겐
//    아무 의미가 없어 끈다.
//  - maxSize/maxExpand — \rule{9999em}{9999em} 류의 레이아웃 폭탄과 매크로 확장 폭탄 방어.
function texToHtml(tex, displayMode) {
  const src = String(tex ?? '');
  try {
    return katex.renderToString(src, {
      displayMode,
      throwOnError: false,
      errorColor: '#cc0000',
      trust: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
      // 50em은 방어가 되지 않는다 — 기본 글씨 13px에서 786px짜리 검은 사각형이 나와
      // 384px 폭 요약 패널을 가득 채우고 뒤 본문을 화면 밖으로 밀어낸다(실측).
      // 정상 수식은 이만한 명시 크기를 쓰지 않으므로 5em으로 좁힌다.
      maxSize: 5,
      maxExpand: 1000,
    });
  } catch {
    // throwOnError:false로도 막히지 않는 예외(예: maxExpand 초과)가 남는다. 이때도 죽지 않고
    // 원문을 빨간 글씨로 남긴다 — 사용자는 "여기 수식이 있었는데 못 그렸구나"를 알 수 있다.
    return `<span class="math-error" style="color:#cc0000">${escapeHtml(src)}</span>`;
  }
}

// marked에는 수식 문법이 없어 확장(extension)을 직접 붙인다.
// (marked-katex-extension 패키지는 katex를 0.18 미만으로 묶어서 쓰지 않는다.)
//
// 코드블록/인라인 코드 안의 `$`가 수식이 되지 않는 이유: marked의 tokenizer는 남은 원문(src)의
// **맨 앞**만 본다. 코드펜스나 백틱을 만나면 code 계열 tokenizer가 그 구간을 통째로 소비하므로,
// 그 안의 `$`는 애초에 src의 맨 앞에 오지 못한다. 우리 tokenizer는 `^\$`에서만 매치하므로
// 자연히 코드 내부를 건드리지 않는다(test/markdownView.test.js에서 이걸 증명한다).
//
// 통화 표기와 가르는 규칙은 pandoc의 판정을 그대로 따른다:
//   여는 $ 바로 뒤에 공백이 오면 안 되고, 닫는 $ 바로 앞에 공백이 오면 안 되며,
//   닫는 $ 바로 뒤에 숫자가 오면 안 된다.
// 그래서 "가격은 $5 입니다"(닫는 $ 없음), "$5 and $10"(닫는 $ 앞이 공백), "$5and$10"(닫는 $ 뒤가
// 숫자)은 모두 수식이 아니고, "$N$"이나 "$x_1$"은 수식이 된다. 인라인 수식은 줄바꿈을 넘지 못하게
// 해서 짝이 안 맞는 $ 하나가 문단 전체를 삼키는 일도 막는다.
const INLINE_DISPLAY_RE = /^\$\$(?!\$)([^\n]+?)\$\$/;
const INLINE_MATH_RE = /^\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\d)/;
// 블록 디스플레이 수식: 줄 맨 앞(들여쓰기 3칸까지)의 $$ 로 열고 $$ 로 닫는다. 4칸 이상 들여쓴
// 줄은 여기서 걸리지 않아 marked의 indented code로 넘어간다.
const BLOCK_DISPLAY_RE = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/;

const mathBlockExtension = {
  name: 'mathBlock',
  level: 'block',
  // start는 "문단을 어디서 끊어야 하는지" 알려 준다. 없으면 paragraph tokenizer가 뒤따르는
  // 수식 줄까지 통째로 먹어 버린다. 다만 아무 $$나 가리키면 안 된다 — 문장 중간의 "…$$a$$…"에서
  // 문단이 잘려 인라인 수식으로 처리될 기회를 잃는다. 그래서 실제로 블록 수식으로 닫히는
  // 위치만 돌려준다.
  start(src) {
    const re = /(?:^|\n) {0,3}\$\$/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const at = m[0][0] === '\n' ? m.index + 1 : m.index;
      if (BLOCK_DISPLAY_RE.test(src.slice(at))) return at;
    }
    return -1;
  },
  tokenizer(src) {
    const m = BLOCK_DISPLAY_RE.exec(src);
    if (!m) return undefined;
    return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
  },
  renderer(token) { return `${texToHtml(token.text, true)}\n`; },
};

const mathInlineExtension = {
  name: 'mathInline',
  level: 'inline',
  // 역슬래시로 이스케이프한 \$ 앞에서는 끊지 않는다 — 끊으면 marked의 escape tokenizer가
  // \$ 를 처리할 기회를 잃고 역슬래시가 화면에 남는다.
  start(src) { const m = /(?<!\\)\$/.exec(src); return m ? m.index : -1; },
  tokenizer(src) {
    const d = INLINE_DISPLAY_RE.exec(src);
    if (d) return { type: 'mathInline', raw: d[0], text: d[1].trim(), display: true };
    const i = INLINE_MATH_RE.exec(src);
    if (i) return { type: 'mathInline', raw: i[0], text: i[1].trim(), display: false };
    return undefined;
  },
  renderer(token) { return texToHtml(token.text, !!token.display); },
};

// ===== marked =====

// 전역 marked를 건드리지 않도록 전용 인스턴스를 쓴다(다른 모듈이 marked를 쓰게 돼도 서로 간섭 없음).
//  - gfm/breaks: markdownLite는 문단 안의 줄바꿈을 <br>로 그렸다. 그 화면을 그대로 유지하려고
//    breaks를 켠다(LLM은 한 문단을 한 줄로 뽑기도, 여러 줄로 접어 뽑기도 한다).
//  - pedantic:false — GFM 표/취소선을 쓰기 위한 기본값.
const md = new Marked({ gfm: true, breaks: true, pedantic: false });

md.use({
  extensions: [mathBlockExtension, mathInlineExtension],
  renderer: {
    // GFM 체크리스트(- [x] / - [ ])는 marked가 <input type="checkbox" disabled>로 만드는데,
    // 아래 정화 설정이 input을 통째로 지운다 → 체크된 항목과 안 된 항목이 화면에서
    // 글자 하나 다르지 않게 된다(실측). input을 허용해 정화를 느슨하게 하는 대신
    // 문자로 바꾼다 — 읽기 전용 요약에서는 이 편이 안전하고 결과도 같다.
    checkbox({ checked }) {
      return `<span class="md-check">${checked ? '☑' : '☐'}</span> `;
    },
    // 링크는 살리되 위험 스킴은 링크 자체를 버리고 글자만 남긴다.
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!SAFE_HREF.test(String(href || '').trim())) return text;
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      // target="_blank"가 있어야 링크가 실제로 열린다. 이 창은 main.js가 will-navigate를
      // preventDefault해 같은 프레임 이동을 막으므로, target 없이는 논문 요약에 흔한 DOI·arXiv
      // 링크가 "눌러도 아무 일 없는" 죽은 링크가 된다(실측). target이 붙으면
      // setWindowOpenHandler → shell.openExternal 경로를 타 외부 브라우저에서 열린다.
      // 스킴은 위 SAFE_HREF와 DOMPurify가 이중으로 좁혀 두었다(javascript:·data: 불가).
      return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noreferrer noopener">${text}</a>`;
    },
  },
});

// 마크다운 + 수식 → HTML 문자열. **정화 전** 결과다(원문의 raw HTML이 그대로 남아 있을 수 있다).
// DOM 없이 동작하는 순수 함수라 node 단위 테스트가 그대로 부를 수 있다.
function markdownToHtml(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  try {
    return md.parse(raw.slice(0, MAX_INPUT_CHARS));
  } catch {
    // 파서가 예외를 던져도(있어선 안 되지만) 패널이 빈 화면이 되는 것보다 원문을 보여주는 게 낫다.
    return `<pre><code>${escapeHtml(raw.slice(0, MAX_INPUT_CHARS))}</code></pre>`;
  }
}

// ===== 정화 =====

// DOMPurify 설정. KaTeX가 만드는 MathML/SVG가 살아남아야 수식이 보이므로 세 프로필을 켠다.
//  - USE_PROFILES로 html/mathMl/svg만 켠다. svgFilters(feGaussianBlur 등)는 KaTeX가 쓰지 않아 뺀다.
//  - ADD_TAGS: KaTeX MathML은 <semantics>/<annotation encoding="application/x-tex">로 감싸는데
//    DOMPurify 기본 목록엔 둘 다 없다. 빼면 annotation 안의 LaTeX 원문이 텍스트로 새어 나온다.
//  - annotation-xml은 일부러 넣지 않고 FORBID_TAGS에 못박는다. 이건 MathML→HTML 네임스페이스
//    전환점(HTML integration point)이라 mXSS 통로로 알려져 있고, KaTeX는 쓰지도 않는다.
//    같은 이유로 SVG의 foreignObject/use는 DOMPurify 기본값이 이미 막고 있다.
//  - 즉 MathML/SVG를 켜서 생기는 추가 위험은 "네임스페이스를 넘나드는 태그"인데, 그 통로를 전부
//    닫았으므로 새 구멍은 생기지 않는다. 스크립트 실행 경로(script/iframe/object/embed/on*)는
//    아래에서 다시 명시적으로 막는다.
//  - ALLOWED_URI_REGEXP는 **일부러 기본값을 쓴다.** DOMPurify는 이 정규식을 href/src뿐 아니라
//    URI_SAFE_ATTRIBUTES(alt/class/id/style/title/xmlns 등)에 없는 **모든 속성값**에 적용한다.
//    http(s)/mailto로 좁히면 KaTeX SVG의 d="M95,702c…", viewBox="0 0 400000 1080",
//    annotation의 encoding="application/x-tex"까지 함께 잘려 수식이 깨진다. 기본값은
//    javascript:·data:·vbscript: 같은 스킴을 이미 막고, 링크 스킴은 위 link 렌더러에서 한 번 더
//    https?/mailto/앵커로 좁혀 놓았다(정화 전 문자열에도 위험 스킴이 남지 않는다).
const PURIFY_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ['semantics', 'annotation'],
  FORBID_TAGS: [
    'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select',
    'style', 'link', 'base', 'meta', 'annotation-xml', 'foreignobject', 'use',
  ],
  // on* 이벤트 핸들러는 DOMPurify가 기본으로 전부 제거하지만(허용 목록에 없음),
  // 의도를 남기려고 대표적인 것들과 위험한 속성을 명시한다.
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'formaction', 'srcset', 'ping'],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
};

let purifier; // undefined=아직 안 봄, null=쓸 수 없음, 객체=사용 가능

// DOMPurify는 window가 있어야 sanitize가 붙는다(없으면 팩토리 함수만 돌아온다).
// 그래서 import 시점이 아니라 renderMarkdown에서 처음 필요할 때 초기화한다 —
// markdownToHtml만 부르는 node 테스트는 dompurify를 아예 건드리지 않는다.
function getPurifier() {
  if (purifier !== undefined) return purifier;
  purifier = null;
  try {
    const mod = require('dompurify');
    const candidates = [mod, mod && mod.default];
    for (const c of candidates) {
      if (c && typeof c.sanitize === 'function') { purifier = c; break; }
    }
    if (!purifier && typeof window !== 'undefined') {
      for (const c of candidates) {
        if (typeof c === 'function') {
          const inst = c(window);
          if (inst && typeof inst.sanitize === 'function') { purifier = inst; break; }
        }
      }
    }
  } catch {
    purifier = null;
  }
  return purifier;
}

// hostEl을 통째로 교체한다. 정화되지 않은 HTML은 어떤 경우에도 DOM에 들어가지 않는다.
function renderMarkdown(hostEl, text) {
  if (!hostEl) return;
  const html = markdownToHtml(text);
  if (!html) { hostEl.replaceChildren(); return; }

  const dp = getPurifier();
  if (!dp) {
    // fail-closed: 정화기를 못 얻었으면 HTML을 넣지 않는다. 마크다운 원문을 글자로만 보여준다
    // (textContent라 어떤 태그도 해석되지 않는다).
    hostEl.replaceChildren();
    const pre = document.createElement('pre');
    pre.textContent = String(text ?? '').slice(0, MAX_INPUT_CHARS);
    hostEl.appendChild(pre);
    return;
  }

  hostEl.replaceChildren();
  hostEl.innerHTML = dp.sanitize(html, PURIFY_CONFIG); // 정화 후에만 innerHTML에 대입한다
}

module.exports = { markdownToHtml, renderMarkdown };
