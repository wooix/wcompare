// src/main/fileService.js
const fs = require('node:fs');

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function readFile(filePath) {
  const raw = fs.readFileSync(filePath);
  const bin = isBinary(raw);
  let bom = false;
  let buf = raw;
  if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    bom = true; buf = raw.subarray(3);
  }
  const content = bin ? '' : buf.toString('utf8');
  return { content, eol: detectEol(content), encoding: 'utf8', bom, isBinary: bin, byteSize: raw.length };
}

function writeFile(filePath, content, opts) {
  const eol = opts?.eol || '\n';
  // 모델 내용은 항상 \n. 원본 eol로 정규화 후 기록.
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, eol);
  const body = Buffer.from(normalized, opts?.encoding || 'utf8');
  const out = opts?.bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]) : body;
  fs.writeFileSync(filePath, out);
}

module.exports = { readFile, writeFile, detectEol, isBinary };
