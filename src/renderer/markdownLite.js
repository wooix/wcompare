// src/renderer/markdownLite.js — LLM이 생성한 마크다운(논문 요약/절 해설)을 화면에 그리기 위한
// 최소 렌더러. marked/markdown-it 같은 외부 의존성을 쓰지 않고 직접 구현한다.
//
// 보안 원칙(반드시 지킬 것): text 인자는 LLM 출력이라 신뢰할 수 없는 입력이다.
// renderMarkdown은 절대로 innerHTML을 쓰지 않는다 — 모든 DOM은 document.createElement +
// textContent만으로 구성한다. parseInline이 뽑아낸 조각(Span)도 textContent로만 꽂히므로,
// 입력에 <script> 같은 HTML 태그 문자열이 섞여 있어도 브라우저가 태그로 해석하지 않고
// 화면에 보이는 그대로의 문자로 남는다 — 우리가 해석하는 마크업은 마크다운 인라인 문법
// (**굵게**, *기울임*, `코드`) 뿐이고, 그 외 모든 문자는 리터럴 텍스트로만 취급한다.
//
// parseMarkdown/parseInline은 DOM 없이 동작하는 순수 함수라 노드 단위 테스트(require)가
// 가능하다(mdToc.js/syncScroll.js의 module.exports 관용구를 그대로 따른다). renderMarkdown만
// DOM을 만지므로 브라우저(렌더러 프로세스)에서만 호출한다.

// LLM 출력이 비정상적으로 길거나(반복·폭주) 리스트 항목이 과도하게 많은 경우를 대비한 상한.
// 정상적인 요약/절 해설 분량에는 전혀 영향이 없고, 망가진 응답이 렌더링을 멎게 하는 것만 막는다.
const MAX_INPUT_CHARS = 200000; // 파싱할 원문 전체 길이 상한
const MAX_BLOCKS = 2000;        // 문서 전체 블록 개수 상한
const MAX_LIST_ITEMS = 1000;    // 리스트 하나당 항목 수 상한
const MAX_LANG_LEN = 32;        // 코드펜스 info string(언어 표기) 길이 상한

// 코드펜스 info string에서 언어 이름만 정화해 꺼낸다 — 첫 단어만 취하고, 클래스명/속성값으로
// 안전한 문자([A-Za-z0-9_+-])만 남긴다(LLM이 임의 문자열을 넣어도 DOM 속성 오염으로 못 이어진다).
function sanitizeLang(raw) {
  const firstWord = String(raw || '').trim().split(/\s+/)[0] || '';
  return firstWord.replace(/[^A-Za-z0-9_+-]/g, '').slice(0, MAX_LANG_LEN);
}

