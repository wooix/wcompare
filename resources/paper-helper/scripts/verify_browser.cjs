const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'verification');
const python = process.env.PYTHON_BIN || 'python3';
const results = {};

function build(input, target, script = path.join(root, 'scripts/build_site.py')) {
  return execFileSync(python, [script, '--input', input, '--output', target, '--node', process.execPath], { encoding: 'utf8' });
}

function files(directory, prefix = '') {
  return fs.readdirSync(directory).sort().flatMap(name => {
    const absolute = path.join(directory, name);
    return fs.statSync(absolute).isDirectory() ? files(absolute, prefix + name + '/') : [prefix + name];
  });
}

function hashes(directory) {
  return Object.fromEntries(files(directory).map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
}

function rejected(input, target, script) {
  const run = spawnSync(python, [script || path.join(root, 'scripts/build_site.py'), '--input', input, '--output', target, '--node', process.execPath], { encoding: 'utf8' });
  assert.notEqual(run.status, 0, 'Invalid input should fail before producing a site');
  assert.equal(fs.existsSync(target), false);
  return run.stderr;
}

async function ready(page) {
  await page.waitForFunction(() => document.body.dataset.positionState === 'ready');
  await page.evaluate(() => document.fonts.ready);
}

async function selectText(page, id, length = 180) {
  await page.locator(`[data-read-id="${id}"]`).first().scrollIntoViewIfNeeded();
  await page.evaluate(({ id, length }) => {
    const parent = document.querySelector(`[data-read-id="${id}"]`);
    const walk = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walk.nextNode())) if (!node.parentElement.closest('button,math,.original-inline')) nodes.push(node);
    const range = document.createRange();
    range.setStart(nodes[0], 0);
    let remaining = length;
    for (const item of nodes) {
      if (remaining <= item.length) { range.setEnd(item, remaining); break; }
      remaining -= item.length;
      range.setEnd(item, item.length);
    }
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, { id, length });
  await page.locator('#selection-tools:not([hidden])').waitFor();
}

async function closePanel(page) { await page.locator('[data-close="side-panel"]').first().click(); }

