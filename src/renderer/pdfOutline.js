// src/renderer/pdfOutline.js — PDF 목차(outline)를 절 단위로 펴서 LLM 요약 프롬프트 재료를 만든다.
// 전부 순수 함수라 pdf.js/DOM 없이 단위 테스트할 수 있다(mdToc.js/syncScroll.js와 같은 module.exports 관용구).
// dest→page 변환처럼 pdf.js 문서 객체가 필요한 비동기 작업은 이 모듈 밖(오케스트레이터)의 책임이고,
// 여기 들어오는 FlatItem에는 이미 페이지 번호(startPage)가 채워져 있다고 가정한다.

// pdf.js OutlineNode 트리 { title, dest, url, items:[...] }를 문서 순서대로 평탄화한다.
// depth는 1부터 시작(최상위 항목 = 1). maxDepth=2 기본값은 "장-절" 2단계까지만 취한다는 뜻이다 —
// 논문 목차는 보통 그 정도면 충분하고, 더 깊이 들어가면 절별 요약이 산만해진다.
// 깊이 초과 노드는 자손도 구조적으로 전부 초과이므로 그 지점에서 순회를 멈춘다(자손을 훑을 필요가 없다).
function flattenOutline(items, { maxDepth = 2, maxItems = 60 } = {}) {
  const out = [];

  function walk(nodes, depth) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (out.length >= maxItems) return; // 이미 상한 도달 — 남은 형제도 더 볼 필요 없다
      if (depth <= maxDepth) {
        const title = typeof node?.title === 'string' ? node.title.trim() : '';
        // 제목이 없는 항목(공백뿐인 경우 포함)은 결과에서 빼지만, 자식은 원래 깊이 그대로 순회한다 —
        // "숨은 그룹 헤더" 하나 때문에 그 아래 실제 절들까지 통째로 사라지면 안 되기 때문이다.
        if (title) {
          out.push({ title, depth, dest: node?.dest });
          if (out.length >= maxItems) return;
        }
        walk(node?.items, depth + 1);
      }
      if (out.length >= maxItems) return; // 방금 처리한 노드(+자손)로 상한을 채웠으면 중단
    }
  }

  walk(items, 1);
  return out;
}

// flat 각 항목의 startPage(number|null)를 정리한다.
// null인 항목은 "바로 다음(문서 순서상 더 뒤)의 유효한 startPage"를 물려받는다 — 끊어진 dest나
// 그룹핑용 헤더 항목이 그 아래 실제 절들과 같은 페이지에서 시작한다고 보는 편이 목차 상 자연스럽다.
// 끝까지 유효한 값이 없으면(꼬리가 전부 null) null로 남겨 호출자가 버리게 한다.
function resolveStartPages(flat) {
  const resolved = new Array(flat.length).fill(null);
  let nextValid = null;
  for (let i = flat.length - 1; i >= 0; i--) {
    const sp = flat[i]?.startPage;
    if (typeof sp === 'number' && Number.isFinite(sp)) nextValid = sp;
    resolved[i] = nextValid;
  }
  return resolved;
}

