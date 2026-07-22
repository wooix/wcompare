// src/main/lint/lintService.js
const { hasCommand } = require('./which.js');
const { runRuff } = require('./adapters/ruff.js');
const { runEslint } = require('./adapters/eslint.js');

const MAX_BYTES = 5 * 1024 * 1024;

// languageId → { cmd, run }
const ROUTES = {
  python: { cmd: 'ruff', run: runRuff },
  javascript: { cmd: 'eslint', run: runEslint },
  typescript: { cmd: 'eslint', run: runEslint },
};

async function lint({ languageId, content, path: filePath }) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    return { diagnostics: [], skipped: 'size' };
  }
  const route = ROUTES[languageId];
  if (!route) return { diagnostics: [], skipped: 'unsupported' };
  if (!hasCommand(route.cmd)) return { diagnostics: [], skipped: 'missing:' + route.cmd };
  try {
    const diagnostics = await route.run(content, filePath);
    return { diagnostics, skipped: null };
  } catch {
    return { diagnostics: [], skipped: 'error' };
  }
}

module.exports = { lint, MAX_BYTES, ROUTES };
