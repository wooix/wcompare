# wcompare — PDF 동기 스크롤 듀얼 뷰어 설계

- 날짜: 2026-06-23
- 상태: 초안 (리뷰 전)
- 대상: 기존 wcompare(Electron + Monaco diff)에 **PDF 2-파일 동기 스크롤 뷰어 모드** 추가

## 1. 목표 (What & Why)

동일 format의 PDF 2개(예: 같은 문서의 영어판·한글판)를 좌/우에 나란히 띄우고, **한쪽을 스크롤하면 다른 쪽도 같이 움직이는** 동기 스크롤 뷰어를 추가한다.

- 핵심: 두 PDF의 스크롤 위치 공유(양방향)
- 원칙: PDF 렌더링은 직접 구현하지 않고 **pdf.js(`pdfjs-dist` 6.x)** 의 프리빌트 뷰어를 얹는다. 우리 코드는 "워커 설정 + 바이트 로딩 + 동기화 글루".

### 성공 기준 (Acceptance)
1. `.pdf` 파일을 좌/우에 열면 PDF 듀얼 뷰어 모드로 두 문서가 연속 스크롤로 렌더된다.
2. 한쪽을 스크롤하면 다른 쪽이 **비율 기반**으로 같이 스크롤된다(양방향).
3. 줌(±) 시 양쪽이 같은 배율로 확대/축소된다.
4. 동기화 ON/OFF 토글로 한쪽만 따로 볼 수 있고, 다시 ON 하면 즉시 재정렬된다.
5. 현재 페이지(x/N)가 표시되고, 페이지 번호 입력으로 양쪽이 함께 이동한다.
6. 텍스트/코드 파일을 열면 기존 diff 모드로 동작한다(회귀 없음).

## 2. 비목표 (YAGNI)

- PDF 텍스트 검색/주석/하이라이트/편집·저장
- 페이지별 시각 diff(픽셀 비교), 회전, 인쇄
- PDF↔텍스트 혼합 비교, 3개 이상 패널
- 페이지 썸네일 사이드바, 아웃라인(목차) 패널

## 3. 기술 스택 (추가분)

| 역할 | 선택 | 비고 |
|---|---|---|
| PDF 파싱/렌더 | `pdfjs-dist` 6.0.x | ESM: `build/pdf.mjs`, 워커 `build/pdf.worker.mjs` |
| 연속 뷰어 | `pdfjs-dist/web/pdf_viewer.mjs` + `.css` | `PDFViewer`/`EventBus`/`PDFLinkService` |
| 빌드 | 기존 esbuild | 워커 엔트리 1개 추가 + `pdf_viewer.css` 복사 |

> `pdfjs-dist` 6.x는 Node ≥22.13 요구(현재 Node 26.3 충족). 버전은 `package.json`에 하한 고정(`^6.0`).

## 4. 모드 구조 (기존 앱과의 통합)

전역 상태 `mode: 'diff' | 'pdf'`.

```
index.html
 ├─ #toolbar         (공통: Open Left/Right, Theme, [Diff⇄PDF 토글])
 │                    + diff 컨트롤 그룹 / pdf 컨트롤 그룹 (모드별 show/hide)
 ├─ #editor          (기존 Monaco diff, mode='diff'일 때 표시)
 ├─ #pdfview         (신규 PDF 듀얼 뷰어, mode='pdf'일 때 표시)
 └─ #statusbars      (모드별 내용 swap: vim 상태 / pdf 페이지 x·N)
```

- **각 모드는 독립된 좌/우 상태를 가진다.** 모드 전환은 show/hide일 뿐, 서로의 파일을 건드리지 않는다.
- **진입(둘 다)**: ① 자동 — 파일을 열 때 확장자가 `.pdf`면 `mode='pdf'`로 전환 후 해당 side 로드, 텍스트/코드면 `mode='diff'`. ② 수동 — 툴바 `Diff⇄PDF` 토글 버튼.
- dialog/드래그앤드롭/CLI 인자 모두 동일 경로(`openSide`)를 탄다.

## 5. 컴포넌트 (파일)

