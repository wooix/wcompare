const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const readers = new Map();
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors app://bundle; base-uri 'none'; form-action 'none'";

function exposeReader(result, source) {
  readers.set(result.key, { root: fs.realpathSync(result.site), files: result.files, source });
  return { url: `paper://${result.key}/index.html`, savedAt: result.savedAt, report: result.report };
}

function sourceForReaderUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'paper:' || url.pathname !== '/source.pdf') return null;
    const source = readers.get(url.hostname)?.source;
    if (!source) return null;
    const page = /^#page=[1-9][0-9]*$/.test(url.hash) ? Number(url.hash.slice(6)) : 1;
    return { path: source, page };
  } catch { return null; }
}

function resolveReaderFile(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const reader = url.protocol === 'paper:' && readers.get(url.hostname);
    if (!reader) return null;
    if (url.pathname === '/source.pdf' && reader.source) return reader.source;
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (!Object.hasOwn(reader.files, name)) return null;
    const file = fs.realpathSync(path.join(reader.root, name));
    if (!file.startsWith(reader.root + path.sep)) return null;
    return file;
  } catch { return null; }
}

function handleReaderProtocol(protocol, net) {
  protocol.handle('paper', async request => {
    const file = resolveReaderFile(request.url);
    if (!file) return new Response('not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  });
}

module.exports = { exposeReader, resolveReaderFile, handleReaderProtocol, sourceForReaderUrl };
