// src/main/summaryExport.js — 요약 탭(overview/sections/flow) 내용을 내보낼 때 쓰는 순수 로직.
// electron 미의존(단위 테스트 가능) — ipc.js가 이 모듈을 불러 IPC 핸들러에서 쓴다.
//
// 신뢰 경계: parts/title/docPath는 전부 렌더러가 보낸 값이라 신뢰하지 않는다.
//   - parts의 각 칸은 화면에 표시 중인 값을 그대로 넘겨받을 뿐이라, summaryStore의 정화를
//     거쳤다는 보장이 없다(예: 캐시 파일을 사용자가 손으로 고쳤거나 옛 버전이 남긴 값) → 여기서도
//     문자열이 아니면 버리고 다시 trim한다.
//   - flow 칸은 paperSummary.extractMermaid가 이미 펜스를 벗겨 순수 mermaid 코드만 남긴 값이
//     정상이지만, 위와 같은 이유로 펜스가 남아 있는 값이 들어올 수 있다. 그대로 ```mermaid로
//     한 번 더 감싸면 중첩 펜스가 되어 GitHub/Obsidian이 그림 대신 날 것 코드블록을 보여준다.
//     그래서 감싸기 전에 바깥쪽 펜스를 한 번 벗겨 낸다(stripOuterFence).
//   - docPath는 파일을 읽거나 쓰는 데 전혀 쓰이지 않는다(path.basename으로 이름만 뽑는다) —
//     그래서 이 파일의 함수들은 allowlist 검문 대상이 아니다. 다만 그 결과가 결국
//     showSaveDialog의 defaultPath로 나가므로, 파일명으로 쓰기에 안전한 값인지는 반드시
//     sanitizeFileNamePart를 거쳐 보장한다.
const path = require('node:path');

const KINDS = ['overview', 'sections', 'flow'];
const TAB_LABEL = { overview: 'Overview', sections: '절별 요약', flow: '흐름도' };
// 파일명 접미사. 한글이어도 macOS 파일시스템엔 안전하지만 공백은 보기 나쁘니 뺀다.
const TAB_SUFFIX = { overview: 'overview', sections: '절별요약', flow: '흐름도' };

// 내보낼 문서(마크다운 전체, mermaid 펜스 포함) 상한. 파트 하나(summaryStore.MAX_PART_CHARS)가
// 20만자, 세 파트를 다 담아도 60만자 남짓 + 헤딩 몇 줄이다. ipc.js의 두 핸들러(export-text/export)가
// 이 상수를 그대로 공유해 마지막 방어선을 세운다 — 정상 사용량의 3배 이상 여유를 둔다.
const MAX_EXPORT_CHARS = 2 * 1024 * 1024; // 2,097,152자

// 파일시스템에서 문제 되는 문자들. pdfDownload.js의 BAD_NAME_CHARS와 같은 목록이지만, 상수 하나
// 때문에 두 pure 모듈 사이에 의존을 만들 이유가 없어 그대로 복제해 둔다.
const BAD_NAME_CHARS = '/\\:*?"<>|';

// path.basename은 인자가 이상해도 예외를 던지지 않지만(문자열이 아니면 TypeError는 던진다),
// 호출부가 String(...) 없이 넘길 수 있으니 여기서 한 번 더 방어한다.
function safeBasename(p) {
  try { return path.basename(String(p ?? '')); } catch { return ''; }
}

/**
 * 임의 문자열을 파일명 한 조각으로 안전하게 만든다: 경로 구분자·제어문자·선행 점·상위 디렉터리
 * 토큰(..)을 제거한다. 이 함수를 거친 값은 디렉터리를 가리킬 수 없다 — showSaveDialog의
 * defaultPath로 내보내도 안전한 이유가 이것이다.
 *
 * '..' 제거가 한 번의 전역 치환으로 충분한 이유: 슬래시·역슬래시는 이 함수 안에서 이미 먼저
 * 제거되므로, 그 뒤에 남는 것은 점과 그 밖의 허용 문자뿐이다. 점이 아닌 문자로 갈라진 두 점
 * 구간은 서로 다리를 놓을 수 없고, 한 구간(길이 k) 안에서 /\.\./g는 좌에서 우로 겹치지 않게
 * 두 개씩 지우므로 그 구간에는 최대 한 개(k가 홀수일 때)의 점만 남는다 — 즉 치환 후에는
 * ".." 부분 문자열이 결과에 남을 수 없다.
 * @param {*} raw
 * @returns {string} 안전한 조각. 빈 문자열일 수 있다 — 호출측이 기본값으로 대체해야 한다.
 */
function sanitizeFileNamePart(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let s = [...raw].filter((ch) => {
    const c = ch.codePointAt(0);
    return c > 31 && c !== 127 && !BAD_NAME_CHARS.includes(ch); // 제어문자 + 경로/와일드카드 문자 제거
  }).join('');
  s = s.replace(/\.\./g, ''); // 상위 디렉터리 토큰
  s = s.replace(/^\.+/, '').trim(); // 숨김 파일이 되지 않게 선행 점도 제거
  // 코드 유닛이 아니라 코드 포인트로 자른다 — s.slice(80)은 이모지·일부 한자의 서로게이트 쌍
  // 한가운데를 갈라 고아 서로게이트(U+FFFD로 깨져 보이는 글자)를 파일명 끝에 남긴다.
  return [...s].slice(0, 80).join('');
}

