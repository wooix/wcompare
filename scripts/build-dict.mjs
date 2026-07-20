// scripts/build-dict.mjs — 영→한 오프라인 단어 사전 데이터 파이프라인.
// 두 출처를 받아 역색인(영어 소문자 → 한국어 후보들) 사전 JSON을 생성한다.
//   1) MUSE en-ko 단어쌍 (CC BY-NC 4.0) — 직접 단어쌍이라 우선순위가 높다.
//   2) kaikki 한국어 위키낱말사전 JSONL (CC BY-SA 4.0 + GFDL) — gloss에서 영어 키를 역추출.
// 변환은 전부 순수 함수로 분리·export 되어 단위 테스트 대상(test/buildDict.test.js).
// main()만 부수효과(다운로드/파일 쓰기)를 가지며, 모듈로 import 될 때는 실행되지 않는다.
//
// 사용법:
//   node scripts/build-dict.mjs            두 출처 병합 → assets/dict/en-ko.json
//   node scripts/build-dict.mjs --no-muse  MUSE 제외(비상업 NC 제약 회피) → kaikki만으로 재생성
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── 경로/URL 상수 ──────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC_DIR = path.join(ROOT, 'assets', 'dict', 'src'); // 원본 캐시(.gitignore 대상)
const OUT_FILE = path.join(ROOT, 'assets', 'dict', 'en-ko.json');
const MUSE_URL = 'https://dl.fbaipublicfiles.com/arrival/dictionaries/en-ko.txt';
const KAIKKI_URL = 'https://kaikki.org/dictionary/Korean/kaikki.org-dictionary-Korean.jsonl.gz';

const MAX_PER_KEY = 8;

// ── 순수 함수(테스트 대상) ────────────────────────────────────────────────

// 한글(음절/자모)이 하나라도 있는지. kaikki 표제어·MUSE 번역 검증에 쓴다.
export function hasHangul(s) {
  return /[가-힣ᄀ-ᇿ㄰-㆏]/.test(String(s));
}

// 괄호 구간 제거. 중첩 괄호까지 반복 제거한다("a (b (c)) d" → "a  d").
// 자리엔 공백을 남겨 인접 단어가 붙지 않게 한다(뒤에서 공백 정규화).
export function stripParens(s) {
  let prev;
  let out = String(s);
  do {
    prev = out;
    out = out.replace(/\([^()]*\)/g, ' ');
  } while (out !== prev);
  return out;
}

// gloss 후보 하나를 정규화한다.
//   괄호 구간 제거 → 공백 정규화·소문자화 → 선행 "to "/"a "/"an "/"the " 1회 제거
//   → 끝 마침표 제거 → trim.
// 선행 관사/부정사 제거를 대소문자 무관하게 하려고 소문자화를 먼저 적용한다.
export function normalizeGloss(candidate) {
  let s = stripParens(candidate).toLowerCase();
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:to|an?|the)\s+/, '');
  s = s.replace(/\.+$/, '').trim();
  return s;
}

// 역색인 키로 채택 가능한가: 1~3 단어, 문자셋은 [a-z 하이픈 아포스트로피 공백]뿐.
export function isValidKey(k) {
  if (!k) return false;
  if (!/^[a-z' -]+$/.test(k)) return false; // 숫자·비ASCII·마침표 등 기각
  const words = k.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 3;
}

// gloss 텍스트에서 역색인 키들을 뽑는다. ";"와 ","로 후보 분리 후 정규화·필터.
export function glossToKeys(glossText) {
  const keys = [];
  for (const part of String(glossText).split(/[;,]/)) {
    const k = normalizeGloss(part);
    if (isValidKey(k)) keys.push(k);
  }
  return keys;
}

// kaikki JSONL 한 줄(파싱된 객체)에서 역색인 항목 [{ key, ko, pos }] 을 만든다.
// word에 한글이 없거나 senses가 없으면 빈 배열(=skip).
// 각 sense는 glosses의 마지막 원소(가장 구체적)만 사용한다.
export function kaikkiToEntries(obj) {
  const out = [];
  if (!obj || typeof obj.word !== 'string' || !hasHangul(obj.word)) return out;
  if (!Array.isArray(obj.senses)) return out;
  const pos = typeof obj.pos === 'string' ? obj.pos : null;
  for (const sense of obj.senses) {
    const glosses = sense && Array.isArray(sense.glosses) ? sense.glosses : null;
    if (!glosses || glosses.length === 0) continue;
    const last = glosses[glosses.length - 1];
    if (typeof last !== 'string') continue;
    for (const key of glossToKeys(last)) out.push({ key, ko: obj.word, pos });
  }
  return out;
}

// MUSE en-ko.txt 텍스트를 파싱. 줄마다 "english 한국어"(공백 구분).
// en 소문자를 키로, { key, ko, pos: null }. ko에 한글이 없으면 방어적으로 skip.
export function parseMuse(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.search(/\s/);
    if (sp < 0) continue;
    const en = t.slice(0, sp).trim().toLowerCase();
    const ko = t.slice(sp + 1).trim();
    if (!en || !ko || !hasHangul(ko)) continue;
    out.push({ key: en, ko, pos: null });
  }
  return out;
}

// kaikki JSONL 텍스트 전체를 항목 배열로. 파싱 불가 줄은 건너뛴다.
export function parseKaikki(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    for (const e of kaikkiToEntries(obj)) out.push(e);
  }
  return out;
}

