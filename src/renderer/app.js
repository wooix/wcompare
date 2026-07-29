import './monacoEnv.js';
import * as monaco from 'monaco-editor';
import { createDiff } from './diffEditor.js';
import { wireLintController } from './lintController.js';
import { setupVim, toggleVim, setSaveHandler, getActiveSide } from './vimBinding.js';
import { setStatus } from './toolbar.js';
import { setupDnd } from './dnd.js';
import { createDualView } from './pdfDualView.js';
import { createSummaryPanel } from './summaryPanel.js';
import { flattenOutline, sectionRanges, sectionsDigest, outlineDigest } from './pdfOutline.js';
import { createMdToc } from './mdToc.js';
import { normalizeEvent, hasModifier, format as fmtShortcut, isReserved, ACTIONS } from './shortcuts.js';

const $ = (id) => document.getElementById(id);
const isPdf = (p) => /\.pdf$/i.test(p || '');
// ipcRenderer.invoke는 거부 메시지 앞에 "Error invoking remote method '<채널>': Error: "를 덧붙인다.
// 사용자에게 그대로 보여 줄 자리(URL 패널 등)에서는 그 껍데기를 벗겨 main이 쓴 문장만 남긴다.
const ipcMessage = (e) => String(e?.message ?? e)
  .replace(/^Error invoking remote method '[^']*':\s*(?:[\w$.]*Error:\s*)?/, '');

// ===== diff mode =====
const editorApi = createDiff($('editor'));
const linters = {
  left: wireLintController(monaco, editorApi, 'left'),
  right: wireLintController(monaco, editorApi, 'right'),
};
// 화면 테마 — 앱 전체(툴바·패널·요약)는 index.html의 CSS 변수가, 편집기는 Monaco 테마가 맡는다.
// 값은 설정(ui.theme)에 저장돼 창을 새로 열어도 유지된다. PDF 야간 모드(Night)는 페이지 canvas만
// 반전하는 별개 기능이라 여기에 묶지 않는다 — 묶으면 "밝은 UI + 반전된 PDF" 조합을 못 만든다.
let theme = 'dark';
let ws = false;
function applyTheme(name) {
  theme = name === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
  const sel = $('set-theme');
  if (sel) sel.value = theme; // 설정창이 열려 있으면 선택 상태도 맞춘다
  // 흐름도는 CSS가 아니라 SVG에 색이 박혀 있어 다시 그려야 테마를 따라온다.
  summaryPanel?.setTheme(theme);
}
function setTheme(name) {
  applyTheme(name);
  window.wcompare.settings.set({ ui: { theme } }).catch((e) => console.warn('테마 저장 실패(무시):', e?.message || e));
}
applyTheme(theme);

editorApi.onDirty(() => refreshStatus());
const mark = (s) => (s.path ? (s.dirty ? '● ' : '') + s.path.split('/').pop() : '(empty)');
function refreshStatus() {
  if (mode !== 'diff') return;
  setStatus(`${mark(editorApi.getState('left'))}  |  ${mark(editorApi.getState('right'))}`);
}
async function dirtyGuard(side) {
  if (!editorApi.getState(side).dirty) return true;
  const ans = prompt('미저장 변경이 있습니다. save / discard / cancel 중 입력', 'cancel');
  if (ans === 'save') { await save(side); return true; }
  return ans === 'discard';
}
function placeFile(side, file) {
  if (file.isBinary && !confirm('바이너리 파일입니다. 텍스트로 강제로 열까요?')) return;
  if (file.byteSize > 5 * 1024 * 1024) alert('5MB 초과: lint를 비활성화하고 엽니다.');
  editorApi.open(side, file);
  linters[side].cancel(); linters[side].request();
  refreshStatus();
}
async function save(side = getActiveSide()) {
  const st = editorApi.getState(side);
  if (!st.path) return;
  await window.wcompare.writeFile({ path: st.path, content: editorApi.getValue(side), eol: st.eol, encoding: 'utf8', bom: st.bom });
  editorApi.setDirty(side, false);
  linters[side].cancel(); linters[side].request();
  refreshStatus();
}
setSaveHandler(save);

// ===== pdf mode =====
let mode = 'diff';
let dualView = null;
let summaryPanel = null;
const pdfPaths = { left: null, right: null };
let pdfState = null;

// ===== PDF 보기 형태 =====
// compare 원문|번역 · summary 원문|요약 · full 원문|번역|요약.
// 어떤 열을 보여줄지만 #pdfview의 클래스로 끊는다 — 문서 로드 상태를 전혀 건드리지 않으므로
// 형태를 오가도 열려 있던 PDF·마커·스크롤 위치가 그대로 남는다.
// 프로젝트 파일(.wcproj)이 아니라 localStorage에 둔 이유: .wcproj는 필드 화이트리스트 + 버전 게이트라
// 새 필드를 넣으면 구버전 앱과의 호환을 따로 정해야 하는데, 보기 형태는 문서가 아니라 "지금 이 창의
// 취향"에 가깝다(Night/Dict 토글과 같은 성격).
const LAYOUTS = ['compare', 'summary', 'full'];
const SUMMARY_KINDS = ['overview', 'sections', 'flow'];
const SUMMARY_LABEL = { overview: 'Overview', sections: '절별 요약', flow: '흐름도' };
let layout = 'compare';
try { const v = localStorage.getItem('wc-layout'); if (LAYOUTS.includes(v)) layout = v; } catch { /* 스토리지 불가 */ }

function applyLayout() {
  const view = $('pdfview');
  for (const l of LAYOUTS) {
    view.classList.toggle(`layout-${l}`, l === layout);
    $(`btn-layout-${l}`)?.classList.toggle('on', l === layout);
  }
  // 요약형에서는 오른쪽 pane이 숨는다 → 폭이 0이라 비율 동기·page-width 계산에서 빼야 한다.
  dualView?.setPaneVisible('right', layout !== 'summary');
  // 패널이 숨어 있는 동안 도착한 흐름도는 폭을 못 재 렌더가 밀려 있을 수 있다.
  // 드러나는 순간 같은 탭을 한 번 더 지정해 밀린 렌더를 깨운다.
  if (layout !== 'compare') summaryPanel?.setTab(summaryPanel.getTab());
}
function setLayout(l) {
  if (!LAYOUTS.includes(l)) return;
  layout = l;
  try { localStorage.setItem('wc-layout', l); } catch { /* 저장 실패 무시 */ }
  applyLayout();
}

// ===== markdown TOC (diff 모드) =====
// 열림 상태는 세션 한정 — PDF outline과 대칭(localStorage 불필요).
let mdTocOpen = false;
const mdToc = createMdToc(editorApi, {
  leftEl: $('md-toc-left'),
  rightEl: $('md-toc-right'),
  onChange: () => updateTocBtn(), // 콘텐츠 변경(디바운스) → 표시 규칙 재평가 + 재렌더
});
function toggleMdToc() { mdTocOpen = !mdTocOpen; updateTocBtn(); }

