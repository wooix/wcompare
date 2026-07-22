const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { readFile, writeFile, detectEol, isBinary } = require('../src/main/fileService.js');

const tmp = (name, buf) => { const p = path.join(os.tmpdir(), 'wc-' + Date.now() + '-' + name); fs.writeFileSync(p, buf); return p; };

test('detectEol', () => {
  assert.equal(detectEol('a\r\nb'), '\r\n');
  assert.equal(detectEol('a\nb'), '\n');
  assert.equal(detectEol('nolineend'), '\n'); // 기본 LF
});

test('isBinary: NUL 바이트 감지', () => {
  assert.equal(isBinary(Buffer.from('hello world')), false);
  assert.equal(isBinary(Buffer.from([0x68, 0x00, 0x69])), true);
});

test('readFile: 텍스트 + 메타', () => {
  const p = tmp('r.txt', Buffer.from('line1\r\nline2\r\n', 'utf8'));
  const r = readFile(p);
  assert.equal(r.content, 'line1\r\nline2\r\n');
  assert.equal(r.eol, '\r\n');
  assert.equal(r.isBinary, false);
  assert.ok(r.byteSize > 0);
  fs.unlinkSync(p);
});

test('writeFile 왕복 + BOM 보존', () => {
  const p = path.join(os.tmpdir(), 'wc-w-' + Date.now() + '.txt');
  writeFile(p, 'héllo\nworld\n', { eol: '\n', encoding: 'utf8', bom: false });
  assert.equal(readFile(p).content, 'héllo\nworld\n');
  writeFile(p, 'x\n', { eol: '\n', encoding: 'utf8', bom: true });
  const raw = fs.readFileSync(p);
  assert.deepEqual(raw.subarray(0, 3), Buffer.from([0xEF, 0xBB, 0xBF]));
  fs.unlinkSync(p);
});

test('readBytes: 파일 바이트와 크기 반환', () => {
  const p = path.join(os.tmpdir(), 'wc-bytes-' + Date.now() + '.bin');
  fs.writeFileSync(p, Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF
  const { readBytes } = require('../src/main/fileService.js');
  const r = readBytes(p);
  assert.equal(r.byteSize, 4);
  assert.ok(Buffer.isBuffer(r.bytes));
  assert.equal(r.bytes[0], 0x25);
  fs.unlinkSync(p);
});
