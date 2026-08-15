# memo 모드 구현 지시서

> 대상: wcompare (`/Volumes/EX400U/workspace/develop/wcompare`), 브랜치 `feat/pdf-dual-viewer`
> 이 문서는 다른 세션·에이전트가 받아 **바로 구현에 착수**할 수 있게 쓰였다.
> 2절의 결정은 사용자가 이미 내린 것이다 — 임의로 바꾸지 말고, 이견이 있으면 구현 전에 보고하라.

---

## 1. 목표

마크다운 메모를 쓰기 위한 세 번째 모드를 만든다. 기본은 마크다운 에디터이고, 옆에 **번역**과
**미리보기**를 띄워 함께 볼 수 있다.

핵심은 "왼쪽이 기준(메인)"이라는 한 가지 규칙이다. 왼쪽 에디터가 지금 쓰고 있는 문서이고,
미리보기는 **언제나 메인을 렌더**한다. 좌우를 바꾸면 메인이 바뀌고 미리보기도 따라간다.

---

## 2. 확정된 결정 (변경 금지)

| # | 항목 | 결정 |
|---|---|---|
| 1 | 모드 구성 | `diff` / `pdf` / `memo` **별개 3종**. diff를 흡수하거나 memo를 diff 안에 넣지 않는다 |
| 2 | 기본 화면 | 마크다운 에디터 (Monaco) |
| 3 | 열 구성 | **에디터 \| 번역 \| 미리보기 3열**. 번역과 미리보기는 **각각 독립적으로** 열고 닫는다 |
| 4 | 번역 실행 | **버튼으로 문서 전체**. 문단 자동 번역·선택 영역 번역이 아니다 |
| 5 | 번역창의 성격 | **번역창도 동일한 에디터**다. 사용자가 번역본을 직접 고칠 수 있다 |
| 6 | 좌우 스왑 | **에디터 ↔ 번역창을 교환**한다. 번역창이 왼쪽(메인)이 되면 **미리보기도 새 메인을 렌더**한다 |
| 7 | 파일 위치 | 보관 폴더의 **`memos/`** (`settings.dirFor('memos')`) |
| 8 | 재번역 충돌 | 번역본이 마지막 번역 이후 **수정된 경우에만** "손본 내용이 사라집니다" 확인을 띄운다. 안 건드렸으면 조용히 진행 |
| 9 | 저장 시점 | **명시적 저장(⌘S)만**. 자동 저장하지 않는다 |
| 10 | 종료 시 | 앱을 닫을 때 **미저장분이 있으면 저장 여부 팝업**을 띄운다 |

---

## 3. 현재 코드베이스 — 재사용할 것과 손댈 곳

### 3.1 그대로 재사용

| 자산 | 위치 | 쓰임 |
|---|---|---|
| Monaco 에디터·dirty 추적 | `src/renderer/diffEditor.js` | `open/close/getValue/getState`, dirty 콜백. **다만 좌우 2개 고정 구조다** — 4절 참고 |
| 마크다운 렌더러 | `src/renderer/markdownView.js` `renderMarkdown(el, text)` | 미리보기. 요약 패널이 쓰던 것을 그대로 |
| 목차 | `src/renderer/mdToc.js` | 필요하면. 지금은 diff 모드 왼쪽 전용 드로어 |
| **열 폭 스플리터** | `src/renderer/paneSplit.js` `createPaneSplit(host, {target, onResize})` | 3열 폭 조절. `clampWidth`가 "어느 쪽도 0px가 되지 않음"을 보장 |
| 파일 읽기·쓰기 | `src/main/fileService.js` `readFile/writeFile` | EOL·BOM 보존 |
| LLM CLI 호출 관용구 | `src/main/paperSummary.js` | detached spawn, 타임아웃, 출력 상한, 취소, stderr 꼬리표. **번역은 이 파일을 본떠 새로 만든다** |
| 진행 표시·취소 | `src/main/translationJobs.js` | 창당 1개 작업 제한 |

### 3.2 반드시 손대야 하는 곳

**`src/renderer/app.js`**
- `setMode(m)` (209행 부근): 지금은 `diff`/`pdf` 2분기다. `#diff-wrap`/`#pdfview` 표시,
  `#diff-controls`/`#pdf-controls`(`display:contents`), `#statusbars`/`#pdf-status`를 전부 3분기로.
- `$('btn-mode').onclick` (778행): 지금은 **2항 토글**(`mode === 'diff' ? 'pdf' : 'diff'`)이고
  버튼 라벨도 상대 모드 이름을 보여준다. 3종이 되면 이 방식이 성립하지 않는다 →
  `#pdf-layout`처럼 **붙은 버튼 3개 선택**으로 바꾼다(그쪽 CSS 관용구를 그대로 쓴다).
- `dirtyGuard(side)` (54행): `prompt('save / discard / cancel 중 입력')` — 네이티브 `prompt`다.
  memo 모드에서도 쓰려면 이 조악함이 그대로 드러난다. **개선 여부는 구현자 판단**이되,
  종료 시 팝업(결정 10)은 이것과 별개로 main의 dialog를 써야 한다.

