// src/renderer/summaryToc.js — 절별 요약 탭 전용 헤딩 목차(TOC). 요약 패널의 오른쪽에 붙는다.
//
// mdToc.js가 이미 내놓는 parseMdHeadings/buildTree를 그대로 가져다 쓴다 — 헤딩 파서와 트리 빌더를
// 여기서 다시 만들지 않는다(코드가 다르면 언젠가 동작도 갈린다).
//
// 헤딩 식별 방식(설계의 핵심): 클릭 시 어떤 DOM 헤딩으로 스크롤할지를 제목 문자열이 아니라
// **문서 순서상 몇 번째 헤딩인가**(0-based, ord)로 알려준다. 제목 문자열 매칭은 "실험 결과"처럼
// 같은 제목이 두 절에 나오면 항상 첫 번째만 찾고 끝나 버린다 — ord는 그런 충돌이 없다.
// 전제와 한계: ord는 parseMdHeadings가 원문 마크다운에서 헤딩을 센 순번이고, 통합 담당이 이 값으로
// 실제 DOM에서 찾을 때는 렌더된 절 pane 안의 `querySelectorAll('h1,h2,h3,h4,h5,h6')`의 같은 순번
// 엘리먼트를 쓰면 된다(marked가 ATX 헤딩을 원문 순서 그대로, 하나도 빠짐없이 h1~h6으로 옮긴다는
// 전제). blockquote/list 안에 들여쓴 헤딩처럼 아주 드문 마크다운에서는 parseMdHeadings(줄 시작 #만
// 인식)와 marked가 인식 결과가 갈릴 수 있는데, 이건 mdToc.js도 이미 안고 있는 동일한 한계라
// 이 모듈이 새로 만드는 문제는 아니다.
//
// depth 필터는 "TOC에 몇 단계까지 보여줄지"만 정한다 — 렌더된 마크다운 본문의 헤딩 자체는
// depth와 무관하게 전부 존재한다. 그래서 ord는 반드시 "거르기 전" 배열의 인덱스여야 하고,
// depth를 바꿔 항목이 화면에서 사라져도 남은 항목의 ord는 계속 DOM과 맞아야 한다.
const { parseMdHeadings, buildTree } = require('./mdToc.js');

const DEPTH_MIN = 1;
const DEPTH_MAX = 6;
// KIND_SPEC.sections 프롬프트(src/main/paperSummary.js:166)는 모델에게 절 제목을 반드시
// '## 제목'(h2) 헤딩으로 쓰라고 못박는다 → 실데이터는 사실상 전부 h2 하나뿐이다.
// depth=1이면 논문 대부분에 h1이 없어 TOC가 텅 비어 보이므로, "그 h2가 전부 보이는" 2를
// 기본값으로 삼는다.
const DEPTH_DEFAULT = 2;
// 사용자의 보기 취향이므로 문서가 아니라 localStorage에 둔다 — summaryPanel.js의
// FONT_KEY('wc-sum-font') 관용구를 그대로 따른다.
const DEPTH_KEY = 'wc-sum-toc-depth';
// 목차 접힘(collapse)도 같은 이유로 localStorage에 둔다. depth와는 완전히 다른 축이므로
// 키도 별도로 둔다 — 아래 createSummaryToc의 "두 상태 축" 설명 참고.
const COLLAPSE_KEY = 'wc-sum-toc-collapsed';

// 스토리지 값은 신뢰하지 않는다 — 사람이 손대거나 옛 버전이 남긴 값일 수 있다.
// 정수가 아니거나 1~6 범위를 벗어나면 조용히 기본값으로 되돌린다.

// 예전에는 여기서 stripLeadingNumber로 제목 앞 번호를 떼었다. 그 번호가 옛 outlineDigest가 붙이던
// "평탄화 순번"(계층과 무관한 1,2,3…)이라 PDF의 실제 절 번호와 어긋났기 때문이다.
// 이제 pdfOutline.js의 outlineDigest가 '2.1' 같은 올바른 계층 번호를 직접 매기도록 고쳐졌으므로
// (다른 에이전트 작업, 목표 4번) 이 파일은 더 이상 번호를 떼지 않는다 — 논문 자체의 절 번호와
// 목차 번호가 같아야 한다는 목표에는 "번호를 그대로 보이게" 두는 쪽이 맞다.
// stripLeadingNumber 함수는 완전히 지웠다(주석 처리·미사용 보존이 아니라). 이유: 그 정규식은
// '2.1 Method'처럼 정확히 지금 되살리려는 계층 번호 모양을 노려 지우도록 만들어졌다 — 죽은 코드로
// 남겨 두면 나중에 누군가 "혹시 몰라" 다시 불렀을 때 방금 고친 올바른 번호가 그 즉시 다시
// 떨어져 나가는, 원인을 찾기 어려운 회귀가 재발한다. 지워서 그 가능성 자체를 없앤다.

