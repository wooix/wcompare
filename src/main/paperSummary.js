// src/main/paperSummary.js — 외부 LLM CLI(agy/claude)를 한 번 불러 논문 요약 3종을 받아온다.
// electron 미의존(순수 node → 단위 테스트 가능). 실행 파일 탐색·PATH 보강·detached spawn 관용구는
// transpaper.js와 완전히 같은 것을 재사용한다 — 두 곳이 갈라지면 GUI(.app)의 빈약한 PATH 문제가
// 한쪽에서만 고쳐지는 사고가 난다.
//
// 신뢰 경계: 여기서 다루는 입력은 전부 신뢰할 수 없다.
//   - 본문/제목/목차: PDF에서 긁어온 것이라 길이도 내용도 보장이 없다 → clipText/상한으로 자른다.
//   - LLM 응답: 형식 지시를 자주 어긴다 → cleanResponse/extractMermaid로 정화하고 바이트 상한을 건다.
// 프롬프트로 "하지 마라"고 시킨 것도 코드에서 한 번 더 막는 것이 이 파일의 기본 태도다.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathDirs, envWithPath, MODEL_NAME_RE } = require('./transpaper.js');

// transpaper.js의 isExec와 같은 판정(그쪽은 export하지 않아 그대로 옮겨 왔다).
function isExec(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch { return false; }
}

const KINDS = ['overview', 'sections', 'flow'];

// 프롬프트에 넣을 본문 상한. 논문 한 편(30p 남짓)이 대략 6~8만자라 12만자면 부록까지 들어간다.
// 더 키우면 모델의 컨텍스트 한도에 걸려 통째로 실패하므로 여기서 미리 자른다.
const MAX_TEXT_CHARS = 120000;
// stdout 상한. 요약 결과는 아무리 길어도 수만 바이트다 — 1MB를 넘으면 CLI가 폭주한 것으로 보고 죽인다.
const MAX_OUTPUT_BYTES = 1024 * 1024;
// 논문 전체를 읽고 답하므로 번역만큼은 아니어도 분 단위가 걸린다.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// SIGTERM을 무시하도록 만든 CLI가 있다(trap '' TERM). 유예 뒤에도 살아 있으면 SIGKILL로 올린다.
const KILL_GRACE_MS = 3000;

// stderr 꼬리표 상한. 줄 수만 세면 개행 없이 폭주하는 CLI 앞에서 상한이 서지 않아, 미완성 줄을
// 담는 버퍼 자체에 문자 상한을 둔다. 한 줄 길이도 자르는데, 에러 메시지는 어차피 뒤 600자만 쓴다.
const MAX_STDERR_BUF_CHARS = 64 * 1024;
const MAX_TAIL_LINES = 40;
const MAX_TAIL_LINE_CHARS = 1000;

// 정화된 값이 마크다운/mermaid로 렌더러에 넘어가므로 화면에 올릴 크기에도 상한을 둔다.
const MAX_CONTENT_CHARS = 200000;
const MAX_MERMAID_CHARS = 20000;
const MAX_TITLE_CHARS = 300;
const MAX_OUTLINE_CHARS = 4000;

// engine별 실행 파일 override 환경변수. e2e에서 가짜 셸스크립트를 끼우는 seam이기도 하다.
const ENGINE_ENV = { agy: 'WCOMPARE_AGY', claude: 'WCOMPARE_CLAUDE' };

function notFoundHint(engine) {
  const envName = ENGINE_ENV[engine] || ENGINE_ENV.agy;
  return `${engine} CLI를 찾을 수 없습니다.\n\n` +
    '다음 중 하나로 해결하세요:\n' +
    `  1) ${engine} 를 PATH에 두기 (~/.local/bin, /opt/homebrew/bin 등)\n` +
    `  2) ${envName} 환경변수에 실행 파일 절대경로 지정`;
}

