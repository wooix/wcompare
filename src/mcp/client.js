const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const defaultSocket = () => process.env.WCOMPARE_CONTROL_SOCKET ||
  path.join(os.homedir(), 'Library', 'Application Support', 'wcompare', 'control', 'mcp.sock');

function requestControl(method, params = {}, { socketPath = defaultSocket(), timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    let data = '';
    const finish = (error, result) => {
      clearTimeout(timer); connection.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('wcompare 응답 시간이 초과되었습니다.')), timeoutMs);
    connection.on('error', error => finish(error));
    connection.on('connect', () => connection.write(JSON.stringify({ method, params }) + '\n'));
    connection.on('data', chunk => {
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) { finish(new Error('wcompare 응답이 너무 큽니다.')); return; }
      if (!data.includes('\n')) return;
      try {
        const response = JSON.parse(data.slice(0, data.indexOf('\n')));
        finish(response.error ? new Error(response.error) : null, response.result);
      } catch (error) { finish(error); }
    });
  });
}

async function callControl(method, params) {
  try { return await requestControl(method, params); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  const appPath = process.env.WCOMPARE_APP || '/Applications/wcompare.app';
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => execFile('/usr/bin/open', ['-a', appPath], { env }, error => error ? reject(error) : resolve()));
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try { return await requestControl(method, params); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error('wcompare MCP 연결을 열 수 없습니다. MCP 지원 빌드가 실행 중인지 확인하세요.');
}
module.exports = { requestControl, callControl };
