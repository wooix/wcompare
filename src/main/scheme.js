// app:// 커스텀 스킴을 same-origin·secure로 등록하고 dist/renderer를 서빙한다.
const { protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..', 'dist', 'renderer');

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function handleScheme() {
  // app://bundle/<file> → dist/renderer/<file>
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.join(ROOT, rel);
    // 디렉토리 탈출 방지
    if (!filePath.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

module.exports = { registerScheme, handleScheme, APP_ORIGIN: 'app://bundle/' };