// #btn-toc는 두 모드에서 보인다. pdf 모드는 뷰어 outline, diff 모드는 md TOC를 제어한다.
// setMode / 파일 open·close / 토글 시 이 함수 하나로 버튼 상태와 드로어 표시를 맞춘다.
function updateTocBtn() {
  const btn = $('btn-toc');
  if (!btn) return;
  if (mode === 'pdf') {
    // pdf 모드 라벨은 renderPdfStatus도 갱신하지만, 모드 전환 직후 상태가 안 와도 맞도록 여기서도 맞춘다.
    btn.disabled = false;
    btn.textContent = 'TOC' + (dualView && dualView.isOutline() ? ' ✓' : '');
    return;
  }
  const isMd = (s) => !!editorApi.getState(s).path && editorApi.languageOf(s) === 'markdown';
  const anyMd = isMd('left') || isMd('right');
  if (!anyMd) mdTocOpen = false; // markdown 파일이 한쪽도 없으면 열림 상태 해제
  btn.disabled = !anyMd;
  btn.textContent = 'TOC' + (mdTocOpen ? ' ✓' : '');
  mdToc.render('left', mdTocOpen && isMd('left'));
  mdToc.render('right', mdTocOpen && isMd('right'));
}
function ensureDualView() {
  if (dualView) return dualView;
  dualView = createDualView($('pdfview'));
  dualView.onState(renderPdfStatus);
  dualView.onFind(renderFindCount);
  // 사용자가 마커를 추가·삭제(색상 변경 포함)하면 그 문서의 마커를 디바운스 저장한다.
  dualView.onMarkersChanged((docPath) => scheduleMarkerSave(docPath));
  // 빈 pane의 URL 입력 → main이 내려받아 보관 폴더에 둔 파일을 그 자리에 연다.
  // 오류는 alert 대신 던져서 URL 패널이 입력창 아래에 인라인으로 보여 준다.
  dualView.onOpenUrl(async (side, url, opts) => {
    if (translating) throw new Error('번역이 끝난 뒤에 열 수 있습니다');
    try {
      const { path: p } = await window.wcompare.openPdfUrl(url, opts);
      await openPdfOrThrow(side, p);
    } catch (e) {
      throw new Error(ipcMessage(e)); // main이 쓴 한국어 문장만 남겨 그대로 보여 준다
    }
  });
  // 요약 패널은 dualView가 만든 .pdf-panes와 형제로 붙는다(세 번째 열).
  // 던진 오류는 패널이 스스로 인라인 표시하므로 여기서 try/catch로 감싸지 않는다.
  summaryPanel = createSummaryPanel($('pdfview'), {
    onGenerate: () => generateSummary(),
    onRegenerate: () => generateSummary(),
  });
  summaryPanel.setTheme(theme); // 패널은 나중에 만들어지므로 현재 테마를 지금 물려준다
  applyLayout();
  return dualView;
}
// 원문/번역본은 텍스트가 달라 한쪽만 걸리는 게 정상 → 양쪽 결과를 따로 보여준다.
function renderFindCount({ query, left, right }) {
  const el = $('pdf-find-count');
  if (!query) { el.textContent = ''; el.classList.remove('miss'); return; }
  const fmt = (c) => (c ? `${c.total ? c.current : 0}/${c.total}` : '–');
  el.textContent = `L ${fmt(left)}  R ${fmt(right)}`;
  el.classList.toggle('miss', !(left?.total || right?.total));
}
function renderPdfStatus(st) {
  pdfState = st;
  $('pdf-total').textContent = String(Math.max(st.left.count, st.right.count));
  $('pdf-page').value = String(st.left.page || st.right.page || 1);
  $('btn-sync').textContent = 'Sync: ' + (st.sync ? 'ON' : 'OFF');
  $('btn-sync').classList.toggle('on', !!st.sync);
  $('btn-fit').textContent = 'Fit: ' + (st.fit ? 'ON' : 'OFF');
  $('btn-fit').classList.toggle('on', !!st.fit);
  $('btn-toc').textContent = 'TOC' + (st.outline ? ' ✓' : '');
  $('pdf-status').textContent = `L ${st.left.page}/${st.left.count}   R ${st.right.page}/${st.right.count}   ${Math.round(st.scale * 100)}%`;
  $('btn-back').disabled = !st.canBack;
  $('btn-forward').disabled = !st.canForward;
  updatePdfBtns();
}
function setMode(m) {
  mode = m;
  // #diff-wrap 전체를 토글해야 좌/우 md TOC 드로어도 에디터와 함께 사라진다.
  $('diff-wrap').style.display = m === 'diff' ? 'flex' : 'none';
  $('pdfview').style.display = m === 'pdf' ? 'flex' : 'none';
  // 'contents' — 이 묶음 자체는 상자를 만들지 않고 안의 버튼들이 툴바의 flex 항목이 된다.
  // 그래야 툴바가 버튼 단위로 두 줄로 접힌다('flex'면 묶음이 통째로 한 항목이라 접히지 않는다).
  $('diff-controls').style.display = m === 'diff' ? 'contents' : 'none';
  $('pdf-controls').style.display = m === 'pdf' ? 'contents' : 'none';
  $('statusbars').style.display = m === 'diff' ? 'flex' : 'none';
  $('pdf-status').style.display = m === 'pdf' ? 'flex' : 'none';
  $('btn-mode').textContent = m === 'diff' ? 'PDF Mode' : 'Diff Mode';
  if (m === 'diff') refreshStatus(); else setStatus('');
  resetDict(); // 모드가 바뀌면 선택 컨텍스트가 달라지므로 중복 전송 기준을 리셋한다
  if (m === 'pdf') applyLayout(); // 숨어 있는 동안 밀린 흐름도 렌더도 여기서 깨어난다
  updatePdfBtns();
  updateTocBtn();
}
// 열기 본체 — 실패를 그대로 던진다. 오류를 자기 자리에 표시하는 호출자(URL 패널)가 쓴다.
async function openPdfOrThrow(side, p) {
  // 메인이 정규화한 경로를 그대로 보관 — 번역 IPC의 화이트리스트 키와 어긋나지 않게.
  const { path: real, bytes } = await window.wcompare.readBytes(p);
  ensureDualView();
  setMode('pdf');
  await dualView.openSide(side, { bytes, path: real });
  pdfPaths[side] = real;
  // 지금 형태가 이 pane을 감추고 있으면 형태를 넓힌다. 사용자가 방금 연 문서를 숨긴 채 두지 않기
  // 위해서다 — 특히 번역은 완료되면 반대편 pane에 결과를 여는데, 요약형(오른쪽 숨김)에서는
  // 수 분을 기다린 번역본이 보이지 않는 열에 떨어진다.
  if (side === 'right' && layout === 'summary') setLayout('full');
  // 자동 복원: 이 PDF에 저장된 마커를 불러와 붙인다(단순 열기·DnD·CLI·최근 파일 모두 이 경로를 지난다).
  // 이미 메모리에 이 문서의 마커가 있으면(같은 PDF를 다른 pane에서 먼저 열어 편집 중) 덮어쓰지 않는다.
  // 프로젝트 로드는 openByPath→여기로 들어와 자동 복원하지만, onProjectLoad가 마지막에
  // setMarkers로 프로젝트 파일의 markers를 덮어써 "프로젝트가 우선"한다(설계 확정).
  await restoreMarkers(side, real);
  await syncSummaryToDoc(); // 요약 대상 문서가 바뀌었을 때만 패널을 갈아 끼운다
  updatePdfBtns();
  refreshTranslationInfo(); // 열린 문서가 바뀌었으니 "지울 번역본이 있는가"를 다시 묻는다(비동기, 열기를 막지 않는다)
}
async function openPdf(side, p) {
  try {
    await openPdfOrThrow(side, p);
  } catch (e) {
    alert('PDF를 열 수 없습니다: ' + (e?.message || e));
  }
}

// ===== 마커 자동 영속화 =====
// 저장은 문서 경로별로 500ms 디바운스한다. 복원은 열기 직후 1회.
const markerSaveTimers = new Map(); // 문서경로 → setTimeout 핸들
async function restoreMarkers(side, docPath) {
  try {
    const saved = await window.wcompare.markers.load(docPath);
    // 디스크에 저장분이 있고 메모리에 아직 이 문서 마커가 없을 때만 붙인다(진행 중 편집 클로버 방지).
    if (saved.length && !dualView.getMarkersByPath(docPath).length) dualView.setMarkers(side, saved);
  } catch (e) {
    console.warn('마커 복원 실패(무시):', e?.message || e);
  }
}
function scheduleMarkerSave(docPath) {
  if (!docPath) return;
  clearTimeout(markerSaveTimers.get(docPath));
  markerSaveTimers.set(docPath, setTimeout(() => {
    markerSaveTimers.delete(docPath);
    // 경로 기준으로 현재 마커를 읽는다 — 그사이 switch로 side가 바뀌어도 대상이 어긋나지 않는다.
    const markers = dualView.getMarkersByPath(docPath);
    window.wcompare.markers.save(docPath, markers).catch((e) => console.warn('마커 저장 실패(무시):', e?.message || e));
  }, 500));
}
// 창이 닫힐 때 디바운스 대기 중인 저장을 즉시 흘려보낸다 — 편집 후 500ms 이내 종료 시 유실 방지.
// invoke는 비동기지만 main 프로세스가 렌더러보다 오래 살아 있어 기록은 완료된다.
window.addEventListener('pagehide', () => {
  for (const [docPath, timer] of markerSaveTimers) {
    clearTimeout(timer);
    window.wcompare.markers.save(docPath, dualView.getMarkersByPath(docPath)).catch(() => {});
  }
  markerSaveTimers.clear();
});

// 좌우 교체 — 뷰어 문서와 경로를 함께 맞바꾼다.
async function switchSides() {
  if (translating) return;
  await dualView?.switchSides();
  [pdfPaths.left, pdfPaths.right] = [pdfPaths.right, pdfPaths.left];
  // 요약 대상은 "왼쪽 우선"이라 교체와 함께 바뀐다 → 패널도 새 대상 문서로 다시 묶는다.
  // 빠뜨리면 닫힌 뒤에도 앞 문서 요약이 남아 새 문서용 생성 버튼이 사라진다.
  await syncSummaryToDoc();
  updatePdfBtns();
}

