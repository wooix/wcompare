# wcompare — 설계 문서 (v2, 리뷰 반영)

- 날짜: 2026-06-16
- 상태: 리뷰 반영 완료 (40개 발견 / blocker 8·major 20·minor 10·nit 2 → 모두 반영)
- 접근법: **A — 얇은 메인 프로세스 + 바닐라 렌더러**
- 리뷰 산출물: `wcompare-design-review` 워크플로(6차원 리뷰 → 적대적 검증 → 종합)

## 1. 목표 (What & Why)

두 파일을 Beyond Compare처럼 **나란히(side-by-side) 비교·편집·저장**하는 "매우 심플한" Electron 데스크톱 앱.

- 핵심: 파일 2개 비교
- 필수: **syntax 하이라이트 / lint / vim 모드** — 확장자에 따라 자동 적용
- 원칙: diff·syntax·vim·lint 알고리즘을 **직접 구현하지 않는다.** 검증된 라이브러리/CLI에 위임하고, 우리 코드는 "조립과 배선(glue)"에 집중한다.

### 성공 기준 (Acceptance)
1. `wcompare a.py b.py` 또는 GUI에서 파일 2개를 열면 좌/우 정렬된 diff가 보인다.
2. 확장자에 맞는 syntax 하이라이트가 자동 적용된다.
3. `.py`는 ruff(`--isolated` 내장 룰셋)로 진단 마커가 표시된다. `.js/.ts`는 wcompare 번들 기본 eslint flat config로 진단이 표시된다. **설치되지 않은 linter 언어는 조용히 건너뛴다(앱 정상 동작).** → ruff 진단이 acceptance의 1차 근거.
4. vim 키바인딩으로 편집/이동이 되고, 토글로 끌 수 있다.
5. 편집 후 Ctrl+S(또는 `:w`)로 **현재 active side** 파일이 디스크에 저장된다.

> Acceptance #3 정책 결정(오픈 질문 해소): lint는 **완전 격리 모드**로만 동작한다 — 사용자 프로젝트의 lint 설정은 자동으로 읽지 않는다(RCE 차단·항상 동일 동작). ruff는 `--isolated`, eslint는 `--no-config-lookup` + wcompare 번들 기본 config. 무설정 환경에서 eslint 진단 0개는 정상이며 버그가 아니다.

## 2. 비목표 (YAGNI — 명시적으로 안 만든다)

- 3-way 머지, 폴더(디렉토리) 트리 비교
- git/VCS 연동, 충돌 해결
- **사용자 프로젝트 lint 설정 자동 반영**("신뢰 폴더 확인 후 탐색"은 후순위)
- 플러그인 시스템, 설정 UI
- 다국어 i18n, 자동 업데이트, 코드 서명(배포는 MVP 이후)

## 3. 기술 스택

| 역할 | 선택 | 버전/비고 |
|---|---|---|
| 셸/런타임 | Electron | 최신 안정 메이저. `app.enableSandbox()` 사용 |
| 에디터/Diff/Syntax | Monaco Editor | **>=0.45.0 필수**(권장 `^0.52`). `goToDiff`가 0.45 도입 |
| Vim | monaco-vim | `initVimMode(editor, statusBarEl)` |
| Lint | 외부 CLI (ruff, eslint) | child_process spawn, **완전 격리 모드**, graceful skip |
| 번들러 | esbuild | 렌더러/preload/워커 번들(메인은 비번들) |
| 테스트 | node:test(단위) + @playwright/test `_electron`(E2E) | 파서/매핑은 순수함수 우선 |

**버전 고정 규칙:** `package.json`에서 `monaco-editor`는 0.45 미만 미지원을 명문화(하한 고정). 폴리필 분기를 두지 않는다(아래 §9).

## 4. 아키텍처 — 프로세스 분리 & 보안 기준선

