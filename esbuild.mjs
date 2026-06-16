// esbuild.mjs — 렌더러/preload/Monaco 워커를 번들한다. 메인 프로세스는 번들하지 않는다.
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = (p) => path.join(__dirname, 'dist', p);
const watch = process.argv.includes('--watch');

// Monaco 언어 워커 5종 (label→worker 매핑은 renderer/monacoEnv.js 참조)
const WORKERS = {
  'editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js',
  'json.worker': 'monaco-editor/esm/vs/language/json/json.worker.js',
  'css.worker': 'monaco-editor/esm/vs/language/css/css.worker.js',
  'html.worker': 'monaco-editor/esm/vs/language/html/html.worker.js',
  'ts.worker': 'monaco-editor/esm/vs/language/typescript/ts.worker.js',
};

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

const configs = [
  // 렌더러: monaco 포함, iife
  // monaco-vim이 참조하는 editor.api를 monaco-editor 메인에 매핑(단일 monaco 인스턴스 보장)
  { ...common, entryPoints: ['src/renderer/app.js'], outfile: out('renderer/app.js'),
    platform: 'browser', format: 'iife', loader: { '.ttf': 'file' },
    alias: { 'monaco-editor/esm/vs/editor/editor.api': 'monaco-editor/esm/vs/editor/editor.api.js' } },
  // 워커: classic(iife), browser
  ...Object.entries(WORKERS).map(([name, entry]) => ({
    ...common, entryPoints: [entry], outfile: out(`renderer/${name}.js`),
    platform: 'browser', format: 'iife',
  })),
  // preload: cjs 단일 파일, electron external
  { ...common, entryPoints: ['src/preload/preload.js'], outfile: out('preload/preload.js'),
    platform: 'node', format: 'cjs', external: ['electron'] },
];

async function copyStatic() {
  await mkdir(out('renderer'), { recursive: true });
  await cp('src/renderer/index.html', out('renderer/index.html'));
  console.log('[esbuild] copied index.html');
}

if (watch) {
  await copyStatic();
  for (const c of configs) (await context(c)).watch();
  console.log('[esbuild] watching…');
} else {
  await Promise.all(configs.map((c) => build(c)));
  await copyStatic();
  console.log('[esbuild] build complete');
}
