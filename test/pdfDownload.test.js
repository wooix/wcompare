// test/pdfDownload.test.js — URL로 PDF 내려받기(main/pdfDownload.js).
// electron 비의존 모듈이라 fetch를 주입해 네트워크 없이 검증한다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  downloadPdf, parsePdfUrl, filenameFromUrl,
  INDEX_FILE, indexPath, loadIndex, saveIndex, normalizeUrlKey, lookupDownloaded,
} = require('../src/main/pdfDownload.js');
const { makePdf } = require('./helpers/makePdf.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wc-dl-'));
// 보관 폴더에는 이제 숨김 색인 파일도 같이 산다 — 눈에 보이는 산출물만 세려고 .pdf만 추린다.
const pdfsIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();

// arrayBuffer만 가진 최소 Response 흉내(스트림 없음 → readCapped의 fallback 경로).
function fakeRes(body, { ok = true, status = 200, headers = {} } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}
// body(ReadableStream)를 가진 Response 흉내 — 청크 단위 상한 검사 경로를 태운다.
function fakeStreamRes(chunks) {
  let i = 0;
  return {
    ok: true, status: 200,
    headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => (i < chunks.length ? { done: false, value: new Uint8Array(chunks[i++]) } : { done: true }),
      cancel: async () => {},
    }) },
  };
}
const serving = (res) => async () => res;
// 호출 횟수를 세는 fetch — "두 번째는 네트워크를 타지 않는다"를 에둘러 말고 직접 단언하려고.
function countingFetch(res) {
  const fn = async () => { fn.calls += 1; return res; };
  fn.calls = 0;
  return fn;
}

// console.warn을 잠시 가로챈다 — "조용히 실패하지 않는다"는 경고가 실제로 나오는지 봐야 알 수 있다.
function captureWarn() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.map((a) => String(a)).join(' '));
  return { lines, restore: () => { console.warn = original; } };
}

test('parsePdfUrl: http/https만 통과하고 나머지는 거부한다', () => {
  assert.equal(parsePdfUrl(' https://a.com/x.pdf ').protocol, 'https:');
  assert.equal(parsePdfUrl('http://a.com/x.pdf').protocol, 'http:');
  assert.throws(() => parsePdfUrl(''), /URL을 입력/);
  assert.throws(() => parsePdfUrl('그냥 글자'), /형식/);
  assert.throws(() => parsePdfUrl('file:///etc/passwd'), /http\/https/);
  assert.throws(() => parsePdfUrl('data:application/pdf;base64,AAAA'), /http\/https/);
});

test('filenameFromUrl: 마지막 경로 조각을 쓰고 항상 .pdf로 끝난다', () => {
  assert.equal(filenameFromUrl(new URL('https://arxiv.org/pdf/2301.12345v2.pdf?dl=1')), '2301.12345v2.pdf');
  assert.equal(filenameFromUrl(new URL('https://a.com/docs/report')), 'report.pdf');
  assert.equal(filenameFromUrl(new URL('https://a.com/')), 'a.com.pdf', '경로가 없으면 호스트명으로');
});

test('filenameFromUrl: 경로 이탈 문자를 지워 보관 폴더 밖을 가리키지 않는다', () => {
  // %2e%2e%2f = "../" — 디코드 후에도 구분자·선행 점이 남지 않아야 한다
  const name = filenameFromUrl(new URL('https://a.com/%2e%2e%2f%2e%2e%2fevil.pdf'));
  assert.equal(name, 'evil.pdf');
  assert.ok(!name.includes('/') && !name.startsWith('.'));
});

test('downloadPdf: 받은 바이트를 dir에 저장하고 그 경로를 돌려준다', async () => {
  const dir = tmpDir();
  const pdf = makePdf(2);
  const res = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: serving(fakeRes(pdf)) });
  assert.equal(res.path, path.join(dir, 'paper.pdf'));
  assert.equal(res.byteSize, pdf.length);
  assert.ok(fs.readFileSync(res.path).equals(pdf));
});

test('downloadPdf: 같은 URL을 다시 받아도 내용이 같으면 사본을 만들지 않는다', async () => {
  const dir = tmpDir();
  const pdf = makePdf(2);
  const a = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: serving(fakeRes(pdf)) });
  const b = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: serving(fakeRes(pdf)) });
  assert.equal(b.path, a.path);
  assert.deepEqual(pdfsIn(dir), ['paper.pdf']);
});