```
┌─────────────────────────── Electron App ───────────────────────────┐
│  Main process (Node, 앱 실행 사용자 권한)   Renderer (Chromium sandbox)│
│  ┌─────────────────────────┐            ┌────────────────────────┐  │
│  │ main.js  부트/윈도우/메뉴 │            │ Monaco DiffEditor        │  │
│  │ scheme.js app:// 등록     │            │ monaco-vim ×2 (영구)     │  │
│  │ cli.js   argv 파싱        │  preload   │ languageMap (확장자→id)  │  │
│  │ fileService 읽기/쓰기/메타│◀──(safe)──▶│ lintController(마커)     │  │
│  │ lintService  linter 실행  │   IPC      │ toolbar/단축키/DnD       │  │
│  │ linters/* 어댑터          │            │ activeSide 추적          │  │
│  └─────────────────────────┘            └────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.1 보안 기준선 (모두 **무조건** 고정, 도피 조항 없음)
- `contextIsolation: true`, `nodeIntegration: false`, **`sandbox: true`** — `app.enableSandbox()`를 app ready 이전 호출.
- **설계 불변식**: `preload.js`는 Node 코어 모듈(`fs`/`child_process`/`os`/`path`)을 직접 require하지 않는다. `contextBridge` + `ipcRenderer`만 사용. (sandbox:true에서 preload의 Node 접근이 제한되므로 구조적으로 항상 성립.)
- **CSP**(file:///app:// `index.html`의 `<meta http-equiv="Content-Security-Policy">`, 1차):
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; font-src 'self' data:; img-src 'self' data:; connect-src 'none'`
  → 구현 중 DevTools CSP violation으로 `blob:`/`data:` 실제 필요 여부를 실측해 최소 권한으로 좁힌다.
- **네비게이션 차단**: `app.on('web-contents-created')`에서 `will-navigate` → `preventDefault()`, `setWindowOpenHandler(() => ({action:'deny'}))`. 외부 링크는 `shell.openExternal`로만. `dnd.js`는 document/window의 `dragover`/`drop` 기본 동작을 `preventDefault()`로 차단.
- **`webSecurity: false` 금지**(워커 로딩 회피책으로도 사용 금지).

### 4.2 IPC 계약 (신뢰 경계)
- `file:read`: dialog/CLI/DnD로 **사용자가 명시 선택한 경로**만. 경로 정규화 + symlink 해소 후 검증.
- `file:write`: 현재 세션의 **열린 파일 화이트리스트(좌/우 경로)** 에 속한 path만 허용, 그 외 거부. (XSS가 임의 파일 쓰기 프리미티브로 악용되는 것 차단.)
- `lint:run`: `{languageId, content, path}` 수신. 메인이 content 바이트 상한을 **자체 재검증**(렌더러 판단 불신).
- preload 이벤트 채널은 콜백을 래핑해 `IpcRendererEvent`를 렌더러로 절대 넘기지 않는다:
  `onOpenPair: (cb) => ipcRenderer.on('open-pair', (_e, data) => cb(data))`.

### 4.3 책임 경계 (한 줄 정의)
- **fileService**: 경로를 받아 `{content, isBinary, byteSize, eol, encoding}`를 읽고, 쓴다. 바이너리(NUL 휴리스틱)·크기 판정의 **단일 구현 위치**.
- **lintService**: `{languageId, content, path}` → 표준 `Diagnostic[]`. 라우팅 + 입력 바이트 상한 재검증 + graceful skip.
- **linters/\<name\>.js**: 특정 CLI를 spawn하고 stdout(JSON)을 표준 `Diagnostic`으로 정규화. **정규화 파서는 순수함수**로 분리(테스트 대상).
- **diffEditor.js**: DiffEditor 생성/모델 교체/언어 적용 캡슐화. 외부엔 `open(side, {...})`, `getValue(side)`, `onDirty(side, cb)`, `getInnerEditor(side)`만 노출.
- **lintController.js**: dirty/저장/로드 → 디바운스 → lintService → `setModelMarkers`. stale 결과 폐기(versionId 가드)·저장 시 디바운스 취소.
- **vimBinding.js**: 두 inner editor에 vim 영구 attach, focus → `activeSide` 갱신, `:w` ex 명령 전역 등록, 토글.

## 5. 파일/모듈 구조