**`src/main/settings.js`**
- `SUBDIRS`(63행)에 `memos: 'memos'` 추가. 그러면 `dirFor('memos')`가 폴더를 보장한다.

**`src/main/main.js`**
- 지금은 `app.on('will-quit', () => cancelTranslation())`뿐이고 **닫기를 가로채는 경로가 없다**.
  결정 10을 위해 `win.on('close', e => …)`로 막고 렌더러에 미저장 여부를 물어 `dialog.showMessageBox`를
  띄우는 왕복이 필요하다. 이것이 이 작업에서 **가장 까다로운 부분**이다(4.4 참고).

**`src/renderer/index.html`**
- `#memoview` 컨테이너와 `#memo-controls` 툴바 묶음 신설. 툴바 묶음은 반드시
  `display:contents`로 토글한다 — `flex`면 툴바가 두 줄로 접히지 않는다(주석에 이유가 적혀 있다).

---

## 4. 구현 계약

### 4.1 화면 구조

```
#memoview (flex row)
├─ .memo-pane[data-role=main]   (flex:1 1 0)   ← 에디터 (항상 보임)
├─ .pane-split                                  ← 번역창이 열려 있을 때만
├─ .memo-pane[data-role=trans]  (폭 가변)       ← 번역 에디터 (토글)
├─ .pane-split                                  ← 미리보기가 열려 있을 때만
└─ .memo-preview                (폭 가변)       ← 미리보기 (토글)
```

- 번역·미리보기는 **서로 독립**이다. 넷 중 어떤 조합도 성립해야 한다(둘 다 닫힘 / 번역만 /
  미리보기만 / 둘 다).
- 닫힌 열의 스플리터도 함께 숨는다. **허공에 손잡이가 남으면 안 된다**(PDF 모드에서 같은 실수를
  이미 한 번 잡았다 — `#pdfview.layout-compare .pane-split { display:none }` 참고).

### 4.2 좌우 스왑 (결정 6)

- 상태는 `mainSide: 'source' | 'translation'` 하나로 둔다. "지금 왼쪽에 있는 게 원문인가 번역본인가".
- 스왑은 **두 에디터의 내용·경로·dirty 상태를 맞바꾸는 것이 아니라, 배치만 바꾸는 것**이어야 한다.
  내용을 실제로 옮기면 dirty 판정과 저장 대상이 어긋난다. `order` CSS나 DOM 재배치로 해결하라.
- 미리보기는 **항상 `mainSide`가 가리키는 문서**를 렌더한다. 스왑하면 즉시 다시 렌더한다.
- PDF의 `dualView.switchSides()`는 **파싱된 문서 객체를 맞바꾸는 구현**이라 여기 재사용할 수 없다.
  이름만 빌리고 로직은 새로 짜라.

### 4.3 번역 (결정 4·5·8)

- 새 모듈 `src/main/memoTranslate.js`. `paperSummary.js`의 spawn 관용구를 본뜨되,
  **프롬프트는 마크다운 구조를 보존하도록** 짠다(헤딩 레벨·코드블록·표·링크를 그대로 유지).
- 입력 상한·제어문자 제거·argv 정화는 `paperSummary.js`와 **같은 강도로** 건다.
  특히 NUL 하나로 spawn이 인자를 통째로 거부해 실패한 전례가 있다.
- 결과는 번역 에디터에 넣고, 그 시점의 내용 해시(또는 사본)를 `lastTranslatedAt` 기준으로 보관한다.
  **재번역 시 현재 번역본이 그 기준과 다르면** 확인 대화상자를 띄운다(결정 8).
  확인 문구는 `번역본 삭제` 버튼의 관용구를 따른다(main의 `dialog.showMessageBox`, 기본 선택은 취소).
- 진행 중에는 번역 버튼을 잠그고 취소 수단을 준다. 창당 1개만 실행(`translationJobs` 관용구).

### 4.4 저장 (결정 7·9·10)

- 파일: 원문 `memos/<이름>.md`, 번역본 `memos/<이름>.ko.md`.
- **경로는 렌더러가 만들지 않는다.** main이 `dirFor('memos')` 기준으로 만들고 `allowPath`로 등록한다.
  이것이 이 저장소의 신뢰 경계 원칙이고, 예외를 두지 마라.
- ⌘S는 **현재 포커스가 있는 에디터**를 저장한다. 두 에디터가 각각 dirty를 가진다.
- 종료 팝업: `win.on('close')`에서 `e.preventDefault()` → 렌더러에 미저장 여부 질의 →
  `dialog.showMessageBox`로 `저장 / 저장 안 함 / 취소` → 결과에 따라 저장 후 `win.destroy()` 또는 취소.
  **함정**: 저장 후 `close()`를 다시 부르면 핸들러가 재진입해 무한 루프가 된다. 플래그로 막아라.
  여러 창이 열려 있는 경우도 각 창이 독립적으로 이 흐름을 타야 한다.

### 4.5 미리보기

- `renderMarkdown`으로 렌더한다. 읽기 전용이다.
- 편집 중 매 타자마다 다시 그리면 긴 문서에서 버벅인다 → **디바운스**를 걸어라(요약 프롬프트
  저장에서 쓴 600ms 관용구가 참고가 된다).
