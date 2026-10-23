// src/main/summaryStore.js — PDF별 논문 요약(overview/sections/flow) 캐시 저장소.
// electron 미의존(순수 fs → 단위 테스트 가능). markerStore.js와 같은 구조를 그대로 미러한다.
//
// 왜 캐시하는가: LLM 호출(agy/claude)이 느리고 비싸다. 같은 논문을 다시 열었을 때 매번
// 다시 요약을 만들면 안 되므로, 만든 결과를 디스크에 남겨 재오픈 시 즉시 복원한다.
//
// 저장 위치: <dir>/<basename>.<sha1(정규화 절대경로)>.summary.json
//   markerStore와 동일하게 sha1이 "같은 경로 → 같은 파일"을 보장한다. 다만 파일명 끝에
//   ".summary"를 끼워 넣어 markerStore가 같은 dir을 쓰더라도(<basename>.<hash>.json) 겹치지
//   않게 했다 — 두 저장소가 서로 다른 데이터를 같은 이름으로 덮어쓰는 사고를 원천 차단.
//
// 내용: { format:'wcompare-summary', version:1, path:<abs>, savedAt, parts:{overview,sections,flow}, meta }.
//   parts/meta는 저장/로드 양쪽에서 sanitize*로 정화한다(디스크 파일은 신뢰 불가 입력 —
//   사용자가 손댈 수 있고 다른 버전의 앱이 쓴 것일 수 있다).
//
// 부분 저장 정책(중요): overview만 먼저 만들어지고 sections/flow는 나중에 채워질 수 있다.
//   이 모듈은 "save에 넘어온 parts를 그대로 덮어쓴다" — 기존 파일에 남아있던 다른 탭의 값과
//   병합하지 않는다. 병합이 필요하면(예: overview만 다시 생성하고 sections는 유지하고 싶다)
//   호출자가 먼저 load()로 기존 값을 읽고 합친 뒤 save()를 호출해야 한다. 이렇게 정한 이유는
//   "무엇을 지우고 무엇을 남길지"는 UI 상태(사용자가 지금 어떤 탭을 재생성했는지)에 달려있어
//   저장소 계층에서 추측하면 오히려 사용자가 원치 않는 값이 조용히 남는 사고가 나기 때문이다.
//
// 멀티윈도우 한계: markerStore와 동일하게 "마지막 저장이 이긴다". tmp+rename 원자 기록으로
// 파일이 반쯤 쓰인 채 깨지는 것만 막고, 동시 편집 병합은 하지 않는다.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'wcompare-summary';
const VERSION = 1;
const KINDS = Object.freeze(['overview', 'narrative', 'sections', 'flow']);
const MAX_PART_CHARS = 200000; // 파트(overview/sections/flow)당 상한 — 20만자

// 결정적 파일명: 정규화 절대경로의 sha1 + 가독성용 basename 접두(파일시스템 안전 문자만, 40자 제한).
function fileNameFor(absPath) {
  const resolved = path.resolve(absPath);
  const hash = crypto.createHash('sha1').update(resolved).digest('hex');
  const base = path.basename(resolved).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'pdf';
  return `${base}.${hash}.summary.json`;
}

function filePathFor(dir, absPath) {
  return path.join(dir, fileNameFor(absPath));
}

// raw가 문자열이 아니면 빈 문자열로, 상한을 넘으면 잘라낸다. 객체/배열/숫자 등 어떤 값이 와도 안전.
function cleanPart(v) {
  return typeof v === 'string' ? v.slice(0, MAX_PART_CHARS) : '';
}

function sanitizeParts(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    overview: cleanPart(src.overview),
    narrative: cleanPart(src.narrative),
    sections: cleanPart(src.sections),
    flow: cleanPart(src.flow),
  };
}

// meta는 {engine, model, truncated} 정도의 얕은 정보만 신뢰한다 — 문자열/불리언 외 값은 버린다.
function sanitizeMeta(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    engine: typeof src.engine === 'string' ? src.engine.slice(0, 64) : '',
    model: typeof src.model === 'string' ? src.model.slice(0, 128) : '',
    truncated: typeof src.truncated === 'boolean' ? src.truncated : false,
    ...(src.readingVersions && typeof src.readingVersions === 'object' ? {
      readingVersions: Object.fromEntries(KINDS.filter(k => Number.isInteger(src.readingVersions[k]) && src.readingVersions[k] > 0 && src.readingVersions[k] <= 100).map(k => [k, src.readingVersions[k]])),
    } : {}),
  };
}

// 로드: 파일 없음·JSON 손상·format/version 불일치는 모두 빈 값으로(열기 흐름을 절대 막지 않는다).
function load(dir, absPath) {
  const empty = { parts: sanitizeParts(null), meta: null };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePathFor(dir, absPath), 'utf8'));
  } catch {
    return empty;
  }
  if (!raw || raw.format !== FORMAT || raw.version !== VERSION) return empty;
  return {
    parts: sanitizeParts(raw.parts),
    meta: {
      ...sanitizeMeta(raw.meta),
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null,
    },
  };
}

// 저장: 정화 후 세 파트가 전부 비면 파일을 지운다(빈 파일이 쌓이지 않게 = 정리, markerStore와 동일 정책).
// 있으면 넘어온 parts를 그대로(병합 없이) tmp+rename으로 원자 기록한다.
function save(dir, absPath, parts, meta) {
  const clean = sanitizeParts(parts);
  if (!clean.overview && !clean.narrative && !clean.sections && !clean.flow) {
    remove(dir, absPath);
    return { saved: false, parts: clean };
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = filePathFor(dir, absPath);
  const text = `${JSON.stringify({
    format: FORMAT,
    version: VERSION,
    path: path.resolve(absPath),
    savedAt: new Date().toISOString(),
    parts: clean,
    meta: sanitizeMeta(meta),
  }, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // 같은 볼륨 → 원자적
  return { saved: true, parts: clean };
}

function remove(dir, absPath) {
  try { fs.unlinkSync(filePathFor(dir, absPath)); } catch { /* 이미 없음 */ }
}

module.exports = {
  fileNameFor, filePathFor, sanitizeParts, load, save, remove, FORMAT, VERSION, KINDS, MAX_PART_CHARS,
};
