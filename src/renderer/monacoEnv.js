// Monaco 워커를 app:// same-origin에서 로드한다. label→worker 파일 매핑(Monaco 규격).
const MAP = {
  json: 'json.worker.js',
  css: 'css.worker.js', scss: 'css.worker.js', less: 'css.worker.js',
  html: 'html.worker.js', handlebars: 'html.worker.js', razor: 'html.worker.js',
  typescript: 'ts.worker.js', javascript: 'ts.worker.js',
};

self.MonacoEnvironment = {
  getWorker(_id, label) {
    const file = MAP[label] || 'editor.worker.js';
    // app://bundle/renderer/<file> (app.js와 동일 디렉토리). classic worker.
    return new Worker(new URL('./' + file, self.location.href));
  },
};