// ===== 논문 요약 =====
// 요약 재료는 "원문" 쪽에서 뽑는다 — 왼쪽이 있으면 왼쪽, 없으면 오른쪽.
// 번역본을 다시 요약하면 번역에서 한 번 잃은 것 위에 요약 손실이 또 겹치기 때문이다.
// 요약이 이미 어떤 문서에 묶여 있으면 그 문서가 "지금 있는 쪽"을 쓴다 — Switch로 좌우를 옮겨
// 다녀도 요약은 문서를 따라간다(마커가 side가 아니라 문서 경로에 묶여 있는 것과 같은 규칙).
// 아직 묶이지 않았으면 원문 쪽(왼쪽 우선)을 고른다.
const summarySide = () => {
  if (summaryDoc) {
    if (pdfPaths.left === summaryDoc) return 'left';
    if (pdfPaths.right === summaryDoc) return 'right';
  }
  return pdfPaths.left ? 'left' : (pdfPaths.right ? 'right' : null);
};

// 요약 생성의 세대. 문서가 바뀔 때마다(열기·닫기) 올린다.
// 진행 중이던 생성은 "끝나지 않을 수도" 있다 — 문서를 닫으면 pdf.js가 loadingTask를 destroy하고,
// 그때 대기 중이던 getPageTexts/getOutline promise는 영영 settle되지 않는다. 그래서 취소를
// 기다리는 대신 세대를 올려 무효로 표시하고, 늦게 끝나더라도 새 문서 화면을 건드리지 않게 한다.
let summaryRun = 0;
// 요약 패널이 지금 어느 "문서"의 것인지. side가 아니라 경로로 들고 있는 이유: Switch로 문서가
// 좌우를 옮겨 다니는데, 닫힌 문서가 어느 쪽에 있었는지로 판정하면 어긋난다
// (실제 버그: A를 요약 → Switch → 오른쪽으로 옮겨간 A를 닫으면, 'right !== left'라서
//  "요약 side가 아니다"로 오판해 A의 요약이 남고 새 문서용 생성 버튼이 사라졌다).
let summaryDoc = null;
function resetSummaryPanel() {
  summaryRun++;
  summaryDoc = null;
  summaryPanel?.reset();
  // main에 걸려 있는 LLM 호출도 끊는다 — 화면에서 버린 결과를 위해 계속 돈이 나갈 이유가 없다.
  window.wcompare.cancelSummarize().catch(() => {});
}

// 요약 패널을 열려 있는 문서에 다시 묶는다. 열기·닫기·Switch가 모두 이 한 곳을 지나게 해서
// 세 경로가 서로 다른 판정을 하지 않게 한다.
//
// 규칙은 하나다: **주인 문서가 아직 열려 있으면 아무것도 하지 않는다.**
// Switch는 문서를 닫지 않고 자리만 바꾸므로 이 규칙 덕분에 읽던 요약이 그대로 남는다
// (side 기준으로 판정하면 Switch 한 번에 요약이 사라진다 — 실제로 그랬다).
// 주인이 닫혔을 때만 남은 문서로 갈아 끼우고, 아무것도 없으면 비운다.
async function syncSummaryToDoc() {
  if (!summaryPanel) return;
  const open = [pdfPaths.left, pdfPaths.right].filter(Boolean);
  if (summaryDoc && open.includes(summaryDoc)) return; // 주인이 살아 있다 → 그대로 둔다
  const next = pdfPaths.left || pdfPaths.right || null;
  if (next) await restoreSummary(next); else resetSummaryPanel();
}

// 프롬프트 재료를 모은다. 목차가 있으면 각 절의 페이지 범위로 본문을 잘라 "절 제목 + 그 절 본문"
// 형태로 넘긴다 — 모델이 목차 순서를 그대로 따르게 하려는 것이 목적이다(요구사항의 "목차 순서에 따른 요약").
// 목차가 없거나 dest를 페이지로 못 바꾸면 페이지 순서 그대로 이어 붙인 통짜 본문으로 물러선다.
async function collectSummaryMaterial(side) {
  const [title, pageTexts, rawOutline] = await Promise.all([
    dualView.getTitle(side),
    dualView.getPageTexts(side),
    dualView.getOutlineOf(side).catch(() => null), // 목차 없는 PDF가 흔하다 — 없는 것으로 취급
  ]);
  const flat = flattenOutline(rawOutline);
  // dest→페이지 변환은 pdf.js 문서 객체가 필요한 비동기 작업이라 여기서 한 번에 처리해
  // 순수 모듈(pdfOutline)에는 이미 페이지가 매겨진 데이터만 넘긴다.
  const withPages = [];
  for (const it of flat) withPages.push({ ...it, startPage: await dualView.destToPage(side, it.dest) });
  const ranges = sectionRanges(withPages, pageTexts.length);
  return {
    title: title || '',
    outline: ranges.length ? outlineDigest(ranges) : null,
    text: ranges.length ? sectionsDigest(ranges, pageTexts) : pageTexts.join('\n\n'),
  };
}

// 세 탭을 순서대로 만든다. Overview가 제일 짧고 빨라 먼저 띄우면 나머지를 기다리는 동안
// 읽을거리가 생긴다. 하나가 실패해도 나머지는 계속 만든다 — 흐름도 하나가 깨졌다고
// 요약 전체를 잃는 것이 가장 아까운 실패이기 때문.
async function generateSummary() {
  const side = summarySide();
  if (!side) throw new Error('먼저 PDF를 여세요');
  if (translating) throw new Error('번역이 끝난 뒤에 생성할 수 있습니다');
  const docPath = pdfPaths[side];
  // 이 실행의 세대. 도중에 문서가 바뀌면(닫기·다른 문서 열기) 세대가 어긋나므로,
  // 늦게 끝나더라도 새 문서의 패널에 앞 문서의 요약을 쓰지 않는다.
  const myRun = ++summaryRun;
  const alive = () => myRun === summaryRun;

  summaryPanel.setBusy({ title: '논문 요약 준비 중…', sub: '본문과 목차를 읽는 중' });
  let material;
  try {
    material = await collectSummaryMaterial(side);
  } catch (e) {
    if (alive()) summaryPanel.setBusy(null);
    throw new Error('본문을 읽지 못했습니다: ' + (e?.message || e));
  }
  if (!alive()) return; // 본문을 읽는 사이에 문서가 바뀌었다 — 조용히 물러난다

  const parts = { overview: '', sections: '', flow: '' };
  const failed = [];
  let truncated = false;
  let done = 0;
  try {
    for (const kind of SUMMARY_KINDS) {
      if (!alive()) return; // 문서가 바뀌었다 — 남은 탭을 만들 이유가 없다
      summaryPanel.setBusy({
        title: '논문 요약 생성 중…',
        sub: `${SUMMARY_LABEL[kind]} (${done + 1}/${SUMMARY_KINDS.length})`,
        hint: '완성된 탭부터 바로 읽을 수 있습니다',
        ratio: done / SUMMARY_KINDS.length,
      });
      try {
        const res = await window.wcompare.summarize({ path: docPath, kind, ...material });
        parts[kind] = res.content;
        truncated = truncated || !!res.truncated;
        if (!alive()) return; // 기다리는 사이에 문서가 바뀌었다면 새 화면에 앞 문서 요약을 쓰지 않는다
        summaryPanel.setPart(kind, res.content);
        if (kind === 'overview') summaryPanel.setTab('overview'); // 먼저 완성된 것을 바로 보여 준다
      } catch (e) {
        failed.push(`${SUMMARY_LABEL[kind]} — ${ipcMessage(e)}`);
      }
      done++;
    }
  } finally {
    // 낡은 실행이 새 문서의 진행 표시를 지우지 않게 한다.
    if (alive()) summaryPanel.setBusy(null);
    // 문서가 바뀌었더라도 여기까지 만든 것은 그 문서의 캐시로 남긴다 — 다시 열면 바로 뜬다.
    // summaryStore는 넘긴 parts를 병합 없이 덮어쓰므로 항상 세 파트를 함께 넘긴다.
    if (SUMMARY_KINDS.some((k) => parts[k])) {
      window.wcompare.summary.save(docPath, parts, { truncated })
        .catch((e) => console.warn('요약 저장 실패(무시):', e?.message || e));
    }
  }
  if (failed.length) throw new Error(failed.join('\n'));
}

