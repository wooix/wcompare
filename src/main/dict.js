// src/main/dict.js — 실시간 사전 런타임(electron 비의존 팩토리 — settingsStore.js 패턴).
//  - lookup(term): 오프라인 사전(assets/dict/en-ko.json)에서 정규화 + 굴절 폴백으로 뜻을 찾는다.
//  - translate(text): 로컬 CLI 번역 엔진(agy→claude 폴백)을 spawn해 한국어로 옮긴다. 결과만 캐시.
//  - cancel(): 진행 중인 엔진 자식을 프로세스 그룹째 정리한다(동시 1건).
// PATH 보강/환경은 transpaper.js가 export하는 pathDirs/envWithPath를 재사용한다(.app은 셸 PATH가 없다).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathDirs, envWithPath } = require('./transpaper.js');

const DEFAULT_DICT_FILE = path.join(__dirname, '..', '..', 'assets', 'dict', 'en-ko.json');
const PROMPT_HEAD = '다음 영어 텍스트를 자연스러운 한국어로 번역하라. 설명 없이 번역문만 출력하라.';
const TIMEOUT_MS = 30_000;
const MAX_CACHE = 2000;

function isExec(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); }
  catch { return false; }
}

// 양끝 문장부호/공백만 벗겨 소문자로. 내부의 어깻점(don't)·하이픈(well-known)은 키에 있을 수 있어 보존한다.
function normalizeTerm(s) {
  const t = String(s ?? '').trim().toLowerCase();
  return t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}

// 굴절 폴백 후보 — 원형 → 복수형 → 진행/과거 → 비교급 순으로 "벗겨 본" 형태들.
// 실제 사전은 running/boxes 같은 굴절형을 상당수 키로 갖고 있어 raw에서 대부분 잡히고,
// 이 후보들은 키에 없는 형태를 원형으로 되돌려 보는 best-effort다(불규칙형 ran/went은 못 잡는다).
function inflections(term) {
  const out = [term];
  const add = (x) => { if (x && x.length >= 2 && !out.includes(x)) out.push(x); };
  // 복수형
  if (term.endsWith('ies') && term.length > 3) add(term.slice(0, -3) + 'y');   // cities→city
  if (term.endsWith('es') && term.length > 2) add(term.slice(0, -2));          // boxes→box
  if (term.endsWith('s') && !term.endsWith('ss') && term.length > 1) add(term.slice(0, -1)); // cats→cat
  // 진행/과거
  if (term.endsWith('ing') && term.length > 4) { add(term.slice(0, -3)); add(term.slice(0, -3) + 'e'); } // studying→study, making→make
  if (term.endsWith('ied') && term.length > 3) add(term.slice(0, -3) + 'y');   // studied→study
  if (term.endsWith('ed') && term.length > 2) { add(term.slice(0, -2)); add(term.slice(0, -1)); } // walked→walk, used→use
  // 비교급/최상급
  if (term.endsWith('iest') && term.length > 4) add(term.slice(0, -4) + 'y');  // happiest→happy
  if (term.endsWith('est') && term.length > 3) add(term.slice(0, -3));         // smallest→small
  if (term.endsWith('ier') && term.length > 3) add(term.slice(0, -3) + 'y');   // happier→happy
  if (term.endsWith('er') && term.length > 2) add(term.slice(0, -2));          // smaller→small
  return out;
}

function buildPrompt(text) { return `${PROMPT_HEAD}\n\n${text}`; }

