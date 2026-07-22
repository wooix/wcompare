// src/main/markerStore.js — PDF별 마커 자동 영속화 저장소. electron 미의존(순수 fs → 단위 테스트 가능).
//
// 저장 위치: <dir>/<basename>.<sha1(정규화 절대경로)>.json — 파일 1개 = PDF 1개.
//   sha1은 결정적이라 "같은 경로 → 같은 파일"이 보장된다(basename 접두는 사람이 알아보기 위한 장식일 뿐,
//   충돌/유일성은 전적으로 해시가 책임진다). 경로 정규화(realpath)는 호출측(main/ipc)이 하고
//   이 모듈은 받은 절대경로를 path.resolve만 해서 해싱한다 — 순수성 유지.
//
// 내용: { format:'wcompare-markers', version:1, path:<abs>, savedAt, markers:[...] }.
//   markers는 저장/로드 양쪽에서 projectFile.sanitizeMarkers로 정화한다(신뢰 불가 입력 방지 + 상한).
//
// 멀티윈도우 한계: 같은 PDF를 두 창(또는 두 pane)에서 열어 각각 편집하면 "마지막 저장이 이긴다".
//   tmp+rename 원자 기록으로 파일이 반쯤 쓰인 채 깨지는 것만 막고, 병합은 하지 않는다.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeMarkers } = require('./projectFile.js');

const FORMAT = 'wcompare-markers';
const VERSION = 1;

// 결정적 파일명: 정규화 절대경로의 sha1 + 가독성용 basename 접두(파일시스템 안전 문자만, 40자 제한).
function fileNameFor(absPath) {
  const resolved = path.resolve(absPath);
  const hash = crypto.createHash('sha1').update(resolved).digest('hex');
  const base = path.basename(resolved).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'pdf';
  return `${base}.${hash}.json`;
}

function filePathFor(dir, absPath) {
  return path.join(dir, fileNameFor(absPath));
}

// 로드: 파일 없음·JSON 손상·형식 불일치는 모두 빈 배열로(열기 흐름을 절대 막지 않는다).
function load(dir, absPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePathFor(dir, absPath), 'utf8'));
    return sanitizeMarkers(raw?.markers);
  } catch {
    return [];
  }
}

// 저장: 정화 후 마커가 하나도 없으면 파일을 지운다(빈 파일이 쌓이지 않게 = 정리).
// 있으면 tmp+rename으로 원자적으로 기록한다.
function save(dir, absPath, markers) {
  const clean = sanitizeMarkers(markers);
  if (!clean.length) { remove(dir, absPath); return { count: 0, deleted: true }; }
  fs.mkdirSync(dir, { recursive: true });
  const file = filePathFor(dir, absPath);
  const text = `${JSON.stringify({
    format: FORMAT,
    version: VERSION,
    path: path.resolve(absPath),
    savedAt: new Date().toISOString(),
    markers: clean,
  }, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // 같은 볼륨 → 원자적
  return { count: clean.length, deleted: false };
}

function remove(dir, absPath) {
  try { fs.unlinkSync(filePathFor(dir, absPath)); } catch { /* 이미 없음 */ }
}

module.exports = { fileNameFor, filePathFor, load, save, remove, FORMAT, VERSION };