function clampDepth(n) {
  const v = Number(n);
  if (Number.isInteger(v) && v >= DEPTH_MIN && v <= DEPTH_MAX) return v;
  return DEPTH_DEFAULT;
}

function readDepth() {
  try { return clampDepth(localStorage.getItem(DEPTH_KEY)); } catch { return DEPTH_DEFAULT; }
}

function writeDepth(n) {
  try { localStorage.setItem(DEPTH_KEY, String(n)); } catch { /* 저장 실패 무시(예: 시크릿 모드) */ }
}

// localStorage는 문자열만 돌려준다. depth(clampDepth)와 달리 접힘은 "잘못 해석해도 안전한 쪽"이
// 뚜렷하다 — 접힌 채로 잘못 열려도 손해가 없지만, 펴야 하는데 접힌 채로 굳으면 사용자가
// TOC 자체를 못 찾는다. 그래서 저장값이 정확히 '1'일 때만 접힘으로 보고, 그 외(옛 형식/손상값/
// null/처음 실행)는 전부 펼침 쪽으로 안전하게 떨어진다.
function parseCollapsed(raw) {
  return raw === '1';
}

function readCollapsed() {
  try { return parseCollapsed(localStorage.getItem(COLLAPSE_KEY)); } catch { return false; }
}

function writeCollapsed(v) {
  try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* 저장 실패 무시 */ }
}

// 순수 로직(DOM 없이 테스트 가능): 헤딩 목록 중 depth 이하만 남기고, 원문 배열에서 몇 번째였는지
// (ord)를 함께 붙인다. heads는 parseMdHeadings가 돌려주는 { level, title, line } 배열이다.
function filterByDepth(heads, depth) {
  const d = clampDepth(depth);
  const list = Array.isArray(heads) ? heads : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    if (h && h.level <= d) out.push({ level: h.level, title: h.title, line: h.line, ord: i });
  }
  return out;
}