```
wcompare/
├─ package.json
├─ esbuild.mjs                 # 렌더러/preload/워커 번들 (메인 비번들)
├─ playwright.config.js        # testDir: test/e2e, fullyParallel:false, workers:1
├─ eslint.config.mjs           # ⟵ wcompare가 lint에 주입하는 "기본 flat config"(번들 리소스)
├─ src/
│  ├─ main/
│  │  ├─ main.js               # enableSandbox, BrowserWindow, 메뉴, web-contents-created 가드
│  │  ├─ scheme.js             # app:// registerSchemesAsPrivileged + 핸들러
│  │  ├─ cli.js                # process.argv → 초기 0~2 파일
│  │  ├─ ipc.js                # ipcMain.handle (file:read/write, lint:run) + 화이트리스트
│  │  ├─ fileService.js        # fs 읽기/쓰기, isBinary/byteSize/EOL/BOM/인코딩
│  │  └─ lint/
│  │     ├─ lintService.js     # languageId→어댑터 라우팅, 바이트상한, 미설치 감지
│  │     ├─ which.js           # CLI 존재 확인(프로세스 수명 캐시)
│  │     └─ adapters/
│  │        ├─ ruff.js         # spawn(--isolated) + 순수 parseRuff()
│  │        └─ eslint.js       # spawn(--no-config-lookup -c <bundled>) + 순수 parseEslint()
│  ├─ preload/
│  │  └─ preload.js            # contextBridge: window.wcompare.{readFile,writeFile,lint,onOpenPair,...}
│  ├─ renderer/
│  │  ├─ index.html            # CSP meta 포함
│  │  ├─ monacoEnv.js          # self.MonacoEnvironment.getWorker(label) 매핑
│  │  ├─ app.js                # 부트, 레이아웃, 이벤트 배선
│  │  ├─ diffEditor.js
│  │  ├─ languageMap.js        # 확장자→languageId (순수)
│  │  ├─ vimBinding.js
│  │  ├─ lintController.js
│  │  ├─ toolbar.js            # 버튼/단축키/공백무시/테마/diff 이동
│  │  └─ dnd.js
│  └─ shared/
│     └─ diagnostics.js        # Diagnostic 타입/severity 매핑 (순수)
└─ test/
   ├─ languageMap.test.js
   ├─ ruffParser.test.js       # exit1+JSON→N개, exit2/파싱실패→[], invalid-syntax, surrogate
   ├─ eslintParser.test.js
   ├─ diagnostics.test.js      # 좌표 1-based/exclusive-end/UTF-16 엣지
   ├─ fileService.test.js      # EOL/BOM 왕복, isBinary
   ├─ lintController.test.js   # stale 폐기, 저장 시 디바운스 취소(순수 오케스트레이션부)
   └─ e2e/
      ├─ compare.spec.js       # 비교/syntax/vim/저장
      └─ graceful-skip.spec.js # linter 미설치 시 크래시 없음 (필수 게이트)
```

## 6. 데이터 흐름

1. **시작**: `cli.js`가 argv에서 0~2개 경로 추출.
2. **열기**(dialog 버튼 / DnD / CLI) → `file:read` → `{path, content, ext, isBinary, byteSize, eol, encoding}`.
   - **재열기 가드**: `open(side,...)` 호출 전, 해당 side가 dirty(●)면 **저장/버림/취소** 3지선다. 취소 시 기존 모델 유지. 같은 path 재열기(디스크 reload)와 다른 path 열기를 구분.
3. **표시**: `diffEditor.open(side,…)` → 모델 설정 + `languageMap`으로 languageId 적용 → Monaco가 syntax + diff 렌더.
   - **단일 파일(0~1개) 정책**: 반대쪽을 빈(untitled) 모델로 채워 동일 DiffEditor UI 유지. syntax/lint/vim/저장은 채워진 쪽에서 정상 동작. 빈 패널은 저장 대상 아님.
4. **편집**: 모델 변경 → **per-side dirty** 플래그 → 제목/탭에 `●`. (양쪽 모두 편집 가능)
5. **lint**: 로드/저장 시 즉시 + 편집 시 디바운스(600ms) → `lint:run` → 어댑터 spawn → `Diagnostic[]` → `setModelMarkers`. (stale 가드는 §8.4)
6. **저장**: Ctrl+S 또는 `:w` → **activeSide** 모델 내용 → `file:write(path, content, {eol, encoding})` → dirty 해제 → 저장 후 재-lint.
   - **activeSide = 단일 진실원천**: 브라우저 포커스가 있는(= vim이 키를 라우팅받는) 패널. Ctrl+S와 `:w`가 동일 activeSide로 라우팅.

## 7. 확장자 매핑

