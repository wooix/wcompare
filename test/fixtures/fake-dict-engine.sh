#!/bin/sh
# test/fixtures/fake-dict-engine.sh — e2e용 가짜 번역 엔진.
# 실제 agy/claude 대신 WCOMPARE_DICT_ENGINE로 주입한다. 인자(-p <프롬프트>)는 무시하고
# 항상 같은 한국어 한 줄만 stdout에 내보내고 종료한다.
echo "가짜 번역 결과"