// 캐시 복원 — LLM 호출이 느리고 비싸서, 같은 논문을 다시 열면 기다림 없이 떠야 한다.
async function restoreSummary(docPath) {
  if (!summaryPanel) return;
  resetSummaryPanel(); // 앞 문서의 내용도, 진행 중이던 생성의 잠금도 함께 푼다
  summaryDoc = docPath; // reset이 null로 되돌린 뒤에 이 문서로 다시 묶는다
  try {
    const { parts } = await window.wcompare.summary.load(docPath);
    for (const kind of SUMMARY_KINDS) if (parts?.[kind]) summaryPanel.setPart(kind, parts[kind]);
  } catch (e) {
    console.warn('요약 복원 실패(무시):', e?.message || e);
  }
}

// ===== pdf 번역 (transpaper) =====
// 한쪽에만 PDF가 열려 있을 때, 그 PDF를 한국어로 번역해 반대편 pane에 띄운다.
let translating = false;
let translateTarget = null; // 진행 상황을 띄울 빈 pane
let translateDone = 0;
let translateTotal = 0;
let translateStart = 0;
let translateTimer = 0;
const loadedPdfSides = () => ['left', 'right'].filter((s) => pdfPaths[s]);

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// 경과 시간 + 남은 시간 추정. 1페이지 = agy 1회로 페이지당 시간이 균일해 done 기준 선형 추정이 잘 맞는다.
// done=0이면 아직 페이지당 시간을 몰라 남은 시간은 표기하지 않는다.
function progressTimes(done, total, elapsedSec) {
  const elapsed = fmtDuration(elapsedSec);
  if (!done || !total) return { elapsed, eta: null };
  const perPage = elapsedSec / done;
  return { elapsed, eta: fmtDuration(perPage * (total - done)) };
}

// 진행 상황은 번역본이 들어올 "빈 창"에 오버레이로 보여준다.
function showTranslateProgress(sub) {
  if (!translateTarget) return;
  const elapsedSec = translateStart ? (Date.now() - translateStart) / 1000 : 0;
  const { elapsed, eta } = progressTimes(translateDone, translateTotal, elapsedSec);
  const pages = translateTotal ? `${translateDone} / ${translateTotal} 페이지` : `${translateDone} 페이지`;
  dualView?.setBusy(translateTarget, {
    title: '한국어 번역 중…',
    sub: sub ?? pages,
    hint: eta ? `경과 ${elapsed} · 남은 시간 약 ${eta}` : `경과 ${elapsed} · 남은 시간 계산 중…`,
    ratio: translateTotal ? translateDone / translateTotal : undefined,
  });
}

// 번역본 삭제 — 지울 파일이 있는지는 main만 안다(경로 유도 규칙이 거기에 있다).
// 렌더러는 그 답을 캐싱해 버튼 상태와 안내 문구에만 쓴다.
let translationInfo = { source: null, targets: [] };
let translationInfoRun = 0;
async function refreshTranslationInfo() {
  const my = ++translationInfoRun;
  const paths = loadedPdfSides().map((s) => pdfPaths[s]);
  let next = { source: null, targets: [] };
  if (paths.length) {
    try { next = await window.wcompare.translation.info(paths); }
    catch { /* 조회 실패는 버튼을 잠그는 것으로 충분하다 — 열기 흐름을 오류로 끊지 않는다 */ }
  }
  if (my !== translationInfoRun) return; // 기다리는 사이 문서가 또 바뀌었다 — 늦게 온 답은 버린다
  translationInfo = next;
  updatePdfBtns();
}

async function deleteTranslation() {
  const { source, targets } = translationInfo;
  if (translating || !source || !targets.length) return;
  let res;
  try {
    res = await window.wcompare.translation.remove(source);
  } catch (e) {
    alert('번역본 삭제 실패: ' + ipcMessage(e));
    await refreshTranslationInfo(); // 실패 사유가 "이미 없음"일 수도 있으니 상태를 다시 맞춘다
    return;
  }
  if (res.canceled || !res.removed.length) return;
  // 지운 파일이 화면에 열려 있으면 그 pane을 닫는다 — 없는 파일을 계속 보여줄 수는 없다.
  // main이 정규화(realpath)한 경로를 돌려주므로 pdfPaths와 그대로 비교된다.
  for (const side of ['left', 'right']) {
    if (res.removed.includes(pdfPaths[side])) await closeFile(side);
  }
  await refreshTranslationInfo();
  setStatus(`번역본을 휴지통으로 옮겼습니다: ${res.removed.map((p) => p.split('/').pop()).join(', ')}`);
}

function updatePdfBtns() {
  const only = loadedPdfSides().length === 1;
  const any = loadedPdfSides().length > 0;

  const d = $('btn-del-translation');
  if (d) {
    const n = translationInfo.targets.length;
    d.disabled = translating || !n;
    d.title = translating ? '번역 중에는 삭제할 수 없습니다'
      : n ? `${translationInfo.targets.map((p) => p.split('/').pop()).join(', ')} 을(를) 휴지통으로 옮깁니다`
        : '지울 한국어 번역본이 없습니다';
  }

  const t = $('btn-translate');
  if (t) {
    t.disabled = !translating && !only;
    t.textContent = translating ? '번역 취소' : '한국어 번역 ▶';
    t.title = translating ? '진행 중인 번역을 취소합니다'
      : only ? 'transpaper로 번역해 반대편에 엽니다. 이미 번역본이 있으면 그것을 엽니다 (⌥+클릭 = 다시 번역)'
        : 'PDF를 한쪽에만 열었을 때 사용할 수 있습니다';
  }
  const s = $('btn-switch');
  if (s) {
    s.disabled = translating || !any;
    s.title = translating ? '번역 중에는 교체할 수 없습니다' : '좌우 화면을 서로 바꿉니다';
  }
}

// force=true면 이미 번역본이 있어도 새로 만든다(⌥+클릭). 기본은 기존 번역본 재사용.
async function translatePdf(force = false) {
  if (translating) { await window.wcompare.cancelTranslate(); return; }
  const [side] = loadedPdfSides();
  if (!side) return;
  const src = pdfPaths[side];

  translating = true;
  translateTarget = side === 'left' ? 'right' : 'left';
  translateDone = 0;
  translateTotal = pdfState?.[side]?.count || 0;
  translateStart = Date.now();
  updatePdfBtns();
  // 분모(전체 페이지 수)는 이미 알고 있으므로 처음부터 "0 / N 페이지"로 보여준다.
  // 1페이지 = agy 1회 호출 = 진행 1틱. 첫 틱은 1쪽 번역이 끝나야 오므로 그동안은 0/N.
  showTranslateProgress();
  clearInterval(translateTimer);
  translateTimer = setInterval(() => { if (translating) showTranslateProgress(); }, 1000); // 경과 시간을 매초 갱신
  try {
    const res = await window.wcompare.translatePdf({ path: src, force });
    await openPdf(translateTarget, res.output);
    // 이미 만들어 둔 번역본은 묻지 않고 그대로 연다. 번역은 페이지마다 LLM을 부르는 작업이라
    // 논문 하나에 수 분이 걸리므로, 되묻는 순간 실수로 같은 일을 다시 시키기 쉽다.
    // 다시 만들고 싶으면 ⌥(Alt)를 누른 채 번역 버튼을 누른다(버튼 툴팁에 안내).
    // 안내는 openPdf 뒤에 쓴다 — openPdf가 setMode('pdf')를 지나며 상태줄을 비우기 때문.
    if (res.existed) setStatus(`기존 번역본을 재사용했습니다: ${res.output.split('/').pop()}`);
    if (res.partial) alert('일부 페이지는 번역에 실패해 원문 그대로 유지되었습니다.');
  } catch (e) {
    alert('번역 실패: ' + (e?.message || e));
  } finally {
    clearInterval(translateTimer);
    dualView?.setBusy(translateTarget, null);
    translating = false;
    translateTarget = null;
    translateStart = 0;
    updatePdfBtns();
  }
}

window.wcompare.onTranslateProgress(({ done }) => {
  if (!translating) return;
  translateDone = done;
  showTranslateProgress();
});