// 마크다운 원문 → 블록 목록. 줄 단위로 한 번 훑으면서 상태(진행 중인 문단/리스트/인용)를
// 유지하다가, 종류가 바뀌는 지점에서 지금까지 모은 것을 블록으로 확정(flush)한다.
function parseMarkdown(text) {
  const raw = text === null || text === undefined ? '' : String(text).slice(0, MAX_INPUT_CHARS);
  const lines = raw.split(/\r\n|\r|\n/);
  const blocks = [];

  function pushBlock(b) {
    if (blocks.length < MAX_BLOCKS) blocks.push(b);
  }

  let paraBuf = [];   // 진행 중인 문단의 줄들
  let listBuf = null; // { ordered, items:[] } 진행 중인 리스트
  let quoteBuf = null; // 진행 중인 인용의 줄들(문자열 배열)

  function flushPara() {
    if (paraBuf.length) {
      const t = paraBuf.join('\n').trim();
      paraBuf = [];
      if (t) pushBlock({ type: 'paragraph', text: t });
    }
  }
  function flushList() {
    if (listBuf) {
      const b = listBuf;
      listBuf = null;
      if (b.items.length) pushBlock({ type: 'list', ordered: b.ordered, items: b.items });
    }
  }
  function flushQuote() {
    if (quoteBuf) {
      const t = quoteBuf.join('\n').trim();
      quoteBuf = null;
      if (t) pushBlock({ type: 'quote', text: t });
    }
  }
  function flushAll() {
    flushPara();
    flushList();
    flushQuote();
  }

  let i = 0;
  while (i < lines.length) {
    if (blocks.length >= MAX_BLOCKS) break; // 상한 도달 시 더 파싱하지 않고 방어적으로 종료
    const line = lines[i];

    // 빈 줄: 진행 중이던 블록을 모두 닫는다(다음 블록과 분리하는 경계).
    if (/^\s*$/.test(line)) {
      flushAll();
      i++;
      continue;
    }

    // 수평선: 하이픈 3개 이상만 인정한다(별표/언더스코어 변형은 지원 범위 밖).
    if (/^ {0,3}-{3,}\s*$/.test(line)) {
      flushAll();
      pushBlock({ type: 'hr' });
      i++;
      continue;
    }

    // 코드펜스(백틱 3개 이상)로 열리는 블록: 닫는 줄(같은 형태의 백틱 전용 줄)까지
    // 그대로 수집한다. 내부는 인라인 마크업을 전혀 해석하지 않는다.
    const fenceOpen = line.match(/^ {0,3}`{3,}(.*)$/);
    if (fenceOpen) {
      flushAll();
      const lang = sanitizeLang(fenceOpen[1]);
      const codeLines = [];
      i++;
      while (i < lines.length) {
        if (/^ {0,3}`{3,}\s*$/.test(lines[i])) { i++; break; }
        codeLines.push(lines[i]);
        i++;
      }
      pushBlock({ type: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

    // 샵 1~6개 제목. # 뒤에 반드시 공백이 있어야 헤딩 → "#hashtag"는 헤딩이 아니다(mdToc.js와 동일 규칙).
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const title = (heading[2] || '').replace(/\s+#+\s*$/, '').trim(); // 닫는 # 시퀀스 제거
      pushBlock({ type: 'heading', level, text: title });
      i++;
      continue;
    }

    // 인용(>): 연속된 인용 줄은 하나의 블록으로 합친다(줄바꿈은 \n으로 보존).
    const quote = line.match(/^ {0,3}>\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      if (!quoteBuf) quoteBuf = [];
      quoteBuf.push(quote[1]);
      i++;
      continue;
    }

    // 목록: 하이픈/별표(비순서) 또는 숫자점(순서). 마커 종류가 바뀌면 새 리스트 블록을 연다
    // (중첩은 지원하지 않는다 — 지원 범위 밖).
    const bullet = line.match(/^ {0,3}[-*]\s+(.*)$/);
    const ordered = !bullet && line.match(/^ {0,3}\d+\.\s+(.*)$/);
    if (bullet || ordered) {
      flushPara();
      flushQuote();
      const isOrdered = !!ordered;
      const itemText = bullet ? bullet[1] : ordered[1];
      if (listBuf && listBuf.ordered === isOrdered) {
        if (listBuf.items.length < MAX_LIST_ITEMS) listBuf.items.push(itemText);
      } else {
        flushList();
        listBuf = { ordered: isOrdered, items: [itemText] };
      }
      i++;
      continue;
    }

    // 그 외: 문단의 연속. 앞서 진행 중이던 리스트/인용은 닫는다.
    flushList();
    flushQuote();
    paraBuf.push(line);
    i++;
  }
  flushAll();

  return blocks;
}

// 인라인 마크업(굵게/기울임/코드) 파서. 왼쪽에서 오른쪽으로 한 글자씩 훑으며, 어떤 마커도
// 짝이 맞지 않으면 그 문자를 리터럴 텍스트로 남긴다(깨지지 않는 것이 중첩 지원보다 우선).
// 인라인 코드(`)를 굵게/기울임보다 먼저 검사해 코드 내용 속의 별표는 해석하지 않는다.
function parseInline(text) {
  const s = String(text === null || text === undefined ? '' : text);
  const spans = [];
  let buf = '';

  function flushText() {
    if (buf) {
      spans.push({ type: 'text', text: buf });
      buf = '';
    }
  }

  let i = 0;
  while (i < s.length) {
    // 인라인 코드: `...` (내용이 비어있지 않아야 한다)
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end !== -1 && end > i + 1) {
        flushText();
        spans.push({ type: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // 굵게: **...** (내용이 비어있지 않아야 한다)
    if (s[i] === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end !== -1 && end > i + 2) {
        flushText();
        spans.push({ type: 'strong', text: s.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // 기울임: *...* (위 굵게 검사에 걸리지 않은 단일 별표만 여기 도달)
    if (s[i] === '*') {
      const end = s.indexOf('*', i + 1);
      if (end !== -1 && end > i + 1) {
        flushText();
        spans.push({ type: 'em', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  flushText();

  return spans;
}

// text(여러 줄 가능, \n 구분)를 parent 아래에 인라인 스팬으로 채운다. 줄바꿈은 <br>로 표현한다
// (createElement로만 만들므로 이 br도 안전하다 — innerHTML 아님).
function appendInlineWithBreaks(parent, text) {
  const lines = String(text === null || text === undefined ? '' : text).split('\n');
  lines.forEach((line, idx) => {
    if (idx > 0) parent.appendChild(document.createElement('br'));
    for (const span of parseInline(line)) {
      if (span.type === 'strong') {
        const el = document.createElement('strong');
        el.className = 'md-strong';
        el.textContent = span.text;
        parent.appendChild(el);
      } else if (span.type === 'em') {
        const el = document.createElement('em');
        el.className = 'md-em';
        el.textContent = span.text;
        parent.appendChild(el);
      } else if (span.type === 'code') {
        const el = document.createElement('code');
        el.className = 'md-icode';
        el.textContent = span.text;
        parent.appendChild(el);
      } else {
        parent.appendChild(document.createTextNode(span.text));
      }
    }
  });
}

// 블록 하나 → DOM 요소 하나. code/hr을 제외하면 모두 appendInlineWithBreaks로 내용을 채운다.
function blockToElement(block) {
  if (block.type === 'heading') {
    const el = document.createElement('h' + block.level);
    el.className = 'md-h' + block.level;
    appendInlineWithBreaks(el, block.text);
    return el;
  }
  if (block.type === 'paragraph') {
    const el = document.createElement('p');
    el.className = 'md-p';
    appendInlineWithBreaks(el, block.text);
    return el;
  }
  if (block.type === 'list') {
    const el = document.createElement(block.ordered ? 'ol' : 'ul');
    el.className = block.ordered ? 'md-ol' : 'md-ul';
    for (const item of block.items) {
      const li = document.createElement('li');
      li.className = 'md-li';
      appendInlineWithBreaks(li, item);
      el.appendChild(li);
    }
    return el;
  }
  if (block.type === 'code') {
    const pre = document.createElement('pre');
    pre.className = 'md-pre';
    const code = document.createElement('code');
    code.className = 'md-code';
    if (block.lang) code.dataset.lang = block.lang;
    code.textContent = block.text; // 코드 내부는 인라인 마크업을 해석하지 않고 그대로 보여준다.
    pre.appendChild(code);
    return pre;
  }
  if (block.type === 'quote') {
    const bq = document.createElement('blockquote');
    bq.className = 'md-quote';
    const p = document.createElement('p');
    p.className = 'md-p';
    appendInlineWithBreaks(p, block.text);
    bq.appendChild(p);
    return bq;
  }
  if (block.type === 'hr') {
    const el = document.createElement('hr');
    el.className = 'md-hr';
    return el;
  }
  return null;
}

// hostEl.replaceChildren(...)로 통째 교체한다. innerHTML은 절대 쓰지 않는다(파일 상단 주석 참고).
function renderMarkdown(hostEl, text) {
  if (!hostEl) return;
  const blocks = parseMarkdown(text);
  const frag = document.createDocumentFragment();
  for (const block of blocks) {
    const el = blockToElement(block);
    if (el) frag.appendChild(el);
  }
  hostEl.replaceChildren(frag);
}

module.exports = { parseMarkdown, parseInline, renderMarkdown };