// 기본 엔진 실행기: <engine> -p <프롬프트>. detached로 자신만의 프로세스 그룹을 가져
// 취소/타임아웃 시 엔진이 다시 띄운 자식(claude 등)까지 그룹째 정리한다.
function defaultRunEngine({ bin, name, text, signal, timeoutMs = TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', buildPrompt(text)], {
      env: envWithPath(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let done = false;
    const killGroup = (sig) => { if (child.pid) { try { process.kill(-child.pid, sig); } catch { /* 이미 종료 */ } } };
    const settle = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(arg); };
    const onAbort = () => { killGroup('SIGTERM'); const e = new Error('취소됨'); e.canceled = true; settle(reject, e); };
    const timer = setTimeout(() => { killGroup('SIGTERM'); settle(reject, new Error(`${name} 응답 시간 초과(${Math.round(timeoutMs / 1000)}초)`)); }, timeoutMs);

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    child.on('error', (e) => settle(reject, new Error(`${name} 실행 실패: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return settle(resolve, out);
      settle(reject, new Error(`${name} 오류 (exit ${code})\n${err.slice(-400)}`));
    });
  });
}

// 엔진 해석: WCOMPARE_DICT_ENGINE(절대경로, 실행 가능) → 보강된 PATH에서 agy → claude.
// 명시 지정이 있으면 그것만(폴백 없음), 없으면 존재하는 것들을 [primary, 폴백] 순으로 돌려준다.
function resolveEngines(env = process.env) {
  const explicit = env.WCOMPARE_DICT_ENGINE;
  if (explicit) {
    if (isExec(explicit)) return [{ bin: explicit, name: path.basename(explicit) }];
    throw new Error(`WCOMPARE_DICT_ENGINE가 실행 가능한 파일이 아닙니다: ${explicit}`);
  }
  const found = [];
  for (const name of ['agy', 'claude']) {
    for (const dir of pathDirs(env)) {
      const cand = path.join(dir, name);
      if (isExec(cand)) { found.push({ bin: cand, name }); break; }
    }
  }
  return found;
}

function createDict({
  dictFile = process.env.WCOMPARE_DICT_FILE || DEFAULT_DICT_FILE,
  cacheFile = null,
  env = process.env,
  runEngine = defaultRunEngine,
  resolveEngines: resolveEnginesFn = resolveEngines,
  timeoutMs = TIMEOUT_MS,
  maxCache = MAX_CACHE,
} = {}) {
  // ===== 오프라인 사전 =====
  let map = null; // 첫 조회 때 lazy 로드
  function ensureMap() {
    if (map) return map;
    map = new Map();
    try {
      const obj = JSON.parse(fs.readFileSync(dictFile, 'utf8'));
      const entries = obj && obj.entries;
      if (entries && typeof entries === 'object') {
        for (const [k, v] of Object.entries(entries)) if (Array.isArray(v)) map.set(k, v);
      }
    } catch { /* 파일이 없거나 깨졌으면 빈 사전 → lookup은 null만 반환 */ }
    return map;
  }

  // 정규화 후 굴절 폴백 체인으로 첫 히트를 반환. 히트 [[ko,pos],...], 미스 null.
  function lookup(term) {
    const norm = normalizeTerm(term);
    if (!norm) return null;
    const m = ensureMap();
    for (const cand of inflections(norm)) {
      const hit = m.get(cand);
      if (hit) return hit;
    }
    return null;
  }

  // ===== 번역 결과 캐시(MT만) — userData/dict-cache.json, tmp+rename 원자 기록 =====
  let cache = null;
  function loadCache() {
    if (cache) return cache;
    cache = { version: 1, entries: {} };
    if (!cacheFile) return cache;
    try {
      const obj = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (obj && obj.entries && typeof obj.entries === 'object') cache.entries = obj.entries;
    } catch { /* 없거나 깨짐 → 빈 캐시 */ }
    return cache;
  }
  function cacheGet(key) { return loadCache().entries[key] || null; }
  function cacheSet(key, val) {
    if (!cacheFile) return;
    const c = loadCache();
    if (c.entries[key]) delete c.entries[key]; // 재삽입해 "최근"으로 끌어올린다(삽입 순서 = LRU 근사)
    c.entries[key] = { ...val, at: Date.now() };
    const keys = Object.keys(c.entries);
    if (keys.length > maxCache) for (const k of keys.slice(0, keys.length - maxCache)) delete c.entries[k];
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(c));
      fs.renameSync(tmp, cacheFile);
    } catch { /* 캐시는 best-effort */ }
  }

  // ===== CLI 번역 (동시 1건) =====
  let current = null; // { controller, canceled }
  function cancel() {
    if (!current) return;
    current.canceled = true;
    current.controller.abort();
    current = null;
  }

  function canceledError() { const e = new Error('취소됨'); e.canceled = true; return e; }

  async function translate(text) {
    const src = String(text ?? '');
    const key = crypto.createHash('sha1').update(src).digest('hex');
    const cached = cacheGet(key);
    if (cached) return { ko: cached.ko, engine: cached.engine, cached: true };

    cancel(); // 진행 중이던 요청은 취소하고 이번 요청으로 대체
    const controller = new AbortController();
    const token = { controller, canceled: false };
    current = token;

    const engines = resolveEnginesFn(env);
    if (!engines.length) { if (current === token) current = null; throw new Error('번역 엔진(agy/claude)을 찾을 수 없습니다'); }

    let lastErr = null;
    for (const eng of engines) {
      try {
        const stdout = await runEngine({ bin: eng.bin, name: eng.name, text: src, signal: controller.signal, timeoutMs, env });
        if (token.canceled) throw canceledError();
        const ko = String(stdout ?? '').trim();
        cacheSet(key, { ko, engine: eng.name });
        if (current === token) current = null;
        return { ko, engine: eng.name };
      } catch (e) {
        if (token.canceled || e?.canceled) { if (current === token) current = null; throw canceledError(); }
        lastErr = e; // 이 엔진 실패 → 다음(반대) 엔진으로 1회 폴백
      }
    }
    if (current === token) current = null;
    throw lastErr || new Error('번역 실패');
  }

  return { lookup, translate, cancel };
}

module.exports = {
  createDict,
  normalizeTerm,
  inflections,
  buildPrompt,
  resolveEngines,
  defaultRunEngine,
  DEFAULT_DICT_FILE,
};
