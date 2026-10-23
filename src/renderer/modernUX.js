// App chrome only; document state stays with the existing mode controllers.
export function initModernUX() {
  const $ = id => document.getElementById(id);
  const header = document.createElement('header');
  header.id = 'workspace-header';
  header.innerHTML = '<div class="brand"><span class="brand-mark">w</span><div><strong>wcompare</strong><small>읽고, 비교하고, 이해하세요</small></div></div><div id="workspace-modes"></div><div class="header-actions"><button id="ai-settings-shortcut" title="번역 엔진·모델 설정">AI 설정</button></div>';
  document.body.prepend(header);
  $('workspace-modes').append($('mode-switch'));
  const settings = $('btn-settings');
  if (settings) { settings.textContent = '설정'; header.querySelector('.header-actions').append(settings); }
  $('ai-settings-shortcut').onclick = () => {
    settings?.click();
    document.querySelector('#settings-tabs [data-tab="translate"]')?.click();
  };
  const focus = document.createElement('button');
  focus.id = 'btn-reading-focus';
  let focusEnabled = false;
  let focusPending = false;
  let focusChanged = false;
  const showFocus = on => {
    focusEnabled = on;
    document.body.classList.toggle('reading-focus', on);
    focus.textContent = on ? '집중 모드 종료' : '집중 모드';
    focus.title = on
      ? '집중 모드 종료 · Esc'
      : '다른 앱과 바탕화면을 어둡게 표시합니다. 전체화면 앱과 다른 Space는 제외됩니다.';
    focus.setAttribute('aria-pressed', String(on));
    window.dispatchEvent(new Event('resize'));
  };
  const setFocus = async on => {
    if (focusPending) return;
    focusChanged = true;
    focusPending = true;
    focus.disabled = true;
    try {
      const state = await window.wcompare.focusMode.set(on);
      showFocus(state.enabled);
    } catch (error) {
      $('toolbar-status').textContent = `집중 모드를 시작할 수 없습니다: ${error.message}`;
    } finally {
      focusPending = false;
      focus.disabled = false;
    }
  };
  focus.onclick = () => setFocus(!focusEnabled);
  header.querySelector('.header-actions').prepend(focus);
  showFocus(false);
  window.wcompare.focusMode.onChanged(state => { focusChanged = true; showFocus(state.enabled); });
  window.wcompare.focusMode.get().then(state => {
    focus.hidden = !state.supported;
    if (!focusChanged) showFocus(state.enabled);
  }).catch(() => { focus.hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && focusEnabled && !document.querySelector('dialog[open]')) setFocus(false);
  });
  const labels = { 'btn-open-left': '파일 열기', 'btn-open-right': '비교 파일 열기', 'btn-toc': '목차', 'btn-save': '저장', 'btn-prev-diff': '← 이전 차이', 'btn-next-diff': '다음 차이 →' };
  for (const [id, text] of Object.entries(labels)) if ($(id)) $(id).textContent = text;
  $('btn-open-left').title = '왼쪽 파일 열기 · ⌘O';
  $('btn-open-right').title = '오른쪽 파일 열기 · ⌘⇧O';
  $('pdf-find').setAttribute('aria-label', 'PDF에서 검색');
  $('pdf-page').setAttribute('aria-label', '이동할 페이지');
  $('set-translate-engine').setAttribute('aria-label', '번역 엔진');
  $('toolbar-status').setAttribute('role', 'status');
  $('toolbar-status').setAttribute('aria-live', 'polite');

  // Keep binary toggles accessible when existing controllers change their classes.
  const updateToggle = el => el.setAttribute('aria-pressed', String(el.classList.contains('on')));
  const toggles = document.querySelectorAll('#mode-switch button, #pdf-layout button, #btn-fit, #btn-sync, #btn-night, #btn-wrap, #btn-equal');
  const observer = new MutationObserver(records => records.forEach(r => updateToggle(r.target)));
  for (const el of toggles) { updateToggle(el); observer.observe(el, { attributes: true, attributeFilter: ['class'] }); }

  for (const selector of ['#settings-tabs', '#set-prompt-tabs']) {
    const group = document.querySelector(selector);
    if (!group) continue;
    group.setAttribute('role', 'tablist');
    const tabs = [...group.querySelectorAll('button')];
    const syncTabs = () => tabs.forEach(tab => {
      const active = tab.classList.contains('on');
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    new MutationObserver(syncTabs).observe(group, { subtree: true, attributes: true, attributeFilter: ['class'] });
    syncTabs();
    group.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const i = tabs.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus();
    });
  }

  // The empty pane is a starting point, with an actual local-file action.
  const decorate = () => {
    const welcome = document.querySelector('.pdf-url');
    if (welcome && !welcome.querySelector('.welcome-open')) {
      welcome.querySelector('.pdf-url-title').textContent = '다음 논문을 펼쳐보세요';
      const intro = document.createElement('p'); intro.className = 'welcome-description';
      intro.textContent = '원문과 번역을 나란히 읽고, 핵심 내용을 한곳에 정리하세요.';
      const open = document.createElement('button'); open.className = 'welcome-open';
      open.textContent = 'PDF 파일 선택'; open.onclick = () => $('btn-open-left').click();
      welcome.querySelector('.pdf-url-title').after(intro, open);
      welcome.querySelector('.pdf-url-input').setAttribute('aria-label', 'PDF 주소');
      welcome.querySelector('.pdf-url-input').placeholder = '또는 PDF 주소를 붙여넣으세요';
      welcome.querySelector('.pdf-url-hint').textContent = '파일을 이곳으로 끌어다 놓아도 열 수 있어요. · ⌥+열기: 다시 다운로드';
    }
    const right = document.querySelector('.pdf-pane[data-side="right"]');
    if (right && !right.querySelector('.empty-companion')) {
      const hint = document.createElement('div'); hint.className = 'empty-companion';
      hint.innerHTML = '<span class="empty-symbol">⇄</span><strong>두 문서를 한눈에</strong><p>원문을 연 뒤 한국어 번역을 시작하거나<br>비교할 파일을 추가하세요.</p><button>비교 파일 선택</button>';
      hint.querySelector('button').onclick = () => $('btn-open-right').click();
      right.append(hint);
    }
  };
  decorate();
  const viewObserver = new MutationObserver(decorate);
  viewObserver.observe($('pdfview'), { childList: true });
}
