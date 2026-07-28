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
  'pdf.worker': 'pdfjs-dist/build/pdf.worker.mjs',
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
  await cp('node_modules/pdfjs-dist/web/pdf_viewer.css', out('renderer/pdf_viewer.css'));
  await cp('node_modules/pdfjs-dist/web/images', out('renderer/images'), { recursive: true });
  // mermaid는 번들에 넣지 않고 파일로 둔다: iife 포맷에선 esbuild가 동적 import를 전부 인라인해
  // app.js가 11MB → 19MB로 불어나는데, 흐름도 탭은 대부분의 세션에서 아예 열리지 않는다.
  // 대신 mermaidLoader가 이 파일을 <script>로 1회 주입한다(chunks 참조 없는 자기완결 번들).
  await cp('node_modules/mermaid/dist/mermaid.min.js', out('renderer/mermaid.min.js'));
  // KaTeX: 수식은 CSS와 웹폰트가 있어야 글자로 보인다. katex.min.css가 fonts/를 **상대경로**로
  // 참조하므로 같은 폴더 구조 그대로 복사해야 app:// 스킴에서 same-origin이 되어
  // CSP(font-src 'self')를 통과한다. 폰트를 다른 곳에 두면 수식이 네모로만 뜬다.
  await cp('node_modules/katex/dist/katex.min.css', out('renderer/katex.min.css'));
  await cp('node_modules/katex/dist/fonts', out('renderer/fonts'), { recursive: true });
  console.log('[esbuild] copied index.html + pdf_viewer.css + images + mermaid.min.js + katex');
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