/**
 * 완성된 내보내기 파일명(확장자 포함)을 안전하게 정화한다. sanitizeFileNamePart를 그대로 쓰면
 * 안 되는 이유: 그쪽은 80자에서 잘라 내므로 이미 '-요약.md'가 붙은 긴 이름에 다시 적용하면
 * 확장자가 통째로 잘려 나간다(파일명이 75자를 넘는 논문에서 실제로 재현된다). 그래서 확장자를
 * 떼어 두고 이름 부분만 정화한 뒤 다시 붙인다.
 * @param {*} raw 렌더러가 힌트로 넘긴 파일명. 신뢰하지 않는다.
 * @returns {string} 항상 '.md'로 끝나는 안전한 파일명(디렉터리 없음).
 */
function sanitizeExportFileName(raw) {
  const s = typeof raw === 'string' ? raw : '';
  const stem = sanitizeFileNamePart(s.replace(/\.md$/i, ''));
  return stem ? `${stem}.md` : defaultExportFileName();
}

/**
 * 저장 파일명 기본값(확장자 포함, 디렉터리 없음). 원본 PDF 경로에서 파일명을 뽑아 정화하고
 * scope/tab에 따라 접미사를 붙인다. 이 값이 그대로 showSaveDialog의 defaultPath로 나가므로
 * sanitizeFileNamePart를 반드시 거친다.
 * @param {string} [docPath] 원본 PDF 경로. 비었거나 정화 후 빈 값이면 '요약'을 이름으로 쓴다.
 * @param {object} [opts]
 * @param {'all'|'current'} [opts.scope='all']
 * @param {'overview'|'sections'|'flow'} [opts.tab] scope==='current'일 때만 접미사에 쓰인다
 * @returns {string}
 */
function defaultExportFileName(docPath, { scope = 'all', tab } = {}) {
  const stem = sanitizeFileNamePart(safeBasename(docPath).replace(/\.pdf$/i, ''));
  const suffix = scope === 'current' && KINDS.includes(tab) ? `-${TAB_SUFFIX[tab]}` : '';
  // stem이 없을 때 '요약-요약.md'처럼 겹치지 않게, 문서명이 있을 때만 '-요약'을 덧붙인다.
  const label = stem ? `${stem}-요약${suffix}` : `요약${suffix}`;
  return `${label}.md`;
}

function cleanPart(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// 응답 전체가 코드펜스 한 겹으로 감싸여 있으면 벗긴다(캐시 파일을 사용자가 손으로 감쌌거나
// 옛 버전이 펜스를 남긴 값을 관대하게 받아들인다). 안쪽에 또 다른 펜스가 있으면(중첩) 무엇을
// 벗겨야 할지 모호하므로 건드리지 않는다 — 멀쩡한 내용을 망치는 것보다 이중 펜스가 낫다.
function stripOuterFence(s) {
  const m = s.match(/^```[^\n]*\n/);
  if (!m || !s.endsWith('```')) return s;
  const inner = s.slice(m[0].length, s.length - 3);
  return inner.includes('```') ? s : inner.trim();
}

/**
 * 요약 parts를 내보낼 마크다운 문자열로 만든다. 순수 함수 — electron 미의존.
 * flow(mermaid)는 ```mermaid 펜스로 감싼다: 안 감싸면 GitHub/Obsidian 등에서 그림이 아니라
 * 그냥 텍스트 덩어리로 보인다.
 * @param {{overview?:string, sections?:string, flow?:string}} parts
 * @param {object} [opts]
 * @param {string} [opts.title] 논문 제목 — 있으면 표제로 쓴다
 * @param {string} [opts.docPath] 원본 PDF 경로 — 제목이 없을 때 파일명을 표제로 대신 쓰고,
 *   있으면 "원본" 각주 한 줄에도 쓴다(파일을 읽거나 쓰지 않는다 — 표시 문자열로만 쓰인다)
 * @param {'all'|'current'} [opts.scope='all']
 * @param {'overview'|'sections'|'flow'} [opts.tab] scope==='current'일 때 담을 탭.
 *   KINDS에 없는 값이면(빠뜨렸거나 오타) 조용히 scope='all'로 물러난다 — 잘못 좁혀서
 *   빈 파일을 내보내는 것보다 전체를 내보내는 편이 덜 놀랍다.
 * @returns {string} 담을 내용이 하나도 없으면 빈 문자열(호출측이 "내보낼 것이 없다"고 판단하게 한다)
 */
function buildExportMarkdown(parts, opts = {}) {
  const { title, docPath, scope = 'all', tab } = opts || {};
  const src = parts && typeof parts === 'object' && !Array.isArray(parts) ? parts : {};
  const kinds = scope === 'current' && KINDS.includes(tab) ? [tab] : KINDS;

  const sections = [];
  for (const kind of kinds) {
    const raw = cleanPart(src[kind]);
    if (!raw) continue;
    const body = kind === 'flow' ? `\`\`\`mermaid\n${stripOuterFence(raw)}\n\`\`\`` : raw;
    sections.push(`## ${TAB_LABEL[kind]}\n\n${body}`);
  }
  if (!sections.length) return '';

  const heading = cleanPart(title) || sanitizeFileNamePart(safeBasename(docPath).replace(/\.pdf$/i, '')) || '요약';
  const lines = [`# ${heading} — 논문 요약`];
  if (typeof docPath === 'string' && docPath.trim()) lines.push('', `_원본: ${safeBasename(docPath)}_`);
  lines.push('', sections.join('\n\n'));
  return `${lines.join('\n').trimEnd()}\n`;
}

module.exports = {
  KINDS, TAB_LABEL, MAX_EXPORT_CHARS,
  sanitizeFileNamePart, sanitizeExportFileName, defaultExportFileName, stripOuterFence, buildExportMarkdown,
};