```
src/renderer/
 ├─ pdfEnv.js        # GlobalWorkerOptions.workerSrc='./pdf.worker.js'; getDocument 옵션 상수
 ├─ syncScroll.js    # 순수: syncTargetTop(from, to) — 비율→대상 scrollTop
 ├─ pdfViewer.js     # 한 side용 PDFViewer 래퍼
 ├─ pdfDualView.js   # 두 pdfViewer + 동기 스크롤/줌/페이지/토글
 └─ (app.js 수정)    # mode 매니저, 확장자 라우팅, pdf 툴바 배선
src/main/
 ├─ ipc.js (수정)    # 'file:readBytes' 핸들러 추가(화이트리스트 재사용)
 └─ fileService.js (수정) # readBytes(path) → {bytes, byteSize}
src/preload/preload.js (수정) # readBytes 노출
esbuild.mjs (수정)  # pdf.worker 엔트리 + pdf_viewer.css 복사
src/renderer/index.html (수정) # #pdfview, pdf 컨트롤/상태바, pdf_viewer.css link
```

### 책임 경계 (한 줄)
- **pdfEnv.js**: pdf.js 전역 워커 경로/문서 로드 옵션을 한곳에서 설정(`isEvalSupported:false`).
- **syncScroll.js**: `from`의 스크롤 메트릭으로 `to`의 목표 `scrollTop`을 계산하는 순수 함수. monaco/pdf/DOM 미import → 단위테스트 대상.
- **pdfViewer.js**: 한 side의 `PDFViewer`를 캡슐화. `load(bytes)`, `el`(스크롤 컨테이너), `setScale(n)/getScale()`, `currentPage()/pageCount()`, `scrollToPage(n)`, `onPageChange(cb)`.
- **pdfDualView.js**: 두 `pdfViewer`를 좌/우로 배치 + 동기화 오케스트레이션. `el`, `openSide(side,{bytes,path})`, `setSync(bool)`, `zoom(delta)`, `gotoPage(n)`, `onState(cb)`(현재 페이지·배율·동기상태 보고).

## 6. 데이터 흐름

1. 파일 열기(dialog/DnD/CLI) → 확장자 검사.
2. `.pdf`: `window.wcompare.readBytes(path)` → `{bytes, byteSize}` → `mode='pdf'` 전환 → `pdfDualView.openSide(side, {bytes})` → pdf.js가 연속 페이지 렌더.
3. 한쪽 스크롤 → `syncScroll`로 반대쪽 `scrollTop` 미러(동기 ON일 때).
4. 줌 버튼 → 양쪽 `setScale` 동일 적용. 페이지 입력 → 양쪽 `scrollToPage`.
5. 텍스트/코드 → `mode='diff'`(기존 경로 그대로, 회귀 없음).

## 7. 동기 스크롤 (유일한 신규 알고리즘)

```js
// syncScroll.js (순수)
function syncTargetTop(from, to) {
  // from/to = { scrollTop, scrollHeight, clientHeight }
  const fromRange = from.scrollHeight - from.clientHeight;
  const toRange = to.scrollHeight - to.clientHeight;
  if (fromRange <= 0 || toRange <= 0) return 0;
  const ratio = from.scrollTop / fromRange;          // 0..1
  return Math.max(0, Math.min(toRange, ratio * toRange)); // 클램프
}
```

오케스트레이션(`pdfDualView`):
```js
let syncing = false;
function onScroll(fromSide) {
  if (!syncEnabled || syncing) return;
  syncing = true;
  const to = viewer[other(fromSide)].el;
  to.scrollTop = syncTargetTop(viewer[fromSide].el, to);
  requestAnimationFrame(() => { syncing = false; }); // 에코 차단
}
```
- 양방향: 좌/우 컨테이너에 동일 핸들러 부착.
- 줌 동기: 줌 버튼이 양쪽 `setScale(scale)`을 동일하게 호출(별도 per-side 줌 UI 없음 → 한쪽만 바뀔 일 없음).
- 페이지 점프: 입력값을 양쪽 `scrollToPage(n)`(각 뷰어 페이지 수로 min 클램프).

## 8. PDF 바이트 로딩 (IPC)

- `file:readBytes(path)` 핸들러 추가: `normalize` + 화이트리스트 `allowed`에 등록(기존 read와 동일 신뢰 경계) → `fileService.readBytes(p)` → `{ path, ext, bytes: Uint8Array, byteSize }`.
- preload `readBytes(path)` 노출.
- pdf.js는 `getDocument({ data: bytes, isEvalSupported:false })`로 로드.
- 전송: 구조화 복제로 `Uint8Array`/`ArrayBuffer` 전달. MVP에서 수십 MB 복사는 허용(수백 ms). **후순위**: app:// 스킴 range 스트리밍으로 대용량 최적화.

## 9. 보안 / CSP