### 7.1 languageId (Monaco 기본 보유 언어 우선)
`.js/.cjs/.mjs/.jsx→javascript`, `.ts/.tsx→typescript`, `.json→json`, `.css→css`, `.scss→scss`, `.html/.htm→html`, `.xml→xml`, `.md/.markdown→markdown`, `.py→python`, `.sh/.bash→shell`, `.yaml/.yml→yaml`, `.sql→sql`, `.go→go`, `.rs→rust`, `.c/.h→c`, `.cpp/.hpp→cpp`, `.java→java`, `.ini/.cfg→ini`, **그 외 → plaintext**.

> **언어 서비스 vs 하이라이트 구분(중요)**: Monaco는 5종 언어 워커(json/css/html/ts)만 IntelliSense·내장 검증을 제공한다. `js/ts/json/css/scss/html`은 워커가 동작하지만, `python/yaml/go/rust/…`는 **syntax 하이라이트만** 되고 Monaco 자체 언어 검증은 없다(이쪽 진단은 외부 linter가 담당). `.toml` 등 Monaco 미보유 언어는 plaintext fallback.

### 7.2 linter 매핑 (완전 격리 모드)
| languageId | linter | 호출 | 정책 |
|---|---|---|---|
| python | ruff | `ruff check --output-format json --stdin-filename <abs> -` + `--isolated` | 내장 기본 룰셋(F + E 일부). 항상 동작 |
| javascript/typescript | eslint | `eslint --no-config-lookup -c <bundled eslint.config.mjs> --format json --stdin --stdin-filename <abs>` | wcompare 번들 기본 config. user config 무시 |
| (그 외) | 없음 | — | lint 생략 |

- 어댑터는 **stdin 입력** 사용(임시파일·셸 인젝션 회피).
- `which.js`로 CLI 존재를 **프로세스 수명 동안 1회** 확인 후 캐시(무효화 트리거 없음). 없으면 해당 언어 lint 영구 skip + 상태바 1회 안내.
- **eslint는 두 linter와 동일 추상으로 다루지 않는다**: 무설정 기본 룰셋이 없어 반드시 번들 config를 `-c`로 주입. ruff는 `--isolated`로 내장 룰셋 사용.

## 8. Lint 통합 상세

### 8.1 표준 Diagnostic & 좌표 규약
`{ startLine, startCol, endLine, endCol, message, severity('error'|'warning'|'info'), source, code? }`
- **ruff/eslint 모두 line·column이 1-based이며 column은 character(코드포인트) 1-based** → **-1/0-based 보정 금지**(보정 시 off-by-one).
- ruff `end_location.column` / eslint `endColumn`은 **exclusive end** → 표준 `endCol`에 그대로 매핑.
- **UTF-16 엣지**: Monaco column은 UTF-16 code unit 기준이므로, BMP 밖 문자(이모지 등 surrogate pair)에서는 linter의 코드포인트 column을 UTF-16 column으로 변환해야 정렬이 맞는다. → `diagnostics.test.js`에 surrogate-pair 케이스 포함.

### 8.2 ruff 어댑터
- ruff JSON에는 **severity 필드가 없음** → 매핑 규칙: `code === 'invalid-syntax'` → `error`, 그 외 → `warning`.
- 방어적 파싱: `code` 누락 시 `source='ruff'`로 생성, `url=null`이면 링크 생략, `fix=null`/`noqa_row=null` 안전 처리.
- 확인된 출력 형태(ruff 0.14.10): `location:{row,column}`(시작), `end_location:{row,column}`(끝) 모두 1-based.

### 8.3 결과 판정 (종료코드 ≠ 성공/실패)
- **stdout이 유효 JSON이면 exit 0/1 무관하게 진단으로 채택.** exit 1은 ruff/eslint에서 "진단 발견"을 뜻하는 **정상** 상태(허용 집합: ruff 0/1, eslint 0/1).
- stdout이 비고 `exit ≥ 2`(eslint 설정/치명 오류) 또는 타임아웃/크래시 → 빈 결과 + 상태바 1줄 로깅.
- `JSON.parse` 실패 → 빈 결과 + 로깅.
- **eslint 미설정 흡수**: `exit 2 + stderr "couldn't find ... eslint.config"` → 에러 토스트가 아니라 "미설정 skip" 상태바 1줄. (번들 config를 항상 `-c`로 주므로 정상 경로에서는 발생하지 않음 — 방어용.)