// ===== 실시간 사전 (외부 앱 위임) =====
// 드래그로 텍스트를 선택하면 main이 시스템에 Control+Shift+D를 합성해
// ShortcutDictionary가 그 선택을 사전에서 열게 한다(앱은 사전 데이터를 직접 갖지 않는다).
// 한/영 판별·팝업이 없다 — 선택 텍스트는 외부 앱이 자체적으로 읽는다. 활성 상태는 localStorage("wc-dict").
let dictOn = false;
try { dictOn = localStorage.getItem('wc-dict') === '1'; } catch { /* 스토리지 불가 */ }
let dictSelTimer = 0;             // 선택 디바운스(모드별로 하나만 활성)
let lastSent = '';               // 직전에 보낸 선택 텍스트 — 같은 선택 중복 전송을 막는다
let accessibilityWarned = false; // 접근성 권한 안내는 세션당 1회만(매 선택 반복 금지)
let dictExternalCalls = 0;       // e2e 훅용 — external() 실제 호출 횟수(중복 전송 방지 이후에만 증가)

function updateDictBtn() {
  $('btn-dict').textContent = 'Dict: ' + (dictOn ? 'ON' : 'OFF');
  $('btn-dict').classList.toggle('on', dictOn); // ON일 때 버튼 강조
}
// 선택 해제·모드 전환·Dict OFF 시 — 팝업이 없으므로 중복 전송 기준(lastSent)만 리셋한다.
function resetDict() {
  clearTimeout(dictSelTimer);
  lastSent = '';
}
function setDict(on) {
  dictOn = on;
  try { localStorage.setItem('wc-dict', on ? '1' : '0'); } catch { /* 저장 실패 무시 */ }
  if (!on) resetDict();
  updateDictBtn();
}
function toggleDict() { setDict(!dictOn); }

// 선택이 확정되면 외부 사전 앱을 트리거한다. 같은 선택 반복은 무시한다.
async function sendToExternalDict(text) {
  const t = (text || '').trim();
  if (!dictOn || !t) return;
  if (t === lastSent) return; // 같은 선택으로 중복 전송 방지
  lastSent = t;
  dictExternalCalls++;
  try {
    const res = await window.wcompare.dict.external();
    if (res && res.ok === false && res.code === 'no-accessibility') {
      if (!accessibilityWarned) {
        accessibilityWarned = true;
        setStatus('손쉬운 사용 권한이 필요합니다: 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 wcompare를 허용하세요');
      }
    } else if (res && res.ok === false) {
      console.warn('사전 트리거 실패:', res.message); // 그 외 오류는 조용히 무시(콘솔 경고만)
    }
  } catch (e) {
    console.warn('사전 트리거 실패:', e?.message || e);
  }
}

// diff 모드: 양쪽 inner editor의 선택 변경(300ms 디바운스).
function handleDiffSelection(side) {
  if (!dictOn || mode !== 'diff') return;
  const ed = editorApi.innerOf(side);
  const sel = ed.getSelection();
  if (!sel || sel.isEmpty()) { resetDict(); return; } // 선택 해제 → lastSent 리셋
  sendToExternalDict(editorApi.modelOf(side).getValueInRange(sel));
}
for (const side of ['left', 'right']) {
  editorApi.innerOf(side).onDidChangeCursorSelection(() => {
    if (!dictOn || mode !== 'diff') return;
    clearTimeout(dictSelTimer);
    dictSelTimer = setTimeout(() => handleDiffSelection(side), 300);
  });
}

// PDF 모드: #pdfview mouseup(250ms 디바운스). 선택이 .textLayer 내부이고 비어있지 않을 때만.
function textLayerOf(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el?.closest?.('.textLayer') || null;
}
function handlePdfSelection() {
  if (!dictOn || mode !== 'pdf') return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode) { resetDict(); return; }
  if (!textLayerOf(sel.anchorNode)) return; // PDF 본문(textLayer) 밖 선택은 무시
  const text = sel.toString();
  if (!text.trim()) { resetDict(); return; }
  sendToExternalDict(text);
}
$('pdfview').addEventListener('mouseup', () => {
  if (!dictOn || mode !== 'pdf') return;
  clearTimeout(dictSelTimer);
  dictSelTimer = setTimeout(handlePdfSelection, 250);
});

// ===== open routing =====
async function openByPath(side, p) {
  if (isPdf(p)) return openPdf(side, p);
  if (!(await dirtyGuard(side))) return;
  try {
    const file = await window.wcompare.readFile(p);
    placeFile(side, file);
    setMode('diff');
  } catch (e) {
    alert('파일을 열 수 없습니다: ' + (e?.message || e)); // 최근 파일이 사라진 경우 등
  }
}
async function openByDialog(side) {
  const file = await window.wcompare.openFileDialog();
  if (!file) return;
  if (isPdf(file.path)) return openPdf(side, file.path);
  if (!(await dirtyGuard(side))) return;
  placeFile(side, file);
  setMode('diff');
}

// 열린 파일 닫기 — pdf는 뷰어 문서 해제, diff는 미저장 확인 후 빈 모델로.
async function closeFile(side) {
  if (mode === 'pdf') {
    if (translating) return; // 번역 중 문서 상태 변경 금지 (switch와 동일)
    await dualView?.closeSide(side);
    pdfPaths[side] = null;
    await syncSummaryToDoc(); // 닫힌 문서가 요약의 주인이었으면 남은 문서로 갈아 끼우고, 없으면 비운다
    updatePdfBtns();
    refreshTranslationInfo();
  } else {
    if (!(await dirtyGuard(side))) return;
    editorApi.close(side);
    linters[side].cancel();
    refreshStatus();
    updateTocBtn(); // 닫힌 side가 markdown이면 드로어를 숨기고 버튼 상태를 갱신
  }
}

// ===== toolbar wiring (by id) =====
$('btn-open-left').onclick = () => openByDialog('left');
$('btn-open-right').onclick = () => openByDialog('right');
$('btn-mode').onclick = () => { ensureDualView(); setMode(mode === 'diff' ? 'pdf' : 'diff'); };
$('btn-save').onclick = () => save();
$('btn-prev-diff').onclick = () => editorApi.goToDiff('previous');
$('btn-next-diff').onclick = () => editorApi.goToDiff('next');
$('btn-ws').onclick = () => { ws = !ws; editorApi.updateOptions({ ignoreTrimWhitespace: ws }); };
$('btn-vim').onclick = () => toggleVim(editorApi);
$('btn-zoom-out').onclick = () => dualView?.zoom(-1);
$('btn-zoom-in').onclick = () => dualView?.zoom(1);
$('btn-sync').onclick = () => dualView?.setSync(!dualView.isSync());
$('btn-fit').onclick = () => dualView?.setFit(!dualView.isFit());
$('btn-switch').onclick = () => switchSides();
$('btn-translate').onclick = (e) => translatePdf(e.altKey); // ⌥+클릭 = 기존 번역본 무시하고 다시 번역
$('btn-del-translation').onclick = () => deleteTranslation();
$('btn-back').onclick = () => dualView?.goBack();
$('btn-forward').onclick = () => dualView?.goForward();
$('btn-toc').onclick = () => {
  if (mode === 'pdf') dualView?.setOutline(!dualView.isOutline());
  else toggleMdToc();
};
$('btn-dict').onclick = () => toggleDict();
for (const l of LAYOUTS) $(`btn-layout-${l}`).onclick = () => setLayout(l);

// ===== 커스텀 토글 단축키 =====
// shortcuts는 액션(dict/fit/sync/night/switch)→표현문자열 맵. 시작 시 설정에서 로드하고,
// 설정창에서 바꾸면 즉시 갱신한다(현재 창 한정 — 다른 창은 다음 openSettings/재시작 시 반영).
let shortcuts = { dict: 'Cmd+D', fit: 'Alt+F', sync: 'Alt+S', night: 'Alt+N', switch: 'Alt+ArrowRight' };
let settingsCapture = null; // 설정창에서 키 입력 대기 중인 액션 id(없으면 null)
// 시작 시 한 번 — 저장된 단축키와 테마를 현재 창에 반영한다(비동기라 실패하면 기본값 유지).
async function loadUserSettings() {
  try {
    const s = await window.wcompare.settings.get();
    if (s && s.shortcuts) shortcuts = { ...shortcuts, ...s.shortcuts };
    if (s?.ui?.theme) applyTheme(s.ui.theme);
  } catch { /* 로드 실패 시 기본값 유지 */ }
}
// 액션 실행. PDF 전용(fit/sync/switch)은 dualView 존재·pdf 모드 가드를 지킨다(없으면 무시).
function runShortcutAction(id) {
  switch (id) {
    case 'dict': toggleDict(); break;
    case 'night': toggleNight(); break;
    case 'fit': if (dualView && mode === 'pdf') dualView.setFit(!dualView.isFit()); break;
    case 'sync': if (dualView && mode === 'pdf') dualView.setSync(!dualView.isSync()); break;
    case 'switch': if (dualView && mode === 'pdf') switchSides(); break;
  }
}
// 커스텀 단축키를 기존 keydown(find/zoom/back-forward)보다 "먼저" 매칭한다 → capture 단계에 등록.
// 입력 필드(찾기/이름/설정 input, Monaco 내부 textarea 포함)에 포커스가 있으면 텍스트 입력을 방해하지 않도록 skip.
window.addEventListener('keydown', (e) => {
  if (settingsCapture) return; // 설정창에서 키 캡처 중이면 여기서 발동 금지(캡처 핸들러가 처리)
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
  const str = normalizeEvent(e);
  if (!str) return;
  for (const id of Object.keys(shortcuts)) {
    if (shortcuts[id] && shortcuts[id] === str) {
      e.preventDefault();
      e.stopImmediatePropagation(); // 뒤따르는 기존 keydown 리스너가 같은 키를 또 처리하지 않게
      runShortcutAction(id);
      return;
    }
  }
}, true);

