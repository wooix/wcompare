// src/renderer/pdfEnv.js — pdf.js 전역 워커 경로와 문서 로드 옵션을 한곳에서 설정.
import { GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';

// app://bundle/pdf.worker.js (renderer 자산과 동일 오리진)
GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.js', window.location.href).toString();

// CSP(script-src 'self') 준수: 동적 eval 비활성
export const DOC_OPTS = { isEvalSupported: false };