### 8.4 안정성/경쟁조건
- `spawn(cmd, argsArray)`(셸 미경유). 타임아웃(5s) + child.kill() 취소 경로. 최대 출력 버퍼 제한. EPIPE/조기종료 핸들러(에러 삼키지 않고 빈 결과).
- 사용자 제어 경로는 `path.resolve`로 절대경로화(`-` 접두 제거). 위치 인자 어댑터(향후)는 옵션 뒤 POSIX `--` 종결자. **lint 대상 '내용'은 절대 인자로 넣지 않고 stdin으로만.** (셸 미경유는 옵션 인젝션을 막지 못함을 명시.)
- **입력 바이트 상한**: 메인 `lint:run`이 content 길이를 자체 상한(5MB)으로 재검증, 초과 시 spawn 없이 빈 결과. child.stdin write()의 backpressure 대기.
- **stale 결과 폐기**: lint 요청 시 `model.getVersionId()` 캡처 → 결과 도착 시 `setModelMarkers` 직전 동일 versionId일 때만 적용, 다르면 폐기. 저장 시 떠 있는 디바운스 타이머 `clearTimeout` + in-flight lint를 AbortController/child.kill로 취소. `setModelMarkers` owner 문자열 일관 고정.

## 9. Diff / 비교 기능 (Monaco 위임 + 얇은 보강)

- `monaco.editor.createDiffEditor(el, { renderSideBySide:true, originalEditable:true, ignoreTrimWhitespace:<toggle>, automaticLayout:true })`.
  - **`originalEditable:true`** — 양쪽 편집 가능(Beyond Compare 모델, §6-4 per-side dirty와 일관).
- **차이 이동**: `diffEditor.goToDiff('next'|'previous')`(0.45+; 폴리필 분기 없음). 단축키 F7 / Shift+F7. → **IStandaloneDiffEditor**(createDiffEditor 반환)에 호출. `getModifiedEditor()/getOriginalEditor()`의 inner editor에는 `goToDiff`가 없음(§10 교차 주석).
- **공백 무시 토글**: `updateOptions({ ignoreTrimWhitespace })`.
- **getLineChanges 비동기 타이밍(중요)**: diff는 워커에서 비동기 계산 → `open()`/`setModel` 직후 `getLineChanges()`는 **null일 수 있음**. getLineChanges에 의존하는 모든 경로(복사 등)는 `diffEditor.onDidUpdateDiff` 콜백 이후에만 활성화하고 최신 lineChanges를 캐시해 소비. **null 가드(미완료 시 no-op) 의무.** 좌표는 공개 타입 `ILineChange`의 original/modified Start/EndLineNumber 기준. (getLineChanges는 deprecated 아님 — 교체 API 도입 금지.)
- **한쪽→다른쪽 복사(Beyond Compare 화살표)** — 얇게 직접 구현:
  - `executeEdits` 대상은 diff 에디터가 아니라 `getInnerEditor(side)`(inner `IStandaloneCodeEditor`) 또는 그 `.getModel()`.
  - onDidUpdateDiff 완료 후 **신선한** getLineChanges()로 **1블록 적용 → 재계산** 반복(기본). 사용자 편집 후 재계산 완료 전 복사 실행 방지 가드.
  - 다중 블록 일괄 적용 시 라인 번호 **내림차순**(아래 블록부터) 적용으로 오프셋 무효화 회피. (1블록 스코프는 무효화 없음.)

## 10. Vim 모드

