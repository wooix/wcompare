// src/main/shortcutDict.js — 사전을 외부 앱(ShortcutDictionary.app)에 위임한다.
// 앱은 사전 데이터를 직접 갖지 않고, 시스템에 Control+Shift+D 키 이벤트를 보내
// ShortcutDictionary가 "현재 선택된 텍스트"를 사전에서 열게 한다(선택 텍스트는 그 앱이 자체적으로 읽는다).
// electron 비의존 — 러너(run) 주입으로 단위 테스트가 가능하다.
const { execFile } = require('node:child_process');

// key code 2 = 'd' (macOS 가상 키코드). ShortcutDictionary의 기본 단축키가 Control+Shift+D.
const KEY_CODE_D = 2;
// System Events로 Control+Shift+D를 합성한다. 접근성(손쉬운 사용) 권한이 있어야 동작한다.
const SCRIPT = `tell application "System Events" to key code ${KEY_CODE_D} using {control down, shift down}`;
const COMMAND = 'osascript';

// 기본 러너: execFile을 Promise로 감싼다. 성공 시 resolve, 실패 시 stderr를 실은 에러로 reject.
// (에러 분류는 triggerShortcutDict가 담당 — 러너는 실행만 한다.)
function defaultRun(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout, stderr });
    });
  });
}

// osascript로 Control+Shift+D를 보낸다. 러너 실패 시 stderr를 검사해 결과 코드를 정한다:
//  - 접근성 미허용: System Events가 -1719(권한 없음) 또는 "not allowed"/"assistive" 메시지를 낸다 → no-accessibility
//  - 그 외: error(메시지 포함)
async function triggerShortcutDict({ run = defaultRun } = {}) {
  try {
    await run(COMMAND, ['-e', SCRIPT]);
    return { ok: true };
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err || '');
    if (/-1719|not allowed|assistive/i.test(msg)) return { ok: false, code: 'no-accessibility' };
    return { ok: false, code: 'error', message: msg };
  }
}

module.exports = { triggerShortcutDict, SCRIPT, KEY_CODE_D, COMMAND };
