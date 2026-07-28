// src/main/pdfDownload.js — URL로 받은 PDF를 보관 폴더에 내려받는다. electron 미의존(단위 테스트 가능).
// 네트워크 구현은 주입받는다: 기본은 globalThis.fetch, main(ipc.js)은 electron net.fetch를 넘긴다
// (프록시·인증서 등 앱 세션 설정을 그대로 따르게).
//
// 렌더러가 URL 문자열을 보내고 main이 파일로 만들어 allowPath에 등록하는 구조 — 경로를 만들어
// 내는 주체는 여전히 main 하나뿐이라 이 앱의 allowlist 원칙이 유지된다.
//
// URL→파일명 색인을 두는 이유: 받은 뒤에 내용으로 거르면 늦다. 같은 URL을 다시 열 때마다
// 네트워크를 타고, 내용이 한 바이트라도 달라지면 placeFile이 paper-2.pdf로 비켜 저장하는데
// 그러면 번역 출력 경로도 paper-2.ko.pdf라는 새 경로가 되어 이미 만들어 둔 paper.ko.pdf를
// 못 찾고 번역을 처음부터 다시 돌린다. 번역은 페이지마다 LLM을 부르므로 논문 하나에 수 분이다.
// 그래서 "받기 전에" URL로 기존 파일을 찾는다.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 200 * 1024 * 1024; // 논문/책 PDF를 넉넉히 덮는 상한. 넘으면 받다가 중단한다.
const TOO_BIG = `PDF가 너무 큽니다 (${Math.round(MAX_BYTES / 1024 / 1024)}MB 초과)`;
const BAD_NAME_CHARS = '/\\:*?"<>|';

// 색인 파일. '.'으로 시작해 눈에 띄지 않게 한다 — 보관 폴더를 훑는 다른 코드가 .pdf만 본다는
// 보장이 없어서다. filenameFromUrl이 선행 점을 지우므로 내려받은 파일과 이름이 겹칠 일도 없다.
const INDEX_FILE = '.wcompare-downloads.json';
const INDEX_FORMAT = 'wcompare-downloads';
const INDEX_VERSION = 1;
const MAX_INDEX_ENTRIES = 2000; // 무한히 자라지 않게. 넘치면 오래된 항목부터 버린다(최근 것이 다시 열릴 확률이 높다).
const MAX_INDEX_BYTES = 4 * 1024 * 1024; // 이보다 큰 색인은 정상일 수 없다 → 통째로 버리고 새로 시작
const MAX_KEY_LEN = 2048;

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
//
// 심볼릭 링크는 후보에서 통째로 건너뛴다. 링크를 따라가면 두 가지가 한꺼번에 터진다:
//   (1) 끊어진 링크에 쓰면 보관 폴더 **밖에 새 파일을 만든다**.
//   (2) 폴더 밖 PDF를 가리키는 링크에 응답 바이트가 우연히 같으면 "이미 받아 둔 파일"로 판정해
//       그 경로를 돌려주고, ipc의 allowPath가 realpath로 폴더 밖 실경로를 허용 목록에 등록한다.
// 게다가 (2)는 매 호출 캐시 미스를 내는 무한 재다운로드 루프이기도 하다.
// 쓰기는 'wx'(O_CREAT|O_EXCL)로 한다 — 끊어진 링크까지 EEXIST로 걸러 주는 것이 핵심이다.
function placeFile(dir, filename, bytes) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const dst = path.join(dir, n === 1 ? filename : `${stem}-${n}${ext}`);
    try {
      fs.writeFileSync(dst, bytes, { flag: 'wx' });
      return dst;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e; // 권한 등 진짜 실패는 그대로 올린다
    }
    // 이미 뭔가 있는 자리다. 우리가 쓴 평범한 파일일 때만 내용을 비교하고,
    // 링크·디렉터리 등 우리 것이 아닌 것은 건드리지 않고 다음 이름으로 비켜 간다.
    let st;
    try { st = fs.lstatSync(dst); } catch { continue; }
    if (!st.isFile() || st.nlink > 1) continue; // 하드 링크도 폴더 밖 inode일 수 있다
    try {
      const cur = fs.readFileSync(dst);
      if (cur.length === bytes.length && cur.equals(bytes)) return dst; // 이미 받아 둔 같은 파일
    } catch { /* 읽을 수 없으면 다음 후보로 */ }
  }
  throw new Error('저장할 파일 이름을 정할 수 없습니다');
}