- **두 inner editor에 영구 attach**: `getOriginalEditor()`/`getModifiedEditor()` 각각에 `initVimMode(editor, statusBarEl)`를 앱 수명 동안 1회씩. 포커스 전환 시 인스턴스를 옮기지 않음 — 키는 Monaco 포커스로 자연 라우팅되어 항상 1개만 활성.
- **상태바**: 패널마다 1개(initVimMode 호출당 DOM 노드 1개), 포커스된 쪽만 CSS로 표시. `statusBarEl`은 표시용이 아니라 `:` ex 명령·`/` 검색 시 monaco-vim이 내부에 `<input>`을 동적 생성·focus하는 컨테이너. **반드시 statusBarEl을 넘겨 attach**해야 dispose 시 자동 정리(closeInput/clear)가 발화 → 수동 `innerHTML=''` 불필요.
- **`:w` 저장 배선**: `VimMode.Vim.defineEx('write','w', cb)`는 **전역 1회 등록**(앱 부팅 시, 토글마다 재등록 금지). 콜백 `cb(cm, params)`의 `cm`은 monaco editor가 아니라 CodeMirror 호환 어댑터 → editor 참조를 인자에서 얻지 말고 **모듈 스코프 `activeSide`** 로 주입. 콜백은 activeSide로 `getInnerEditor(side).getValue()`와 path를 읽어 `file:write` IPC 전송. focus → activeSide 갱신 책임은 vimBinding.js.
- **토글**: 두 인스턴스를 **함께** dispose(끄기) / 함께 재생성(켜기). 기본 ON. vim OFF 시 `:w`는 없으므로 저장은 Ctrl+S로 단일화.
- **액션/단축키 등록 규칙**: diffEditor 객체에 직접 걸지 말고, 각 inner editor에 개별 `addAction`/`addCommand`(diff-editor 레벨 addAction은 modified 쪽에만 붙음).

## 11. 에러 처리 / 엣지 케이스

- 읽기 실패(권한/부재): 토스트 + 해당 패널 비움.
- **바이너리**(fileService NUL 휴리스틱): "바이너리 비교 미지원" 안내 + 텍스트 강제 열기 옵션.
- **대용량**(`byteSize > 5MB`): 경고 + **진행이 기본값**(차단보다 경고 후 진행, "매우 심플" 원칙). lint 자동 비활성, syntax/diff 유지.
- **인코딩/EOL**: UTF-8 기본, BOM 보존, 원본 EOL(CRLF/LF) 감지·저장 시 보존.
- **재열기 시 dirty 데이터 손실 방지**: §6-2 가드(저장/버림/취소). 미저장 편집은 명시 확인 없이 사라지지 않는다.
- **같은 path를 좌/우 동시(자기 비교)**: 저장 시 어느 쪽을 덮어쓰는지 경고.
- **외부 변경(mtime)**: 저장 시 mtime 비교로 덮어쓰기 경고(초기엔 단순).
- linter 타임아웃/크래시: 빈 결과 + 상태바 1줄.

## 12. 테스트 전략 (TDD 우선순위)

- **격리 불변식**: 단위테스트 대상(`languageMap`, `*Parser`, `diagnostics`, `fileService`, lintController의 순수 오케스트레이션부)은 **monaco/monaco-vim/electron을 import하지 않는 순수 모듈**. monaco languageId·좌표는 문자열/숫자 상수로만 다룸.
1. **순수 단위테스트(필수, TDD)**: languageMap, ruff/eslint 파서(exit1+JSON→N개 / exit2·파싱실패→[] / invalid-syntax / surrogate), diagnostics 좌표, fileService EOL·BOM·isBinary, lintController stale 폐기·저장 시 디바운스 취소.
2. **메인 IPC 통합**: lintService 라우팅(미설치 skip), which 캐시, file:write 화이트리스트 외 경로 거부, 콜백에 event 미노출.
3. **E2E(@playwright/test `_electron`)**:
   - `graceful-skip.spec.js`(**항상 실행, 필수 게이트**): ruff/eslint 미설치(PATH 비움/which 모킹) 시 크래시 없이 열리고 상태바 "미설치" 안내.
   - `compare.spec.js`(**linter 존재 시 게이팅**, test.skip): 두 파일 열기→diff/syntax, vim 토글, Ctrl+S 저장 후 디스크 반영, ruff 진단 마커. 단일 파일 시나리오 포함.
   - 실행 대상: `electron.launch({ args:['src/main/main.js'] })`로 **소스 main.js 직접 실행**. 렌더러/preload/워커는 빌드 산출물 필요 → `npm run e2e = npm run build && playwright test`.

## 13. 빌드 / 실행

### 13.1 esbuild 매트릭스
| 대상 | platform | format | 비고 |
|---|---|---|---|
| renderer(app.js 등) | browser | iife | monaco 번들 포함(external 아님) |
| preload.js | node(또는 neutral) | **cjs, 단일 파일** | `external:['electron']`. sandbox 제약상 단일 CJS |
| Monaco 워커 ×5 | browser | **iife(classic)** | 각 entryPoint. `{type:'module'}` ESM 워커 회피 |
| main 프로세스 | (번들 안 함) | — | Node가 `src/main/*`를 직접 require |