// 키별 병합: MUSE 항목을 앞(우선), kaikki를 뒤에 이어 붙인 뒤
//   1) 같은 ko 중복 제거(먼저 등장분 유지 → MUSE 우선 반영)
//   2) pos === 'name' 항목은 배열 뒤로(안정적 분할)
//   3) 키당 최대 maxPerKey개로 절단
// 반환: { "<key>": [["<ko>", "<pos|null>"], ...] } 튜플 배열 맵.
export function mergeEntries(museEntries, kaikkiEntries, maxPerKey = MAX_PER_KEY) {
  const byKey = new Map();
  const push = (e) => {
    let arr = byKey.get(e.key);
    if (!arr) byKey.set(e.key, (arr = []));
    arr.push(e);
  };
  for (const e of museEntries) push(e);
  for (const e of kaikkiEntries) push(e);

  const entries = {};
  for (const [key, list] of byKey) {
    const seen = new Set();
    const named = [];
    const rest = [];
    for (const e of list) {
      if (seen.has(e.ko)) continue; // ko 중복 제거
      seen.add(e.ko);
      (e.pos === 'name' ? named : rest).push(e);
    }
    const ordered = rest.concat(named).slice(0, maxPerKey);
    entries[key] = ordered.map((e) => [e.ko, e.pos ?? null]);
  }
  return entries;
}

// 최종 출력 객체. 키 사전순 정렬로 diff 노이즈를 없앤다.
export function buildOutput(entries) {
  const sorted = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];
  return { version: 1, entries: sorted };
}

// 안정 직렬화: 키마다 한 줄(정렬 순서). 값 튜플은 압축 형태.
// JSON.stringify 한 줄 통짜보다 diff가 국소적으로 잡힌다.
export function serialize(output) {
  const keys = Object.keys(output.entries).sort();
  const lines = ['{', `  "version": ${JSON.stringify(output.version)},`, '  "entries": {'];
  keys.forEach((k, i) => {
    const comma = i < keys.length - 1 ? ',' : '';
    lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(output.entries[k])}${comma}`);
  });
  lines.push('  }', '}');
  return lines.join('\n') + '\n';
}

// ── 부수효과: 다운로드 ──────────────────────────────────────────────────────
// curl로 dest에 받는다. 이미 있으면(크기>0) 재다운로드 생략. 실패 시 1회 재시도.
function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`[build-dict] cached ${path.basename(dest)} (${statSync(dest).size} bytes)`);
    return true;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync('curl', ['-fSL', '-o', dest, url], { stdio: 'inherit' });
    if (r.status === 0 && existsSync(dest) && statSync(dest).size > 0) {
      console.log(`[build-dict] downloaded ${path.basename(dest)} (${statSync(dest).size} bytes)`);
      return true;
    }
    console.error(`[build-dict] download failed (attempt ${attempt}/2): ${url}`);
  }
  return false;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main(argv) {
  const noMuse = argv.includes('--no-muse');

  // kaikki는 항상 필요
  const kaikkiGz = path.join(SRC_DIR, 'kaikki.org-dictionary-Korean.jsonl.gz');
  if (!download(KAIKKI_URL, kaikkiGz)) {
    console.error('[build-dict] FATAL: kaikki 다운로드 실패 — 중단');
    return 1;
  }

  let museEntries = [];
  if (noMuse) {
    console.log('[build-dict] --no-muse: MUSE 제외(비상업 NC 제약 회피)');
  } else {
    const museTxt = path.join(SRC_DIR, 'en-ko.txt');
    if (!download(MUSE_URL, museTxt)) {
      console.error('[build-dict] FATAL: MUSE 다운로드 실패 — 중단(제외하려면 --no-muse)');
      return 1;
    }
    museEntries = parseMuse(readFileSync(museTxt, 'utf8'));
    console.log(`[build-dict] MUSE 항목: ${museEntries.length}`);
  }

  console.log('[build-dict] kaikki 압축 해제/파싱 중…');
  const kaikkiText = gunzipSync(readFileSync(kaikkiGz)).toString('utf8');
  const kaikkiEntries = parseKaikki(kaikkiText);
  console.log(`[build-dict] kaikki 항목: ${kaikkiEntries.length}`);

  const entries = mergeEntries(museEntries, kaikkiEntries);
  const output = buildOutput(entries);
  const json = serialize(output);
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, json);

  const keyCount = Object.keys(output.entries).length;
  console.log(`[build-dict] OK → ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`[build-dict] 키 수: ${keyCount}, 파일 크기: ${statSync(OUT_FILE).size} bytes`);
  return 0;
}

// 직접 실행될 때만 main. import(테스트)될 땐 실행하지 않는다.
if (pathToFileURL(process.argv[1] || '').href === import.meta.url) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