// ===== URL → 파일명 색인 =====
// 파일명만으로 판정하면 안 된다. 서로 다른 사이트가 저마다 paper.pdf를 내려주므로
// basename이 같다고 같은 문서일 수 없다. 그래서 키는 언제나 정규화한 URL이다.

function indexPath(dir) {
  return path.join(dir, INDEX_FILE);
}

// 색인 키. 어디까지 "같은 URL"로 볼지의 판단:
//   - 앞뒤 공백: 사용자가 붙여넣기하며 딸려 온 것뿐이니 무시한다.
//   - fragment(#...): 서버로 전송되지도 않는다(#page=3 같은 뷰어 힌트). 같은 문서로 본다.
//   - userinfo(user:pw@): **지운다**. 색인은 디스크에 남는 파일인데, 이 기능이 생기기 전까지
//     이 앱은 URL을 디스크에 전혀 적지 않았다(recentFiles는 파일 경로만 적는다). 자격증명을
//     평문으로 남길 이유가 없고, userinfo는 "어느 문서인가"를 고르지 않으므로 지워도 같은
//     문서는 여전히 같은 키다 — 재사용이 깨지지 않는다.
//   - 쿼리스트링: **유지한다**. 서명된 S3 URL처럼 쿼리만 매번 바뀌는 같은 문서도 있지만,
//     download.php?doc=42 처럼 쿼리가 문서를 고르는 사이트가 훨씬 흔하다. 쿼리를 버리면
//     그런 사이트에서 네트워크도 타지 않고 **다른 문서를 내주는** 정합성 사고가 되는 반면,
//     유지해서 치르는 대가는 서명 URL을 한 번 더 받는 것뿐이다 — 게다가 다시 받아도
//     placeFile이 내용이 같음을 보고 같은 경로를 돌려주므로 번역본은 그대로 재사용된다.
//     한쪽은 오답, 다른 쪽은 낭비 한 번. 오답을 피한다.
//     그래서 X-Amz-Signature 같은 서명 쿼리는 디스크에 남는다 — 자격증명을 지우는 것과
//     모순처럼 보이지만 기준은 같다: **문서를 고르는 부분은 건드리지 않고, 고르지 않는 부분만 지운다**.
// 스킴·호스트 소문자화, 기본 포트 제거 등 나머지 정규화는 URL 파서에 맡긴다.
function normalizeUrlKey(url) {
  const s = String(url ?? '').trim();
  try {
    const u = new URL(s);
    u.hash = '';
    u.password = ''; // 비밀번호를 먼저 비워야 'user:@host' 같은 잔재가 남지 않는다
    u.username = '';
    if (!u.search) u.search = ''; // 'x.pdf?'와 'x.pdf'는 같은 키로
    return u.toString();
  } catch {
    return s.split('#')[0]; // URL로 못 읽는 문자열도 키는 돌려준다(이 함수는 절대 던지지 않는다)
  }
}

// 밖으로 내보내는 URL에서 자격증명을 지운다. fetch에는 원본 URL을 그대로 쓰지만, 돌려주는 값은
// IPC를 타고 렌더러로 가서 로그·상태줄에 실릴 수 있다 — 색인 파일에서 비밀번호를 지운 것과 같은 이유로
// 여기서도 지운다. hash는 남긴다(색인 키와 달리 이 값은 사람이 보는 용도다).
function safeUrl(u) {
  const c = new URL(u.toString());
  c.password = '';
  c.username = '';
  return c.toString();
}

// 색인 값은 dir 바로 아래의 파일명 하나여야 한다. 색인도 디스크에서 읽은 신뢰할 수 없는
// 입력이므로, 구분자·선행 점('.', '..', 색인 파일 자신)·제어문자가 섞인 값은 버린다
// — 그대로 path.join하면 보관 폴더 밖을 가리킬 수 있다.
function validEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 255) return false;
  if (name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\') || name.includes(path.sep)) return false;
  if ([...name].some((ch) => ch.charCodeAt(0) < 32)) return false;
  return name === path.basename(name);
}