// 탐색 순서: WCOMPARE_AGY/WCOMPARE_CLAUDE → PATH(+사용자 bin 보강).
// override가 실행 불가면 조용히 폴백하지 않고 throw한다 — 사용자가 지정한 것을 무시하고 다른 걸 쓰면
// "왜 설정이 안 먹지"를 영영 못 찾는다.
function resolveEngineBin(engine, env = process.env, extraDirs = undefined) {
  const name = engine === 'claude' ? 'claude' : 'agy';
  const explicit = env[ENGINE_ENV[name]];
  if (explicit) {
    if (isExec(explicit)) return explicit;
    throw new Error(`${ENGINE_ENV[name]}가 실행 가능한 파일이 아닙니다: ${explicit}`);
  }
  // extraDirs가 undefined면 pathDirs의 기본값(사용자 bin 보강 목록)이 그대로 쓰인다.
  for (const dir of pathDirs(env, extraDirs)) {
    const cand = path.join(dir, name);
    if (isExec(cand)) return cand;
  }
  return null;
}

// CLI 인자 구성 — 순수 함수로 분리해 단위 테스트한다.
// 모델명은 MODEL_NAME_RE를 통과할 때만 붙인다(빈 값·불량 값은 조용히 생략 = CLI 기본 모델).
// transpaper.buildTranslateArgs와 같은 정책이어야 사용자가 설정 한 곳만 보고도 결과를 예측할 수 있다.
function buildSummaryArgs(engine, prompt, translateSettings = {}) {
  // 최후 방어선: 여기가 argv로 나가는 마지막 관문이다. 위에서 이미 정화하지만, 프롬프트를
  // 만드는 경로가 하나 늘어날 때마다 정화를 빠뜨릴 수 있으므로 문지기를 한 번 더 세운다
  // (NUL이 하나만 섞여도 spawn이 인자를 통째로 거부해 요약 전체가 실패한다).
  const args = ['-p', stripControlChars(String(prompt ?? ''))];
  const { agyModel, claudeModel } = translateSettings || {};
  const model = engine === 'claude' ? claudeModel : agyModel;
  if (typeof model === 'string' && MODEL_NAME_RE.test(model)) args.push('--model', model);
  return args;
}

// 가운데를 덜어낸 자리에 남기는 표식. 모델이 "여기가 끊겼다"는 것을 알아야 없는 내용을 지어내지 않는다.
const CLIP_MARKER = '\n\n…(본문 중간 생략)…\n\n';

// 왜 앞뒤를 함께 남기나: 논문은 앞(초록·서론·방법)과 뒤(실험 결과·결론·한계)에 요약에 필요한 정보가
// 몰려 있고, 가운데(관련 연구·증명·부록)는 상대적으로 덜 중요하다. 앞에서 단순 slice하면 결론과 한계가
// 통째로 사라져 "저자가 밝힌 한계" 같은 항목을 모델이 지어내게 된다. 그래서 앞 70% + 뒤 30%를 남긴다.
// 표식 길이를 예산에서 미리 빼므로 결과 길이는 항상 max 이하 → 같은 값을 다시 clip해도 그대로다(멱등).
// PDF에서 뽑은 텍스트에는 제어문자가 섞여 들어온다 — 폰트의 ToUnicode 맵이 불완전하면
// pdf.js가 매핑되지 않은 글리프를 그대로 흘려보내기 때문이다.
// 그중 NUL은 치명적이다: node의 spawn은 argv에 NUL이 하나라도 있으면 인자를 통째로 거부해서
// (ERR_INVALID_ARG_VALUE) 요약 세 개가 한꺼번에 실패한다. arXiv 2203.15556에서 실제로 발생했다.
// 줄바꿈·탭은 문단 구조라 살리고, 나머지 제어문자는 공백으로 바꾼다(지우면 단어가 붙어 버린다).
function stripControlChars(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    // C0(개행·탭 제외) + DEL + C1 제어문자
    out += (c < 32 && c !== 10 && c !== 9) || c === 127 || (c >= 128 && c <= 159) ? ' ' : ch;
  }
  return out;
}

function clipText(text, max = MAX_TEXT_CHARS) {
  const s = stripControlChars(typeof text === 'string' ? text : String(text ?? ''));
  if (s.length <= max) return { text: s, truncated: false };
  const budget = Math.max(0, max - CLIP_MARKER.length);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  const clipped = s.slice(0, head) + CLIP_MARKER + (tail > 0 ? s.slice(s.length - tail) : '');
  return { text: clipped, truncated: true };
}

