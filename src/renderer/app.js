import './monacoEnv.js';
import * as monaco from 'monaco-editor';

const el = document.getElementById('editor');
const diff = monaco.editor.createDiffEditor(el, {
  renderSideBySide: true, originalEditable: true, automaticLayout: true,
});
diff.setModel({
  original: monaco.editor.createModel('const a = 1\nconst b = 2\n', 'typescript'),
  // 타입 에러를 일부러 포함 → ts.worker 동작 시 빨간 물결(.squiggly-error)이 떠야 함
  modified: monaco.editor.createModel('const a: number = "x"\nconst c = 3\n', 'typescript'),
});
document.getElementById('toolbar').textContent =
  'SPIKE: diff + typescript worker — ' + (window.wcompare?.ping?.() ?? 'no-bridge');
