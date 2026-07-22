// src/main/settingsStore.js — 설정 저장소. electron 미의존(단위 테스트 가능).
// createSettingsStore(filePath, defaults) → { get, set }
//  - get(): 파일을 읽어 defaults와 merge(깨졌으면 defaults). 알 수 없는 키는 버린다.
//  - set(patch): 허용 키(defaults의 키)만, 타입이 맞을 때만 반영. tmp+rename 원자 기록 후 결과 반환.
//    · storageDir: 절대경로 문자열,  boolean 키: boolean,
//    · object 키(shortcuts, translate): 하위 병합 — 하위값은 defaults의 타입과 같을 때만 채택.
//      문자열 하위 defaults → 문자열만, 배열(문자열 배열) 하위 defaults → 원소가 전부 문자열인 배열만(통째 교체).
const fs = require('node:fs');
const path = require('node:path');

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function createSettingsStore(filePath, defaults) {
  const keys = Object.keys(defaults);

  // 스칼라 키 타입은 defaults의 값 타입으로 정한다: 문자열 키는 절대경로 문자열만, 불리언 키는 불리언만.
  function validScalar(def, value) {
    if (typeof def === 'boolean') return typeof value === 'boolean';
    if (typeof def === 'string') return typeof value === 'string' && path.isAbsolute(value);
    return false;
  }

  // object 키(예: shortcuts, translate) 병합: def의 하위 키만 채택하고, 하위값의 타입이
  // defaults의 그 하위값과 같은 종류일 때만 반영한다 — 문자열 defaults(예: shortcuts.dict,
  // translate.agyModel)는 문자열만(빈 문자열 허용 = "없음"), 문자열 배열 defaults(예:
  // translate.agyModels)는 원소가 전부 문자열인 배열만(통째 교체). 알 수 없는 하위 키는 무시.
  // base(현재 병합값) 위에 incoming을 덮어쓴다.
  function validSubValue(defVal, val) {
    if (typeof defVal === 'string') return typeof val === 'string';
    if (Array.isArray(defVal)) return isStringArray(val);
    return false;
  }
  function mergeObject(def, base, incoming) {
    const out = { ...def, ...(isPlainObject(base) ? base : {}) };
    if (isPlainObject(incoming)) {
      for (const sub of Object.keys(def)) {
        if (sub in incoming && validSubValue(def[sub], incoming[sub])) out[sub] = incoming[sub];
      }
    }
    return out;
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
      const def = defaults[key];
      if (isPlainObject(def)) {
        out[key] = mergeObject(def, {}, raw[key]); // defaults에서 시작해 raw의 유효 하위키만 덮어쓴다
      } else if (key in raw && validScalar(def, raw[key])) {
        out[key] = raw[key];
      }
    }
    return out;
  }

  function set(patch) {
    const next = get();
    for (const key of keys) {
      const def = defaults[key];
      if (isPlainObject(def)) {
        if (patch && key in patch) next[key] = mergeObject(def, next[key], patch[key]); // 부분 patch 허용
      } else if (patch && key in patch && validScalar(def, patch[key])) {
        next[key] = patch[key];
      }
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