// 제목·목차는 PDF에서 긁어온 값이라 길이 보장이 없다. 프롬프트가 본문보다 메타데이터로 뒤덮이지 않게 자른다.
function clipField(v, max) {
  if (typeof v !== 'string') return '';
  const s = stripControlChars(v.replace(/\r\n?/g, '\n')).trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const COMMON_RULES = [
  '너는 학술 논문을 정확하게 읽고 한국어로 정리해 주는 조수다.',
  '',
  '[규칙]',
  '- 반드시 한국어로 답한다.',
  '- 인사말, 서론, "물론입니다" 같은 군더더기를 붙이지 않는다. 요구한 결과물만 출력한다.',
  '- 전문 용어는 처음 나올 때 한 번만 한국어(English) 형태로 병기한다. 예: 지도 미세조정(Supervised Fine-Tuning).',
  '- 원문에 없는 내용을 지어내지 않는다. 본문에서 확인되지 않는 수치나 주장은 쓰지 않는다.',
  '- 본문에 "…(본문 중간 생략)…" 표식이 있으면 그 부분은 추측해 채우지 않는다.',
];

// kind별 출력 형식 지시. 이 앱에서 요약 품질을 좌우하는 것은 사실상 이 문자열들이다.
const KIND_SPEC = {
  overview: [
    '[할 일] 이 논문 전체를 최대한 간략히 요약한다.',
    '',
    '[출력 형식]',
    '- 마크다운. 공백 포함 800자 이내로 쓴다. 길면 잘라 내지 말고 더 압축한다.',
    '- 다음 여섯 가지를 이 순서로 모두 담는다. 각 항목은 굵은 소제목 + 1~2문장으로.',
    '  1) **무엇을 푸는 문제인가**',
    '  2) **기존 방법의 한계**',
    '  3) **핵심 아이디어** — 반드시 한 줄로',
    '  4) **어떻게 검증했나** — 데이터셋, 비교 대상, 평가 지표',
    '  5) **핵심 수치 결과** — 원문에 나온 숫자를 그대로 인용',
    '  6) **저자가 밝힌 한계**',
    '- 독자가 30초 안에 "이 논문을 읽을지" 판단할 수 있어야 한다. 훑어보기 쉽게 쓴다.',
  ],
  sections: [
    '[할 일] 논문을 절 단위로 나누어 요약하고 해석한다.',
    '',
    '[출력 형식]',
    "- 마크다운. 각 절은 '## 제목' 헤딩으로 시작하고, 그 아래에 3~6문장을 쓴다.",
    '- [목차]가 주어졌다면 그 제목과 순서를 그대로 따른다. 목차에 없는 절을 만들거나 순서를 바꾸지 않는다.',
    '- [목차]가 없다면 본문을 읽고 논리 단위로 절을 스스로 구획해 제목을 붙인다.',
    '- 단순 번역이 아니라 해석을 담는다: 이 절이 왜 있는지, 앞 절과 어떻게 이어지는지, 저자가 여기서 무엇을 주장하는지.',
    '- 수식이 핵심인 절은 그 수식이 무엇을 측정하고 왜 그렇게 설계했는지를 평이한 말로 풀어 쓴다. 수식만 옮겨 적지 않는다.',
    '- 본문에 근거가 없는 절은 만들지 않는다.',
  ],
  flow: [
    '[할 일] 이 논문의 논리 흐름도를 mermaid로 그린다.',
    '',
    '[출력 형식]',
    '- 오직 mermaid 코드블록 하나만 출력한다. 코드블록 앞뒤에 설명, 제목, 인사를 일절 붙이지 않는다.',
    "- 코드블록의 첫 줄은 정확히 'flowchart TD' 로 시작한다.",
    '- 노드는 8~14개. 노드 id는 A, B, C … 처럼 영문 대문자 한 글자(모자라면 뒤에 숫자 하나)만 쓴다.',
    '- 노드 라벨은 한국어로 쓰고 반드시 큰따옴표로 감싼다: A["텍스트"]',
    '- 라벨 안에 괄호 ( ) 대괄호 [ ] 중괄호 { } 따옴표 " \' 를 절대 쓰지 않는다. 쉼표 대신 공백을 쓴다.',
    '- 흐름은 문제 제기 → 기존 한계 → 핵심 아이디어 → 방법 구성요소 → 실험 설계 → 결과 → 한계 순서로 잇는다.',
    '- 화살표는 A --> B 형태만 쓴다. 화살표에 라벨이 필요하면 A -->|짧은 한국어| B 처럼 짧게 쓴다.',
  ],
};

// 본문 뒤에 한 번 더 붙이는 마무리 지시. 긴 본문 뒤에서는 앞머리 지시가 묻히기 쉬워 형식을 다시 못박는다.
const KIND_TAIL = {
  overview: '이제 위 [출력 형식]에 따라 800자 이내의 요약만 출력하라.',
  sections: "이제 위 [출력 형식]에 따라 '## 제목' 헤딩으로 시작하는 절별 요약만 출력하라.",
  flow: '이제 mermaid 코드블록 하나만 출력하라. 라벨은 큰따옴표로 감싸고 괄호를 쓰지 않는다.',
};

function buildPrompt(kind, { title, outline, text } = {}) {
  const spec = KIND_SPEC[kind] || KIND_SPEC.overview;
  const body = clipText(text).text; // 호출측이 이미 잘랐어도 멱등이라 안전하다
  const lines = [
    ...COMMON_RULES,
    '',
    ...spec,
    '',
    '[논문 제목]',
    clipField(title, MAX_TITLE_CHARS) || '(제목 미상)',
    '',
  ];
  const ol = clipField(outline, MAX_OUTLINE_CHARS);
  if (ol) lines.push('[목차]', ol, '');
  lines.push('[본문]', body, '', KIND_TAIL[kind] || KIND_TAIL.overview);
  return lines.join('\n');
}

// CLI가 붙이는 앞뒤 공백/빈 줄을 걷어내고, 응답 전체를 코드펜스로 감싸 온 경우 그 펜스를 벗긴다
// (모델이 "마크다운으로 답하라"를 "마크다운 코드블록으로 답하라"로 오해하는 일이 잦다).
function cleanResponse(raw) {
  let s = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  // 전체를 감싼 펜스만 벗긴다. 본문 안에 코드블록이 섞여 있는 경우를 망가뜨리지 않도록,
  // 여는 펜스 이후 닫는 펜스가 맨 끝에만 있을 때로 한정한다.
  const open = s.match(/^```[^\n]*\n/);
  if (open && s.endsWith('```')) {
    const inner = s.slice(open[0].length, s.length - 3);
    if (!inner.includes('```')) s = inner.trim();
  }
  if (s.length > MAX_CONTENT_CHARS) s = `${s.slice(0, MAX_CONTENT_CHARS)}\n\n…(응답이 너무 길어 잘랐습니다)`;
  return s;
}

// mermaid 다이어그램 시작 키워드. 방향(TD/LR…)까지 요구해 산문 속 "flowchart를 그리면" 같은 줄을 걸러낸다.
const MERMAID_START_RE = new RegExp(
  '^[ \\t]*(?:(?:flowchart|graph)[ \\t]+(?:TD|TB|BT|LR|RL)\\b' +
  '|(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart)\\b)',
);

// 노드 정의의 여는 토큰들(긴 것부터). mermaid의 모든 도형을 다 다루지는 않고, LLM이 실제로 쓰는 것만 본다.
const NODE_SHAPES = [
  ['[[', ']]'], ['((', '))'], ['{{', '}}'], ['([', '])'], ['[(', ')]'],
  ['[', ']'], ['(', ')'], ['{', '}'],
];
const ID_OPEN_RE = /([A-Za-z][A-Za-z0-9_]*)(\[\[|\(\(|\{\{|\(\[|\[\(|\[|\(|\{)/g;

// 라벨의 끝을 찾는다. 라벨 안에 닫는 문자가 섞여 있을 수 있으므로(예: A[전이 학습 (transfer)])
// 여는 토큰의 중첩 깊이를 세면서 깊이 0에서 닫히는 자리만 후보로 본다.
// 왜 깊이를 세나: 예전에는 "닫은 뒤가 공백"이면 곧장 끝으로 봐서, 인용 표기가 섞인
// A[선행 연구 [1] 참조] 가 A["선행 연구 1"] 참조] 로 조기 절단됐다 — 논문 요약이라 [1]은 흔하다.
// 깊이 0인데 뒷모습이 구분자가 아니면(E[[요약 [최종]]] 처럼 도형 닫힘이 겹친 경우) 한 칸씩 밀며
// 더 뒤를 본다. 끝내 못 찾으면 처음 만난 깊이 0 자리를 최후의 보루로 쓴다.
function findClose(line, from, open, close) {
  let depth = 0;
  let fallback = -1;
  let i = from;
  while (i < line.length) {
    if (line.startsWith(open, i)) { depth += 1; i += open.length; continue; }
    if (line.startsWith(close, i)) {
      if (depth > 0) { depth -= 1; i += close.length; continue; }
      const after = line.slice(i + close.length);
      if (after === '' || /^[\s;,&|]/.test(after) || /^[-=.]{1,3}[->.]/.test(after)) return i;
      if (fallback < 0) fallback = i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return fallback;
}

// 라벨 정화: 감싼 따옴표를 벗기고 파서를 깨는 문자를 지운 뒤 다시 큰따옴표로 감싼다.
// mermaid는 라벨 안의 괄호·따옴표를 문법으로 먼저 읽어서, 하나만 섞여도 다이어그램 전체가 죽는다.
function normalizeLabel(s) {
  return s
    .replace(/^\s*["']|["']\s*$/g, '')
    .replace(/[()[\]{}"'`]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// subgraph 제목도 노드 라벨과 똑같은 위험을 안는다. 프롬프트가 "전문 용어는 한국어(English) 병기"를
// 시키는 탓에 'subgraph 전처리 (preprocessing)' 같은 줄이 구조적으로 자주 나오는데, 괄호 하나로
// 흐름도 전체가 파싱 에러를 낸다. 그래서 제목에도 같은 정화 규칙을 태우고 큰따옴표로 감싼다.
// 'subgraph id [제목]' 형태는 id를 살려 둔다 — 다른 줄에서 그 id를 참조할 수 있다.
const SUBGRAPH_RE = /^([ \t]*subgraph[ \t]+)(.+?)[ \t]*$/i;
const SUBGRAPH_ID_RE = /^([A-Za-z][A-Za-z0-9_]*)[ \t]*\[(.*)\][ \t]*$/;

function sanitizeSubgraph(line) {
  const m = line.match(SUBGRAPH_RE);
  if (!m) return null;
  const withId = m[2].match(SUBGRAPH_ID_RE);
  const id = withId ? withId[1] : '';
  // 정화 결과가 비면 id를, 그것도 없으면 중립적인 이름을 쓴다. 제목 없는 subgraph는 문법 오류다.
  const label = normalizeLabel(withId ? withId[2] : m[2]) || id || '그룹';
  return id ? `${m[1]}${id} ["${label}"]` : `${m[1]}"${label}"`;
}

// 한 줄 안의 모든 노드 라벨을 정화한다. 노드 정의가 아닌 줄(style, classDef, 화살표만 있는 줄)은 그대로 둔다.
function sanitizeNodeLabels(line) {
  if (/^\s*(?:%%|style\b|classDef\b|class\b|linkStyle\b|click\b)/.test(line)) return line;
  const sub = sanitizeSubgraph(line);
  if (sub !== null) return sub;
  let out = '';
  let cursor = 0;
  ID_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = ID_OPEN_RE.exec(line)) !== null) {
    if (m.index < cursor) continue; // 이미 라벨로 소비한 구간이면 건너뛴다
    const shape = NODE_SHAPES.find(([o]) => o === m[2]);
    if (!shape) continue;
    const labelStart = m.index + m[0].length;
    const end = findClose(line, labelStart, shape[0], shape[1]);
    if (end < 0) continue; // 닫는 짝을 못 찾으면 건드리지 않는다(멀쩡한 줄을 망치는 게 더 나쁘다)
    // 지우는 문자만으로 된 라벨(A[()], B[""])은 정화하면 빈 문자열이 된다. 그대로 두면 A[] 가 남아
    // 파서가 죽으므로, 그럴 때는 노드 id를 라벨로 쓴다 — 라벨은 항상 유효한 값이어야 한다.
    const label = normalizeLabel(line.slice(labelStart, end)) || m[1];
    out += line.slice(cursor, m.index) + m[1] + shape[0] + `"${label}"` + shape[1];
    cursor = end + shape[1].length;
    ID_OPEN_RE.lastIndex = cursor;
  }
  return out + line.slice(cursor);
}

// 다이어그램 문법으로 보이는 줄인가. 펜스가 없어 "어디까지가 그림인지" 표시가 없을 때, 뒤에 붙은
// 산문을 걷어내는 데만 쓴다. mermaid는 그런 문장을 오류 없이 노드 선언으로 삼켜 화면에 그려 버린다.
const MERMAID_STMT_RE = new RegExp([
  '^\\s*$',                                                                 // 빈 줄
  '^\\s*%%',                                                                // 주석
  '^\\s*(?:subgraph|end|direction|style|classDef|class|linkStyle|click|accTitle|accDescr)\\b',
  '(?:--+>|--+|-\\.-+|==+>|==+|~~~|<--|o--|--o|x--|--x)',                   // 간선
  '[A-Za-z][A-Za-z0-9_]*\\s*[[({]',                                         // 노드 선언
  '^\\s*[A-Za-z][A-Za-z0-9_]*\\s*;?\\s*$',                                  // id만 적은 노드 선언
].join('|'));

// 상한 초과분을 자른다. 줄 경계가 있으면 마지막 줄 경계에서, 없으면 세미콜론 경계에서 끊는다.
// 왜 세미콜론 경계가 필요한가: 예전에는 줄 경계만 봐서 'graph TD; A-->B;' 같은 한 줄짜리 입력이면
// 결과가 통째로 빈 문자열이 됐고, 그러면 호출측이 "모델이 형식을 어겼다"는 틀린 원인을 사용자에게
// 보고했다 — 멀쩡한 다이어그램을 받아 놓고서.
function truncateMermaid(s) {
  const head = s.slice(0, MAX_MERMAID_CHARS);
  for (const cut of [head.lastIndexOf('\n'), head.lastIndexOf(';')]) {
    if (cut <= 0) continue;
    // 줄 경계는 그 앞까지, 세미콜론은 자기 자신까지 살린다(문장이 닫힌 자리가 파싱 가능한 지점이다).
    const kept = head.slice(0, head[cut] === ';' ? cut + 1 : cut).trim();
    if (kept) return kept;
  }
  return head.trim();
}

function sanitizeMermaid(body, { dropTrailingProse = false } = {}) {
  const lines = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*```/.test(l)); // 안쪽에 남은 펜스 조각 제거
  // 시작 키워드 앞의 잡담(모델이 코드블록 안에 설명을 끼워 넣는 경우)은 버린다.
  const start = lines.findIndex((l) => MERMAID_START_RE.test(l));
  if (start < 0) return '';
  const kept = lines.slice(start);
  while (dropTrailingProse && kept.length > 1 && !MERMAID_STMT_RE.test(kept[kept.length - 1])) kept.pop();
  const out = kept.map(sanitizeNodeLabels).join('\n').trim();
  return out.length <= MAX_MERMAID_CHARS ? out : truncateMermaid(out);
}

// 코드펜스 블록을 등장 순서대로 모은다. 닫는 펜스를 빠뜨린 마지막 블록도 살린다 — 흔한 실수인데
// 버리면 사용자만 손해다.
function fencedBlocks(s) {
  const lines = s.split('\n');
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^[ \t]*```+[ \t]*(.*)$/);
    if (!m) continue;
    if (open) { blocks.push({ info: open.info, body: lines.slice(open.start, i).join('\n') }); open = null; } else {
      open = { info: m[1].trim(), start: i + 1 };
    }
  }
  if (open) blocks.push({ info: open.info, body: lines.slice(open.start).join('\n') });
  return blocks;
}

// mermaid 코드만 뽑는다. 아무것도 못 찾으면 빈 문자열(호출측이 "형식을 어겼다"고 판단하게 한다).
// 여는 펜스의 언어 표기(```mermaid)나 속성(```mermaid title=x) 유무와 무관하게 항상 닫는 펜스에서
// 끊는다 — 예전에는 표기가 없으면 끝까지 읽어, 뒤에 붙은 설명 문장이 노드로 그려졌다.
function extractMermaid(raw) {
  const s = String(raw ?? '').replace(/\r\n?/g, '\n');
  const blocks = fencedBlocks(s);
  // mermaid라고 밝힌 블록을 먼저 본다. 앞에 python 코드블록이 있어도 진짜 다이어그램을 놓치지 않는다.
  const labeled = blocks.filter((b) => /^mermaid\b/i.test(b.info));
  for (const b of [...labeled, ...blocks]) {
    const out = sanitizeMermaid(b.body);
    if (out) return out;
  }
  // 펜스 안에서 못 찾았으면 응답 전체를 훑는다. 이때는 끝을 알려 주는 표시가 없으므로 뒤쪽 산문을 걷어낸다.
  return sanitizeMermaid(s, { dropTrailingProse: true });
}

// 스트림을 줄 단위로 잘라 최근 n줄만 남긴다(에러 메시지 꼬리표용). 전부 모으면 폭주하는 CLI에 메모리를 내준다.
// 줄 수만 세면 상한이 서지 않는다: 개행이 한 번도 오지 않으면 미완성 줄이 통째로 버퍼에 쌓여
// 기본 타임아웃 5분 동안 수 GB까지 자란다(실측 3초에 +89MB). 그래서 버퍼 자체에 문자 상한을 두고
// 넘치면 앞을 버린다 — 뒤쪽이 최신이라 에러 원인에 더 가깝다.
// stdout과 달리 프로세스를 죽이지는 않는다. 정상 CLI도 진행 로그를 stderr로 쏟아붓기 때문이다.
// 반환값은 버퍼가 상한 안에 머무는지 테스트에서 들여다보기 위한 관찰 창구다.
function keepTailLines(stream, tail, max = MAX_TAIL_LINES, maxBuf = MAX_STDERR_BUF_CHARS) {
  let buf = '';
  const clamp = () => { if (buf.length > maxBuf) buf = buf.slice(buf.length - maxBuf); };
  const push = (line) => {
    tail.push(line.length > MAX_TAIL_LINE_CHARS ? line.slice(-MAX_TAIL_LINE_CHARS) : line);
    if (tail.length > max) tail.shift();
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const s = String(chunk);
    const cut = s.lastIndexOf('\n');
    if (cut < 0) { buf += s; clamp(); return; } // 완성된 줄이 없으면 버퍼만 키우되 상한을 지킨다
    for (const l of (buf + s.slice(0, cut)).split('\n')) push(l);
    buf = s.slice(cut + 1);
    clamp();
  });
  // 개행 없이 끝난 마지막 줄도 에러 메시지에 실어 준다(오류만 찍고 개행 없이 죽는 CLI가 있다).
  stream.on('end', () => { if (buf) { push(buf); buf = ''; } });
  return { pending: () => buf.length };
}

function pickEngine(engine, translateSettings) {
  for (const cand of [engine, translateSettings?.engine]) {
    if (cand === 'agy' || cand === 'claude') return cand;
  }
  return 'agy'; // 설정이 없으면 번역 기본값과 같은 agy
}

/**
 * LLM CLI를 한 번 불러 요약 하나를 받아온다.
 * @param {'overview'|'sections'|'flow'} kind
 * @param {{title?:string, outline?:string|null, text?:string}} doc PDF에서 추출한 원문
 * @param {object} [opts]
 * @param {'agy'|'claude'} [opts.engine] 미지정이면 translateSettings.engine → agy 순으로 고른다
 * @param {object} [opts.translateSettings] settings.get().translate — agyModel/claudeModel/engine
 * @param {string[]} [opts.extraDirs] PATH 앞에 얹을 디렉터리(테스트에서 []로 실제 CLI 탐색을 막는 seam)
 * @param {number} [opts.maxOutputBytes] 상한 테스트용 주입점(기본 MAX_OUTPUT_BYTES)
 * @param {number} [opts.killGraceMs] SIGTERM 후 SIGKILL까지의 유예(테스트 주입점)
 * @returns {{ promise: Promise<{kind:string, content:string, truncated:boolean}>, cancel: () => void, pid?: number }}
 */
function summarize(kind, doc = {}, opts = {}) {
  const {
    engine, translateSettings, env = process.env, extraDirs,
    timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES, killGraceMs = KILL_GRACE_MS,
  } = opts || {};

  if (!KINDS.includes(kind)) {
    return { promise: Promise.reject(new Error(`알 수 없는 요약 종류입니다: ${kind}`)), cancel() {} };
  }

  const eng = pickEngine(engine, translateSettings);
  let bin;
  try {
    bin = resolveEngineBin(eng, env, extraDirs);
  } catch (e) {
    return { promise: Promise.reject(e), cancel() {} };
  }
  if (!bin) return { promise: Promise.reject(new Error(notFoundHint(eng))), cancel() {} };

  const { text, truncated } = clipText(doc?.text);
  const prompt = buildPrompt(kind, { title: doc?.title, outline: doc?.outline, text });

  // detached: 자신만의 프로세스 그룹을 갖게 해, 취소 시 CLI가 띄운 자식들까지 함께 정리한다.
  const child = spawn(bin, buildSummaryArgs(eng, prompt, translateSettings), {
    env: envWithPath(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chunks = [];
  const errTail = [];
  let bytes = 0;
  let stop = ''; // '' | 'canceled' | 'timeout' | 'overflow' — 왜 죽였는지가 에러 메시지를 가른다
  let closed = false;
  let settled = false;
  let timer = null;
  let killTimer = null;
  let resolveOnce = () => {};
  let rejectOnce = () => {};

  const promise = new Promise((resolve, reject) => {
    const done = (fn) => (v) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      fn(v);
    };
    resolveOnce = done(resolve);
    rejectOnce = done(reject);
  });

  function stopMessage(reason) {
    if (reason === 'canceled') return '요약이 취소되었습니다.';
    if (reason === 'timeout') return `${eng} 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않아 중단했습니다.`;
    return `${eng} 응답이 너무 깁니다 (${maxOutputBytes}바이트 초과). 중단했습니다.`;
  }

  function kill() {
    if (closed || !child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 이미 종료됨 */ }
    if (killTimer) return;
    // SIGTERM을 무시하는 프로세스(trap '' TERM)가 있다. 유예 뒤에도 살아 있으면 강제로 내린다.
    killTimer = setTimeout(() => {
      killTimer = null;
      if (closed || !child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 종료됨 */ }
    }, killGraceMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  }

  // 왜 죽인 뒤 close를 기다리지 않나: SIGTERM을 무시하는 프로세스에서는 close가 영영 오지 않아
  // promise가 resolve도 reject도 되지 않은 채 남고, UI는 스피너에 영구히 갇힌다.
  // 여기에는 "timeoutMs 안에 끝낸다"는 계약이 있으니 kill 성공 여부와 무관하게 즉시 매듭짓는다.
  function abort(reason) {
    if (!stop) stop = reason;
    kill();
    rejectOnce(new Error(stopMessage(stop)));
  }

  timer = timeoutMs > 0 ? setTimeout(() => abort('timeout'), timeoutMs) : null;

  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxOutputBytes) {
      abort('overflow');
      return; // 넘친 조각은 버린다 — 어차피 에러로 끝난다
    }
    chunks.push(chunk);
  });
  keepTailLines(child.stderr, errTail);

  child.on('error', (e) => {
    rejectOnce(new Error(`${eng} 실행 실패: ${e.message}`));
  });
  child.on('close', (code) => {
    closed = true;
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    if (settled) return; // 이미 취소·타임아웃·상한 초과로 매듭지은 뒤 뒤늦게 닫힌 경우
    if (stop) return rejectOnce(new Error(stopMessage(stop)));
    if (code !== 0) {
      return rejectOnce(new Error(`${eng} 오류 (exit ${code})\n${errTail.join('\n').slice(-600)}`));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const content = kind === 'flow' ? extractMermaid(raw) : cleanResponse(raw);
    if (!content) {
      return rejectOnce(new Error(kind === 'flow'
        ? '흐름도(mermaid)를 찾지 못했습니다. 다시 시도해 주세요.'
        : '요약 응답이 비어 있습니다. 다시 시도해 주세요.'));
    }
    return resolveOnce({ kind, content, truncated });
  });

  function cancel() {
    abort('canceled');
  }

  // pid는 테스트가 "정말 죽었는지"를 확인하는 창구다(운영 코드에서는 쓰지 않는다).
  return { promise, cancel, pid: child.pid };
}

module.exports = {
  summarize, resolveEngineBin, buildSummaryArgs, clipText, buildPrompt, cleanResponse, extractMermaid,
  keepTailLines,
  KINDS, MAX_TEXT_CHARS, MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, MAX_MERMAID_CHARS, MAX_STDERR_BUF_CHARS,
};
