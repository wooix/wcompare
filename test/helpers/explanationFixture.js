const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makePdf } = require('./makePdf');

function explanationFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-explanation-'));
  const input = path.join(dir, 'paper.pdf');
  const translated = path.join(dir, 'paper.ko.pdf');
  fs.writeFileSync(input, makePdf(3, { lines: 20 }));
  fs.writeFileSync(translated, makePdf(3, { lines: 15 }));
  const stub = path.join(dir, 'codex');
  fs.writeFileSync(stub, `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', data => prompt += data);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.EXPLANATION_LOG, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }) + '\\n');
  if (process.env.EXPLANATION_MODE === 'hang') { setInterval(() => {}, 1000); return; }
  if (process.env.EXPLANATION_MODE === 'error') { process.exitCode = 1; return; }
  const paper = JSON.parse(fs.readFileSync(process.env.EXPLANATION_FIXTURE));
  fs.writeFileSync('paper.json', JSON.stringify(paper));
  fs.writeFileSync('source-inventory.json', JSON.stringify(paper.sourceInventory));
});
`, { mode: 0o755 });
  const log = path.join(dir, 'calls.jsonl');
  return {
    dir, input, translated, log, cache: path.join(dir, 'cache'),
    env: { ...process.env, WCOMPARE_CODEX: stub, WCOMPARE_NODE: process.execPath,
      EXPLANATION_LOG: log,
      EXPLANATION_FIXTURE: path.resolve(__dirname, '../../resources/paper-helper/examples/queue-demo.json') },
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}
module.exports = { explanationFixture };
