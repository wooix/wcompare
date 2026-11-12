const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { arxivPdfUrl } = require('./arxiv');
const { createControlJobs } = require('./controlJobs');

function createControlServer({ app, BrowserWindow, ipcMain, createWindow, settings, download, registerFile }) {
  const directory = path.join(app.getPath('userData'), 'control');
  const socketPath = process.env.WCOMPARE_CONTROL_SOCKET || path.join(directory, 'mcp.sock');
  const jobs = createControlJobs(path.join(directory, 'jobs.json'));
  const ready = new Set();
  const pending = new Map();
  const windows = () => BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && !win._wcompareFocusOverlay);
  const request = async (win, action, params = {}, timeoutMs = 15000) => {
    const started = Date.now();
    while (!ready.has(win.webContents.id)) {
      if (win.isDestroyed() || Date.now() - started > 15000) throw new Error('wcompare 창을 준비하지 못했습니다.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('wcompare 응답 시간이 초과되었습니다.')); }, timeoutMs);
      pending.set(id, { wcId: win.webContents.id, resolve, reject, timer });
      win.webContents.send('control:request', { id, action, params });
    });
  };
  ipcMain.on('control:ready', event => {
    ready.add(event.sender.id);
    event.sender.once('destroyed', () => {
      ready.delete(event.sender.id);
      for (const [id, item] of pending) if (item.wcId === event.sender.id) {
        clearTimeout(item.timer); pending.delete(id); item.reject(new Error('작업 창이 닫혔습니다.'));
      }
    });
  });
  ipcMain.on('control:reply', (event, reply) => {
    const item = pending.get(reply?.id);
    if (!item || item.wcId !== event.sender.id) return;
    clearTimeout(item.timer); pending.delete(reply.id);
    if (reply.error) item.reject(new Error(String(reply.error)));
    else item.resolve(reply.result);
  });
  ipcMain.on('control:progress', (event, value) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && value && typeof value === 'object') jobs.progress(win.id, value);
  });
  function selectWindow(id) {
    const list = windows();
    if (id !== undefined) {
      const win = list.find(item => item.id === id);
      if (!win) throw new Error('창 ID를 찾을 수 없습니다. get_state로 확인하세요.');
      return win;
    }
    if (list.length !== 1) throw new Error('get_state로 창 목록을 확인한 뒤 window_id를 지정하세요.');
    return list[0];
  }
  const methods = {
    async get_state() {
      return { version: app.getVersion(), build: require('./version').readBuildVersion(), windows: await Promise.all(windows().map(async win => ({
        window_id: win.id, title: win.getTitle(), ...(await request(win, 'state')),
      }))) };
    },
    async open_arxiv({ url, refresh = false }) {
      const pdfUrl = arxivPdfUrl(url);
      const file = await download(pdfUrl, { refresh });
      const filePath = registerFile(file.path);
      const win = createWindow();
      await request(win, 'open', { path: filePath }, 30000);
      win.show(); win.focus();
      return { window_id: win.id, path: filePath, url: pdfUrl, cached: !!file.reused, state: await request(win, 'state') };
    },
    async start_job({ window_id, operation, force = false, kinds }) {
      if (!['translate', 'explain', 'summarize'].includes(operation)) throw new Error('지원하지 않는 작업입니다.');
      const win = selectWindow(window_id);
      const state = await request(win, 'state');
      if (!state.files.length) throw new Error('먼저 arXiv 논문 또는 PDF를 여세요.');
      return jobs.start(win.id, operation,
        () => request(win, operation, { force: force === true, kinds }, 60 * 60 * 1000),
        () => request(win, 'cancel', { operation }));
    },
    get_job: ({ job_id }) => jobs.get(job_id),
    wait_job: ({ job_id, seconds }) => jobs.wait(job_id, seconds),
    cancel_job: ({ job_id }) => jobs.cancel(job_id),
    list_jobs: () => jobs.list(),
    set_view: params => request(selectWindow(params.window_id), 'view', params),
  };
  const server = net.createServer(connection => {
    let input = '';
    connection.setTimeout(120000, () => connection.destroy());
    connection.on('error', () => {});
    connection.on('data', chunk => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 1024 * 1024) { connection.destroy(); return; }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      connection.removeAllListeners('data');
      Promise.resolve().then(() => {
        const message = JSON.parse(input.slice(0, newline));
        if (!Object.hasOwn(methods, message.method)) throw new Error('알 수 없는 MCP 제어 명령입니다.');
        return methods[message.method](message.params || {});
      }).then(result => connection.end(JSON.stringify({ result }) + '\n'),
        error => connection.end(JSON.stringify({ error: String(error.message || error) }) + '\n'));
    });
  });
  async function start() {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(socketPath)) {
      if (!fs.lstatSync(socketPath).isSocket()) throw new Error('MCP 소켓 경로가 다른 파일에 사용 중입니다.');
      const live = await new Promise(resolve => {
        const probe = net.createConnection(socketPath);
        probe.on('connect', () => { probe.destroy(); resolve(true); });
        probe.on('error', () => resolve(false));
      });
      if (live) throw new Error('다른 wcompare 인스턴스가 MCP 연결을 사용 중입니다.');
      fs.unlinkSync(socketPath);
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    app.once('will-quit', () => { server.close(); try { fs.unlinkSync(socketPath); } catch {} });
    return socketPath;
  }
  return { start, methods };
}
module.exports = { createControlServer };