// 정화된 항목만 남긴다. 상한을 넘으면 뒤(=최근 기록)부터 남긴다.
function sanitizeEntries(urls) {
  const out = Object.create(null); // JSON 키가 __proto__여도 프로토타입을 건드리지 못하게
  if (!urls || typeof urls !== 'object' || Array.isArray(urls)) return out;
  for (const [key, name] of Object.entries(urls).slice(-MAX_INDEX_ENTRIES)) {
    if (!key || key.length > MAX_KEY_LEN || !validEntryName(name)) continue;
    out[key] = name;
  }
  return out;
}

// 로드: 파일 없음·JSON 손상·형식 불일치는 모두 빈 객체로(다운로드 흐름을 절대 막지 않는다).
function loadIndex(dir) {
  let raw;
  try {
    const file = indexPath(dir);
    if (fs.statSync(file).size > MAX_INDEX_BYTES) return Object.create(null);
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return Object.create(null);
  }
  if (!raw || typeof raw !== 'object' || raw.format !== INDEX_FORMAT) return Object.create(null);
  return sanitizeEntries(raw.urls);
}

// 저장: markerStore와 같은 tmp+rename 관용구 — 반쯤 쓰인 색인이 남지 않게.
function saveIndex(dir, index) {
  const urls = sanitizeEntries(index);
  fs.mkdirSync(dir, { recursive: true });
  const file = indexPath(dir);
  const text = `${JSON.stringify({
    format: INDEX_FORMAT,
    version: INDEX_VERSION,
    savedAt: new Date().toISOString(),
    urls,
  }, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // 같은 볼륨 → 원자적
}

// 색인 기록은 부가 기능이다 — 실패해도 이미 받아 둔 파일까지 무효로 만들지 않는다(경고만).
// 다만 "조용히" 실패해서는 안 된다: sanitizeEntries가 버릴 항목을 그냥 넘기면 saveIndex는
// 아무것도 던지지 않고 항목만 사라져, 기록됐다고 믿는 채로 같은 URL을 열 때마다 다시
// 내려받는다(느려진 이유를 아무도 모른다). 버려질 항목은 여기서 먼저 알아채고 경고를 남긴다.
// 상한(MAX_KEY_LEN) 자체는 유지한다 — URL 하나가 색인 파일을 무한정 부풀리지 못하게 하는 값이다.
function rememberDownload(dir, key, name) {
  const len = String(key ?? '').length;
  if (!key || len > MAX_KEY_LEN) {
    console.warn(`다운로드 색인 기록 생략: URL 키가 상한을 넘습니다 (${len}/${MAX_KEY_LEN}자) — 이 URL은 열 때마다 다시 내려받습니다`);
    return;
  }
  if (!validEntryName(name)) {
    console.warn(`다운로드 색인 기록 생략: 색인에 쓸 수 없는 파일명입니다 (${name}) — 이 URL은 열 때마다 다시 내려받습니다`);
    return;
  }
  try {
    const index = loadIndex(dir);
    index[key] = name;
    saveIndex(dir, index);
  } catch (e) {
    console.warn('다운로드 색인 기록 실패(무시):', e?.message || e);
  }
}

const PDF_HEAD_BYTES = 1024; // looksLikePdf가 훑는 범위와 같다 — 재확인은 이 앞부분만 읽으면 충분하다.

// 재사용 후보가 정말 "보관 폴더 안에 있는 PDF 파일"인지 본다. 색인은 신뢰할 수 없는 디스크
// 입력이고, 그 사이 파일이 바뀌었을 수도 있으므로 존재+크기만으로는 모자란다.
//   - lstat으로 링크 자체를 본다: statSync는 링크를 따라가므로 downloads/x.pdf가 폴더 밖을
//     가리키는 심볼릭 링크여도 통과한다. validEntryName은 '/'·선행 점 같은 **어휘적** 이탈만
//     막을 뿐 링크 이탈은 못 막는다. 그대로 두면 보관 폴더 밖 파일이 열리고, allowlist가
//     realpath로 정규화하는 탓에 폴더 밖 실경로가 허용 목록에까지 등록된다.
//   - 앞부분에서 %PDF-를 다시 찾는다: 받을 때는 헤더로 걸러 내면서 재사용할 때만 무검사로
//     통과하면, 저장된 뒤 다른 것으로 덮인 파일(HTML 오류 페이지 등)이 PDF인 척 열린다.
function isReusablePdf(abs) {
  let fd;
  try {
    const st = fs.lstatSync(abs);
    // nlink > 1: 하드 링크는 lstat에도 평범한 파일로 보이지만 폴더 밖 inode를 가리킬 수 있다.
    // 우리가 새로 쓴 파일은 항상 nlink=1이라 정상 다운로드에는 영향이 없다.
    if (!st.isFile() || st.size === 0 || st.nlink > 1) return false;
    fd = fs.openSync(abs, 'r');
    const head = Buffer.alloc(PDF_HEAD_BYTES);
    const n = fs.readSync(fd, head, 0, PDF_HEAD_BYTES, 0);
    return looksLikePdf(head.subarray(0, n));
  } catch {
    return false; // 지워졌거나 읽을 수 없음
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 이미 닫힘 */ } }
  }
}

// 색인에 있고 그 파일을 실제로 재사용할 수 있으면 절대경로, 아니면 null.
// 쓸 수 없는 항목(사용자가 지웠거나, 링크로 바뀌었거나, 더는 PDF가 아니거나)은 색인에서도
// 지운다. 여기서 에러로 끊지 않는 이유: 호출측이 그냥 새로 받게 두는 편이 낫다 —
// 사용자 눈에는 "고장난 캐시가 스스로 복구되는" 동작이어야 한다.
function lookupDownloaded(dir, url) {
  if (!dir) return null;
  const key = normalizeUrlKey(url);
  const index = loadIndex(dir);
  const name = index[key];
  if (!name) return null;
  const abs = path.join(dir, name);
  if (isReusablePdf(abs)) return abs;
  try {
    delete index[key];
    saveIndex(dir, index);
  } catch (e) {
    console.warn('다운로드 색인 정리 실패(무시):', e?.message || e);
  }
  return null;
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
// 같은 URL을 이미 받아 두었으면 네트워크를 타지 않고 그 경로를 그대로 돌려준다(reused: true).
// force는 사용자가 "다시 받기"를 명시했을 때용 — 색인을 무시하고 새로 받는다.
async function downloadPdf(rawUrl, { dir, fetch: fetchImpl = globalThis.fetch, maxBytes = MAX_BYTES, force = false } = {}) {
  const u = parsePdfUrl(rawUrl);
  if (!dir) throw new Error('저장할 폴더가 지정되지 않았습니다');

  const key = normalizeUrlKey(u.toString());
  if (!force) {
    const hit = lookupDownloaded(dir, key);
    if (hit) {
      // 호출측이 재사용인지 따지지 않고 byteSize를 쓸 수 있게 실제 크기를 다시 잰다.
      // 방금 사라졌다면(다른 창이 정리했다든지) 재사용을 포기하고 새로 받는다 — ENOENT를 사용자에게 보이지 않게.
      // 파일인지·PDF인지는 lookupDownloaded가 이미 봤다. 여기서는 크기만 다시 잰다 —
      // statSync 대신 lstatSync를 쓰는 건 그 사이 링크로 바뀐 경로의 실제 크기를 재지 않기 위해서다.
      let size = 0;
      try { size = fs.lstatSync(hit).size; } catch { /* 사라졌다 → 아래로 흘러가 새로 받는다 */ }
      if (size > 0) return { path: hit, byteSize: size, url: safeUrl(u), reused: true };
    }
  }

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
  // placeFile은 색인이 없던 옛 다운로드와 force 재다운로드를 받아 내는 2차 방어선으로 그대로 둔다.
  const saved = placeFile(dir, filenameFromUrl(u), bytes);
  rememberDownload(dir, key, path.basename(saved));
  return { path: saved, byteSize: bytes.length, url: safeUrl(u), reused: false };
}

module.exports = {
  downloadPdf, parsePdfUrl, filenameFromUrl, placeFile, looksLikePdf, MAX_BYTES,
  INDEX_FILE, indexPath, loadIndex, saveIndex, normalizeUrlKey, lookupDownloaded,
};
