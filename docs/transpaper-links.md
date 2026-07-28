# 번역본에서 링크가 사라지는 문제 — 원인과 해법

조사일: 2026-07-28 · 대상: transpaper (별도 저장소), PyMuPDF 1.28.0 / MuPDF 1.29.0

## 결론부터

원인은 wcompare가 아니라 **transpaper**에 있고, **고칠 수 있습니다.**
`transpaper/render.py` 에 4줄을 더하면 링크가 100% 살아남습니다 — 실측으로 확인했습니다.

wcompare 쪽은 손댈 것이 없습니다. 링크가 남아 있는 PDF라면 이미 정상 동작합니다(아래 "앱 쪽은 이미 준비돼 있다").

## 증상

번역본(`.ko.pdf`)을 열면 인용·각주·URL 링크가 대부분 죽어 있습니다. 원본과 번역본의 링크 주석을
pdf.js로 세어 비교한 실측입니다.

| 문서 | 원본 링크 | 번역본 링크 | 남은 비율 |
|---|---|---|---|
| arXiv 2404.19737 | 284 (내부 276 / 외부 8) | 9 (내부 1 / 외부 8) | 3% |
| arXiv 2203.15556 | 482 (내부 450 / 외부 32) | 67 (내부 65 / 외부 2) | 14% |

페이지별로 보면 패턴이 뚜렷합니다 — 번역이 일어난 페이지는 링크가 0이 되고, 손대지 않은 페이지는
그대로 남습니다(2404.19737의 10·11쪽은 4개씩 온전).

## 원인

`transpaper/render.py` 의 리댁션 단계입니다.

```python
    for b in targets:
        for ln in (b.lines or []):
            page.add_redact_annot(fitz.Rect(ln.bbox), fill=False)
        ...
    if targets:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                              graphics=fitz.PDF_REDACT_LINE_ART_NONE)   # ← 여기
```

PyMuPDF의 `apply_redactions()` 는 리댁션 사각형과 **겹치는 주석(annotation)을 함께 지웁니다.**
링크도 주석이고, 인용 링크는 본문 줄 위에 정확히 얹혀 있습니다. 리댁션 사각형이 곧 본문 줄이므로
사실상 전부가 함께 사라집니다. transpaper가 링크를 지우려 한 것이 아니라, 글자를 지우는 함수가
링크까지 데려간 것입니다.

## 해법

리댁션 **전에** 링크를 떠 두었다가 **후에** 되꽂습니다. 페이지 기하(MediaBox·회전)는 리댁션으로
바뀌지 않으므로 원래 좌표가 그대로 유효합니다 — 실제로 원본과 번역본의 모든 페이지가
`612x792 r0` 로 동일했습니다.

```diff
     if targets:
+        # apply_redactions()는 리댁션 사각형과 겹치는 주석을 함께 지운다. 인용 링크는 본문 줄 위에
+        # 정확히 얹혀 있어 사실상 전부가 사라진다. 리댁션 전에 떠 두었다가 뒤에 되꽂는다 —
+        # 페이지 기하는 리댁션으로 바뀌지 않으므로 원래 좌표가 그대로 유효하다.
+        saved_links = page.get_links()
         page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                               graphics=fitz.PDF_REDACT_LINE_ART_NONE)
+        for lk in saved_links:
+            page.insert_link(lk)
         # apply_redactions rebuilds page resources; re-register both fonts so
         # insert_textbox can find them by name in the next step.
         _register()
```

## 검증 결과

transpaper와 같은 순서(줄 단위 리댁션 → `apply_redactions`)로 전 페이지를 처리하고, 링크 복원
유무만 바꿔 두 파일을 만들어 비교했습니다(arXiv 2404.19737, 29쪽).

| | 링크 수 |
|---|---|
| 원본 | 284 |
| 리댁션만 (현재 transpaper) | **0** |
| 리댁션 + 링크 복원 (해법) | **284** |

"있기만 한" 것으로는 부족하므로, 복원된 파일을 **wcompare가 실제로 쓰는 엔진(pdf.js)** 으로 다시
열어 쓸 수 있는 상태인지까지 확인했습니다.

```
외부 URL 링크 8개 · 내부 링크 276개 중 목적지가 실제 페이지로 풀린 것 276개
```

내부 링크는 `cite.xxx` 같은 이름 목적지(named destination)를 가리키는데, 그 이름표는 문서
전역의 name tree에 있고 리댁션이 건드리지 않습니다. 그래서 복원한 링크가 그대로 해석됩니다.

## 함정: `get_links()` 는 검증에 쓰면 안 된다

`apply_redactions()` 이후 같은 세션에서 `page.get_links()` 를 부르면 **메모리 캐시가 돌아와서**
방금 넣은 링크가 보이지 않습니다. 이것 때문에 처음에는 해법이 실패한 줄 알았습니다.

```
[2a] 리댁션 직후 링크        = 0
[2b] 같은 page 객체에 재삽입 → 0   ← 캐시. 실제로는 들어가 있다
[4]  저장·재오픈 후          → 33  ← 진실
```

판정은 반드시 **저장한 뒤 다시 연 파일**에서 하십시오. transpaper도 `doc.save(out)` 으로 끝나므로
그쪽이 실제 산출물의 진실입니다.

## 앱 쪽은 이미 준비돼 있다

링크가 살아 있는 PDF라면 wcompare는 손댈 것 없이 동작합니다. 확인한 것들:

- `PDFViewer` 를 `PDFLinkService` 와 함께 만들고 주석 레이어를 그립니다 (`src/renderer/pdfViewer.js`).
- 주석 레이어 CSS(`pdf_viewer.css`)를 번들에 복사해 `index.html` 에서 읽습니다 (`esbuild.mjs`).
- 내부 링크 클릭은 `linkService` 를 지나며 이동 히스토리를 쌓습니다 → 뒤로/앞으로(`⌘←/→`)가 동작.
  e2e `pdf-dual.spec.js` 의 "링크 히스토리" 테스트가 `.annotationLayer a` 를 실제로 클릭해 덮고 있습니다.
- 외부 URL은 `will-navigate` 를 막고 `setWindowOpenHandler` → `shell.openExternal` 로 보내
  기본 브라우저에서 엽니다 (`src/main/main.js`). 렌더러가 외부 주소로 항해하지 않으므로 CSP도 그대로입니다.
