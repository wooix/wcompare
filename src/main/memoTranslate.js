// src/main/memoTranslate.js — 마크다운 메모 한 편을 LLM CLI로 통째로 한국어 번역한다.
// electron 미의존(순수 node → 단위 테스트 가능).
//
// paperSummary.js와 무엇이 다른가: 그쪽은 "논문을 읽고 요약을 지어내는" 일이고 여기는
// "구조를 그대로 둔 채 말만 바꾸는" 일이다. 그래서 프롬프트의 성격이 정반대다 — 요약은
// 압축을 시키고, 번역은 한 줄도 빼지 말라고 시킨다.
//
// 실행 관용구(실행 파일 탐색·PATH 보강·detached spawn·타임아웃·출력 상한)는 paperSummary.js의
// 것을 그대로 재사용한다. 두 곳이 갈라지면 GUI(.app)의 빈약한 PATH 문제가 한쪽에서만
// 고쳐지는 사고가 난다 — 그 파일이 transpaper.js에 대해 이미 같은 이유로 재사용하고 있다.
const { spawn } = require('node:child_process');
const { resolveEngineBin, buildSummaryArgs } = require('./paperSummary.js');
const { envWithPath } = require('./transpaper.js');

// 번역할 원문 상한. 요약(12만자)보다 낮게 잡는 이유: 번역은 입력과 비슷한 길이를 '출력'해야 해서
// 모델의 출력 한도가 먼저 걸린다. 메모는 논문이 아니라 이 정도면 충분하다.
const MAX_INPUT_CHARS = 40000;
// stdout 상한. 번역본은 원문과 비슷한 크기이므로 넉넉히 잡되, 폭주한 CLI는 여기서 끊는다.
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 3000;

// paperSummary.stripControlChars와 같은 정책(그쪽은 export하지 않아 옮겨 왔다).
// NUL이 하나만 섞여도 spawn이 argv를 통째로 거부해 번역이 통째로 실패한다 — PDF에서 뽑은
// 텍스트를 메모에 붙여넣는 경로가 실제로 있으므로 여기서도 반드시 건다.
function stripControlChars(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c < 32 && c !== 10 && c !== 9) || c === 127 || (c >= 128 && c <= 159) ? ' ' : ch;
  }
  return out;
}

const CLIP_MARKER = '\n\n…(길이 제한으로 이하 생략)…\n\n';

/**
 * 원문을 상한 안으로 자른다. 요약(clipText)과 달리 **앞에서부터** 남긴다 —
 * 번역은 앞뒤를 이어 붙이면 문서가 아니라 조각 두 개가 되고, 사용자는 어디가 잘렸는지 모른 채
 * 가운데가 사라진 번역본을 갖게 된다. 앞에서 자르면 "여기까지 번역됐다"가 눈에 보인다.
 * @returns {{text:string, truncated:boolean}}
 */
function clipSource(text, max = MAX_INPUT_CHARS) {
  const s = stripControlChars(typeof text === 'string' ? text : String(text ?? ''));
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, Math.max(0, max - CLIP_MARKER.length)) + CLIP_MARKER, truncated: true };
}

// 번역 지시문. 마크다운 '구조'를 손대지 말라는 것이 전부다 — 모델은 시키지 않으면 헤딩 레벨을
// 바꾸고 목록을 문단으로 풀고 코드블록 안까지 번역한다.
const RULES = [
  '너는 마크다운 문서를 한국어로 번역하는 번역가다.',
  '',
  '[규칙]',
  '- 결과물만 출력한다. 인사말, 설명, "번역하겠습니다" 같은 군더더기를 붙이지 않는다.',
  '- 전체를 감싸는 코드펜스로 답을 감싸지 않는다. 마크다운 본문을 그대로 낸다.',
  '- 마크다운 구조를 한 글자도 바꾸지 않는다: 헤딩의 # 개수, 목록 기호와 들여쓰기,',
  '  표의 열 구성, 인용부호, 수평선, 빈 줄의 위치를 원문 그대로 유지한다.',
  '- 코드블록(``` 안)과 인라인 코드(` `)의 내용은 번역하지 않고 그대로 둔다.',
  '  코드 안의 주석도 건드리지 않는다.',
  '- 링크는 표시 문자열만 번역하고 URL은 그대로 둔다: [텍스트](url) → [번역된 텍스트](url)',
  '- 이미지 대체 텍스트도 같은 규칙을 따른다.',
  '- 수식($…$, $$…$$)은 그대로 둔다.',
  '- 이미 한국어인 부분은 그대로 둔다. 다시 쓰거나 다듬지 않는다.',
  '- 전문 용어는 처음 나올 때 한 번만 한국어(English) 형태로 병기한다.',
  '- 원문에 없는 내용을 더하지 않고, 있는 내용을 빼지 않는다.',
  '- 원문에 "…(길이 제한으로 이하 생략)…" 표식이 있으면 그 자리에서 멈춘다. 뒤를 지어내지 않는다.',
];

