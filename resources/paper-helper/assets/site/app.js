'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const cache = new Map();
let book;
let chapter = 'start';
let renderNumber = 0;
let scrollPending = false;
let lastSection = '';
let searchTimer;
let toastTimer;
let storageKey;
let state = { read: [], font: 17, dark: false, last: null, compare: false };

async function data(path) {
  if (window.PAPER_OFFLINE?.[path] !== undefined) return window.PAPER_OFFLINE[path];
  if (!cache.has(path)) {
    cache.set(path, fetch(path).then(response => {
      if (!response.ok) throw new Error(`Unable to load ${path}`);
      return path.endsWith('.json') ? response.json() : response.text();
    }));
  }
  return cache.get(path);
}

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {}
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2600);
}

function applyPreferences() {
  document.documentElement.style.setProperty('--text-size', `${state.font}px`);
  document.body.classList.toggle('dark', state.dark);
  document.body.classList.toggle('show-original', state.compare);
  $('#compare-toggle').setAttribute('aria-pressed', state.compare);
  $('#theme-toggle').setAttribute('aria-label', state.dark ? '밝은 화면으로 전환' : '어두운 화면으로 전환');
  $('#font-up').disabled = state.font >= 23;
  $('#font-down').disabled = state.font <= 14;
}

function chapterInfo(id) { return book.chapters.find(item => item.id === id); }
function chapterOf(id) { return id.match(/^(S\d+|A\d+)/)?.[0] || 'start'; }
function mainChapters() { return book.chapters.filter(item => item.kind === 'main'); }
function renderToc() { ReadingTools.renderToc(); }
function navigate(id) {
  if (location.hash.slice(1) === id) route().catch(handleError);
  else location.hash = id;
}
function closeMenu() {
  $('#sidebar').classList.remove('open');
  $('#mobile-scrim').hidden = true;
}

function fillFrame() {
  $('#paper-subject').textContent = book.subject;
  $('#resource-links').innerHTML = book.resources.map(resource => `
    <button class="margin-link" data-panel="${escapeHTML(resource.id)}">
      <span>${escapeHTML(resource.label)}</span><small>${escapeHTML(resource.description)}</small><b>↗</b>
    </button>`).join('');
  $('#original-pdf').href = book.pdf;
  $('#original-pdf').hidden = !book.pdf;
  $('#pdf-description').textContent = book.editionLabel;
  $('#source-footer').innerHTML = `${escapeHTML(book.authors.join(', '))} · ${escapeHTML(book.citation)} ·
    <a href="${escapeHTML(book.license.url)}" target="_blank" rel="noopener">${escapeHTML(book.license.label)}</a>
    <br>한국어 번역과 읽기 구조를 더한 학습 자료`;
}

function guideBox(guide, id, closing = false) {
  if (!guide) return '';
  const body = closing
    ? `<ul>${guide.takeaways.map((text, index) => `<li data-read-id="guide-${id}-takeaway-${index}">${escapeHTML(text)}</li>`).join('')}</ul>
       ${guide.next ? `<p data-read-id="guide-${id}-next">${escapeHTML(guide.next)}</p>` : ''}`
    : `<p data-read-id="guide-${id}-intro">${escapeHTML(guide.intro)}</p>`;
  return `<aside class="guide-box"><div class="guide-label">${closing ? '여기까지, 잠깐 정리' : '이 장을 읽기 전에'}
    <span class="ai-tag">AI 보조 설명</span></div>${body}</aside>`;
}

