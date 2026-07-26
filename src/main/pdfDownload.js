// src/main/pdfDownload.js — URL로 받은 PDF를 보관 폴더에 내려받는다. electron 미의존(단위 테스트 가능).
// 네트워크 구현은 주입받는다: 기본은 globalThis.fetch, main(ipc.js)은 electron net.fetch를 넘긴다
// (프록시·인증서 등 앱 세션 설정을 그대로 따르게).
//
// 렌더러가 URL 문자열을 보내고 main이 파일로 만들어 allowPath에 등록하는 구조 — 경로를 만들어
// 내는 주체는 여전히 main 하나뿐이라 이 앱의 allowlist 원칙이 유지된다.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 200 * 1024 * 1024; // 논문/책 PDF를 넉넉히 덮는 상한. 넘으면 받다가 중단한다.
const TOO_BIG = `PDF가 너무 큽니다 (${Math.round(MAX_BYTES / 1024 / 1024)}MB 초과)`;
const BAD_NAME_CHARS = '/\\:*?"<>|';

// http/https만 허용한다. file:/data: 등 다른 스킴은 로컬 자원을 끌어오는 통로가 되므로 거부.
function parsePdfUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('URL을 입력하세요');
  let u;
  try { u = new URL(s); } catch { throw new Error('URL 형식이 올바르지 않습니다'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http/https URL만 열 수 있습니다');
  return u;
}

// URL 경로의 마지막 조각을 파일명으로 쓴다. 경로 구분자·제어문자를 지워 보관 폴더 밖으로
// 새는 이름(../x, a/b)이 나오지 않게 하고, 항상 .pdf로 끝맺는다.
function filenameFromUrl(u) {
  let base = '';
  try { base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || ''); } catch { /* 잘못된 퍼센트 인코딩 */ }
  base = [...base].filter((ch) => ch.charCodeAt(0) > 31 && !BAD_NAME_CHARS.includes(ch)).join('');
  base = base.replace(/^\.+/, '').trim().replace(/\.pdf$/i, '');
  if (!base) base = u.hostname.replace(/[^\w.-]/g, '') || 'download';
  return `${base.slice(0, 80)}.pdf`;
}

// 같은 이름의 파일이 이미 있고 내용까지 같으면 그 파일을 재사용한다(같은 URL을 다시 열어도
// 사본이 쌓이지 않게). 내용이 다르면 base-2.pdf, base-3.pdf … 로 비켜 간다 — 기존 파일은 덮지 않는다.
function placeFile(dir, filename, bytes) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const dst = path.join(dir, n === 1 ? filename : `${stem}-${n}${ext}`);
    if (!fs.existsSync(dst)) { fs.writeFileSync(dst, bytes); return dst; }
    try {
      const cur = fs.readFileSync(dst);
      if (cur.length === bytes.length && cur.equals(bytes)) return dst; // 이미 받아 둔 같은 파일
    } catch { /* 읽을 수 없으면 다음 후보로 */ }
  }
  throw new Error('저장할 파일 이름을 정할 수 없습니다');
}

// PDF는 헤더 앞에 잡바이트가 붙어 있는 경우가 있어 pdf.js처럼 앞부분에서 %PDF-를 찾는다.
// HTML 오류 페이지를 200으로 돌려주는 서버가 흔해서, content-type만 믿지 않고 바이트로 확인한다.
function looksLikePdf(bytes) {
  return bytes.subarray(0, 1024).includes('%PDF-', 0, 'latin1');
}

// 응답을 상한까지만 읽는다. 스트림이 있으면 청크 단위로 재면서 넘치는 순간 끊는다
// (content-length가 없거나 거짓인 응답에 메모리를 다 내주지 않도록).
async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(TOO_BIG);
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* 이미 닫힘 */ }
      throw new Error(TOO_BIG);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// dir에 내려받아 저장한 파일 경로를 돌려준다. 실패는 사용자에게 그대로 보여줄 한국어 메시지로 던진다.
async function downloadPdf(rawUrl, { dir, fetch: fetchImpl = globalThis.fetch, maxBytes = MAX_BYTES } = {}) {
  const u = parsePdfUrl(rawUrl);
  if (!dir) throw new Error('저장할 폴더가 지정되지 않았습니다');

  let res;
  try {
    res = await fetchImpl(u.toString(), { redirect: 'follow' });
  } catch (e) {
    throw new Error(`다운로드 실패: ${e?.message || e}`);
  }
  if (!res.ok) throw new Error(`다운로드 실패 (HTTP ${res.status})`);

  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(TOO_BIG);

  const bytes = await readCapped(res, maxBytes);
  if (!bytes.length) throw new Error('빈 응답입니다');
  if (!looksLikePdf(bytes)) throw new Error('PDF가 아닙니다 (응답에서 %PDF- 헤더를 찾지 못했습니다)');

  fs.mkdirSync(dir, { recursive: true });
  return { path: placeFile(dir, filenameFromUrl(u), bytes), byteSize: bytes.length, url: u.toString() };
}

module.exports = { downloadPdf, parsePdfUrl, filenameFromUrl, placeFile, looksLikePdf, MAX_BYTES };
