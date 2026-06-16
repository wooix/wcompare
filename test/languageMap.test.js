const { test } = require('node:test');
const assert = require('node:assert');
const { extToLanguageId } = require('../src/renderer/languageMap.js');

test('maps known extensions', () => {
  assert.equal(extToLanguageId('a.py'), 'python');
  assert.equal(extToLanguageId('a.ts'), 'typescript');
  assert.equal(extToLanguageId('a.JS'), 'javascript'); // 대소문자 무시
  assert.equal(extToLanguageId('a.tsx'), 'typescript');
  assert.equal(extToLanguageId('a.yml'), 'yaml');
  assert.equal(extToLanguageId('a.md'), 'markdown');
});

test('unknown → plaintext', () => {
  assert.equal(extToLanguageId('a.toml'), 'plaintext');
  assert.equal(extToLanguageId('noext'), 'plaintext');
  assert.equal(extToLanguageId(''), 'plaintext');
});