// ===== 설정 다이얼로그 wiring (요소는 항상 존재하므로 한 번만 건다) =====
$('set-archive-pdf').onchange = (e) => window.wcompare.settings.set({ archivePdfOnOpen: e.target.checked });
$('set-keep-translations').onchange = (e) => window.wcompare.settings.set({ keepTranslationsInStorage: e.target.checked });
$('set-storage-change').onclick = async () => {
  const s = await window.wcompare.settings.pickStorageDir(); // main dialog, 취소 시 null
  if (s) $('set-storage-path').value = s.storageDir;
};
$('settings-close').onclick = () => { endShortcutCapture(); $('settings-dialog').close(); };
$('set-pdf-default').onclick = () => setPdfDefault();
// 테마 선택은 고르는 즉시 반영·저장한다(체크박스들과 같은 즉시 적용 관용구).
$('set-theme')?.addEventListener('change', (e) => setTheme(e.target.value));

// ===== 설정창: 토글 단축키 UI =====
// ACTIONS 순서대로 행을 만든다: 라벨 + readonly 표시 input + "변경" 버튼 + 경고 span.
function buildShortcutRows() {
  const host = $('shortcut-rows');
  if (!host || host.childElementCount) return; // 한 번만 만든다
  for (const { id, label } of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'sc-row';
    row.dataset.action = id;
    const lab = document.createElement('span'); lab.className = 'sc-label'; lab.textContent = label;
    const key = document.createElement('input'); key.className = 'sc-key'; key.readOnly = true; key.dataset.role = 'key';
    const btn = document.createElement('button'); btn.textContent = '변경'; btn.dataset.role = 'change';
    const warn = document.createElement('span'); warn.className = 'sc-warn'; warn.dataset.role = 'warn';
    row.append(lab, key, btn, warn);
    host.appendChild(row);
    const start = () => startShortcutCapture(id); // 변경 클릭 또는 input 포커스 시 캡처 시작
    btn.addEventListener('click', start);
    key.addEventListener('focus', start);
  }
}
const shortcutRow = (id) => $('shortcut-rows').querySelector(`.sc-row[data-action="${id}"]`);
function renderShortcutRow(id) {
  const row = shortcutRow(id); if (!row) return;
  const str = shortcuts[id] || '';
  row.querySelector('[data-role=key]').value = str ? fmtShortcut(str) : '(없음)';
  const res = isReserved(str);
  row.querySelector('[data-role=warn]').textContent = res ? `⚠ 이미 '${res}'에 사용 중` : '';
}
function renderAllShortcutRows() { for (const { id } of ACTIONS) renderShortcutRow(id); }
function startShortcutCapture(id) {
  if (settingsCapture) endShortcutCapture(); // 다른 행이 대기 중이면 먼저 취소
  settingsCapture = id;
  const key = shortcutRow(id)?.querySelector('[data-role=key]');
  if (key) { key.classList.add('capturing'); key.value = '키 입력 대기…'; }
}
function endShortcutCapture() {
  const id = settingsCapture;
  settingsCapture = null;
  if (!id) return;
  shortcutRow(id)?.querySelector('[data-role=key]')?.classList.remove('capturing');
  renderShortcutRow(id); // 대기 표시를 원래 값으로 되돌린다
}
function saveShortcuts() { window.wcompare.settings.set({ shortcuts }).catch(() => {}); }
// 캡처 keydown — document capture 단계로 등록. window(capture)의 발동 핸들러는 settingsCapture 중엔 skip하므로
// 이 핸들러가 키를 잡는다. modifier 최소 1개 필요, Escape는 취소.
document.addEventListener('keydown', (e) => {
  if (!settingsCapture) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.key === 'Escape') { endShortcutCapture(); return; }
  const str = normalizeEvent(e);
  if (!str || !hasModifier(str)) return; // modifier 없는 단일 키/단독 modifier는 무시하고 계속 대기
  const id = settingsCapture;
  shortcuts[id] = str;
  settingsCapture = null;
  shortcutRow(id)?.querySelector('[data-role=key]')?.classList.remove('capturing');
  renderShortcutRow(id);
  saveShortcuts(); // 즉시 저장 + 현재 창 반영(shortcuts 변수는 이미 갱신됨)
}, true);
buildShortcutRows();

// ===== 설정창: 번역 엔진·모델 =====
// translateModelLists는 datalist를 채우는 현재 목록(agyModels/claudeModels)의 로컬 사본 —
// "목록 새로고침"·모델 저장이 성공할 때마다 서버(settings)가 돌려준 값으로 갱신한다.
let translateModelLists = { agyModels: [], claudeModels: [] };
function fillDatalist(id, models) {
  const dl = $(id);
  if (!dl) return;
  dl.innerHTML = '';
  for (const m of models || []) {
    const opt = document.createElement('option');
    opt.value = m;
    dl.appendChild(opt);
  }
}
function applyTranslateSettings(t) {
  if (!t) return;
  translateModelLists = { agyModels: t.agyModels || [], claudeModels: t.claudeModels || [] };
  $('set-translate-engine').value = t.engine || 'agy';
  $('set-agy-model').value = t.agyModel || '';
  $('set-claude-model').value = t.claudeModel || '';
  fillDatalist('agy-model-list', translateModelLists.agyModels);
  fillDatalist('claude-model-list', translateModelLists.claudeModels);
}
// 입력한 모델이 목록에 없으면 그 목록에 추가해 사용자 정의 모델을 유지한다(통째 교체 배열).
function withCustomModel(list, value) {
  if (!value || (list || []).includes(value)) return list || [];
  return [...(list || []), value];
}
function saveTranslateEngine() {
  window.wcompare.settings.set({ translate: { engine: $('set-translate-engine').value } })
    .then((s) => applyTranslateSettings(s?.translate)).catch(() => {});
}
function saveAgyModel() {
  const v = $('set-agy-model').value.trim();
  const agyModels = withCustomModel(translateModelLists.agyModels, v);
  window.wcompare.settings.set({ translate: { agyModel: v, agyModels } })
    .then((s) => applyTranslateSettings(s?.translate)).catch(() => {});
}
function saveClaudeModel() {
  const v = $('set-claude-model').value.trim();
  const claudeModels = withCustomModel(translateModelLists.claudeModels, v);
  window.wcompare.settings.set({ translate: { claudeModel: v, claudeModels } })
    .then((s) => applyTranslateSettings(s?.translate)).catch(() => {});
}
$('set-translate-engine').onchange = saveTranslateEngine;
$('set-agy-model').onchange = saveAgyModel;
$('set-claude-model').onchange = saveClaudeModel;
$('set-agy-refresh').onclick = async () => {
  const status = $('set-agy-refresh-status');
  const btn = $('set-agy-refresh');
  btn.disabled = true;
  status.textContent = '새로고침 중…';
  try {
    const res = await window.wcompare.models.refresh();
    if (res?.ok) {
      translateModelLists.agyModels = res.models || [];
      fillDatalist('agy-model-list', translateModelLists.agyModels);
      status.textContent = `${(res.models || []).length}개 모델 로드됨`;
    } else {
      status.textContent = '새로고침 실패: ' + (res?.error || '알 수 없는 오류');
    }
  } catch (e) {
    status.textContent = '새로고침 실패: ' + (e?.message || e);
  } finally {
    btn.disabled = false;
  }
};