// flat(FlatItem & { startPage })을 절 단위 페이지 범위로 바꾼다.
// 절의 끝 = 다음 항목의 startPage, 마지막 항목의 끝 = pageCount.
// 주의: 같은 페이지에서 여러 절이 시작하면 startPage와 endPage가 같아져 그 절의 페이지 범위가
// 비게 된다 — 페이지 단위로 절을 자르는 방식 자체의 원리적 한계이며, 잘못이 아니라 의도된 결과다.
function sectionRanges(flat, pageCount) {
  const list = Array.isArray(flat) ? flat : [];
  const resolvedStarts = resolveStartPages(list);

  // startPage를 끝내 못 찾은 항목(꼬리가 전부 null)은 버린다.
  const kept = [];
  for (let i = 0; i < list.length; i++) {
    if (resolvedStarts[i] === null) continue; // resolveStartPages는 항상 number 아니면 null만 반환한다
    kept.push({ title: list[i]?.title, depth: list[i]?.depth, startPage: resolvedStarts[i] });
  }

  // 역행 방어: dest가 뒤섞여 startPage가 앞 절보다 작아지는 깨진 목차가 있을 수 있다.
  // 앞 절의 시작 페이지로 끌어올려 최소한 뒤로 되돌아가지는 않게 한다(음수 길이 range 방지) —
  // 결과적으로 "같은 페이지에서 시작하는 절"과 동일하게 취급되어 위의 원리적 한계로 흡수된다.
  let prevStart = -Infinity;
  for (const item of kept) {
    if (item.startPage < prevStart) item.startPage = prevStart;
    prevStart = item.startPage;
  }

  return kept.map((item, i) => ({
    title: item.title,
    depth: item.depth,
    startPage: item.startPage,
    endPage: i < kept.length - 1 ? kept[i + 1].startPage : pageCount,
  }));
}

// "p.시작-끝" 형태의 페이지 표기. endPage는 다음 절의 시작(배타적 경계)이라 실제 마지막 페이지는
// endPage-1이다. 그 값이 startPage 이하면(겹침으로 페이지가 비는 경우 포함) 시작 페이지 하나만 보여준다.
function pageRangeLabel(startPage, endPage) {
  if (typeof startPage !== 'number' || !Number.isFinite(startPage)) return '(페이지 정보 없음)';
  const lastPage = endPage - 1;
  return lastPage > startPage ? `p.${startPage}-${lastPage}` : `p.${startPage}`;
}

// pageTexts(0-based, pageTexts[0]=1페이지)에서 [startPage, endPage-1] 구간 텍스트를 이어붙인다.
// 범위가 비었거나(겹침으로 endPage-1 < startPage) 페이지가 배열 밖이면 조용히 건너뛴다 —
// 신뢰할 수 없는 입력(페이지 수 불일치 등)에 방어적으로 대응한다.
//
// 그 방어는 인덱스 접근뿐 아니라 "루프 횟수"에도 있어야 한다. 깨진 목차나 잘못 계산된 pageCount로
// endPage가 터무니없이 크게 들어오면(예: 1e9) 배열 밖 페이지를 수억 번 헛도느라 렌더러가 통째로 멎는다.
// 배열 밖 페이지는 어차피 버려지므로 순회 구간을 pageTexts 경계로 미리 잘라 둔다 — 결과는 같고 시간만 유한해진다.
function collectPageText(pageTexts, startPage, endPage) {
  if (typeof startPage !== 'number' || !Number.isFinite(startPage)) return '';
  const lastPage = endPage - 1;
  if (!Number.isFinite(lastPage) || lastPage < startPage) return '';
  const pageCount = Number.isFinite(pageTexts?.length) ? pageTexts.length : 0;
  const from = Math.max(1, startPage); // 1보다 작은 페이지는 배열 앞쪽 밖이라 볼 것이 없다
  const to = Math.min(lastPage, pageCount);
  const chunks = [];
  for (let p = from; p <= to; p++) {
    const t = pageTexts[p - 1];
    if (typeof t === 'string' && t.trim()) chunks.push(t.trim());
  }
  return chunks.join('\n');
}

// 절 하나를 "## N. 제목 (p.시작-끝)\n본문" 블록으로 만든다. 본문이 없으면 제목 줄만 남긴다.
// 절당 상한(maxCharsPerSection)을 넘으면 잘라내고 잘렸다는 표시를 붙인다.
function buildSectionBlock(range, index, pageTexts, maxCharsPerSection) {
  const title = range?.title || '(제목 없음)';
  const header = `## ${index + 1}. ${title} (${pageRangeLabel(range?.startPage, range?.endPage)})`;
  const body = collectPageText(pageTexts, range?.startPage, range?.endPage);
  if (!body) return header;
  const truncated = body.length > maxCharsPerSection;
  const clipped = truncated ? body.slice(0, maxCharsPerSection) : body;
  return truncated ? `${header}\n${clipped}\n…(절 길이 제한으로 이하 생략)` : `${header}\n${clipped}`;
}