test('downloadPdf: 이름이 같고 내용이 다르면 기존 파일을 덮지 않고 -2로 비켜 간다', async () => {
  const dir = tmpDir();
  const first = makePdf(2);
  const second = makePdf(5);
  const a = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: serving(fakeRes(first)) });
  // force로 색인을 건너뛰어야 placeFile까지 내려온다 — 색인이 붙은 뒤로 이 정책은 색인이 없던
  // 옛 다운로드와 "다시 받기"를 받아 내는 2차 방어선이다.
  const b = await downloadPdf('https://a.com/paper.pdf', { dir, force: true, fetch: serving(fakeRes(second)) });
  assert.equal(b.path, path.join(dir, 'paper-2.pdf'));
  assert.ok(fs.readFileSync(a.path).equals(first), '먼저 받은 파일은 그대로 남는다');
});

test('downloadPdf: PDF가 아니면(HTML 오류 페이지 등) 거부한다', async () => {
  const dir = tmpDir();
  const html = Buffer.from('<!doctype html><h1>404 Not Found</h1>');
  await assert.rejects(
    downloadPdf('https://a.com/paper.pdf', { dir, fetch: serving(fakeRes(html)) }),
    /PDF가 아닙니다/);
  assert.deepEqual(fs.readdirSync(dir), [], '거부되면 파일을 남기지 않는다');
});

test('downloadPdf: HTTP 오류·빈 응답·네트워크 실패를 사람이 읽을 메시지로 던진다', async () => {
  const dir = tmpDir();
  await assert.rejects(
    downloadPdf('https://a.com/x.pdf', { dir, fetch: serving(fakeRes('', { ok: false, status: 403 })) }),
    /HTTP 403/);
  await assert.rejects(
    downloadPdf('https://a.com/x.pdf', { dir, fetch: serving(fakeRes('')) }),
    /빈 응답/);
  await assert.rejects(
    downloadPdf('https://a.com/x.pdf', { dir, fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }),
    /다운로드 실패: getaddrinfo ENOTFOUND/);
});

test('downloadPdf: content-length가 상한을 넘으면 받기 전에 거부한다', async () => {
  const dir = tmpDir();
  const res = fakeRes(makePdf(1), { headers: { 'content-length': '999999' } });
  await assert.rejects(downloadPdf('https://a.com/x.pdf', { dir, fetch: serving(res), maxBytes: 1000 }), /너무 큽니다/);
});

test('downloadPdf: content-length가 없어도 스트림을 재다가 상한에서 끊는다', async () => {
  const dir = tmpDir();
  const chunks = [Buffer.from('%PDF-1.4\n'), Buffer.alloc(600, 0x41), Buffer.alloc(600, 0x42)];
  await assert.rejects(
    downloadPdf('https://a.com/x.pdf', { dir, fetch: serving(fakeStreamRes(chunks)), maxBytes: 1000 }),
    /너무 큽니다/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('downloadPdf: 스트림 응답도 정상적으로 이어 붙여 저장한다', async () => {
  const dir = tmpDir();
  const pdf = makePdf(1);
  const chunks = [pdf.subarray(0, 40), pdf.subarray(40)];
  const res = await downloadPdf('https://a.com/x.pdf', { dir, fetch: serving(fakeStreamRes(chunks)) });
  assert.ok(fs.readFileSync(res.path).equals(pdf));
});

// ===== URL 색인: 받기 전에 찾는다 =====
// 목적은 대역폭이 아니라 번역본이다. 같은 URL이 늘 같은 경로로 열려야 paper.ko.pdf를 다시 찾는다.

test('downloadPdf: 같은 URL을 다시 열면 네트워크를 타지 않고 받아 둔 파일을 그대로 쓴다', async () => {
  const dir = tmpDir();
  const pdf = makePdf(2);
  const net = countingFetch(fakeRes(pdf));
  const a = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: net });
  const b = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: net });
  assert.equal(net.calls, 1, '두 번째 요청은 네트워크를 타지 않는다');
  assert.equal(b.path, a.path);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(b.byteSize, pdf.length, '재사용이어도 byteSize는 실제 파일 크기다');
});

test('downloadPdf: 앞뒤 공백·fragment만 다른 URL도 같은 파일로 본다', async () => {
  const dir = tmpDir();
  const net = countingFetch(fakeRes(makePdf(2)));
  const a = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: net });
  const b = await downloadPdf('  https://a.com/paper.pdf#page=3  ', { dir, fetch: net });
  assert.equal(net.calls, 1);
  assert.equal(b.path, a.path);
  assert.ok(b.reused);
});