- 스크롤 동기(에디터 ↔ 미리보기)는 **이번 범위에 넣지 않는다**. 필요하면 후속으로 다룬다.

---

## 5. 반드시 지킬 함정 (이 저장소에서 실제로 당한 것들)

1. **e2e는 `dist/` 번들을 시험한다.** `src`를 고친 뒤 반드시 `npm run build`를 하고 spec을 돌려라.
   빌드 없이 `npx playwright test`를 부르면 stale 번들을 시험해 "고쳤는데 실패"가 난다.
2. **삭제·이동한 요소에 `toBeHidden()`으로 회귀 감시를 걸지 마라.** Playwright는 DOM에 없는 요소도
   hidden으로 친다 → 요소를 지우면 그 단언이 저절로 참이 되어 감시가 죽는다. `toHaveCount(0)`과
   **남은 것의 개수**로 세라.
3. **`npx eslint`를 쓰지 마라.** 이 프로젝트에는 `lint` 스크립트도 eslint 의존성도 없다.
   외부에서 끌어다 쓰면 설치가 일어나 `node_modules`를 건드린다(실제로 겪었다).
4. **Playwright 변환 캐시가 오염될 수 있다.** `test/helpers/` 처럼 `testDir` 밖의 헬퍼를 require하는
   spec이 `context.conditions?.includes is not a function`으로 죽으면, 코드가 아니라 캐시 문제다.
   `$TMPDIR/playwright-transform-cache-<uid>`를 치우고 다시 돌려라.
5. **툴바 묶음은 `display:contents`**로 토글한다. `flex`면 묶음이 한 항목이 되어 두 줄로 안 접힌다.
6. **열 폭에 0px를 허용하지 마라.** `paneSplit.clampWidth`가 이미 그 불변식을 지킨다 — 새 열에도
   같은 규칙을 적용하라.
7. **`rm -rf`는 권한 정책에 막혀 있다.** 지워야 하면 스크래치패드로 `mv` 하라.

---

## 6. 검증

- 단위: `npm test` (`node --test test/*.test.js`). **`test/defaultApp.test.js` 3건 실패는 이 머신에
  duti가 설치돼 있어 생기는 선재 이슈**다 — 고치지 말고 그대로 두어라.
- e2e: `npm run build` 후 관련 spec만. **전체 스위트를 반복해 돌리지 마라**(사용자 사용량 절약).
- 새로 덮어야 할 e2e:
  - 모드 3종 전환에서 각 컨테이너·툴바 묶음이 정확히 하나만 보인다
  - 번역/미리보기 4가지 조합이 모두 성립하고, 닫힌 열의 스플리터가 함께 숨는다
  - 스왑 후 미리보기가 **새 메인**을 렌더한다(내용 문자열로 확인)
  - 스왑이 dirty 상태·저장 대상을 어긋나게 하지 않는다
  - 번역본을 고친 뒤 재번역하면 확인이 뜨고, 안 고쳤으면 뜨지 않는다
  - 미저장 상태로 창을 닫으면 팝업이 뜨고, 취소하면 창이 살아 있다
- 번역 e2e는 **실제 LLM을 부르지 않는다.** `WCOMPARE_AGY`에 가짜 셸스크립트를 끼우는
  `test/e2e/pdf-summary.spec.js`의 `stubAgy` 관용구를 그대로 쓴다.

---

## 7. 코드 스타일

- 주석은 한국어. **"무엇을"이 아니라 "왜"**를 적는다 — 특히 함정과 실제로 터진 버그.
- 파일 첫 줄은 `// 경로 — 한 줄 설명`.
- 들여쓰기 2칸, 세미콜론, 작은따옴표. **새 npm 의존성 금지.**
- 순수 로직(경로 파생, 상태 전이, 충돌 판정)은 DOM·electron 없이 단위 테스트할 수 있게 분리해 export 하라.

---

## 8. 구현자 판단에 맡기는 것

아래는 사용자가 정하지 않았다. 합리적으로 정하고 **선택한 이유를 주석과 보고에 남겨라.**

- 새 메모 만들기 UI와 메모 목록(최근 파일에 얹을지, 별도 목록을 둘지)
- 메모 이름을 언제 정하는가(만들 때 / 첫 저장 때 / 첫 헤딩에서 따오기)
- `dirtyGuard`의 네이티브 `prompt()`를 이 참에 고칠지
- 미리보기·번역창을 연 상태를 localStorage에 기억할지(`wc-sum-toc-collapsed` 관용구)
- memo 모드에서 목차(`mdToc`)를 제공할지
- 내보내기(복사/저장)를 memo에도 붙일지 — 요약의 `summaryExport.js`가 참고가 된다

## 9. 하지 않을 것

- 스크롤 동기(에디터 ↔ 미리보기, 원문 ↔ 번역)
- 문단 단위 자동 번역, 선택 영역 번역 (기존 Dict 기능과 겹친다)
- diff 모드·pdf 모드의 기존 동작 변경 — `setMode`와 툴바 버튼 외에는 건드리지 마라