// ranges + pageTexts → LLM 프롬프트에 넣을 절별 평문 다이제스트.
// 절당 상한은 절 단위로 먼저 적용하고, 그다음 전체를 이어붙인 결과에 전체 상한을 적용한다
// (전체 상한 절단은 절 경계를 존중하지 않을 수 있지만, 어차피 프롬프트 재료일 뿐이라 단순함을 우선한다).
function sectionsDigest(ranges, pageTexts, { maxCharsPerSection = 6000, maxTotalChars = 120000 } = {}) {
  const list = Array.isArray(ranges) ? ranges : [];
  const joined = list
    .map((r, i) => buildSectionBlock(r, i, pageTexts, maxCharsPerSection))
    .join('\n\n');
  if (joined.length <= maxTotalChars) return joined;
  return `${joined.slice(0, maxTotalChars)}\n…(전체 길이 제한으로 이후 생략)`;
}

// 제목이 이미 "1", "1.1", "2.3." 같은 번호로 시작하는지 판정한다.
// 많은 PDF가 목차 제목 자체에 '1 Introduction'/'2.1 Method'처럼 논문 번호를 담아 온다 —
// 그런 제목에 우리 번호를 또 붙이면 '1. 1 Introduction'처럼 이중으로 매겨진다.
// 판정 정규식은 "숫자(.숫자)* 뒤에 구분자(옵션)와 공백, 그다음 실제 글자"가 와야만 맞는다고
// 좁게 잡았다 — 아래 세 문구가 실제로 이 정규식을 피해 가야 하는 반증 사례다.
//   '3D Reconstruction'      → 숫자 바로 뒤에 문자가 붙어 있어 구분자도 공백도 없다.
//   'GPT-4 judgments'        → 애초에 제목이 숫자로 시작하지 않는다.
//   'Proof of Lemma 1 and 2' → 숫자가 제목 끝 쪽에 있을 뿐 맨 앞이 아니다.
// 세 경우 모두 '숫자 다음 공백'이 성립하지 않아 정규식이 걸리지 않는다.
// 참고로 부록을 A/B 문자로 매기는 PDF('A Mathematical Derivations')는 이 정규식에 안 걸려
// 우리 번호가 그대로 붙는다 — 그 한계는 아래 outlineDigest 주석에 적어 둔다.
const NUMBERED_TITLE_RE = /^\d+(?:\.\d+)*[.):]?\s+(?=\S)/;
function hasOwnNumbering(title) {
  return NUMBERED_TITLE_RE.test(title);
}

// (스택 기반) depth 시퀀스를 계층 번호(1, 1.1, 1.2, 2, 2.1 …)로 바꾼다.
// stack은 호출자가 outlineDigest 한 번 실행하는 동안 유지하는 [{ rawDepth, num }, …] —
// 인덱스 0이 최상위, 끝이 현재 위치다. 항목 하나를 처리할 때마다:
//   1) 스택 맨 위의 rawDepth가 이번 depth보다 '더 깊으면' 판다(그 하위 트리는 이미 끝났다).
//   2) 판 뒤 맨 위의 rawDepth가 이번 depth와 '같으면' 형제다 — 그 번호를 이어받아 +1.
//   3) 그렇지 않으면(스택이 비었거나 맨 위가 이번 depth보다 얕으면) 새 하위 단계다 — 1로 시작.
// 이 방식의 핵심은 "번호를 매길 때 절대 원래 depth 값 자체를 쓰지 않는다"는 것이다 — 스택에
// 쌓인 개수(=유효 depth)만 쓴다. 그래서 depth가 1 → 3으로 건너뛰어도(rawDepth 3인 항목이
// 스택엔 rawDepth 1짜리 하나만 있는 상태에서 들어와도) 규칙 3에 걸려 "1.1"이 되지, "1..1"이나
// "1.0.1"처럼 구멍이 뚫리지 않는다 — 건너뛴 만큼을 그냥 "한 단계 더 들어간 자식"으로 흡수한다.
// 그 뒤 또 rawDepth 3인 형제가 오면 규칙 2(맨 위 rawDepth 3와 일치)에 걸려 "1.2"가 되어
// 정상적으로 형제 취급된다 — rawDepth를 스택에 함께 저장해 두었기 때문에 가능하다.
// depth가 1보다 작거나 숫자가 아니면 1로 클램프해 방어한다(depth 0 이하나 깨진 값 대비).
function nextSectionNumber(stack, depth) {
  const d = Number.isFinite(depth) && depth >= 1 ? Math.floor(depth) : 1;
  while (stack.length && stack[stack.length - 1].rawDepth > d) stack.pop();
  if (stack.length && stack[stack.length - 1].rawDepth === d) {
    const prev = stack.pop();
    stack.push({ rawDepth: d, num: prev.num + 1 });
  } else {
    stack.push({ rawDepth: d, num: 1 });
  }
  return stack.map((e) => e.num).join('.');
}

