// src/main/projectSaveDecision.js — 프로젝트 저장 "판정" 로직. electron 미의존(단위 테스트 가능).
// fs 접근은 deps로 주입한다(값이 아니라 함수) → 판정 분기 자체를 순수하게 테스트할 수 있다.
//
// decide(input, deps) 는 IO를 직접 하지 않고 "무엇을 할지" 계획만 돌려준다:
//   { action: 'needName', suggest }        — 렌더러 이름 모달을 띄워야 한다
//   { action: 'confirm',  target }         — 이미 있는(다른) 파일 → 덮어쓰기 확인이 필요하다
//   { action: 'write',    target, backup } — 바로 기록한다(backup=true면 먼저 .bak 로테이션)
// 실제 dialog/fs 기록은 project.js가 이 계획을 받아 수행한다.
const path = require('node:path');
const fs = require('node:fs');

// file이 dir 하위(또는 같음)인지. path.relative가 ..로 시작하지 않으면 하위.
function isInside(dir, file) {
  const rel = path.relative(dir, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 프로젝트 이름 정화. 경로 구분자(/, \)·상위 이동(..)·널문자를 거부하고 앞뒤 공백을 제거한다.
// 통과하지 못하면 null(→ 호출측은 needName으로 재요청).
function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim();
  if (!n || n.length > 80) return null;
  if (n.includes('\0') || n.includes('/') || n.includes('\\') || n.includes('..')) return null;
  if (/^\.+$/.test(n)) return null; // '.' 하나짜리 이름은 '..wcproj'가 되어 경로 판정이 어긋난다
  return n;
}

// 좌/우 파일 쌍이 "같은 프로젝트"인지. null끼리는 같음, 한쪽만 있으면 다름, 둘 다 있으면 정규화 후 비교.
function sameSide(x, y, norm) {
  if (!x && !y) return true;
  if (!x || !y) return false;
  return norm(x) === norm(y);
}
function pairsEqual(a, b, norm) {
  return sameSide(a?.left, b?.left, norm) && sameSide(a?.right, b?.right, norm);
}

// needName의 기본 제안 이름이 이미 있는 파일과 겹치면 ' 2', ' 3' … 로 유니크하게 만든다.
// taken(name) = 해당 이름의 프로젝트 파일이 projectsDir에 이미 있는가.
function uniqueName(base, taken) {
  if (!taken(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const cand = `${base} ${n}`;
    if (!taken(cand)) return cand;
  }
  return base; // 사실상 도달 불가 — 최후의 안전값
}

// input:  { name, saveAs, curPath, snapshot, projectsDir, ext }
// deps:   { exists(absPath)->bool, readPair(absPath)->{left,right}|throws, norm(p)->string }
function decide(input, deps) {
  const { name, saveAs = false, curPath = null, snapshot, projectsDir, ext } = input;
  const { exists, readPair, norm = (p) => path.resolve(p) } = deps;

  // 이 프로젝트의 제안 이름(확장자 제거) — cur이 있으면 그 이름, 없으면 왼쪽 파일명, 그마저 없으면 untitled.
  const suggestBase = () => {
    if (curPath) return path.basename(curPath, `.${ext}`);
    const left = snapshot?.files?.left;
    return left ? path.basename(left, path.extname(left)) : 'untitled';
  };
  const needName = () => ({
    action: 'needName',
    suggest: uniqueName(suggestBase(), (nm) => exists(path.join(projectsDir, `${nm}.${ext}`))),
  });

  // ── Case A: 이름을 명시적으로 받은 저장(이름 모달 결과 또는 "다른 이름으로 저장"의 확정) ──
  if (typeof name === 'string') {
    const clean = sanitizeName(name);
    if (!clean) return needName(); // 정화 후 빈 값/불량 → 다시 물어본다
    const target = path.join(projectsDir, `${clean}.${ext}`);
    // 경로 탈출 차단(정화가 이미 막지만 방어적으로 한 번 더).
    if (!isInside(projectsDir, target)) throw new Error('프로젝트 저장 경로가 보관 폴더를 벗어났습니다');
    const targetExists = exists(target);
    const isCur = curPath && norm(target) === norm(curPath);
    // 이미 있고 이 창의 현재 프로젝트가 아니면(= 남의 파일) 덮어쓰기 확인이 필요하다.
    if (targetExists && !isCur) return { action: 'confirm', target };
    return { action: 'write', target, backup: targetExists };
  }

  // ── Case B: 조용한 재저장(⌘⇧S) — "같은 프로젝트"일 때만 cur에 다시 쓴다 ──
  // 조건: cur이 보관 폴더 안 + cur 파일을 읽을 수 있음 + 저장된 파일 쌍이 지금 스냅샷과 일치.
  // 보관 폴더 밖(레거시)이거나 읽기 실패거나 쌍이 바뀌면(사실상 다른 프로젝트) 건드리지 않고 needName.
  if (!saveAs && curPath && isInside(norm(projectsDir), norm(curPath))) {
    let curPair;
    try { curPair = readPair(curPath); } catch { return needName(); }
    if (curPair && pairsEqual(curPair, snapshot?.files, norm)) {
      return { action: 'write', target: curPath, backup: true };
    }
    return needName();
  }

  // ── Case C: 최초 저장 / "다른 이름으로 저장" / cur 없음 ──
  return needName();
}

// 백업(1개 로테이션) + tmp+rename 원자 기록. 새 파일도 tmp+rename으로 통일한다.
// electron 미의존(fs만) → 임시 디렉터리에서 단위 테스트 가능.
function writeProjectFile(target, text, { backup = false } = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (backup && fs.existsSync(target)) {
    fs.copyFileSync(target, `${target}.bak`); // 항상 같은 .bak을 덮어쓴다(1개만 유지)
  }
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target); // 같은 볼륨 → 원자적
}

module.exports = { decide, sanitizeName, pairsEqual, uniqueName, isInside, writeProjectFile };
