const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const terminal = job => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status);

function createControlJobs(file) {
  const jobs = new Map();
  const cancelCallbacks = new Map();
  const events = new EventEmitter();
  let lastProgressSave = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const job of saved.jobs || []) {
      if (!job || typeof job.id !== 'string') continue;
      if (!terminal(job)) { job.status = 'interrupted'; job.error = '앱이 종료되어 작업이 중단되었습니다.'; }
      jobs.set(job.id, job);
    }
  } catch { /* First launch or unavailable history. */ }
  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const recent = [...jobs.values()].slice(-200);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ jobs: recent }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  function get(id) {
    const job = jobs.get(id);
    if (!job) throw new Error('작업 ID를 찾을 수 없습니다.');
    return structuredClone(job);
  }
  function changed(job, save = true) {
    job.updatedAt = new Date().toISOString();
    if (save) persist();
    events.emit(job.id);
  }
  function active(windowId) {
    return [...jobs.values()].find(job => job.windowId === windowId && !terminal(job));
  }
  function start(windowId, operation, run, cancel) {
    if (active(windowId)) throw new Error('이 창에서 MCP 작업이 진행 중입니다. 완료하거나 취소한 뒤 요청하세요.');
    const job = { id: randomUUID(), windowId, operation, status: 'running', startedAt: new Date().toISOString() };
    jobs.set(job.id, job);
    cancelCallbacks.set(job.id, cancel);
    try { changed(job); }
    catch (error) { jobs.delete(job.id); cancelCallbacks.delete(job.id); throw error; }
    Promise.resolve().then(run).then(result => {
      job.status = job.status === 'cancelling' ? 'cancelled' : 'succeeded';
      job.result = result;
    }, error => {
      const cancelled = job.status === 'cancelling' || /취소|cancelled|canceled/i.test(error?.message || '');
      job.status = cancelled ? 'cancelled' : 'failed';
      job.error = String(error?.message || error).slice(0, 4000);
    }).finally(() => { cancelCallbacks.delete(job.id); changed(job); })
      .catch(error => console.error('MCP job history:', error.message));
    return get(job.id);
  }
  async function cancel(id) {
    const job = jobs.get(id);
    if (!job) return get(id);
    if (terminal(job)) return get(id);
    job.status = 'cancelling';
    changed(job);
    try { await cancelCallbacks.get(id)?.(); }
    catch (error) { job.error = String(error.message || error); changed(job); }
    return get(id);
  }
  async function wait(id, seconds = 20) {
    if (terminal(get(id))) return get(id);
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); events.off(id, onChange); resolve(); };
      const onChange = () => { if (terminal(get(id))) finish(); };
      const timer = setTimeout(finish, Math.max(0, Math.min(25, seconds)) * 1000);
      events.on(id, onChange);
    });
    return get(id);
  }
  function progress(windowId, value) {
    const job = active(windowId);
    if (!job || job.operation !== value.operation) return;
    job.progress = {
      message: String(value.message || '').slice(0, 600),
      ...(Number.isFinite(value.done) ? { done: value.done } : {}),
    };
    const save = Date.now() - lastProgressSave > 1000;
    changed(job, save);
    if (save) lastProgressSave = Date.now();
  }
  return { start, get, cancel, wait, progress, active, list: () => [...jobs.keys()].map(get) };
}
module.exports = { createControlJobs };
