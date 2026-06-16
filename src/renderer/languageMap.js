// src/renderer/languageMap.js — 확장자 → Monaco languageId (순수)
const TABLE = {
  js: 'javascript', cjs: 'javascript', mjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', css: 'css', scss: 'scss', html: 'html', htm: 'html',
  xml: 'xml', md: 'markdown', markdown: 'markdown', py: 'python',
  sh: 'shell', bash: 'shell', yaml: 'yaml', yml: 'yaml', sql: 'sql',
  go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  java: 'java', ini: 'ini', cfg: 'ini',
};

function extToLanguageId(filename) {
  const m = String(filename).toLowerCase().match(/\.([^.\\/]+)$/);
  if (!m) return 'plaintext';
  return TABLE[m[1]] || 'plaintext';
}

module.exports = { extToLanguageId };