// ===== PDF 야간 모드 =====
// 페이지 canvas만 CSS 필터로 반전한다(index.html). 화면 테마(설정창 ui.theme)와는 독립 —
// 묶으면 diff/pdf 상태가 서로 꼬인다.
let night = false;
try { night = localStorage.getItem('wc-night') === '1'; } catch { /* 스토리지 불가 환경 */ }
function applyNight() {
  $('pdfview').classList.toggle('night', night);
  $('btn-night').textContent = 'Night: ' + (night ? 'ON' : 'OFF');
  $('btn-night').classList.toggle('on', night); // ON일 때 버튼 강조
}
function toggleNight() {
  night = !night;
  try { localStorage.setItem('wc-night', night ? '1' : '0'); } catch { /* 저장 실패는 무시 */ }
  applyNight();
}
$('btn-night').onclick = toggleNight;
applyNight();

// ===== 전체 텍스트 복사 =====
// DOM 선택과 무관하게 getTextContent로 뽑으므로 role:'copy' 경유가 필요 없다(main이 클립보드 기록).
async function copyAllText(side) {
  try {
    const text = await dualView.getFullText(side);
    await window.wcompare.copyText(text);
    setStatus(`전체 텍스트 복사됨 (${text.length.toLocaleString()}자)`);
  } catch (e) {
    alert('텍스트 추출 실패: ' + (e?.message || e));
  }
}

// ===== 우클릭: 복사 / 형광펜 / 밑줄 / 마커 삭제 =====
// 선택 영역은 contextInfo()가 "지금 이 순간" 동기적으로 캡처한다.
// 메뉴를 띄우고 응답을 기다리는 사이에 선택이 사라져도 안전하도록.
let lastHighlightColor = null; // 팔레트에서 마지막으로 고른 색 — ⌘⇧H 단축키가 따라간다
$('pdfview').addEventListener('contextmenu', async (e) => {
  if (mode !== 'pdf' || !dualView) return;
  const side = e.target.closest?.('.pdf-pane')?.dataset.side;
  if (!side) return;
  e.preventDefault();
  const info = dualView.contextInfo(side, e.clientX, e.clientY);
  const action = await window.wcompare.pdfContextMenu({ ...info, hasMarker: !!info.markerId });
  if (!action) return;
  if (action.startsWith('highlight')) {
    // 'highlight' 또는 'highlight:<색상>' — 메인이 팔레트에서 고른 색을 붙여 보낸다
    const color = action.slice('highlight:'.length) || null;
    if (color) lastHighlightColor = color;
    dualView.addMarker('highlight', color);
  } else if (action === 'underline') dualView.addMarker('underline');
  else if (action === 'remove') dualView.removeMarker(side, info.markerId);
  else if (action === 'mirror-jump') dualView.jumpMirror(side, e.clientX, e.clientY);
  else if (action === 'copy-all') copyAllText(side);
});

// pane 우상단 ✕ → 그 문서 닫기. altKey와 무관하므로 미러 점프 리스너와 독립으로 둔다.
$('pdfview').addEventListener('click', (e) => {
  const b = e.target.closest?.('.pdf-close');
  if (!b) return;
  e.stopPropagation();
  const side = b.closest('.pdf-pane')?.dataset.side;
  if (side) closeFile(side);
});

// Alt+클릭 → 반대편 같은 위치로 미러 점프 (원문↔번역 대조 읽기의 기본 동선)
$('pdfview').addEventListener('click', (e) => {
  if (mode !== 'pdf' || !dualView || !e.altKey) return;
  const side = e.target.closest?.('.pdf-pane')?.dataset.side;
  if (!side) return;
  e.preventDefault();
  dualView.jumpMirror(side, e.clientX, e.clientY);
});

// ===== 문자열 검색 =====
const findInput = $('pdf-find');
let findTimer = 0;
const runFind = (prev = false) => dualView?.find(findInput.value.trim(), { prev });

findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runFind(), 200); // 타이핑 중 재검색 폭주 방지
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); runFind(e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); findInput.value = ''; dualView?.find(''); findInput.blur(); }
});
$('btn-find-next').onclick = () => runFind(false);
$('btn-find-prev').onclick = () => runFind(true);
$('pdf-page').onchange = (e) => dualView?.gotoPage(parseInt(e.target.value, 10) || 1);

// PDF 모드 단축키: Cmd/Ctrl + '+'/'-' 줌(브라우저 기본 페이지 줌 차단),
// Cmd/Ctrl + F 검색, Cmd/Ctrl + ←/→ 링크 뒤로·앞으로.
window.addEventListener('keydown', (e) => {
  if (mode !== 'pdf' || !dualView) return;
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') { e.preventDefault(); dualView.zoom(1); }
  else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') { e.preventDefault(); dualView.zoom(-1); }
  else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); findInput.focus(); findInput.select(); }
  // 마커 단축키 — 렌더러 keydown이라 네이티브 메뉴를 거치지 않는다(우클릭 메뉴와 같은 경로).
  else if (e.shiftKey && (e.key === 'H' || e.key === 'h')) { e.preventDefault(); dualView.markSelection('highlight', lastHighlightColor); }
  else if (e.shiftKey && (e.key === 'U' || e.key === 'u')) { e.preventDefault(); dualView.markSelection('underline'); }
  // 검색창 안에서는 Cmd+←/→가 커서 이동이므로 가로채지 않는다.
  else if (e.target !== findInput && e.key === 'ArrowLeft') { e.preventDefault(); dualView.goBack(); }
  else if (e.target !== findInput && e.key === 'ArrowRight') { e.preventDefault(); dualView.goForward(); }
});

// 마우스 옵션 버튼(뒤로 3 / 앞으로 4). Chromium은 mousedown의 button 값으로 전달한다.
window.addEventListener('mousedown', (e) => {
  if (mode !== 'pdf' || !dualView) return;
  if (e.button === 3) { e.preventDefault(); dualView.goBack(); }
  else if (e.button === 4) { e.preventDefault(); dualView.goForward(); }
});

// 복사 화살표 (diff)
editorApi.innerOf('left').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, () => editorApi.copyCurrentBlock('left', 'right'));
editorApi.innerOf('right').addCommand(monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, () => editorApi.copyCurrentBlock('right', 'left'));

setupVim(editorApi);
setupDnd($('editor'), (side, p) => openByPath(side, p));
setupDnd($('pdfview'), (side, p) => openByPath(side, p));

// ===== 프로젝트 =====
// 저장할 것: 좌/우 파일, 모드, 뷰 상태(sync/fit/page), PDF 마커.
function projectSnapshot() {
  const filePath = (side) => (mode === 'pdf' ? pdfPaths[side] : editorApi.getState(side).path) || null;
  return {
    mode,
    files: { left: filePath('left'), right: filePath('right') },
    view: {
      sync: dualView ? dualView.isSync() : true,
      fit: dualView ? dualView.isFit() : true,
      page: { left: pdfState?.left.page || 1, right: pdfState?.right.page || 1 },
    },
    markers: dualView ? dualView.getMarkers() : { left: [], right: [] },
  };
}
async function saveProject(as = false) {
  try {
    const snap = projectSnapshot();
    if (!snap.files.left && !snap.files.right) { alert('저장할 파일이 없습니다.'); return; }
    let res = as ? await window.wcompare.project.saveAs(snap) : await window.wcompare.project.save(snap);
    // 이름이 필요하면 모달로 받아 다시 저장. 정화 후 빈 이름 등으로 다시 needName이 오면 한 번 더 묻는다.
    while (res?.needName) {
      const name = await promptProjectName(res.suggest); // 취소 시 null
      if (!name) return;
      res = await window.wcompare.project.save(snap, name);
    }
    if (res?.canceled) return; // 덮어쓰기 취소 — 조용히 중단(기존 상태 유지)
    if (res?.path) setStatus(`프로젝트 저장됨: ${res.display || res.path}`);
  } catch (e) {
    alert('프로젝트 저장 실패: ' + (e?.message || e));
  }
}

// 프로젝트 이름 입력 모달. 확장자 없는 이름 전체가 선택된 상태로 뜬다(요구사항: input.select()).
// 저장 대상 경로는 main이 storageDir/projects 하위로 유도하므로, 렌더러는 "이름 문자열"만 넘긴다.
function promptProjectName(suggest) {
  return new Promise((resolve) => {
    const dlg = $('project-name-dialog');
    const input = $('project-name-input');
    input.value = suggest || '';
    // 이름 모달의 두 버튼은 순서상 첫 submit이 '취소'라, Enter 기본 제출이 취소가 된다 →
    // Enter는 저장으로 명시 처리한다(Esc는 dialog가 빈 returnValue로 닫아 취소가 된다).
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); dlg.close('ok'); } };
    const onClose = () => {
      input.removeEventListener('keydown', onKey);
      dlg.removeEventListener('close', onClose);
      const name = dlg.returnValue === 'ok' ? input.value.trim() : '';
      resolve(name || null);
    };
    input.addEventListener('keydown', onKey);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

