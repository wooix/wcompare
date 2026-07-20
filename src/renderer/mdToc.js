// src/renderer/mdToc.js — Markdown 헤딩 목차(TOC). 파서는 순수 함수(단위 테스트 대상),
// createMdToc는 diff 에디터의 side별 드로어 렌더를 담당한다.
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

// side별 드로어 렌더러. leftEl/rightEl은 index.html의 .md-toc div.
// diffEditor의 모델 인스턴스는 고정 재사용(setValue)이므로, onDidChangeContent를 최초 1회만
// 구독하고 300ms 디바운스로 onChange를 통해 앱에 알린다(앱이 표시 규칙을 판단해 render 재호출).
function createMdToc(editorApi, { leftEl, rightEl, onChange } = {}) {
  const els = { left: leftEl, right: rightEl };
  const timers = { left: 0, right: 0 };

  function empty() {
    const d = document.createElement('div');
    d.className = 'toc-empty';
    d.textContent = '(목차 없음)';
    return d;
  }

  // 트리를 toc-item/toc-toggle/toc-title/toc-kids 구조로 렌더(접기/펼치기 UX는 PDF 목차와 동일).
  function renderTree(nodes, side) {
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
        const ed = editorApi.innerOf(side);
        ed.revealLineNearTop(n.line);
        ed.setPosition({ lineNumber: n.line, column: 1 });
        ed.focus();
      });
      frag.appendChild(row);
      if (n.children.length) {
        const kids = document.createElement('div');
        kids.className = 'toc-kids';
        kids.appendChild(renderTree(n.children, side));
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
  function render(side, show) {
    const el = els[side];
    if (!el) return;
    el.classList.toggle('show', !!show);
    if (!show) return; // 숨김 상태의 내용은 재렌더하지 않는다(다음 표시 때 새로 그린다)
    const heads = parseMdHeadings(editorApi.getValue(side));
    el.replaceChildren(heads.length ? renderTree(buildTree(heads), side) : empty());
  }

  for (const side of ['left', 'right']) {
    editorApi.modelOf(side).onDidChangeContent(() => {
      clearTimeout(timers[side]);
      timers[side] = setTimeout(() => onChange && onChange(side), 300);
    });
  }

  return { render };
}

module.exports = { parseMdHeadings, buildTree, createMdToc };
