# wcompare

파일 2개를 Beyond Compare처럼 나란히 비교·편집·저장하는 매우 심플한 Electron 데스크톱 앱.
확장자에 따라 **syntax 하이라이트 / lint / vim 모드**가 자동 적용됩니다.

핵심 엔진(diff·syntax·vim·lint)은 직접 구현하지 않고 검증된 라이브러리/CLI에 위임합니다:
[Monaco Editor](https://microsoft.github.io/monaco-editor/)(diff·syntax), [monaco-vim](https://github.com/brijeshb42/monaco-vim)(vim), [ruff](https://docs.astral.sh/ruff/)·[ESLint](https://eslint.org/)(lint).

## 요구사항

- Node.js 18+ (개발 환경 기준 Node 26)
- lint를 쓰려면 해당 CLI가 PATH에 설치되어 있어야 합니다(없으면 조용히 건너뜀):
  - Python(`.py`): [`ruff`](https://docs.astral.sh/ruff/installation/)
  - JS/TS(`.js`/`.ts`): [`eslint`](https://eslint.org/docs/latest/use/getting-started)

## 설치 & 실행

```bash
npm install
npm run build      # 렌더러/preload/Monaco 워커 번들
npm start          # 앱 실행
# 또는 두 파일을 바로 열기:
npx electron . path/to/old.py path/to/new.py
```

개발 중에는 `npm run dev`(esbuild watch + electron)를 사용합니다.

## 파일 열기

- 툴바 **Open Left / Open Right** 버튼 (파일 선택 대화상자)
- 편집기 패널에 파일 **드래그앤드롭** (왼쪽 절반=좌, 오른쪽 절반=우)
- CLI 인자: `electron . a.py b.py`

## 단축키

| 동작 | 단축키 |
|---|---|
| 저장(현재 패널) | `Ctrl/Cmd+S` 또는 vim `:w` |
| 다음 / 이전 차이 | `F7` / `Shift+F7` |
| 왼쪽→오른쪽 / 오른쪽→왼쪽 블록 복사 | `Alt+→` / `Alt+←` |
| 파일 열기(좌 / 우) | `Ctrl/Cmd+O` / `Ctrl/Cmd+Shift+O` |
| vim 모드 / 공백 무시 / 테마 토글 | View 메뉴 또는 툴바 버튼 |

vim 모드는 기본 ON입니다. 포커스된 패널이 키를 받으며, 하단 상태바에 vim 상태가 표시됩니다.

## lint 동작 방식

- **완전 격리 모드**로 실행합니다: `ruff --isolated`, `eslint --no-config-lookup`(wcompare 번들 기본 config 사용).
- 즉 **여러분 프로젝트의 `eslint.config.js`/`pyproject.toml`은 자동으로 읽지 않습니다.** 이는 의도된 설계로,
  열린 파일 옆의 설정 파일이 lint 시 자동 실행되어 임의 코드가 도는 것(RCE)을 막기 위함입니다.
- 진단은 편집기에 마커(빨간/노란 물결)로 표시되고, 파일 저장·편집(디바운스) 시 갱신됩니다.

## PDF 동기 스크롤 뷰어

동일 format의 PDF 2개(예: 같은 문서의 영어판·한글판)를 좌/우에 띄우고 **함께 스크롤**합니다.

- **진입**: `.pdf` 파일을 열면 자동으로 PDF 모드로 전환됩니다(`electron . a.pdf b.pdf`, 파일 대화상자, 드래그앤드롭). 툴바 **PDF Mode / Diff Mode** 버튼으로 수동 전환도 됩니다.
- **스크롤 동기**: 한쪽을 스크롤하면 다른 쪽이 **비율 기반**으로 같이 움직입니다(양방향). 페이지 높이가 조금 달라도 비례로 따라갑니다.
- **줌**: 툴바 `−` / `+`, `Cmd/Ctrl +·−`, `Ctrl+휠` 로 양쪽이 같은 배율로 확대·축소됩니다.
- **Fit**: `Fit: ON/OFF` 는 **화면 너비에 맞추는 상태**입니다. 켜 두면 창 크기를 바꿔도 계속 너비에 다시 맞춥니다.
  직접 줌하면 자동으로 꺼지고, 다시 켜면 너비 맞춤으로 복귀합니다.
- **Switch**: `⇄ Switch` 로 좌우 문서를 맞바꿉니다. 이미 파싱된 문서 객체만 교환하므로 재파싱이 없습니다.
  한쪽만 열려 있으면 반대편으로 옮깁니다.
- **동기 토글**: `Sync: ON/OFF` 버튼으로 한쪽만 따로 볼 수 있고, 다시 켜면 즉시 재정렬됩니다.
- **페이지**: 상단 `Page n / N` 입력으로 양쪽이 함께 이동하고, 하단 상태바에 `L n/N  R n/N  배율%`가 표시됩니다.
- **검색**: `⌘F` 로 검색창에 들어가 **양쪽에서 동시에** 찾습니다. 일치 수는 `L 2/7  R 0/0` 처럼 좌우를 따로 보여줍니다
  (원문과 번역본은 텍스트가 달라 한쪽만 걸리는 게 정상입니다). `Enter` 다음 일치, `⇧Enter` 이전 일치, `Esc` 로 지웁니다.
  새 검색은 지금 보고 있는 쪽에서 시작합니다.
- **링크 히스토리**: 문서 안의 링크(인용·목차 등)로 튄 뒤 `◀`/`▶` 버튼, `⌘←`/`⌘→`,
  또는 **마우스 뒤로·앞으로 버튼**으로 원래 보던 자리로 돌아갑니다. 좌우 스크롤 위치를 함께 기록하므로
  `Sync: OFF` 상태에서도 두 pane이 각자 제자리로 돌아갑니다.
- **복사**: 텍스트를 드래그해 `⌘C`, 또는 우클릭 → `복사`.

## 마커 (형광펜 / 밑줄)

텍스트를 드래그로 선택한 뒤 **우클릭 → `형광펜` / `밑줄`**, 또는 단축키 `⌘⇧H` / `⌘⇧U`.
마커 위에서 우클릭하면 `마커 삭제`가 나옵니다.

- 좌표는 페이지 기준 **0~1로 정규화**해 보관하고 `%`로 그립니다 → 확대·축소·창 크기 변경을 그대로 따라갑니다.
- 마커는 side가 아니라 **문서**에 묶입니다 → `⇄ Switch` 해도 마커가 문서를 따라 반대편으로 갑니다.
- 마커는 **프로젝트 파일에 저장**됩니다. 프로젝트로 저장하지 않으면 앱을 닫을 때 사라집니다.

## 프로젝트 (.wcproj)

좌/우 파일과 뷰 상태(모드·sync·fit·페이지)와 마커를 한 파일로 저장했다가 그대로 복원합니다.

- **File → Open Project…** (`⌘⇧P`) / **Save Project** (`⌘⇧S`) / **Save Project As…**
- **File → Recent Projects**: 최근 10개. `~/Library/Application Support/wcompare/recent-projects.json`에 보관합니다.
- 파일 경로는 **상대경로를 먼저** 시도하고 절대경로로 폴백합니다 → 프로젝트와 PDF를 함께 옮겨도 열립니다.
- 파일이 없으면 그 쪽만 비우고 나머지는 엽니다(전체 실패하지 않습니다).

보안: 프로젝트 파일은 신뢰할 수 없는 데이터로 취급합니다. 경로 문자열은 렌더러에서 받지 않고
(열기는 메인이 dialog를 띄우고, 최근 항목은 경로가 아니라 **id**로 엽니다), 저장 시에는
**이번 세션에서 실제로 연 파일만** 프로젝트에 담을 수 있습니다. 마커는 읽을 때 개수·좌표를 다시 검증합니다.

렌더링은 [pdf.js](https://mozilla.github.io/pdf.js/)(`pdfjs-dist`)에 위임하며, PDF는 읽기 전용입니다.
PDF 워커도 Monaco 워커처럼 `app://` same-origin으로 로드되어 `sandbox:true`를 유지합니다.

## PDF 한국어 번역 (transpaper)

PDF를 **한쪽에만** 열면 툴바의 `한국어 번역 ▶` 이 활성화됩니다. 누르면 원본을 한국어로 번역해
**반대편 pane에 자동으로 띄웁니다** — 원문과 번역본을 스크롤 동기된 채로 나란히 읽을 수 있습니다.

- 번역은 외부 도구 [transpaper](https://github.com/wooix/transpaper)가 담당합니다(레이아웃을 보존한 오버레이 번역).
- 결과는 원본 옆에 `<이름>.ko.pdf` 로 저장됩니다. 원본 폴더가 읽기 전용이면 임시 폴더에 씁니다.
- 이미 `.ko.pdf` 가 있으면 다시 번역할지 기존 파일을 열지 묻습니다.
- **느립니다** — 페이지당 LLM 호출이 일어나 15페이지 논문 기준 수 분이 걸립니다. 진행 상황은
  번역본이 들어올 **빈 쪽 창에 오버레이**(`한국어 번역 중… 3 / 15 페이지` + 진행바)로 표시되고,
  `번역 취소` 버튼으로 중단할 수 있습니다. 앱을 종료하면 transpaper 프로세스도 함께 정리됩니다.

### 설치

`transpaper` 실행 파일이 PATH에 있어야 합니다. Finder로 띄운 `.app`은 셸을 거치지 않아
PATH가 `/usr/bin:/bin:...` 뿐이므로, wcompare는 `~/.local/bin`·`/opt/homebrew/bin`·`/usr/local/bin`을
자동으로 PATH에 얹습니다(transpaper가 내부에서 부르는 `agy`/`claude` CLI도 이렇게 찾습니다).

```bash
ln -s <transpaper>/.venv/bin/transpaper ~/.local/bin/transpaper
# 또는 실행 파일 경로를 직접 지정
export WCOMPARE_TRANSPAPER=/path/to/transpaper
```

## 개발: 테스트

```bash
npm test           # 단위 테스트(node:test) — 순수 모듈/파서/서비스
npm run e2e        # E2E(@playwright/test + Electron) — 빌드 후 실행
```

## 아키텍처

- **메인 프로세스**(`src/main/`): 파일 IO + linter CLI spawn + IPC. 시스템 접근을 전담.
- **렌더러**(`src/renderer/`): Monaco DiffEditor + vim + lint 마커, PDF 듀얼 뷰어(pdf.js + 비율 동기 스크롤), 모드 전환 UI.
- **보안**: `sandbox:true` + `contextIsolation:true`, `app://` 커스텀 스킴(워커 same-origin 로딩),
  CSP, 경로 화이트리스트 기반 쓰기, 외부 네비게이션 차단.

설계·구현 계획 문서는 `docs/superpowers/` 아래에 있습니다.
```