const TAIL = '이제 위 규칙에 따라 번역한 마크다운만 출력하라. 설명을 붙이지 마라.';

/**
 * 번역 프롬프트를 만든다. 순수 함수(단위 테스트용).
 * @param {string} markdown 원문
 * @returns {string}
 */
function buildTranslatePrompt(markdown) {
  const { text } = clipSource(markdown);
  return [...RULES, '', '[원문]', text, '', TAIL].join('\n');
}

// 응답 정화: CLI가 붙이는 앞뒤 공백을 걷고, 응답 전체를 코드펜스로 감싸 온 경우 그 펜스를 벗긴다
// (규칙으로 금지했는데도 자주 감싸 온다). 안쪽에 또 펜스가 있으면 건드리지 않는다 —
// 코드블록이 든 문서를 망치는 것보다 펜스 한 겹이 남는 편이 낫다.
function cleanTranslation(raw) {
  const s = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  const open = s.match(/^```[^\n]*\n/);
  if (!open || !s.endsWith('```')) return s;
  const inner = s.slice(open[0].length, s.length - 3);
  return inner.includes('```') ? s : inner.trim();
}

function pickEngine(translateSettings) {
  const e = translateSettings?.engine;
  return e === 'claude' || e === 'agy' || e === 'codex' ? e : 'agy';
}

/**
 * 메모 한 편을 번역한다. paperSummary.summarize와 같은 모양의 { promise, cancel }을 돌려준다 —
 * 호출측(ipc)이 translationJobs로 취소·중복 방지를 똑같이 걸 수 있게 하기 위해서다.
 * @param {string} markdown 원문
 * @param {object} [opts]
 * @returns {{ promise: Promise<{content:string, truncated:boolean}>, cancel: () => void, pid?: number }}
 */
function translateMemo(markdown, opts = {}) {
  const {
    translateSettings, env = process.env, extraDirs,
    timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES, killGraceMs = KILL_GRACE_MS,
  } = opts || {};

  const src = typeof markdown === 'string' ? markdown : '';
  if (!src.trim()) {
    return { promise: Promise.reject(new Error('번역할 내용이 없습니다.')), cancel() {} };
  }

  const eng = pickEngine(translateSettings);
  let bin;
  try {
    bin = resolveEngineBin(eng, env, extraDirs);
  } catch (e) {
    return { promise: Promise.reject(e), cancel() {} };
  }
  if (!bin) {
    return { promise: Promise.reject(new Error(`${eng} CLI를 찾을 수 없습니다.`)), cancel() {} };
  }

  const { truncated } = clipSource(src);
  const prompt = buildTranslatePrompt(src);
  // detached: 자신만의 프로세스 그룹을 갖게 해, 취소 시 CLI가 띄운 자식들까지 함께 정리한다.
  const child = spawn(bin, buildSummaryArgs(eng, prompt, translateSettings), {
    env: envWithPath(env), detached: true, stdio: [eng === 'codex' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    ...(eng === 'codex' ? { cwd: require('node:os').tmpdir() } : {}),
  });

  if (eng === 'codex') {
    child.stdin.on('error', () => {}); // early CLI exit is reported by close/error
    child.stdin.end(prompt);
  }

  const chunks = [];
  let bytes = 0;
  let stop = ''; // '' | 'canceled' | 'timeout' | 'overflow'
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
    if (reason === 'canceled') return '번역이 취소되었습니다.';
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

  // 죽인 뒤 close를 기다리지 않는다: SIGTERM을 무시하는 프로세스에서는 close가 영영 오지 않아
  // promise가 settle되지 않은 채 남고, UI가 진행 표시에 영구히 갇힌다(paperSummary와 같은 이유).
  function abort(reason) {
    if (!stop) stop = reason;
    kill();
    rejectOnce(new Error(stopMessage(stop)));
  }

  timer = timeoutMs > 0 ? setTimeout(() => abort('timeout'), timeoutMs) : null;

  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxOutputBytes) { abort('overflow'); return; }
    chunks.push(chunk);
  });
  let stderrTail = '';
  child.stderr.on('data', d => { stderrTail = (stderrTail + d.toString('utf8')).slice(-1200); });

  child.on('error', (e) => rejectOnce(new Error(`${eng} 실행 실패: ${e.message}`)));
  child.on('close', (code) => {
    closed = true;
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    if (settled) return;
    if (stop) return rejectOnce(new Error(stopMessage(stop)));
    if (code !== 0) return rejectOnce(new Error(`${eng} 오류 (exit ${code})\n${stderrTail.trim()}`));
    const content = cleanTranslation(Buffer.concat(chunks).toString('utf8'));
    if (!content) return rejectOnce(new Error('번역 결과가 비어 있습니다. 다시 시도해 주세요.'));
    return resolveOnce({ content, truncated });
  });

  return { promise, cancel: () => abort('canceled'), pid: child.pid };
}

module.exports = {
  translateMemo, buildTranslatePrompt, clipSource, cleanTranslation,
  MAX_INPUT_CHARS, MAX_OUTPUT_BYTES,
};