test('downloadPdf: 색인에 있어도 파일이 지워졌으면 다시 받고 색인을 되살린다', async () => {
  const dir = tmpDir();
  const net = countingFetch(fakeRes(makePdf(2)));
  const a = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: net });
  fs.unlinkSync(a.path); // 사용자가 보관 폴더를 직접 비운 상황
  const b = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: net });
  assert.equal(net.calls, 2);
  assert.equal(b.reused, false);
  assert.equal(b.path, a.path);
  assert.equal(loadIndex(dir)[normalizeUrlKey('https://a.com/paper.pdf')], 'paper.pdf');
});

test('lookupDownloaded: 파일이 사라진 항목은 null을 주고 색인에서도 지운다', async () => {
  const dir = tmpDir();
  const url = 'https://a.com/paper.pdf';
  const a = await downloadPdf(url, { dir, fetch: serving(fakeRes(makePdf(1))) });
  assert.equal(lookupDownloaded(dir, url), a.path);
  fs.unlinkSync(a.path);
  assert.equal(lookupDownloaded(dir, url), null);
  assert.deepEqual(Object.keys(loadIndex(dir)), [], '죽은 항목은 남지 않는다');
});

test('downloadPdf: force면 색인이 있어도 다시 받는다', async () => {
  const dir = tmpDir();
  const net = countingFetch(fakeRes(makePdf(2)));
  await downloadPdf('https://a.com/paper.pdf', { dir, fetch: net });
  const b = await downloadPdf('https://a.com/paper.pdf', { dir, force: true, fetch: net });
  assert.equal(net.calls, 2);
  assert.equal(b.reused, false);
  assert.deepEqual(pdfsIn(dir), ['paper.pdf'], '내용이 같으면 placeFile이 원래 파일을 그대로 쓴다');
});

test('downloadPdf: 색인 JSON이 깨져 있어도 던지지 않고 새로 받는다', async () => {
  const dir = tmpDir();
  fs.writeFileSync(indexPath(dir), '{ 이건 JSON이 아니다');
  const net = countingFetch(fakeRes(makePdf(1)));
  const a = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: net });
  assert.equal(net.calls, 1);
  assert.equal(a.reused, false);
  assert.equal(loadIndex(dir)[normalizeUrlKey('https://a.com/paper.pdf')], 'paper.pdf', '깨진 색인은 새로 쓰인다');
});

test('downloadPdf: basename이 같아도 URL이 다르면 서로 다른 파일로 관리한다', async () => {
  const dir = tmpDir();
  const one = makePdf(1);
  const two = makePdf(3);
  const a = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: serving(fakeRes(one)) });
  const b = await downloadPdf('https://b.com/paper.pdf', { dir, fetch: serving(fakeRes(two)) });
  assert.equal(a.path, path.join(dir, 'paper.pdf'));
  assert.equal(b.path, path.join(dir, 'paper-2.pdf'));
  // 다시 열면 각자 자기 파일로 — 색인이 파일명이 아니라 URL로 갈리기 때문
  const netA = countingFetch(fakeRes(one));
  const netB = countingFetch(fakeRes(two));
  assert.equal((await downloadPdf('https://a.com/paper.pdf', { dir, fetch: netA })).path, a.path);
  assert.equal((await downloadPdf('https://b.com/paper.pdf', { dir, fetch: netB })).path, b.path);
  assert.equal(netA.calls + netB.calls, 0);
});

test('normalizeUrlKey: 공백·fragment는 무시하고 쿼리는 남긴다', () => {
  const base = 'https://a.com/paper.pdf';
  assert.equal(normalizeUrlKey(`  ${base}  `), base);
  assert.equal(normalizeUrlKey(`${base}#page=3`), base);
  assert.equal(normalizeUrlKey(`${base}?`), base, '빈 쿼리는 없는 것과 같다');
  assert.equal(normalizeUrlKey('https://A.COM:443/paper.pdf'), base, '호스트 대소문자·기본 포트는 URL 파서가 정규화한다');
  // 쿼리는 문서를 고르는 데 쓰이기도 한다 → 다르면 다른 키(같은 키로 묶으면 다른 문서를 내준다)
  assert.equal(normalizeUrlKey('https://a.com/get?doc=1#x'), 'https://a.com/get?doc=1');
  assert.notEqual(normalizeUrlKey('https://a.com/get?doc=1'), normalizeUrlKey('https://a.com/get?doc=2'));
  // 키를 만드는 함수는 절대 던지지 않는다
  assert.equal(normalizeUrlKey(''), '');
  assert.equal(normalizeUrlKey(null), '');
  assert.equal(normalizeUrlKey(' 그냥 글자#x '), '그냥 글자');
});