async function renderCover() {
  const cover = book.cover;
  const abstract = await data('chapters/abstract1.html');
  return `<section class="cover">
    <p class="cover-kicker">A READING COMPANION</p>
    <h1 class="cover-title">${escapeHTML(cover.title)}<br><em>${escapeHTML(cover.subtitle)}</em></h1>
    <p class="cover-description">${escapeHTML(cover.description)}</p>
    <div class="cover-paper"><h2>${escapeHTML(book.title)}</h2>
      <div class="cover-meta">${escapeHTML(book.authors.join(', '))} · ${escapeHTML(book.citation)} · ${escapeHTML(book.date)}</div></div>
    <div class="cover-question"><span class="question-mark">“</span><p>${escapeHTML(cover.question)}
      <small>이 논문을 관통하는 질문 · AI 보조 설명</small></p></div>
    <div class="cover-actions"><a class="primary-button" href="#${mainChapters()[0].id}">첫 장부터 읽기 <span>→</span></a>
      ${state.last ? '<button class="secondary-button" id="cover-resume">읽던 자리로 ↗</button>' : '<button class="secondary-button" data-panel="terminology">용어 먼저 살펴보기 ↗</button>'}</div>
    <section class="reading-map"><h2 class="small-heading">이번 읽기의 흐름</h2>
      ${book.groups.map((group, index) => `<a class="map-row" href="#${group.chapters[0]}">
        <span class="step">${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHTML(group.title)}</strong>
        <p>${escapeHTML(group.description)}</p></div><span class="chapter-range">${group.chapters.length}개 장 ↗</span></a>`).join('')}
    </section>
    <div class="read-policy"><h3>이 자료의 읽기 약속</h3>
      <p>전문 용어는 English (한국어)로 표시합니다. Terminology (용어집)에서 한글 병기를 조절할 수 있습니다.</p>
      <p>초록색 안내와 소절 정리는 AI가 덧붙인 이해 보조 설명입니다.</p>
      <p>본문의 원문 버튼으로 영어 문장을 확인하고, 중요한 문장을 선택해 하이라이트를 저장하세요.</p></div>
    <details class="abstract-details"><summary>Abstract (초록) 전체 번역 펼치기</summary><div class="paper-content">${abstract}</div></details>
    <button class="quiet" data-panel="about">번역 범위와 원문 정보 확인하기 ↗</button>
  </section>`;
}

async function renderChapter(id) {
  const current = chapterInfo(id);
  const chapters = mainChapters();
  const index = chapters.findIndex(item => item.id === id);
  const group = book.groups.find(item => item.chapters.includes(id));
  const next = chapters[index + 1];
  const previous = chapters[index - 1];
  return `<header class="chapter-head">
    <div class="chapter-kicker"><span>${String(index + 1).padStart(2, '0')}</span> / ${chapters.length} · ${escapeHTML(group.title)}</div>
    <h1>${escapeHTML(current.label)}</h1><p class="chapter-subtitle">${escapeHTML(current.subtitle)}</p>
    <div class="chapter-source"><span>원문 ${index + 1}장 · 한국어 번역</span>${sourceLink(current.sourceId || id, '원문 위치 ↗', '')}
      ${current.companions.map(target => `<button class="quiet mobile-reference" data-panel="${escapeHTML(target)}">${escapeHTML(locationLabel(target))} ↗</button>`).join('')}
    </div></header>
    ${guideBox(current.guide, id)}
    <p class="original-tip">문단 끝의 원문 버튼으로 영어 문장을 대조하세요. 중요한 문장을 선택하면 하이라이트를 저장할 수 있습니다.</p>
    <article class="paper-content">${await data(`chapters/${id}.html`)}</article>
    <section class="chapter-close">${guideBox(current.guide, id, true)}
      <div class="chapter-end-actions"><button class="mark-read ${state.read.includes(id) ? 'done' : ''}" id="mark-read">
        ${state.read.includes(id) ? '✓ 읽은 장으로 표시됨' : '✓ 이 장을 읽었어요'}</button>
        ${next ? `<a class="next-chapter" href="#${next.id}"><small>다음 이야기 · ${index + 2}장</small><span>${escapeHTML(next.label)} →</span></a>` : '<a class="next-chapter" href="#start"><span>전체 흐름 다시 보기 →</span></a>'}
      </div></section>
    <nav class="chapter-nav"><a href="#${previous?.id || 'start'}">← ${previous ? '이전 장' : '읽기 안내'}</a>
      <button class="quiet" data-panel="map">전체 연구 지도 ↗</button><a href="#${id}">이 장의 처음 ↑</a></nav>`;
}

function locationLabel(id) {
  const parent = chapterInfo(chapterOf(id));
  return parent?.toc.find(item => item.id === id)?.title || parent?.label || id;
}

function contextLinks(id) {
  $('#context-links').innerHTML = (chapterInfo(id)?.companions || []).map(target => `
    <div class="context-item"><p class="eyebrow">지금 곁에 두면 좋은 자료</p>
      <button data-panel="${escapeHTML(target)}">${escapeHTML(locationLabel(target))} ↗</button></div>`).join('');
  ReadingTools.decorate($('#context-links'));
}

async function route() {
  const positionRoute = ReadingPosition.beginRoute();
  try { await renderRoute(); } finally { ReadingPosition.endRoute(positionRoute); }
}

