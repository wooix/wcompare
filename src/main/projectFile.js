// src/main/projectFile.js — .wcproj 직렬화/파싱/검증. electron 미의존(단위 테스트 가능).
const path = require('node:path');
const fs = require('node:fs');

const FORMAT = 'wcompare-project';
const VERSION = 2; // v2: 마커에 group(미러 쌍 묶음)·origin('mirror') 필드 추가. v1은 그대로 열린다.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MARKERS = 5000;
const MAX_RECTS = 500;
const KINDS = new Set(['highlight', 'underline']);

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

// 프로젝트 파일은 "신뢰할 수 없는 데이터"다(메일·git으로 유통된다) → 전부 다시 만든다.
function sanitizeMarkers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_MARKERS).flatMap((m) => {
    if (!m || !KINDS.has(m.kind)) return [];
    const page = Number.isInteger(m.page) && m.page >= 1 ? m.page : null;
    if (!page) return [];
    const rects = (Array.isArray(m.rects) ? m.rects : []).slice(0, MAX_RECTS)
      .map((r) => ({ x: clamp01(r?.x), y: clamp01(r?.y), w: clamp01(r?.w), h: clamp01(r?.h) }))
      .filter((r) => r.w > 0 && r.h > 0);
    if (!rects.length) return [];
    return [{
      id: typeof m.id === 'string' ? m.id.slice(0, 64) : `mk${page}`,
      page,
      kind: m.kind,
      color: typeof m.color === 'string' ? m.color.slice(0, 32) : '#ffd64a',
      // 미러 쌍 메타데이터(v2). 없으면 필드 자체를 만들지 않는다 — v1 파일과 왕복이 동일하게.
      ...(typeof m.group === 'string' && m.group ? { group: m.group.slice(0, 64) } : {}),
      ...(m.origin === 'mirror' ? { origin: 'mirror' } : {}),
      rects,
    }];
  });
}

function serialize(snapshot, projectPath) {
  const dir = path.dirname(path.resolve(projectPath));
  const fileEntry = (abs) => (abs ? { abs, rel: path.relative(dir, abs) } : null);
  const text = `${JSON.stringify({
    format: FORMAT,
    version: VERSION,
    savedAt: new Date().toISOString(),
    mode: snapshot.mode === 'pdf' ? 'pdf' : 'diff',
    files: {
      left: fileEntry(snapshot.files?.left),
      right: fileEntry(snapshot.files?.right),
    },
    view: {
      sync: snapshot.view?.sync !== false,
      fit: snapshot.view?.fit !== false,
      page: {
        left: snapshot.view?.page?.left || 1,
        right: snapshot.view?.page?.right || 1,
      },
    },
    markers: {
      left: sanitizeMarkers(snapshot.markers?.left),
      right: sanitizeMarkers(snapshot.markers?.right),
    },
  }, null, 2)}\n`;
  // parse가 MAX_BYTES를 거부하므로 여기서 막지 않으면 "저장은 되는데 다시 열 수 없는" 파일이 생긴다.
  // 열기 쪽 1차 관문은 stat.size(바이트)라 length가 아니라 byteLength로 재야 한다.
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    throw new Error('프로젝트가 너무 커서 저장할 수 없습니다 (2MB 초과). 마커를 줄여 주세요.');
  }
  return text;
}

// 프로젝트와 파일이 함께 옮겨간 경우(git repo, 외장 드라이브)를 살리기 위해 rel을 먼저 시도한다.
function resolveEntry(entry, dir) {
  if (!entry) return null;
  const cands = [];
  if (typeof entry.rel === 'string' && entry.rel) cands.push(path.resolve(dir, entry.rel));
  if (typeof entry.abs === 'string' && entry.abs) cands.push(entry.abs);
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return { path: c, missing: false }; } catch { /* 다음 후보 */ }
  }
  return cands.length ? { path: cands[cands.length - 1], missing: true } : null;
}

function parse(text, projectPath) {
  if (text.length > MAX_BYTES) throw new Error('프로젝트 파일이 너무 큽니다 (2MB 초과)');
  let raw;
  try { raw = JSON.parse(text); }
  catch { throw new Error('프로젝트 파일을 읽을 수 없습니다 (JSON 형식 오류)'); }

  if (raw?.format !== FORMAT) throw new Error('wcompare 프로젝트 파일이 아닙니다');
  if (!Number.isInteger(raw.version)) throw new Error('프로젝트 파일에 version이 없습니다');
  // 관대하게 열면 모르는 필드가 조용히 유실된다 → 상위 버전은 열지 않는다.
  if (raw.version > VERSION) throw new Error(`더 새로운 버전의 프로젝트입니다 (v${raw.version}). 앱을 업데이트하세요.`);

  const dir = path.dirname(path.resolve(projectPath));
  const left = resolveEntry(raw.files?.left, dir);
  const right = resolveEntry(raw.files?.right, dir);

  return {
    projectPath: path.resolve(projectPath),
    mode: raw.mode === 'pdf' ? 'pdf' : 'diff',
    files: { left, right }, // { path, missing } | null
    view: {
      sync: raw.view?.sync !== false,
      fit: raw.view?.fit !== false,
      page: { left: raw.view?.page?.left || 1, right: raw.view?.page?.right || 1 },
    },
    markers: {
      left: sanitizeMarkers(raw.markers?.left),
      right: sanitizeMarkers(raw.markers?.right),
    },
  };
}

module.exports = { serialize, parse, sanitizeMarkers, FORMAT, VERSION, MAX_BYTES };
