// src/renderer/mdToc.js — Markdown 헤딩 목차(TOC), 왼쪽 전용.
// 사용자 결정: TOC 드로어는 diff 모드에서 왼쪽 창에만 나타난다. 오른쪽 파일은 "비교 대상"일 뿐
// 사용자가 순서대로 읽어 내려가는 주 문서가 아니므로, 오른쪽에 별도 TOC를 붙이면 두 개의 드로어가
// 화면을 잡아먹으면서도 어느 쪽을 봐야 할지 헷갈리게 만든다. 그래서 오른쪽 드로어 자체를 없앴다.
// 파서는 순수 함수(단위 테스트 대상), createMdToc는 왼쪽 diff 에디터의 드로어 렌더만 담당한다.
// languageMap.js처럼 module.exports 라 node 단위 테스트가 require 할 수 있고,
// app.js는 esbuild 번들에서 ESM import로 가져온다(document는 createMdToc 호출 시점에만 참조).

// ATX 헤딩(1~6개 # + 공백 + 제목)을 { level, title, line } 목록으로 파싱한다.
// 펜스 코드 블록(백틱 3개 또는 물결 3개로 열고 닫는 구간) 내부의 #은 무시한다.
function parseMdHeadings(text) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  const out = [];
  let fence = null; // 열린 펜스 문자('`' 또는 '~'), null이면 코드블록 밖
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 펜스 열림/닫힘 — 최대 3칸 들여쓰기 허용, 같은 종류의 3개+로만 닫힌다(CommonMark 근사).
    const fm = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fm && fm[1][0] === fence) fence = null;
      continue; // 코드블록 내부 라인은 헤딩 검사에서 제외
    }
    if (fm) { fence = fm[1][0]; continue; }
    // # 뒤에 반드시 공백이 있어야 헤딩 → "#hashtag"(공백 없음)는 헤딩이 아니다.
    const hm = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (!hm) continue;
    const level = hm[1].length;
    const title = (hm[2] || '').replace(/\s+#+\s*$/, '').trim(); // 닫는 # 시퀀스 제거
    out.push({ level, title, line: i + 1 });
  }
  return out;
}

// 평평한 헤딩 목록을 level 기준 중첩 트리로 만든다.
function buildTree(heads) {
  const root = { level: 0, children: [] };
  const stack = [root];
  for (const h of heads) {
    const node = { ...h, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

// 왼쪽 드로어 렌더러. leftEl은 index.html의 #md-toc-left(.md-toc) div.
// diffEditor의 모델 인스턴스는 고정 재사용(setValue)이므로, onDidChangeContent를 최초 1회만
// 구독하고 300ms 디바운스로 onChange를 통해 앱에 알린다(앱이 표시 규칙을 판단해 render 재호출).
function createMdToc(editorApi, { leftEl, onChange } = {}) {
  let timer = 0;

  function empty() {
    const d = document.createElement('div');
    d.className = 'toc-empty';
    d.textContent = '(목차 없음)';
    return d;
  }

  // 트리를 toc-item/toc-toggle/toc-title/toc-kids 구조로 렌더(접기/펼치기 UX는 PDF 목차와 동일).
  // side가 사라져 항상 왼쪽 에디터로 고정 이동한다.
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
        const ed = editorApi.innerOf('left');
        ed.revealLineNearTop(n.line);
        ed.setPosition({ lineNumber: n.line, column: 1 });
        ed.focus();
      });
      frag.appendChild(row);
      if (n.children.length) {
        const kids = document.createElement('div');
        kids.className = 'toc-kids';
        kids.appendChild(renderTree(n.children));
        frag.appendChild(kids);
        tog.textContent = '▾';
        tog.addEventListener('click', (e) => {
          e.stopPropagation(); // 행 클릭(라인 이동)과 분리
          tog.textContent = kids.classList.toggle('collapsed') ? '▸' : '▾';
        });
      }
    }
    return frag;
  }

  // show=false면 드로어를 숨기고(클래스 제거), show=true면 현재 내용으로 다시 렌더한다.
  // 시그니처를 render(side, show)에서 render(show)로 바꿨다: 드로어가 왼쪽 하나뿐이라 side 인자는
  // 항상 'left' 고정값만 넘어오는 죽은 매개변수가 된다. 호출부(app.js)가 side별로 두 번 부르던
  // 코드도 한 번으로 줄어 "왼쪽 전용"이라는 불변조건이 호출부 시그니처에도 드러난다.
  function render(show) {
    if (!leftEl) return;
    leftEl.classList.toggle('show', !!show);
    if (!show) return; // 숨김 상태의 내용은 재렌더하지 않는다(다음 표시 때 새로 그린다)
    const heads = parseMdHeadings(editorApi.getValue('left'));
    leftEl.replaceChildren(heads.length ? renderTree(buildTree(heads)) : empty());
  }

  // 오른쪽 문서가 바뀌어도 왼쪽 TOC는 바뀔 이유가 없으므로 왼쪽 모델만 구독한다.
  editorApi.modelOf('left').onDidChangeContent(() => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange && onChange(), 300);
  });

  return { render };
}

module.exports = { parseMdHeadings, buildTree, createMdToc };
