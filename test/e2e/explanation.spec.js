const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { explanationFixture } = require('../helpers/explanationFixture');
const MAIN = path.resolve(__dirname, '../../src/main/main.js');
const L = '.pdf-pane[data-side=left]';
const R = '.pdf-pane[data-side=right]';

async function launch(s, mode) {
  const userData = path.join(s.dir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ storageDir: s.cache }));
  const executablePath = process.env.WCOMPARE_APP_EXECUTABLE;
  const env = { ...s.env, EXPLANATION_MODE: mode || '' };
  if (executablePath) delete env.WCOMPARE_NODE;
  const app = await electron.launch({ executablePath,
    args: [...(executablePath ? [] : [MAIN]), `--user-data-dir=${userData}`, s.input, s.translated], env });
  const win = await app.firstWindow();
  await win.waitForSelector(`${R}.loaded`, { state: 'attached' });
  return { app, win };
}

test('compare/explain and optional summary retain the document pair and paper-helper reader', async () => {
  const s = explanationFixture();
  const { app, win } = await launch(s);
  let closed = false;
  try {
    await expect(win.locator(L)).toBeVisible();
    await expect(win.locator(R)).toBeVisible();
    await win.locator('#chk-summary').check();
    await expect(win.locator('.pdf-summary')).toBeVisible();
    await win.click('#btn-layout-explain');
    await expect(win.locator(L)).toBeVisible();
    await expect(win.locator(R)).toBeHidden();
    await expect(win.locator('.explanation-generate')).toBeEnabled();
    expect(s.calls()).toHaveLength(0);
    await win.click('.explanation-generate');
    const frame = win.frameLocator('.pdf-explanation iframe');
    await expect(frame.locator('#reader h1')).toBeVisible({ timeout: 20000 });
    expect(await frame.locator('body').evaluate(() => typeof window.wcompare)).toBe('undefined');
    await frame.locator('#font-up').click();
    const font = await frame.locator('body').evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-size'));
    expect(font).toBe('18px');
    await win.click('#btn-switch');
    await expect(win.locator(R)).toBeVisible();
    await expect(win.locator(L)).toBeHidden();
    await expect(win.locator('.pdf-summary')).toBeVisible();
    await win.locator('#chk-summary').uncheck();
    await expect(win.locator('.pdf-summary')).toBeHidden();
    await win.click('#btn-layout-compare');
    await expect(win.locator(L)).toBeVisible();
    await expect(win.locator(R)).toBeVisible();
    await win.click('#btn-layout-explain');
    await expect(frame.locator('#reader h1')).toBeVisible();
    expect(s.calls()).toHaveLength(1);
    await frame.locator('#original-pdf').evaluate(link => link.click());
    await expect(win.locator(L)).toBeVisible();
    await win.click('#btn-switch');
    expect(await frame.locator('body').evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-size'))).toBe(font);
    await win.screenshot({ path: path.join(s.dir, 'explanation.png') });
    await app.close();
    closed = true;
    const again = await launch(s);
    try {
      await expect(again.win.frameLocator('.pdf-explanation iframe').locator('#reader h1')).toBeVisible({ timeout: 15000 });
      expect(await again.win.frameLocator('.pdf-explanation iframe').locator('body').evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-size'))).toBe(font);
      expect(s.calls()).toHaveLength(1);
      await expect(again.win.locator(R)).toBeVisible();
      await expect(again.win.locator('.pdf-summary')).toBeHidden();
    } finally { await again.app.close(); }
  } finally { if (!closed) await app.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('generation can be canceled and retried, and the frame cannot read arbitrary app files', async () => {
  const s = explanationFixture();
  const { app, win } = await launch(s, 'hang');
  try {
    await win.click('#btn-layout-explain');
    await win.click('.explanation-generate');
    await expect.poll(() => s.calls().length).toBe(1);
    await win.click('.explanation-cancel');
    await expect(win.locator('.explanation-status')).toContainText('취소');
    await app.evaluate(() => { process.env.EXPLANATION_MODE = ''; });
    await win.click('.explanation-generate');
    const frame = win.frameLocator('.pdf-explanation iframe');
    await expect(frame.locator('#reader h1')).toBeVisible({ timeout: 20000 });
    const response = await frame.locator('body').evaluate(async () => (await fetch('/%2e%2e%2fpackage.json')).status);
    expect(response).toBe(404);
  } finally { await app.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('reader terminology, highlights, source comparison and reading position survive reopening', async () => {
  const s = explanationFixture();
  const { app, win } = await launch(s);
  try {
    await win.click('#btn-layout-explain');
    await win.click('.explanation-generate');
    const frame = win.frameLocator('.pdf-explanation iframe');
    await expect(frame.locator('#reader h1')).toBeVisible({ timeout: 20000 });
    if (await frame.locator('#menu-toggle').isVisible()) await frame.locator('#menu-toggle').click();
    await frame.locator('#toc a[href="#S1"]').click();
    await expect(frame.locator('#S1-p01')).toBeVisible();
    await frame.locator('.mobile-library').click();
    await frame.locator('.library-list [data-panel="terminology"]').click();
    await frame.locator('#term-search').fill('Queue');
    await frame.locator('[data-term-row="queue"] [data-term-toggle]').click();
    await expect(frame.locator('#reader .term-gloss[data-term-key="queue"]:not([hidden])')).toHaveCount(0);
    await frame.locator('[data-term-tab="removed"]').click();
    await frame.locator('[data-term-row="queue"] [data-term-toggle]').click();
    await frame.locator('[data-close="side-panel"]').first().click();
    await frame.locator('#compare-toggle').click();
    await expect(frame.locator('.original-inline').first()).toBeVisible();
    await frame.locator('#compare-toggle').click();
    await frame.locator('#S1-p01').scrollIntoViewIfNeeded();
    await frame.locator('#S1-p01').evaluate(parent => {
      const node = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT).nextNode();
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, Math.min(node.length, 5));
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await frame.locator('#save-highlight').click();
    await expect.poll(() => frame.locator('body').evaluate(() => CSS.highlights.get('paper-saved')?.size || 0)).toBeGreaterThan(0);
    await frame.locator('body').evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const iframe = await win.locator('.pdf-explanation iframe').elementHandle();
    const embedded = await iframe.contentFrame();
    await embedded.goto(embedded.url());
    await expect(frame.locator('#S1-p01')).toBeVisible();
    await expect.poll(() => frame.locator('body').evaluate(() => CSS.highlights.get('paper-saved')?.size || 0)).toBeGreaterThan(0);
    expect(s.calls()).toHaveLength(1);
  } finally { await app.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('opening PDFs, changing modes and restarting never start explanation generation', async () => {
  const s = explanationFixture();
  let app;
  try {
    let session = await launch(s, 'hang');
    app = session.app;
    await session.win.click('#btn-layout-explain');
    await expect(session.win.locator('.explanation-generate')).toBeEnabled();
    await expect(session.win.locator('.explanation-status')).toHaveText('저장된 설명이 없습니다.');
    expect(s.calls()).toHaveLength(0);
    await session.win.click('#btn-layout-compare');
    await session.win.click('#btn-layout-explain');
    await expect(session.win.locator('.explanation-generate')).toBeEnabled();
    expect(s.calls()).toHaveLength(0);
    await app.close();
    app = null;
    session = await launch(s, 'hang');
    app = session.app;
    await expect(session.win.locator('#btn-layout-explain')).toHaveClass(/on/);
    await expect(session.win.locator('.explanation-generate')).toBeEnabled();
    await expect(session.win.locator('.explanation-status')).toHaveText('저장된 설명이 없습니다.');
    expect(s.calls()).toHaveLength(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});
