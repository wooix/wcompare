// src/main/settings.js — 앱 설정(userData/settings.json). 보관 폴더(storageDir)와 보관 정책 토글.
// electron에 의존하는 얇은 래퍼일 뿐, 저장 로직은 settingsStore(단위 테스트 가능)에 있다.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore } = require('./settingsStore.js');

const DEFAULTS = {
  storageDir: path.join(os.homedir(), '.local', 'wcompare'),
  archivePdfOnOpen: false,
  keepTranslationsInStorage: false,
  // 툴바 토글 단축키(사용자 변경 가능). 기본은 기존 기능과 겹치지 않게 ⌥ 위주로 고른다
  // (⌘F=찾기, ⌘S=저장, ⌘N=새 창, ⌘→=앞으로가 이미 쓰여 충돌하므로).
  shortcuts: {
    dict: 'Cmd+D',
    fit: 'Alt+F',
    sync: 'Alt+S',
    night: 'Alt+N',
    switch: 'Alt+ArrowRight',
  },
  // 화면 테마. 최상위 문자열 키는 settingsStore가 "절대경로"만 통과시키므로(storageDir 하나를
  // 위한 규칙) 여기에 그냥 theme:'dark'를 두면 저장이 조용히 무시된다 — 객체 키 하위값은
  // 임의 문자열이 허용되므로 ui 아래에 둔다.
  ui: {
    theme: 'dark', // 'dark' | 'light'
    // 비교 모드에서 긴 줄을 화면 폭에서 접을지. 켜도 논리 줄은 그대로 하나다(그리기만 바뀐다).
    wordWrap: false,
    // 좌우 비교 창을 같은 폭으로 잠글지. 끄면 가운데 분할선을 끌어 옮길 수 있지만,
    // 폭이 달라지면 같은 문장이 좌우에서 다른 지점에서 접힌다.
    paneEqualWidth: true,
  },
  // 번역 AI 모델 선택. engine은 transpaper --engine에 그대로 전달(agy|claude).
  // agyModel/claudeModel이 빈 문자열이면 엔진 기본값을 쓴다(플래그 생략).
  // agyModels는 "목록 새로고침"(agy models)으로 채워지고, claudeModels는 자주 쓰는 값으로 미리 채운다.
  // 둘 다 사용자가 목록에 없는 모델명을 입력하면 자동으로 추가된다(settingsStore의 문자열 배열 지원).
  translate: {
    engine: 'agy',
    agyModel: '',
    claudeModel: '',
    agyModels: [],
    claudeModels: ['sonnet', 'opus', 'haiku'],
  },
  // 요약 프롬프트 override. 빈 문자열 = 내장 기본값(paperSummary.PROMPT_DEFAULTS) 사용
  // — translate.agyModel이 ''이면 엔진 기본 모델을 쓰는 것과 같은 관례다.
  // 왜 "고친 적 없으면 빈 문자열"인가: 사용자가 손대지 않은 칸에 기본 문구를 그대로 복사해 두면,
  // 나중에 내장 프롬프트를 개선해도 옛 문구가 설정 파일에 박제돼 아무에게도 반영되지 않는다.
  // 여기 하위값은 전부 문자열이라 settingsStore가 그대로 받아 준다(객체 키의 문자열 하위값 규칙).
  summaryPrompts: {
    common: '',
    overviewSpec: '', overviewTail: '',
    narrativeSpec: '', narrativeTail: '',
    sectionsSpec: '', sectionsTail: '',
    flowSpec: '', flowTail: '',
  },
};

let store = null;
// app.getPath('userData')는 앱 준비 후에만 유효하므로 최초 사용 시점에 만든다(lazy).
const inst = () => (store ||= createSettingsStore(path.join(app.getPath('userData'), 'settings.json'), DEFAULTS));

const get = () => inst().get();
const set = (patch) => inst().set(patch);

// 보관 폴더 하위의 종류별 디렉터리를 보장하고 그 경로를 돌려준다.
// downloads: URL로 받은 PDF를 두는 곳 — 원본이 로컬에 없으므로 여기 파일이 곧 원본이다.
// summaries: 논문 요약 캐시 — LLM 호출이 느리고 비싸서 같은 논문을 다시 열면 즉시 복원해야 한다.
const SUBDIRS = {
  documents: 'documents', translations: 'translations', projects: 'projects',
  markers: 'markers', downloads: 'downloads', summaries: 'summaries',
  // memo 모드가 쓰는 메모 원문(.md)과 번역본(.ko.md)이 함께 쌓이는 곳.
  memos: 'memos',
};
function dirFor(kind) {
  const sub = SUBDIRS[kind];
  if (!sub) throw new Error(`알 수 없는 보관 폴더 종류: ${kind}`);
  const dir = path.join(get().storageDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { get, set, dirFor, DEFAULTS };
