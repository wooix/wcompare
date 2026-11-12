import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import summary from '../src/main/paperSummary.js';

const app = path.resolve(process.argv[2] || '/Applications/wcompare.app');
const executable = path.join(app, 'Contents/MacOS/wcompare');
const bridge = path.join(app, 'Contents/Resources/app/dist/mcp/server.cjs');
if (!fs.existsSync(executable) || !fs.existsSync(bridge)) throw new Error('MCP 지원 wcompare 앱을 먼저 설치하세요.');
const codex = summary.resolveEngineBin('codex');
if (!codex) throw new Error('Codex CLI를 찾지 못했습니다.');
execFileSync(codex, ['mcp', 'add', 'wcompare', '--env', 'ELECTRON_RUN_AS_NODE=1',
  '--env', `WCOMPARE_APP=${app}`, '--', executable, bridge], { stdio: 'inherit' });

const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const original = fs.readFileSync(config, 'utf8');
const text = original.replace(/(^\[mcp_servers\.wcompare\]\r?\n)([\s\S]*?)(?=^\[|(?![\s\S]))/m, (_match, heading, body) => {
  const setting = 'tool_timeout_sec = 120';
  const next = /^tool_timeout_sec\s*=/m.test(body)
    ? body.replace(/^tool_timeout_sec\s*=.*$/m, setting) : setting + '\n' + body;
  return heading + next;
});
const pending = `${config}.wcompare.tmp`;
fs.writeFileSync(pending, text, { mode: fs.statSync(config).mode & 0o777 });
fs.renameSync(pending, config);
try { execFileSync(codex, ['mcp', 'get', 'wcompare'], { stdio: 'ignore' }); }
catch (error) { fs.writeFileSync(config, original); throw error; }
console.log('wcompare MCP 등록 완료');