test('loadIndex: 파일 없음·JSON 손상·형식 불일치는 모두 빈 색인이 된다', () => {
  const dir = tmpDir();
  assert.deepEqual(Object.keys(loadIndex(dir)), [], '아직 아무것도 받지 않은 폴더');
  fs.writeFileSync(indexPath(dir), '{{{');
  assert.deepEqual(Object.keys(loadIndex(dir)), []);
  fs.writeFileSync(indexPath(dir), JSON.stringify({ format: 'something-else', urls: { a: 'b.pdf' } }));
  assert.deepEqual(Object.keys(loadIndex(dir)), []);
  fs.writeFileSync(indexPath(dir), JSON.stringify([1, 2, 3]));
  assert.deepEqual(Object.keys(loadIndex(dir)), []);
});

test('loadIndex: 문자열이 아니거나 경로가 섞인 값은 버린다(경로 이탈 방어)', () => {
  const dir = tmpDir();
  saveIndex(dir, { 'https://a.com/ok': 'ok.pdf' });
  const raw = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8'));
  raw.urls = {
    'https://a.com/ok': 'ok.pdf',
    'https://a.com/num': 42,
    'https://a.com/obj': { name: 'x.pdf' },
    'https://a.com/null': null,
    'https://a.com/up': '../../etc/passwd',
    'https://a.com/sep': 'sub/x.pdf',
    'https://a.com/win': 'sub\\x.pdf',
    'https://a.com/dotdot': '..',
    'https://a.com/self': INDEX_FILE,
    'https://a.com/ctrl': 'x\u0000.pdf', // NUL이 섞이면 path.join이 던진다 → 애초에 버린다
  };
  fs.writeFileSync(indexPath(dir), JSON.stringify(raw));
  const index = loadIndex(dir);
  assert.deepEqual(Object.keys(index), ['https://a.com/ok']);
  assert.equal(Object.getPrototypeOf(index), null, '색인 키가 프로토타입을 건드릴 수 없게');
});

// ===== 색인은 신뢰할 수 없는 디스크 입력이다 =====
// 값이 "폴더 안의 이름처럼 생겼다"까지만 보면 모자란다. 링크로 폴더를 빠져나갈 수 있고,
// 저장된 뒤에 내용이 바뀔 수도 있다. 재사용 직전에 실제 파일을 다시 확인한다.

test('lookupDownloaded: 보관 폴더 밖을 가리키는 심볼릭 링크는 재사용하지 않는다', () => {
  const dir = tmpDir();
  const outside = path.join(tmpDir(), 'secret.pdf');
  fs.writeFileSync(outside, makePdf(1)); // 내용이 진짜 PDF여도 보관 폴더 밖이면 안 된다
  fs.symlinkSync(outside, path.join(dir, 'link.pdf'));
  saveIndex(dir, { 'https://a.com/y.pdf': 'link.pdf' }); // 이름은 어휘적으로 멀쩡하다
  assert.equal(lookupDownloaded(dir, 'https://a.com/y.pdf'), null);
  assert.deepEqual(Object.keys(loadIndex(dir)), [], '못 쓰는 항목은 색인에서도 지운다');
});

test('downloadPdf: 심볼릭 링크로 걸린 색인 항목은 무시하고 새로 받는다', async () => {
  const dir = tmpDir();
  const outside = path.join(tmpDir(), 'outside.pdf');
  fs.writeFileSync(outside, Buffer.from('%PDF-1.4 폴더 밖 파일'));
  fs.symlinkSync(outside, path.join(dir, 'link.pdf'));
  saveIndex(dir, { [normalizeUrlKey('https://a.com/y.pdf')]: 'link.pdf' });
  const pdf = makePdf(1);
  const net = countingFetch(fakeRes(pdf));
  const r = await downloadPdf('https://a.com/y.pdf', { dir, fetch: net });
  assert.equal(net.calls, 1);
  assert.equal(r.reused, false);
  assert.equal(path.dirname(r.path), dir, '돌려주는 경로는 언제나 보관 폴더 안이다');
  assert.ok(fs.readFileSync(r.path).equals(pdf), '읽히는 내용은 방금 받은 PDF다');
  assert.ok(fs.readFileSync(outside).toString('utf8').includes('폴더 밖'), '폴더 밖 파일은 건드리지 않는다');
});