async function renderRoute() {
  const requested = decodeURIComponent(location.hash.slice(1) || 'start');
  if (['about', 'glossary', 'map', 'references', 'terminology', 'highlights', 'library'].includes(requested) || requested.startsWith('A') || requested.startsWith('bib.')) {
    if (!$('#reader .cover, #reader .chapter-head')) {
      $('#reader').innerHTML = await renderCover();
      renderToc();
      await enhance($('#reader'));
    }
    closeMenu();
    await openPanel(requested);
    return;
  }
  const targetChapter = chapterOf(requested);
  const next = chapterInfo(targetChapter) ? targetChapter : 'start';
  const number = ++renderNumber;
  const changed = chapter !== next || !$('#reader .cover, #reader .chapter-head');
  chapter = next;
  if (changed) {
    $('#reader').innerHTML = '<p class="loading">이야기를 펼치고 있습니다.</p>';
    const markup = next === 'start' ? await renderCover() : await renderChapter(next);
    if (number !== renderNumber) return;
    $('#reader').innerHTML = markup;
    $('#breadcrumb').textContent = next === 'start' ? '읽기 안내' : `${next.slice(1).padStart(2, '0')} / ${chapterInfo(next).label}`;
    document.title = `${next === 'start' ? '논문을 읽는 길' : chapterInfo(next).label} · ${book.shortTitle}`;
    renderToc();
    contextLinks(next);
    await enhance($('#reader'));
    if (number !== renderNumber) return;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  closeMenu();
  if (requested !== next && requested !== 'start') {
    const target = document.getElementById(requested) || document.querySelector(`[data-read-id="${CSS.escape(requested)}"]`);
    target?.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
  onScroll();
}

async function enhance(root) {
  for (const node of root.querySelectorAll('[data-trid]')) {
    if (node.querySelector('[data-trid]') || node.closest('td,th') || !node.textContent.trim()) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'paragraph-source';
    button.dataset.source = node.dataset.trid;
    button.textContent = '원문';
    button.setAttribute('aria-label', '이 문단의 영어 원문 대조');
    node.append(button);
  }
  if (state.compare) await showOriginals(root);
  await ReadingTools.enhance(root);
}

async function showOriginals(root = $('#reader')) {
  const originals = await data('originals.json');
  for (const node of root.querySelectorAll('[data-trid]')) {
    if (!originals[node.dataset.trid] || node.querySelector('[data-trid]') || node.nextElementSibling?.classList.contains('original-inline')) continue;
    const block = document.createElement('div');
    block.className = 'original-inline';
    block.lang = 'en';
    block.innerHTML = originals[node.dataset.trid].html;
    node.after(block);
  }
}

function sourceLink(id, label = '원문 위치로 ↗', className = 'source-location') {
  if (!book.source) return '';
  const url = book.source.split('#')[0] + '#' + encodeURIComponent(id);
  return `<a class="${className}" href="${escapeHTML(url)}" target="_blank" rel="noopener">${escapeHTML(label)}</a>`;
}

function showPanel() {
  ReadingTools.decorate($('#panel-content'));
  if (!$('#side-panel').open) $('#side-panel').showModal();
  $('#side-panel').scrollTop = 0;
}

function closePanel() {
  ReadingTools.clearSelection();
  $('#side-panel').close();
  const hash = location.hash.slice(1);
  if (hash.startsWith('A') || hash.startsWith('bib.') || ['about', 'glossary', 'map', 'references', 'terminology', 'highlights', 'library'].includes(hash)) {
    history.replaceState(null, '', '#' + chapter);
  }
}

async function openSource(id) {
  const original = (await data('originals.json'))[id];
  if (!original) return;
  ReadingTools.onPanelChange('source');
  $('#panel-title').textContent = '영어 원문 대조';
  $('#panel-label').textContent = 'ORIGINAL TEXT · 원문 그대로';
  $('#panel-content').innerHTML = `<div class="original-card" lang="en">${original.html}</div>${sourceLink(original.source)}`;
  showPanel();
}

async function openPanel(id) {
  ReadingTools.onPanelChange(id);
  if (ReadingTools.ownsPanel(id)) return ReadingTools.openPanel(id);
  $('#panel-label').textContent = '곁에 두는 자료';
  if (id === 'glossary') {
    $('#panel-title').textContent = '개념 풀이 노트';
    $('#panel-label').textContent = 'AI 보조 설명';
    $('#panel-content').innerHTML = book.glossary.map(entry => `<section class="glossary-entry">
      <h3>${escapeHTML(entry.term)}</h3><p>${escapeHTML(entry.description)}</p>
      <a href="#${escapeHTML(entry.target)}" data-goto="${escapeHTML(entry.target)}">관련 본문에서 읽기 ↗</a></section>`).join('') || '<p>이 자료에 등록된 개념 풀이가 없습니다.</p>';
  } else if (id === 'map') {
    $('#panel-title').textContent = '전체 연구 지도';
    $('#panel-label').textContent = '논문의 주제와 연결';
    $('#panel-content').innerHTML = book.groups.map(group => `<section><h3>${escapeHTML(group.title)}</h3>
      <p>${escapeHTML(group.description)}</p><ul>${group.chapters.map(target => `<li><a href="#${target}" data-goto="${target}">${escapeHTML(chapterInfo(target).label)}</a></li>`).join('')}</ul></section>`).join('');
  } else if (id === 'about') {
    $('#panel-title').textContent = '자료 정보와 번역 범위';
    $('#panel-content').innerHTML = `<h3>${escapeHTML(book.title)}</h3><p>${escapeHTML(book.authors.join(', '))}</p>
      <p>${escapeHTML(book.citation)} · ${escapeHTML(book.date)}</p>${sourceLink('', '원문 열기 ↗')}
      <h3>번역 범위</h3><p>${escapeHTML(book.coverageDescription)}</p>
      <p>본문의 원문 버튼으로 번역과 영어 문장을 대조할 수 있습니다. 초록색 안내는 AI 보조 설명입니다.</p>
      <h3>읽기 기록</h3><p>읽던 위치, 글자 크기, 용어 설정과 하이라이트는 이 브라우저에 저장됩니다.</p>
      <p><a class="secondary-button" href="read-offline.html" download>오프라인용 한 파일로 저장 ↓</a></p>
      <div class="cover-actions"><button class="secondary-button" data-panel="references">참고문헌 전체</button></div>`;
  } else if (id === 'references' || id.startsWith('bib.')) {
    $('#panel-title').textContent = 'References (참고문헌)';
    const references = await data('references.json');
    $('#panel-content').innerHTML = id === 'references'
      ? Object.keys(references).length ? '<ul>' + Object.values(references).join('') + '</ul>' : '<p>이 자료에 등록된 참고문헌이 없습니다.</p>'
      : references[id] || '<p>해당 참고문헌이 없습니다.</p>';
  } else {
    const parent = chapterInfo(chapterOf(id));
    if (!parent) return;
    $('#panel-title').textContent = parent.label;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = await data(`chapters/${parent.id}.html`);
    const section = id === parent.id ? wrapper : wrapper.querySelector(`[id="${CSS.escape(id)}"]`);
    $('#panel-content').innerHTML = (section?.outerHTML || wrapper.innerHTML) + sourceLink(id);
    await enhance($('#panel-content'));
  }
  showPanel();
}

function onScroll() {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => {
    scrollPending = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    $('#scroll-progress').style.width = `${Math.min(100, Math.max(0, scrollY / Math.max(1, max) * 100))}%`;
    let active = chapter;
    for (const heading of $$('#reader h3,#reader h4,#reader h5,#reader h6')) {
      if (heading.getBoundingClientRect().top < 170) active = heading.parentElement.id || active;
    }
    if (active !== lastSection) {
      lastSection = active;
      ReadingTools.setCurrent(active);
    }
    ReadingPosition.schedule();
  });
}

async function runSearch() {
  const query = $('#search-input').value.trim().toLocaleLowerCase();
  if (query.length < 2) {
    $('#search-results').innerHTML = '<p class="search-hint">두 글자 이상 입력해 주세요.</p>';
    return;
  }
  const entries = (await data('search.json')).filter(entry => (entry.text + ' ' + entry.original).toLocaleLowerCase().includes(query)).slice(0, 30);
  const pattern = new RegExp(escapeHTML(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  $('#search-results').innerHTML = entries.map(entry => {
    const text = ReadingTools.formatText(entry.text);
    const start = Math.max(0, text.toLocaleLowerCase().indexOf(query) - 45);
    const snippet = escapeHTML(text.slice(start, start + 220)).replace(pattern, '<mark>$&</mark>');
    return `<a class="search-result" href="#${entry.id}" data-result="${entry.id}"><small>${escapeHTML(locationLabel(entry.chapter))}</small><p>${snippet}</p></a>`;
  }).join('') || '<p class="search-hint">일치하는 문장이 없습니다.</p>';
}

document.addEventListener('click', async event => {
  const source = event.target.closest('[data-source]');
  if (source) { event.preventDefault(); await openSource(source.dataset.source); return; }
  const panel = event.target.closest('[data-panel]');
  if (panel) { event.preventDefault(); await openPanel(panel.dataset.panel); return; }
  const close = event.target.closest('[data-close]');
  if (close) { close.dataset.close === 'side-panel' ? closePanel() : $('#' + close.dataset.close).close(); return; }
  const result = event.target.closest('[data-result]');
  if (result) { event.preventDefault(); $('#search-dialog').close(); navigate(result.dataset.result); return; }
  const link = event.target.closest('a[href^="#"]');
  if (link) {
    const id = decodeURIComponent(link.hash.slice(1));
    if (id.startsWith('A') || id.startsWith('bib.')) { event.preventDefault(); await openPanel(id); return; }
    if ($('#side-panel').open) { event.preventDefault(); closePanel(); navigate(id); }
  }
  if (event.target.closest('#mark-read')) {
    state.read = state.read.includes(chapter) ? state.read.filter(id => id !== chapter) : [...state.read, chapter];
    save();
    $('#mark-read').classList.toggle('done', state.read.includes(chapter));
    $('#mark-read').textContent = state.read.includes(chapter) ? '✓ 읽은 장으로 표시됨' : '✓ 이 장을 읽었어요';
    renderToc();
  }
  if (event.target.closest('#cover-resume')) { closeMenu(); await ReadingPosition.restore(); }
  const figure = event.target.closest('.paper-content figure img');
  if (figure) {
    ReadingTools.onPanelChange('figure');
    $('#panel-title').textContent = '원문 그림 확대';
    $('#panel-content').innerHTML = `<img src="${escapeHTML(figure.src)}" alt="${escapeHTML(figure.alt)}" style="max-width:100%;height:auto">`;
    showPanel();
  }
});

$('#search-launch').addEventListener('click', () => { $('#search-dialog').showModal(); $('#search-input').focus(); });
$('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
$('#menu-toggle').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
  $('#mobile-scrim').hidden = !$('#sidebar').classList.contains('open');
});
$('#mobile-scrim').addEventListener('click', closeMenu);
$('#resume').addEventListener('click', () => { closeMenu(); ReadingPosition.restore(); });
$('#font-up').addEventListener('click', () => { state.font = Math.min(23, state.font + 1); save(); applyPreferences(); });
$('#font-down').addEventListener('click', () => { state.font = Math.max(14, state.font - 1); save(); applyPreferences(); });
$('#theme-toggle').addEventListener('click', () => { state.dark = !state.dark; save(); applyPreferences(); });
$('#compare-toggle').addEventListener('click', async () => { state.compare = !state.compare; save(); applyPreferences(); if (state.compare) await showOriginals(); });
$('#side-panel').addEventListener('cancel', event => { event.preventDefault(); closePanel(); });
window.addEventListener('hashchange', () => route().catch(handleError));
window.addEventListener('scroll', onScroll, { passive: true });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); $('#search-launch').click(); }
  if (event.key === 'Escape') closeMenu();
});

function handleError(error) {
  console.error(error);
  $('#reader').innerHTML = '<div class="read-policy"><h3>자료를 불러오지 못했습니다.</h3><p>연결을 확인하고 새로고침해 주세요. 내려받은 자료는 read-offline.html로 열 수 있습니다.</p></div>';
}

async function init() {
  book = await data('book.json');
  storageKey = 'paper-reader-state-v1:' + book.id;
  try { state = { ...state, ...JSON.parse(localStorage.getItem(storageKey) || '{}') }; } catch {}
  fillFrame();
  applyPreferences();
  ReadingPosition.init({
    book, getState: () => state, getChapter: () => chapter, save, toast, route, onPositionChanged: onScroll,
    navigate: async id => { history.replaceState(null, '', '#' + id); await route(); }
  });
  await ReadingTools.init({
    book, data, escape: escapeHTML, toast, getChapter: () => chapter, getState: () => state, showPanel, closePanel,
    extraTerms: book.glossary.flatMap(entry => [entry.term, entry.description]),
    goto: async id => {
      if (id.startsWith('A')) await openPanel(id);
      else { history.pushState(null, '', '#' + id); await route(); }
    }
  });
  renderToc();
  await ReadingPosition.start();
}

init().catch(handleError);
