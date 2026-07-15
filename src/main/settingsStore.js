// src/main/settingsStore.js — 설정 저장소. electron 미의존(단위 테스트 가능).
// createSettingsStore(filePath, defaults) → { get, set }
//  - get(): 파일을 읽어 defaults와 merge(깨졌으면 defaults). 알 수 없는 키는 버린다.
//  - set(patch): 허용 키(defaults의 키)만, 타입이 맞을 때만 반영. tmp+rename 원자 기록 후 결과 반환.
//    · storageDir: 절대경로 문자열,  archivePdfOnOpen/keepTranslationsInStorage: boolean.
const fs = require('node:fs');
const path = require('node:path');

function createSettingsStore(filePath, defaults) {
  const keys = Object.keys(defaults);

  // 키별 타입은 defaults의 값 타입으로 정한다: 문자열 키는 절대경로 문자열만, 불리언 키는 불리언만.
  function validKey(key, value) {
    const def = defaults[key];
    if (typeof def === 'boolean') return typeof value === 'boolean';
    if (typeof def === 'string') return typeof value === 'string' && path.isAbsolute(value);
    return false;
  }

  function readRaw() {
    try {
      const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {}; // 파일이 없거나 깨졌으면 defaults만 남는다
    }
  }

  function get() {
    const raw = readRaw();
    const out = { ...defaults };
    for (const key of keys) {
      if (key in raw && validKey(key, raw[key])) out[key] = raw[key];
    }
    return out;
  }

  function set(patch) {
    const next = get();
    for (const key of keys) {
      if (patch && key in patch && validKey(key, patch[key])) next[key] = patch[key];
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, filePath); // 같은 볼륨 → 원자적
    return next;
  }

  return { get, set };
}

module.exports = { createSettingsStore };
