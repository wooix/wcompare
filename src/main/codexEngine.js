// Codex runs as a text transformer: stdin prompt, final answer on stdout.
const { spawn } = require('node:child_process');
const { envWithPath } = require('./transpaper');
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function buildCodexArgs(settings = {}) {
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never'];
  if (settings.codexModel && !MODEL_RE.test(settings.codexModel)) throw new Error('Codex 모델 이름을 확인해 주세요.');
  if (settings.codexModel) args.push('--model', settings.codexModel);
  if (settings.codexEffort) {
    if (!EFFORTS.includes(settings.codexEffort)) throw new Error('Codex effort 값을 확인해 주세요.');
    args.push('-c', `model_reasoning_effort="${settings.codexEffort}"`);
  }
  args.push('-');
  return args;
}

// Ask the same installed Codex CLI used for translation. model/list is a picker catalog,
// not an access guarantee; a real translation request is still the access check.
async function modelCatalog({ env = process.env, timeoutMs = 10000 } = {}) {
  const { resolveEngineBin } = require('./paperSummary');
  const bin = resolveEngineBin('codex', env);
  if (!bin) throw new Error('Codex CLI를 찾을 수 없습니다. 설치 상태를 확인해 주세요.');

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
      env: envWithPath(env), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let buffer = '';
    let stderr = '';
    let pages = 0;
    const models = [];
    const seen = new Set();
    const cursors = new Set();
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(models);
    };
    const requestPage = (cursor) => {
      if (++pages > 10 || (cursor && cursors.has(cursor))) {
        finish(new Error('Codex 모델 목록 페이지를 모두 읽지 못했습니다.'));
        return;
      }
      if (cursor) cursors.add(cursor);
      send({ method: 'model/list', id: 2, params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    };
    const timer = setTimeout(() => finish(new Error('Codex 모델 목록 조회 시간이 초과되었습니다.')), timeoutMs);
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.on('close', (code) => finish(new Error(`Codex 모델 목록 조회가 종료되었습니다 (${code}). ${stderr.slice(-300)}`.trim())));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1000); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error('Codex 모델 목록 응답이 너무 큽니다.'));
      let lineEnd;
      while (!settled && (lineEnd = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error(message.error.message || 'Codex 초기화 실패'));
          send({ method: 'initialized', params: {} });
          requestPage(null);
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message || 'Codex 모델 목록 조회 실패'));
          if (!Array.isArray(message.result?.data)) return finish(new Error('Codex 모델 목록 응답 형식이 올바르지 않습니다.'));
          for (const item of message.result.data) {
            if (!item || typeof item !== 'object') continue;
            const id = item.model || item.id;
            if (item.hidden || typeof id !== 'string' || !MODEL_RE.test(id) || seen.has(id)) continue;
            seen.add(id);
            models.push({
              id,
              name: typeof item.displayName === 'string' ? item.displayName : id,
              efforts: (Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [])
                .map(e => e?.reasoningEffort).filter(e => EFFORTS.includes(e)),
              defaultEffort: EFFORTS.includes(item.defaultReasoningEffort) ? item.defaultReasoningEffort : '',
            });
          }
          if (message.result.nextCursor) requestPage(message.result.nextCursor);
          else finish();
        }
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'wcompare', title: 'wcompare', version: '0.1.0' } } });
  });
}
module.exports = { buildCodexArgs, modelCatalog, EFFORTS };