test('downloadPdf: 받아 둔 파일이 PDF가 아니게 바뀌면 재사용하지 않고 새로 받는다', async () => {
  const dir = tmpDir();
  const pdf = makePdf(2);
  const net = countingFetch(fakeRes(pdf));
  const a = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: net });
  fs.writeFileSync(a.path, '<html>이건 PDF가 아니다</html>'); // 다른 프로그램이 덮어쓴 상황
  const b = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: net });
  assert.equal(net.calls, 2, '크기만 보고 무검사로 재사용하지 않는다');
  assert.equal(b.reused, false);
  assert.ok(fs.readFileSync(b.path).equals(pdf), '돌려주는 경로의 내용은 다시 받은 PDF다');
  assert.equal(loadIndex(dir)[normalizeUrlKey('https://a.com/paper.pdf')], path.basename(b.path),
    '색인은 새로 받은 파일을 가리키게 스스로 복구된다');
});

test('downloadPdf: 색인 상한을 넘는 아주 긴 URL은 경고를 남기고 동작은 깨지지 않는다', async () => {
  const dir = tmpDir();
  const url = `https://a.com/x.pdf?q=${'z'.repeat(2100)}`;
  const pdf = makePdf(1);
  const net = countingFetch(fakeRes(pdf));
  const warnings = captureWarn();
  let a; let b;
  try {
    a = await downloadPdf(url, { dir, fetch: net });
    b = await downloadPdf(url, { dir, fetch: net });
  } finally { warnings.restore(); }
  assert.equal(a.reused, false);
  assert.equal(b.reused, false);
  assert.equal(net.calls, 2, '색인에 넣지 못하니 매번 다시 받는다 — 느려질 뿐 깨지지는 않는다');
  assert.equal(b.path, a.path, '내용이 같으면 placeFile이 같은 경로를 돌려준다(번역본도 그대로)');
  assert.deepEqual(Object.keys(loadIndex(dir)), [], '상한을 넘는 키는 색인에 남지 않는다');
  assert.equal(warnings.lines.length, 2, '기록되지 않은 두 번 모두 알린다');
  assert.ok(warnings.lines.every((m) => m.includes('상한을 넘습니다')),
    `무성 실패가 아니라 경고로 드러나야 한다: ${JSON.stringify(warnings.lines)}`);
});

test('normalizeUrlKey: 자격증명(userinfo)은 키에서 지운다 — 디스크에 평문으로 남지 않게', () => {
  assert.equal(normalizeUrlKey('https://user:pw@a.org/x.pdf'), 'https://a.org/x.pdf');
  assert.equal(normalizeUrlKey('https://user@a.org/x.pdf'), 'https://a.org/x.pdf', '비밀번호 없이 계정만 있어도 지운다');
  assert.ok(!normalizeUrlKey('https://user:s3cret@a.org/x.pdf').includes('s3cret'));
  // 자격증명은 "어느 문서인가"를 고르지 않는다 → 지워도 같은 문서는 같은 키다(재사용이 안 깨진다)
  assert.equal(normalizeUrlKey('https://user:pw@a.org/x.pdf?doc=1#p2'), normalizeUrlKey('https://a.org/x.pdf?doc=1'));
  // 반대로 쿼리는 문서를 고르므로 그대로 둔다 — 서명 쿼리가 남는 건 그 정책의 대가다
  assert.notEqual(normalizeUrlKey('https://u:p@a.org/x?doc=1'), normalizeUrlKey('https://a.org/x?doc=2'));
});

test('downloadPdf: 자격증명이 붙은 URL도 같은 파일을 쓰고 색인 파일에 비밀번호가 남지 않는다', async () => {
  const dir = tmpDir();
  const net = countingFetch(fakeRes(makePdf(2)));
  const a = await downloadPdf('https://a.org/paper.pdf', { dir, fetch: net });
  const b = await downloadPdf('https://reader:s3cret@a.org/paper.pdf', { dir, fetch: net });
  assert.equal(net.calls, 1, '자격증명만 다른 URL은 같은 문서다');
  assert.equal(b.path, a.path);
  assert.ok(b.reused);
  const raw = fs.readFileSync(indexPath(dir), 'utf8');
  assert.ok(!raw.includes('s3cret') && !raw.includes('reader'), `색인에 자격증명이 남았다: ${raw}`);
});