- **불변식**: `child_process`를 쓰는 `src/main/lint/*`는 렌더러/preload 번들 entry 그래프에 **절대 포함되지 않음**.
- **Monaco 워커 5 엔트리**: `editor.worker`, `json.worker`, `css.worker`, `html.worker`, `ts.worker`.
- **`monacoEnv.js`의 getWorker(label) 매핑**(Monaco 규격): `json→json.worker`, `css|scss|less→css.worker`, `html|handlebars|razor→html.worker`, `typescript|javascript→ts.worker`, 그 외 `default→editor.worker`. file:// 환경이므로 `getWorkerUrl(문자열)` 대신 **`getWorker(Worker 인스턴스)`**(Vite 방식).

### 13.2 워커 로딩 방식 (blocker 해소 — MVP 전 스파이크)
- **결정**: 커스텀 스킴 `app://`을 `registerSchemesAsPrivileged({ standard:true, secure:true, supportFetchAPI:true })`로 등록, 렌더러 HTML + Monaco 워커 번들을 **동일 `app://` 오리진**에서 서빙 → same-origin 보장(file://의 opaque-origin 문제 회피, sandbox:true/contextIsolation:true 유지).
- **MVP 착수 전 스파이크(필수)**: sandbox:true + contextIsolation:true 빌드에서 `app://` 오리진으로 `createDiffEditor` + typescript/json 언어 워커가 실제 생성되는지 검증. 실패 시 대안: getWorker에서 Blob 워커 프록시.

### 13.3 npm scripts
- `dev`: esbuild watch + electron / `build`: 프로덕션 번들 / `test`: node:test / `e2e`: `build && playwright test`.
- 패키징(`electron-builder`)은 MVP 이후.

## 14. 리스크 & 오픈 이슈 (해소 상태)

| # | 리스크 | 상태/완화 |
|---|---|---|
| R1 | DiffEditor + vim 키/포커스 충돌 | **해소**: 두 에디터 영구 attach + 포커스 라우팅. E2E로 좌/우 대칭 동작 확인 |
| R2 | file://+sandbox에서 Monaco 워커 로딩 실패 | **해소(결정)**: `app://` 커스텀 스킴 same-origin + MVP 전 스파이크(§13.2). esbuild는 Monaco 공식 통합 문서에 없는 비공식 경로 — Vite 예시를 직접 포팅 |
| R3 | linter 출력 포맷 버전차 | 어댑터 방어적 파싱 + 파서 단위테스트로 고정 |
| R4 | `.toml` 등 Monaco 미보유 언어 | plaintext fallback(초기), Monarch 후속 |
| R5 | ~~무설정 eslint 동작~~ | **정정**: 무설정 eslint는 빈 결과가 아니라 exit 2 → **번들 config + `--no-config-lookup`** 고정. ruff `--isolated` |
| R6 | diff 비동기 타이밍(open 직후 getLineChanges null) | **해소**: onDidUpdateDiff 게이트 + null 가드(§9) |
| R7 | untrusted config RCE(옆 eslint.config.js 자동 실행) | **해소**: 기본 완전 격리(`--no-config-lookup`/`--isolated`). 사용자 config 탐색은 비목표(후순위, 신뢰 폴더 확인 후) |
| R8 | stale lint race / 저장 경쟁 | **해소**: versionId 가드 + 디바운스 취소 + AbortController/child.kill(§8.4) |

## 15. 구현 순서 가이드 (요약)

1. **스파이크**: app:// 스킴 + sandbox 빌드에서 Monaco DiffEditor + 워커 생성 검증(§13.2). ← 최우선, 실패 시 설계 조정.
2. 순수 모듈 + 단위테스트(TDD): languageMap, diagnostics, ruff/eslint 파서, fileService.
3. 메인: scheme/main/ipc/fileService/lintService/adapters + IPC 화이트리스트.
4. 렌더러: diffEditor → languageMap 연결 → lintController → vimBinding → toolbar/dnd.
5. E2E: graceful-skip(필수) → compare(게이팅).
6. 다듬기: 복사 화살표, 재열기 가드, 단일 패널, 테마.
