# 영→한 오프라인 단어 사전 (`en-ko.json`)

`en-ko.json` 은 렌더러의 실시간 사전(영어 단어 드래그 → 한국어 뜻 팝업)이 쓰는
오프라인 역색인 데이터다. 영어 소문자 단어(또는 1~3 단어 구)를 키로, 한국어 후보
배열을 값으로 갖는다. 외부 네트워크 없이 동작하도록 앱에 번들된다.

빌드 파이프라인: [`scripts/build-dict.mjs`](../../scripts/build-dict.mjs).

## 출처와 라이선스

| 출처 | 내용 | 라이선스 |
| --- | --- | --- |
| [MUSE en-ko](https://dl.fbaipublicfiles.com/arrival/dictionaries/en-ko.txt) | 영↔한 단어쌍(줄마다 `english 한국어`) | **CC BY-NC 4.0** (비상업) |
| [kaikki 한국어](https://kaikki.org/dictionary/Korean/) | 영어 위키낱말사전에서 추출한 한국어 표제어 JSONL | CC BY-SA 4.0 + GFDL |

- 원본은 `assets/dict/src/` 아래 캐시되며 `.gitignore` 로 제외한다(재빌드 시 이미
  있으면 재다운로드하지 않음).
- 생성물 `en-ko.json` 은 커밋 대상이다. 두 라이선스의 표시 의무를 지키기 위해 이
  문서로 출처를 고지한다.

### MUSE의 비상업(NC) 제약

MUSE 사전은 **CC BY-NC 4.0** 으로, 상업적 배포에 제약이 있다. 상용으로 앱을
배포한다면 아래 `--no-muse` 로 MUSE를 제외하고 재생성해 CC BY-SA/GFDL 계열만
포함해야 한다. 이 경우 직접 단어쌍이 빠지므로 사전 품질(특히 흔한 단어의 정확한
대역어)은 다소 낮아진다.

## 재생성

```sh
# 두 출처 병합(기본) — 개발/비상업 용
node scripts/build-dict.mjs

# MUSE 제외(비상업 NC 제약 회피) — 상용 배포용
node scripts/build-dict.mjs --no-muse
```

빌드가 끝나면 키 수와 파일 크기를 출력한다. 원본이 `assets/dict/src/` 에 이미
있으면 다운로드를 건너뛴다. 다운로드는 실패 시 1회 재시도하며, 그래도 실패하면
명확히 중단한다.

## 출력 포맷

```jsonc
{
  "version": 1,
  "entries": {
    "<english key>": [["<한국어>", "<pos|null>"], ...]  // 키당 최대 8개
  }
}
```

- 키는 사전순 정렬(diff 노이즈 억제), 키마다 한 줄로 직렬화한다.
- 값 튜플의 두 번째 원소 `pos` 는 품사(kaikki) 또는 `null`(MUSE 직접 단어쌍).
- 병합 규칙: MUSE 항목이 앞(직접 단어쌍이라 우선), kaikki가 뒤. 같은 한국어는
  중복 제거, `pos === "name"`(고유명사)은 배열 뒤로, 키당 8개로 절단.