async function geometry(page) {
  return page.evaluate(() => {
    const css = selector => getComputedStyle(document.querySelector(selector));
    return {
      sidebar: css('.sidebar').width,
      toolbar: css('.toolbar').height,
      grid: css('.page-grid').gridTemplateColumns,
      gap: css('.page-grid').columnGap,
      bodyFont: css('body').fontFamily,
      titleFont: css('.chapter-head h1').fontFamily,
      contentFont: css('.paper-content').fontSize,
      contentLine: css('.paper-content').lineHeight,
      background: css('body').backgroundColor,
      accent: css('body').getPropertyValue('--accent').trim()
    };
  });
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const inputA = path.join(root, 'examples/queue-demo.json');
  const inputB = path.join(root, 'examples/process-demo.json');
  const siteA = path.join(output, 'site-a');
  const siteB = path.join(output, 'site-b');
  build(inputA, siteA);
  build(inputB, siteB);
  const firstBuild = hashes(siteA);
  build(inputA, siteA);
  assert.deepEqual(hashes(siteA), firstBuild);
  results.deterministicBuild = true;
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'template-lock.json')));
  for (const [name, hash] of Object.entries(lock.files)) {
    const relative = name.replace('assets/site/', '');
    assert.equal(hashes(siteA)[relative], hash);
    assert.equal(hashes(siteB)[relative], hash);
  }
  results.identicalUiAssetsForDifferentPapers = true;

  const invalid = JSON.parse(fs.readFileSync(inputA));
  invalid.sourceInventory.untranslated = { text: 'This unit has not been translated.', location: 'untranslated' };
  const invalidPath = path.join(output, 'invalid-source.json');
  fs.writeFileSync(invalidPath, JSON.stringify(invalid));
  assert.match(rejected(invalidPath, path.join(output, 'negative-source')), /Untranslated source units/);
  results.rejectsMissingTranslation = true;
  delete invalid.sourceInventory.untranslated;
  invalid.chapters[1].blocks[0].html = invalid.chapters[1].blocks[0].html.replace('<mn>1</mn>', '<mn>2</mn>');
  fs.writeFileSync(invalidPath, JSON.stringify(invalid));
  assert.match(rejected(invalidPath, path.join(output, 'negative-math')), /MathML changed/);
  results.rejectsChangedEquation = true;
  fs.unlinkSync(invalidPath);
  const changed = path.join(output, 'changed-template');
  fs.cpSync(path.join(root, 'assets'), path.join(changed, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(changed, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/build_site.py'), path.join(changed, 'scripts/build_site.py'));
  fs.copyFileSync(path.join(root, 'template-lock.json'), path.join(changed, 'template-lock.json'));
  fs.appendFileSync(path.join(changed, 'assets/site/styles.css'), '\nbody { color: red }\n');
  assert.match(rejected(inputA, path.join(output, 'negative-template'), path.join(changed, 'scripts/build_site.py')), /Fixed template asset changed/);
  fs.rmSync(changed, { recursive: true });
  results.rejectsUnversionedUiChanges = true;

  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let target = path.join(output, relative);
    if (!target.startsWith(output + path.sep)) { response.writeHead(403).end(); return; }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    if (!fs.existsSync(target)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
    fs.createReadStream(target).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1512, height: 1080 } });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
    await page.goto(origin + '/site-a/#S1', { waitUntil: 'networkidle' });
    await ready(page);
    const firstGeometry = await geometry(page);
    assert.equal(firstGeometry.sidebar, '300px');
    assert.equal(firstGeometry.toolbar, '69px');
    assert.equal(firstGeometry.contentFont, '17px');
    assert.equal(firstGeometry.contentLine, '34px');
    assert.equal(firstGeometry.accent, '#426a54');
    assert.match(firstGeometry.bodyFont, /Noto Sans KR/);
    assert.match(firstGeometry.titleFont, /Noto Serif KR/);
    assert.equal(await page.evaluate(() => document.fonts.check('17px "Noto Sans KR"', '가나다') && document.fonts.check('34px "Noto Serif KR"', '가나다')), true);
    assert.match(await page.locator('#read-count').innerText(), /0 \/ 2/);
    assert.equal(await page.locator('#toc details:not([open])').count(), 0);
    await page.screenshot({ path: path.join(output, 'desktop-a.png') });
    await page.goto(origin + '/site-b/#S1', { waitUntil: 'networkidle' });
    await ready(page);
    assert.deepEqual(await geometry(page), firstGeometry);
    assert.match(await page.locator('#read-count').innerText(), /0 \/ 1/);
    await page.screenshot({ path: path.join(output, 'desktop-b.png') });
    results.sameFontsColorsAndLayoutAcrossPapers = firstGeometry;

    await page.goto(origin + '/site-a/#S1', { waitUntil: 'networkidle' });
    await ready(page);
    await page.locator('.margin-notes [data-panel="terminology"]').click();
    await page.locator('#term-search').fill('Queue');
    await page.locator('[data-term-row="queue"] [data-term-toggle]').click();
    assert.equal(await page.locator('#reader .term-gloss[data-term-key="queue"]:not([hidden])').count(), 0);
    await closePanel(page);
    await page.goto(origin + '/site-b/#S1', { waitUntil: 'networkidle' });
    await ready(page);
    assert.equal(await page.locator('#reader .term-gloss[data-term-key="queue"]:not([hidden])').count(), 0);
    results.sharedTerminologyPreferences = true;
    await page.goto(origin + '/site-a/#S1', { waitUntil: 'networkidle' });
    await ready(page);
    await selectText(page, 'S1-p03');
    await page.locator('#save-highlight').click();
    await page.locator('.margin-notes [data-panel="highlights"]').click();
    assert.equal(await page.locator('.highlight-card').count(), 1);
    await page.screenshot({ path: path.join(output, 'highlights.png') });
    await page.locator('[data-highlight-goto]').click();
    await page.waitForTimeout(250);
    const prior = await page.evaluate(() => JSON.parse(localStorage.getItem('paper-reader-state-v1:queue-demo')).last);
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    assert.ok(Math.abs((await page.evaluate(() => scrollY)) - prior.scroll) < 5);
    assert.ok(await page.evaluate(() => CSS.highlights.get('paper-saved').size > 0));
    results.highlightsAndAutomaticResume = true;

    await page.locator('.paragraph-source').first().click();
    await page.locator('.original-card').waitFor();
    await closePanel(page);
    await page.locator('#compare-toggle').click();
    assert.ok(await page.locator('.original-inline').count() > 0);
    await page.locator('#compare-toggle').click();
    await page.locator('#search-launch').click();
    await page.locator('#search-input').fill('Batch');
    await page.locator('.search-result').first().waitFor();
    await page.locator('.search-result').first().click();
    await page.locator('.margin-link[data-panel="A1"]').click();
    await page.locator('#side-panel[open] #A1').waitFor();
    await closePanel(page);
    await page.goto(origin + '/site-a/#S2', { waitUntil: 'networkidle' });
    await ready(page);
    assert.equal(await page.locator('#reader math').count(), 1);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('17px "STIX Two Math"')), true);
    await page.locator('#theme-toggle').click();
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(29, 36, 33)');
    await page.locator('#theme-toggle').click();
    results.originalSearchAppendixMathAndTheme = true;

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('.mobile-library').click();
    await page.locator('.library-list [data-panel="terminology"]').click();
    await page.screenshot({ path: path.join(output, 'mobile-terminology.png') });
    await closePanel(page);
    await page.locator('#menu-toggle').click();
    await page.screenshot({ path: path.join(output, 'mobile-toc.png') });
    await page.locator('.tree-link[href="#S1"]').click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.sidebar.open').count(), 0);
    results.mobileMenuAndLayout = true;
    await page.goto(origin + '/site-b/#S1', { waitUntil: 'networkidle' });
    await ready(page);
    await page.locator('.mobile-library').click();
    await page.locator('.library-list [data-panel="highlights"]').click();
    assert.equal(await page.locator('.highlight-card').count(), 0);
    results.highlightsArePaperSpecific = true;

    const offline = await browser.newPage({ viewport: { width: 1512, height: 1080 }, offline: true });
    offline.on('pageerror', error => errors.push(error.message));
    const { pathToFileURL } = require('node:url');
    await offline.goto(pathToFileURL(path.join(siteA, 'read-offline.html')).href + '#S1');
    await ready(offline);
    assert.match((await geometry(offline)).bodyFont, /Noto Sans KR/);
    await selectText(offline, 'S1-p03');
    await offline.locator('#save-highlight').click();
    await offline.reload();
    await ready(offline);
    assert.ok(await offline.evaluate(() => CSS.highlights.get('paper-saved').size > 0));
    results.offlineWithBundledFontsAndState = true;
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    results.browserErrors = errors;
    results.externalAssetRequests = external;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