test('saveIndex: 되읽을 수 있게 원자적으로 쓰고 tmp 찌꺼기를 남기지 않는다', () => {
  const dir = path.join(tmpDir(), 'downloads'); // 폴더가 아직 없어도 만든다
  saveIndex(dir, { 'https://a.com/x.pdf': 'x.pdf', 'https://a.com/bad': '../x.pdf' });
  assert.equal(loadIndex(dir)['https://a.com/x.pdf'], 'x.pdf');
  assert.deepEqual(Object.keys(loadIndex(dir)), ['https://a.com/x.pdf'], '쓸 때도 정화한다');
  assert.deepEqual(fs.readdirSync(dir), [INDEX_FILE]);
});

// ===== 보관 폴더 밖으로 새지 않는다 (재검증이 실측으로 잡아낸 쓰기 경로 구멍) =====
// 전제는 "보관 폴더에 링크를 만들 수 있는 로컬 권한"이라 원격 취약점은 아니지만,
// 이 모듈은 색인을 신뢰 불가 입력으로 선언하고 폴더 밖 탈출을 막겠다고 했으므로 그 약속을 지킨다.
// 게다가 링크를 따라가면 매 호출 캐시 미스가 나는 무한 재다운로드 루프가 된다.

test('placeFile: 끊어진 심볼릭 링크를 따라가 보관 폴더 밖에 파일을 만들지 않는다', () => {
  const dir = tmpDir();
  const outside = path.join(tmpDir(), 'victim.pdf');
  fs.symlinkSync(outside, path.join(dir, 'paper.pdf')); // 대상이 아직 없는 dangling 링크
  const pdf = makePdf(2);

  const saved = require('../src/main/pdfDownload.js').placeFile(dir, 'paper.pdf', pdf);

  assert.equal(fs.existsSync(outside), false, '폴더 밖에 파일이 생기면 안 된다');
  assert.equal(path.dirname(saved), dir);
  assert.notEqual(path.basename(saved), 'paper.pdf', '링크 자리를 비켜 갔다');
  assert.ok(fs.readFileSync(saved).equals(pdf));
});

test('placeFile: 폴더 밖 파일을 가리키는 링크는 내용이 같아도 재사용하지 않는다', () => {
  const dir = tmpDir();
  const pdf = makePdf(2);
  const outside = path.join(tmpDir(), 'private.pdf');
  fs.writeFileSync(outside, pdf); // 응답 바이트와 내용이 같은 폴더 밖 파일
  fs.symlinkSync(outside, path.join(dir, 'paper.pdf'));

  const saved = require('../src/main/pdfDownload.js').placeFile(dir, 'paper.pdf', pdf);

  // 링크 경로를 돌려주면 ipc의 allowPath가 realpath로 폴더 밖 경로를 허용 목록에 등록한다
  assert.equal(fs.realpathSync(saved).startsWith(fs.realpathSync(dir)), true);
  assert.notEqual(fs.realpathSync(saved), fs.realpathSync(outside));
});

test('downloadPdf: 하드 링크로 걸린 색인 항목은 재사용하지 않는다', async () => {
  const dir = tmpDir();
  const pdf = makePdf(2);
  const outside = path.join(tmpDir(), 'secret.pdf');
  fs.writeFileSync(outside, pdf);
  fs.linkSync(outside, path.join(dir, 'hard.pdf')); // 하드 링크는 lstat에도 평범한 파일로 보인다
  saveIndex(dir, { 'https://a.com/hard.pdf': 'hard.pdf' });

  assert.equal(lookupDownloaded(dir, 'https://a.com/hard.pdf'), null);

  let calls = 0;
  const r = await downloadPdf('https://a.com/hard.pdf', {
    dir, fetch: async () => { calls++; return fakeRes(pdf); },
  });
  assert.equal(calls, 1, '재사용하지 않고 새로 받는다');
  assert.equal(path.dirname(r.path), dir);
  assert.notEqual(path.basename(r.path), 'hard.pdf');
});

test('downloadPdf: 돌려주는 url에 자격증명이 남지 않는다', async () => {
  const dir = tmpDir();
  const r = await downloadPdf('https://reader:s3cret@b.org/paper.pdf', { dir, fetch: serving(fakeRes(makePdf(1))) });
  assert.ok(!r.url.includes('s3cret'));
  assert.ok(!r.url.includes('reader'));
  assert.equal(r.url, 'https://b.org/paper.pdf');
});