// 설정 모달 — 현재 값으로 채우고 띄운다. 체크박스는 change 시 즉시 반영(아래 wiring 참조).
async function openSettings() {
  const s = await window.wcompare.settings.get();
  $('set-storage-path').value = s.storageDir;
  $('set-archive-pdf').checked = !!s.archivePdfOnOpen;
  $('set-keep-translations').checked = !!s.keepTranslationsInStorage;
  if (s.shortcuts) shortcuts = { ...shortcuts, ...s.shortcuts }; // 저장된 값으로 현재 창 갱신
  if (s.ui?.theme) applyTheme(s.ui.theme); // select 선택 상태까지 함께 맞춘다
  renderAllShortcutRows();
  applyTranslateSettings(s.translate);
  $('set-agy-refresh-status').textContent = '';
  refreshPdfDefault(); // 비동기 — duti 실행을 기다리느라 설정창이 늦게 뜨지 않게
  $('settings-dialog').showModal();
}

// ===== PDF 기본 앱 =====
// macOS는 파일 형식의 기본 앱을 바꾸는 API를 앱에 열어 주지 않는다. 외부 도구 duti가 있으면
// 한 번에 바꾸고, 없으면 Finder로 직접 하는 방법을 안내한다. 어느 쪽이든 Info.plist 선언 덕에
// "다음으로 열기" 목록에는 이미 wcompare가 올라와 있다.
const FINDER_STEPS = 'PDF 파일 하나를 Finder에서 선택 → ⌘I(정보 가져오기) → '
  + '"다음으로 열기"에서 wcompare 선택 → "모두 변경…" 버튼.';

async function refreshPdfDefault() {
  const status = $('set-pdf-default-status');
  const hint = $('set-pdf-default-hint');
  const btn = $('set-pdf-default');
  if (!status) return;
  status.textContent = '확인 중…';
  hint.textContent = '';
  let info;
  try {
    info = await window.wcompare.pdfDefault.get();
  } catch (e) {
    status.textContent = '확인 실패';
    hint.textContent = ipcMessage(e);
    return;
  }
  if (!info.duti) {
    // 확인조차 못 하는 상태다. "다른 앱이 기본"이라고 단정하지 않는다 — 모르는 것은 모른다고 쓴다.
    status.textContent = '현재 설정을 확인할 수 없습니다';
    btn.disabled = false;
    hint.textContent = `직접 지정: ${FINDER_STEPS}\n(brew install duti 를 설치하면 이 버튼으로 한 번에 바꿀 수 있습니다.)`;
    return;
  }
  status.textContent = info.isOurs ? '현재 기본 앱: wcompare' : `현재 기본 앱: ${info.handler || '알 수 없음'}`;
  btn.disabled = !!info.isOurs;
  hint.textContent = info.isOurs ? '' : `버튼을 누르거나, 직접 지정: ${FINDER_STEPS}`;
}

async function setPdfDefault() {
  const hint = $('set-pdf-default-hint');
  const btn = $('set-pdf-default');
  btn.disabled = true;
  try {
    const res = await window.wcompare.pdfDefault.set();
    if (res.ok) { await refreshPdfDefault(); return; }
    if (res.reason === 'no-duti') hint.textContent = `duti가 없어 자동 지정을 못 했습니다. ${FINDER_STEPS}`;
    else hint.textContent = `지정 실패(${res.reason}): ${res.message || ''}\n${FINDER_STEPS}`;
  } catch (e) {
    hint.textContent = '지정 실패: ' + ipcMessage(e);
  }
  btn.disabled = false;
}

window.wcompare.onProjectLoad(async (p) => {
  // 미저장 변경은 한 번만 묻는다 (좌/우 각각 물어 반쪽 상태가 되지 않도록)
  if (editorApi.getState('left').dirty || editorApi.getState('right').dirty) {
    if (!confirm('미저장 변경이 있습니다. 버리고 프로젝트를 열까요?')) return;
    editorApi.setDirty('left', false);
    editorApi.setDirty('right', false);
  }
  for (const side of ['left', 'right']) {
    if (p.files[side]) await openByPath(side, p.files[side]);
  }
  if (p.mode === 'pdf' && dualView) {
    dualView.setSync(p.view.sync);
    dualView.setFit(p.view.fit);
    for (const side of ['left', 'right']) dualView.setMarkers(side, p.markers?.[side] || []);
    const page = p.view.page?.left || 1;
    if (page > 1) dualView.gotoPage(page);
  }
  if (p.missing?.length) {
    alert('파일을 찾을 수 없습니다:\n' + p.missing.map((m) => `${m.side}: ${m.path}`).join('\n'));
  }
});

const MENU = {
  'menu:open-left': () => openByDialog('left'),
  'menu:open-right': () => openByDialog('right'),
  'menu:close-left': () => closeFile('left'),
  'menu:close-right': () => closeFile('right'),
  'menu:save': () => save(),
  'menu:project-save': () => saveProject(false),
  'menu:project-save-as': () => saveProject(true),
  'menu:next-diff': () => editorApi.goToDiff('next'),
  'menu:prev-diff': () => editorApi.goToDiff('previous'),
  'menu:toggle-ws': () => { ws = !ws; editorApi.updateOptions({ ignoreTrimWhitespace: ws }); },
  'menu:toggle-vim': () => toggleVim(editorApi),
  'menu:toggle-theme': () => setTheme(theme === 'dark' ? 'light' : 'dark'),
  'menu:toggle-night': () => toggleNight(),
  'menu:toggle-dict': () => toggleDict(),
  'menu:settings': () => openSettings(),
};
window.wcompare.onMenu((ch) => { MENU[ch]?.(); });

// 최근 파일(메뉴): main이 allowlist에 등록한 경로를 보낸다. 빈 pane을 골라 연다.
window.wcompare.onOpenRecentFile((p) => {
  const empty = isPdf(p)
    ? (!pdfPaths.left ? 'left' : (!pdfPaths.right ? 'right' : 'left'))
    : (!editorApi.getState('left').path ? 'left' : (!editorApi.getState('right').path ? 'right' : 'left'));
  openByPath(empty, p);
});

// Finder에서 연 파일 (PDF 기본 앱). 비어 있는 pane부터 채운다 — 이 앱은 대조가 본업이라
// 두 번째 문서가 옆 칸에 붙는 편이 자연스럽다. 양쪽이 다 찼으면 새 창을 청한다:
// 보고 있던 문서를 말없이 밀어내지 않기 위해서다.
const emptySideFor = (p) => (isPdf(p)
  ? (!pdfPaths.left ? 'left' : (!pdfPaths.right ? 'right' : null))
  : (!editorApi.getState('left').path ? 'left' : (!editorApi.getState('right').path ? 'right' : null)));

window.wcompare.onOpenFiles(async (paths) => {
  const overflow = [];
  for (const p of paths || []) {
    const side = emptySideFor(p);
    if (side) await openByPath(side, p);
    else overflow.push(p);
  }
  if (overflow.length) {
    await window.wcompare.openInNewWindow(overflow)
      .catch((e) => alert('새 창을 열 수 없습니다: ' + ipcMessage(e)));
  }
});

window.wcompare.onOpenPair(async ({ left, right }) => {
  if (left) await openByPath('left', left);
  if (right) await openByPath('right', right);
});

updateDictBtn();
// 기본은 PDF 모드다. 이 앱의 주 용도가 논문 대조·요약이라, 빈 왼쪽 pane의 URL 입력창이
// 시작 화면인 편이 자연스럽다. dualView를 미리 만들어야 그 입력창이 실제로 존재한다.
// 텍스트 파일을 열면 openByPath/openByDialog가 알아서 diff로 되돌린다.
ensureDualView();
setMode('pdf');
refreshStatus();
loadUserSettings(); // 저장된 단축키·테마를 로드(비동기 — 실패 시 기본값 유지)

// e2e 테스트 훅 — 렌더러 내부 상태를 읽기 전용으로 노출한다(외부 네트워크·경로 생성과 무관).
window.__wc = { editorApi, getMode: () => mode, isMdTocOpen: () => mdTocOpen, isDictOn: () => dictOn, dictCalls: () => dictExternalCalls, getShortcuts: () => ({ ...shortcuts }), isNight: () => night, getLayout: () => layout, summaryTab: () => summaryPanel?.getTab() ?? null };
