// src/renderer/dictPopup.js — 실시간 사전 팝업. mdToc.js처럼 순수 판정 함수(isEnglishQuery)는
// node 단위 테스트가 require 하고, createDictPopup은 esbuild 번들에서 ESM import로 쓰인다
// (document는 createDictPopup/메서드 호출 시점에만 참조 — top-level DOM 접근 없음).

// 영→한 전용 게이트: 라틴 문자 2자 이상 + 한글([가-힣]) 없음일 때만 조회한다.
// 한글이 섞인 선택(번역본 대조 중 등)은 무시해 팝업이 뜨지 않게 한다.
function isEnglishQuery(text) {
  const s = String(text ?? '');
  if (/[가-힣]/.test(s)) return false;
  const latin = s.match(/[A-Za-z]/g);
  return !!latin && latin.length >= 2;
}

// body에 붙는 고정 팝업 하나를 만든다. 상태(조회 중/사전/MT/오류)를 메서드로 갈아끼우고
// 위치는 선택 지점 기준으로 뷰포트 안에 보정한다.
function createDictPopup() {
  const el = document.createElement('div');
  el.className = 'wc-dict-popup';
  el.style.display = 'none';
  document.body.appendChild(el);

  let anchor = null; // { x, y } — 최근 표시 지점(내용이 바뀌어도 같은 자리에서 재보정)
  let open = false;

  // 선택 지점(anchor) 아래에 두되, 아래 공간이 부족하면 위로. 좌우도 뷰포트 안으로 클램프.
  function reposition() {
    if (!anchor) return;
    el.style.display = 'block'; // 크기를 재려면 먼저 보여야 한다
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 8; // 뷰포트 여백
    let left = anchor.x;
    if (left + w + M > vw) left = vw - w - M;
    if (left < M) left = M;
    let top = anchor.y + 12; // 기본은 지점 아래
    if (top + h + M > vh) top = anchor.y - h - 12; // 아래가 좁으면 위로
    if (top < M) top = M;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function setBody(node) {
    el.replaceChildren(node);
    reposition();
  }

  function openAt(pos) {
    anchor = { x: pos.x, y: pos.y };
    open = true;
    const wrap = document.createElement('div');
    wrap.className = 'wc-dict-loading';
    const spin = document.createElement('span');
    spin.className = 'wc-dict-spin';
    const label = document.createElement('span');
    label.textContent = '번역 중…';
    wrap.append(spin, label);
    setBody(wrap);
  }

  function renderDict(entries) {
    if (!open) return;
    const list = document.createElement('div');
    list.className = 'wc-dict-entries';
    for (const [ko, pos] of entries || []) {
      const row = document.createElement('div');
      row.className = 'wc-dict-row';
      const word = document.createElement('span');
      word.className = 'wc-dict-ko';
      word.textContent = ko;
      row.appendChild(word);
      if (pos) {
        const badge = document.createElement('span');
        badge.className = 'wc-dict-pos';
        badge.textContent = String(pos).toLowerCase();
        row.appendChild(badge);
      }
      list.appendChild(row);
    }
    if (!list.childElementCount) return renderError('뜻을 찾지 못했습니다');
    setBody(list);
  }

  function renderMt(ko, engine) {
    if (!open) return;
    const wrap = document.createElement('div');
    const p = document.createElement('div');
    p.className = 'wc-dict-mt';
    p.textContent = ko || '(빈 결과)';
    wrap.appendChild(p);
    if (engine) {
      const tag = document.createElement('div');
      tag.className = 'wc-dict-engine';
      tag.textContent = engine;
      wrap.appendChild(tag);
    }
    setBody(wrap);
  }

  function renderError(msg) {
    if (!open) return;
    const e = document.createElement('div');
    e.className = 'wc-dict-error';
    e.textContent = msg || '조회 실패';
    setBody(e);
  }

  function close() {
    open = false;
    anchor = null;
    el.style.display = 'none';
    el.replaceChildren();
  }

  // 팝업 내부 노드인지 — 팝업 안 텍스트를 선택해도 재조회가 걸리지 않게 하려고 쓴다.
  function contains(node) { return !!node && el.contains(node); }

  return {
    el,
    openAt,
    renderDict,
    renderMt,
    renderError,
    close,
    contains,
    isOpen: () => open,
  };
}

module.exports = { isEnglishQuery, createDictPopup };
