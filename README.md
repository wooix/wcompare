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
- **줌**: 툴바 `−` / `+` 로 양쪽이 같은 배율로 확대·축소됩니다.
- **동기 토글**: `Sync: ON/OFF` 버튼으로 한쪽만 따로 볼 수 있고, 다시 켜면 즉시 재정렬됩니다.
- **페이지**: 상단 `Page n / N` 입력으로 양쪽이 함께 이동하고, 하단 상태바에 `L n/N  R n/N  배율%`가 표시됩니다.

렌더링은 [pdf.js](https://mozilla.github.io/pdf.js/)(`pdfjs-dist`)에 위임하며, PDF는 읽기 전용입니다.
PDF 워커도 Monaco 워커처럼 `app://` same-origin으로 로드되어 `sandbox:true`를 유지합니다.

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