// ranges → "1. 제목 (p.1-3)" 줄들로 된 짧은 목차 개요. 번호는 depth를 반영한 계층 번호
// (1, 1.1, 1.2, 2, 2.1 …)이고, 들여쓰기(2칸/단계)도 원래 depth가 아니라 그 계층 번호가
// 실제로 매겨진 유효 depth(스택 길이)를 따른다 — depth가 건너뛴 항목은 번호도 들여쓰기도
// 함께 "한 단계 더 들어간 자식"으로 취급되어 서로 어긋나지 않는다.
//
// 예전에는 번호를 아예 떼서 냈다: `${i+1}. `처럼 평탄화 순번을 붙였더니 모델이 그 번호를
// 절 제목에 그대로 옮겨 적었는데, 원문 PDF 목차에는 없는 번호인 데다 평탄화 순번이라 계층과도
// 어긋났다 — 5의 하위 절이 6이 되는 식이다(arXiv 2305.18290에서 1~29가 그렇게 매겨졌다).
// 이번에 되살리는 번호는 그 문제를 계층 번호로 고친 것이다. 제목이 이미 자기 번호를 갖고
// 있으면(hasOwnNumbering) 우리 번호를 덧붙이지 않고 원문 제목을 그대로 쓴다 — 다만 스택
// 카운터는 그 항목의 위치만큼 그대로 전진시켜서 다음 형제/자식 번호가 밀리지 않게 한다.
//
// 한계: 부록(Appendix)은 논문에서 보통 A, B로 매겨지지만, 우리는 PDF 목차의 depth 정보만
// 갖고 있어서 "이 항목이 본문 마지막 장인지 부록 시작인지"를 구분할 방법이 없다. 그 결과
// 부록 첫 절 'Mathematical Derivations'가 실제로는 'Appendix A'인데도 우리 번호로는 그냥
// depth 순서상 다음 숫자(예: 8)가 매겨진다 — 목차 데이터만으로는 고칠 수 없는 한계이고,
// 지어내서 해결한 척하지 않는다.
function outlineDigest(ranges) {
  const list = Array.isArray(ranges) ? ranges : [];
  if (!list.length) return '';
  const stack = []; // 이 함수 호출 1회 동안만 유지하는 번호 매김 상태(순수 함수 유지를 위해 지역 변수로 둔다)
  return list
    .map((r) => {
      const rawTitle = r?.title || '(제목 없음)';
      const number = nextSectionNumber(stack, r?.depth); // 부작용으로 stack을 전진시킨다
      const indent = '  '.repeat(Math.max(0, stack.length - 1));
      const title = hasOwnNumbering(rawTitle) ? rawTitle : `${number}. ${rawTitle}`;
      return `${indent}${title} (${pageRangeLabel(r?.startPage, r?.endPage)})`;
    })
    .join('\n');
}

module.exports = { flattenOutline, sectionRanges, sectionsDigest, outlineDigest };
