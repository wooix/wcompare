// src/renderer/shortcuts.js — 토글 단축키의 표현/매칭 순수 모듈.
// electron·DOM 전역에 의존하지 않는다(node 단위 테스트 가능). esbuild가 렌더러 번들에 포함한다.
//  - 표현 포맷: modifier들 + main key를 "+"로 이어붙인 문자열. 순서 고정 Cmd, Ctrl, Alt, Shift.
//    (Cmd=metaKey). 예: "Cmd+D", "Alt+F", "Alt+ArrowRight", "Cmd+Shift+F".
//  - main key는 반드시 e.code에서 유도한다: ⌥+문자는 e.key가 특수문자(예 "ƒ")로 와서 못 쓴다.

// 표현 문자열에 등장하는 modifier 토큰의 고정 순서.
const MOD_ORDER = ['Cmd', 'Ctrl', 'Alt', 'Shift'];

// modifier 단독 키(code) — 이 키만 눌린 경우 단축키로 성립하지 않으므로 null.
const MODIFIER_CODES = new Set([
  'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'OSLeft', 'OSRight',
]);

// e.code → main key 표현. "KeyD"→"D", "Digit1"→"1", 그 외(ArrowRight, Comma…)는 그대로.
function mainKeyFromCode(code) {
  if (!code) return null;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code; // ArrowRight, ArrowLeft, Comma, Period, Slash, Minus, Equal, NumpadAdd …
}

// KeyboardEvent(또는 {code, metaKey, altKey, ctrlKey, shiftKey} 모의 객체) → 표현 문자열.
// modifier 단독키면 null. 표현에 modifier가 없을 수도 있다(단일 키) — 할당 가능 여부는 호출측이 판단.
function normalizeEvent(e) {
  if (!e) return null;
  const code = e.code;
  if (!code || MODIFIER_CODES.has(code)) return null;
  const main = mainKeyFromCode(code);
  if (!main) return null;
  const parts = [];
  if (e.metaKey) parts.push('Cmd');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(main);
  return parts.join('+');
}

// 표현 문자열에 modifier가 하나라도 있으면 true(할당 가능 조건 — 맨 modifier 없는 단일 키 거부).
function hasModifier(str) {
  if (!str) return false;
  return str.split('+').slice(0, -1).some((p) => MOD_ORDER.includes(p));
}

// 표시용 치환 — modifier/특수 키를 기호로. "Cmd+D"→"⌘D", "Alt+ArrowRight"→"⌥→".
const DISPLAY = {
  Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧',
  ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓',
  Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=',
  Space: '␣', Enter: '↵', Escape: '⎋', Backspace: '⌫', Tab: '⇥',
};
function format(str) {
  if (!str) return '';
  return str.split('+').map((p) => DISPLAY[p] || p).join('');
}

// 기존에 이미 쓰이는 표현 → 용도 라벨. normalizeEvent와 같은 표기로 통일한다.
// (comma는 accelerator에선 "," 지만 여기선 code 표기 "Comma"로 통일하고 format이 ","로 표시.)
const RESERVED = {
  'Cmd+O': '열기 왼쪽',
  'Cmd+Shift+O': '열기 오른쪽',
  'Cmd+W': '닫기',
  'Cmd+Shift+W': '닫기 오른쪽',
  'Cmd+S': '저장',
  'Cmd+Shift+P': '프로젝트 열기',
  'Cmd+Shift+S': '프로젝트 저장',
  'Cmd+Comma': '설정',
  'Cmd+N': '새 창',
  'Cmd+F': '찾기',
  'Cmd+ArrowLeft': '뒤로',
  'Cmd+ArrowRight': '앞으로',
  'Cmd+Shift+H': '형광펜',
  'Cmd+Shift+U': '밑줄',
};
function isReserved(str) {
  return (str && RESERVED[str]) || null;
}

// 커스터마이즈 대상 토글 액션과 사람이 읽는 라벨.
const ACTIONS = [
  { id: 'dict', label: '사전' },
  { id: 'fit', label: 'Fit(맞춤)' },
  { id: 'sync', label: 'Sync(동기 스크롤)' },
  { id: 'night', label: 'Night(야간)' },
  { id: 'switch', label: 'Switch(좌우 교체)' },
];

module.exports = { normalizeEvent, hasModifier, format, isReserved, RESERVED, ACTIONS };