// hostEl 아래에 목차 UI를 만든다. onJump(heading)은 heading={level,title,line,ord}를 받는다 —
// 실제 스크롤(DOM 조작)은 통합 담당의 몫이다(이 모듈은 sections pane의 존재조차 모른다).
function createSummaryToc(hostEl, { onJump } = {}) {
  const el = document.createElement('div');
  el.className = 'sum-toc';

  // ===== depth 선택 UI =====
  // select/슬라이더 대신 summaryPanel.js의 .sum-font(A−/↺/A+)와 같은 "붙은 버튼 그룹"을 쓴다.
  //  - select는 열고 고르는 2단 조작이라, TOC를 보며 깊이를 이리저리 눌러보는 탐색에는 느리다.
  //  - 슬라이더는 1~6 정수 6칸을 표현하기엔 트랙이 짧고, 이 폭 좁은 드로어에 어울리지 않는다.
  //  - 버튼 그룹은 현재 선택값이 항상 보이고(.on 강조) 클릭 한 번으로 바뀌며, 이미 코드베이스가
  //    쓰는 관용구라 CSS 톤을 그대로 재사용할 수 있다.
  const depthRow = document.createElement('div');
  depthRow.className = 'toc-depth';
  const depthBtns = [];
  for (let n = DEPTH_MIN; n <= DEPTH_MAX; n++) {
    const b = document.createElement('button');
    b.className = 'toc-depth-btn';
    b.type = 'button';
    b.textContent = String(n);
    b.title = `${n}단계까지 보기`;
    b.addEventListener('click', () => setDepth(n));
    depthRow.appendChild(b);
    depthBtns.push(b);
  }

  // 접기 손잡이. 접힌 상태에서도 '반드시 보이는' 유일한 요소라, 접었다가 되돌릴 길이 여기 하나뿐이다
  // (접었더니 목차가 통째로 사라져 다시 펼 방법이 없는 것이 이 기능에서 가장 쉬운 함정이다).
  // 그래서 el의 첫 자식으로 두고, 아래 CSS가 .collapsed일 때 이 버튼만 남기고 나머지를 감춘다.
  const fold = document.createElement('button');
  fold.className = 'toc-fold';
  fold.type = 'button';

  const body = document.createElement('div');
  body.className = 'toc-depth-body';
  el.append(fold, depthRow, body);
  hostEl.appendChild(el);

  let depth = readDepth();
  let lastText = ''; // setDepth가 다시 그릴 때 쓸, 마지막으로 받은 마크다운 원문
  // 상태를 두 축으로 나눈다. visible = "지금 절별 요약 탭인가"(summaryPanel이 정한다),
  // collapsed = "사용자가 접어 두었는가"(사용자가 정한다). 한 플래그로 합치면 접어 둔 채 다른
  // 탭에 갔다 오는 순간 다시 펴진다 — 사용자의 선택이 탭 전환에 씻겨 나가서는 안 된다.
  let visible = false;
  let collapsed = readCollapsed();

  function syncFold() {
    el.classList.toggle('collapsed', collapsed);
    fold.textContent = collapsed ? '☰' : '›';
    fold.title = collapsed ? '목차 펼치기' : '목차 접기';
  }

  function syncDepthBtns() {
    for (let i = 0; i < depthBtns.length; i++) depthBtns[i].classList.toggle('on', i + 1 === depth);
  }

  function empty(msg) {
    const d = document.createElement('div');
    d.className = 'toc-empty';
    d.textContent = msg || '(목차 없음)';
    return d;
  }

  // mdToc.js의 renderTree와 같은 접기/펼치기 구조. 클릭 동작만 에디터 스크롤 대신 onJump 위임으로 바꾼다.
  function renderTree(nodes) {
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const row = document.createElement('div');
      row.className = 'toc-item';
      const tog = document.createElement('span');
      tog.className = 'toc-toggle';
      const title = document.createElement('span');
      title.className = 'toc-title';
      title.textContent = n.title || '(제목 없음)';
      row.append(tog, title);
      row.addEventListener('click', () => {
        onJump && onJump({ level: n.level, title: n.title, line: n.line, ord: n.ord });
      });
      frag.appendChild(row);
      if (n.children.length) {
        const kids = document.createElement('div');
        kids.className = 'toc-kids';
        kids.appendChild(renderTree(n.children));
        frag.appendChild(kids);
        tog.textContent = '▾';
        tog.addEventListener('click', (e) => {
          e.stopPropagation(); // 행 클릭(점프)과 분리
          tog.textContent = kids.classList.toggle('collapsed') ? '▸' : '▾';
        });
      }
    }
    return frag;
  }

  function doRender() {
    const heads = parseMdHeadings(lastText);
    const filtered = filterByDepth(heads, depth);
    // 이 문서에 실제로 있는 레벨만 누를 수 있게 한다. 요약 프롬프트가 절 제목을 '## 제목'으로
    // 못박는 탓에 실데이터는 거의 h2뿐인데, 6칸을 다 열어 두면 2~6은 전부 같은 결과를 내는
    // 먹통 버튼이 되고 1은 목차를 텅 비운다. 그 값이 localStorage에 영구 저장되므로, 호기심에
    // 한 번 누른 사용자는 다른 논문을 열어도 계속 빈 목차를 보며 "고장 났다"고 여기게 된다.
    // "1단계 위로 더"까지는 열어 둔다 — 그 위는 눌러도 결과가 같아 열어 둘 이유가 없다.
    const maxLevel = heads.reduce((m, h) => Math.max(m, h.level), 0);
    for (let i = 0; i < depthBtns.length; i++) {
      const n = i + 1;
      // 헤딩이 아직 없으면(생성 전) 잠그지 않는다 — 내용이 오면 다시 판정한다.
      depthBtns[i].disabled = maxLevel > 0 && n > maxLevel;
    }
    if (filtered.length) {
      body.replaceChildren(renderTree(buildTree(filtered)));
      return;
    }
    // 비었을 때 원인을 말해 준다. 헤딩은 있는데 depth가 낮아 걸러진 경우가 실제 함정이라,
    // 빠져나오는 방법(어느 숫자를 누르면 되는지)까지 문구에 담는다.
    body.replaceChildren(empty(maxLevel > 0 && depth < maxLevel
      ? `이 깊이에는 항목이 없습니다 — ${maxLevel}을 눌러 보세요`
      : '(목차 없음)'));
  }

  // 절별 요약 pane이 다시 그려질 때마다 통합 담당이 호출한다. 인자는 "실제로 렌더에 쓰인" 마크다운
  // 원문이어야 한다(예: summaryPanel의 MAX_TEXT로 잘린 뒤의 t) — 그래야 ord가 렌더된 DOM 헤딩
  // 개수와 어긋나지 않는다.
  function render(markdownText) {
    lastText = String(markdownText ?? '');
    doRender();
  }

  function setDepth(n) {
    const next = clampDepth(n);
    if (next === depth) return; // 값이 그대로면 저장도, 재렌더도 하지 않는다
    depth = next;
    writeDepth(depth);
    syncDepthBtns();
    doRender();
  }

  function setVisible(show) {
    visible = !!show;
    el.classList.toggle('show', visible); // 접힘과 무관한 축 — 접혀 있어도 탭이 맞으면 손잡이는 보인다
  }

  function setCollapsed(v) {
    const next = !!v;
    if (next === collapsed) return; // 값이 그대로면 저장도 하지 않는다
    collapsed = next;
    writeCollapsed(collapsed);
    syncFold();
  }

  fold.addEventListener('click', () => setCollapsed(!collapsed));
  syncDepthBtns();
  syncFold();

  return {
    el,
    render,
    setDepth,
    getDepth: () => depth,
    setVisible,
    setCollapsed,
    isCollapsed: () => collapsed,
  };
}

module.exports = { filterByDepth, clampDepth, parseCollapsed, createSummaryToc };
