// test/pdfDownload.test.js — URL로 PDF 내려받기(main/pdfDownload.js).
// electron 비의존 모듈이라 fetch를 주입해 네트워크 없이 검증한다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { downloadPdf, parsePdfUrl, filenameFromUrl } = require('../src/main/pdfDownload.js');
const { makePdf } = require('./helpers/makePdf.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wc-dl-'));

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
  assert.deepEqual(fs.readdirSync(dir), ['paper.pdf']);
});

test('downloadPdf: 이름이 같고 내용이 다르면 기존 파일을 덮지 않고 -2로 비켜 간다', async () => {
  const dir = tmpDir();
  const first = makePdf(2);
  const second = makePdf(5);
  const a = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: serving(fakeRes(first)) });
  const b = await downloadPdf('https://a.com/paper.pdf', { dir, fetch: serving(fakeRes(second)) });
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