- 워커는 `app://bundle/renderer/pdf.worker.js`(번들 자산) → `worker-src 'self'` 충족(blob: 이미 허용, 폴백).
- `isEvalSupported:false`로 `script-src 'self'` 준수(pdf.js의 동적 eval 경로 차단).
- 바이트는 화이트리스트 IPC로만. **PDF는 읽기 전용**(write IPC 미사용).
- pdf_viewer 텍스트 레이어 인라인 스타일 → `style-src 'self' 'unsafe-inline'`(기존 허용)로 충족. 캔버스/`data:` 이미지 → 기존 `img-src 'self' data:` 충족.
- **새 CSP 지시문 불필요**(스파이크에서 콘솔 violation 0 확인).

## 10. 에러 처리 / 엣지

- 손상/비 PDF → `getDocument` reject → 토스트 + 해당 side 비움.
- 대용량(예 >50MB) → 경고 후 진행(MVP). 
- 두 문서 페이지 수/높이 차이 → 비율 동기는 비례로 동작. 페이지 입력은 각 뷰어 `min(pageCount)`로 클램프.
- 한쪽만 열린 상태 → 열린 쪽만 렌더, 동기는 양쪽 존재 시에만 적용.
- 동기 OFF → 독립 스크롤. ON 전환 시 기준 side 기준으로 즉시 1회 재정렬.
- 모드 전환 중 스크롤 핸들러 누수 방지(뷰어 dispose 시 리스너 제거).

## 11. 테스트 전략

- **단위(순수)**: `syncTargetTop` — 정상 비율, 0-높이 가드(0 반환), 클램프(범위 초과 시 경계), 페이지 클램프 헬퍼.
- **E2E(@playwright/test _electron)**: 작은 멀티페이지 PDF 픽스처 2개로
  1. 두 `.pdf` 열기 → 양쪽 캔버스 렌더(`.pdfViewer .page canvas` 존재)
  2. 좌 컨테이너 스크롤 → 우 `scrollTop` 변화(동기)
  3. 줌+ → 양쪽 배율 증가
  4. 동기 OFF → 좌 스크롤 시 우 불변
  5. 페이지 입력 → 양쪽 해당 페이지로 이동
  6. 회귀: 텍스트 2개 열면 diff 모드(`.monaco-diff-editor`)
  - 픽스처: 최소 유효 멀티페이지 PDF 바이트를 테스트에서 생성(외부 의존 없이).

## 12. 빌드 / 워커 (스파이크 검증 대상)

- esbuild 워커 엔트리: `pdfjs-dist/build/pdf.worker.mjs` → `dist/renderer/pdf.worker.js`(iife/classic).
- `pdf_viewer.css`를 `dist/renderer/`로 복사, `index.html`에서 link.
- 렌더러 번들에 `pdfjs-dist/web/pdf_viewer.mjs` 포함.
- **Phase 0 스파이크(필수)**: sandbox:true + app:// 환경에서 두 PDF가 렌더되고 pdf.worker가 로드되며 콘솔/CSP 에러 0인지 playwright로 자동 검증. 실패 시 대안(Blob 워커 프록시) — 이전 Monaco 워커 해소와 동일 패턴.

## 13. 리스크

| # | 리스크 | 완화 |
|---|---|---|
| P1 | pdf.js 워커가 app://+sandbox에서 로딩 실패 | 스파이크 우선 검증; Blob 워커 폴백 |
| P2 | esbuild가 pdfjs ESM/`.mjs`·워커 번들 시 경로/`import.meta` 이슈 | 스파이크에서 번들 산출물 실행 확인; 필요 시 alias/define |
| P3 | `pdf_viewer.css` 다크 테마와 충돌(흰 배경) | 컨테이너 배경/뷰어 색 토큰 조정 |
| P4 | 대용량 PDF IPC 바이트 복사 지연 | MVP 허용 + 경고; 후순위 app:// 스트리밍 |
| P5 | 동기 스크롤 에코 루프/지터 | `syncing` 플래그 + rAF 리셋, 순수 함수 단위테스트 |

## 14. 구현 순서 (요약)

1. **스파이크**: pdfjs-dist 설치 → esbuild 워커 엔트리 → 두 PDF가 app://+sandbox에서 렌더 + 워커 에러 0 검증.
2. 순수 모듈 + 단위테스트: `syncScroll`.
3. 메인: `fileService.readBytes` + `file:readBytes` IPC + preload.
4. 렌더러: `pdfEnv` → `pdfViewer` → `pdfDualView`(동기/줌/페이지/토글).
5. 통합: mode 매니저 + 확장자 라우팅 + 툴바/상태바.
6. E2E: 렌더/스크롤 동기/줌/토글/페이지/회귀.
