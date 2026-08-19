// src/main/ipc.js
const { app, ipcMain, dialog, BrowserWindow, Menu, clipboard, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { readFile, writeFile, readBytes } = require('./fileService.js');
const { lint } = require('./lint/lintService.js');
const {
  translate, outputPathFor, translationCandidates, resolveAgyBin, envWithPath, parseModelList,
} = require('./transpaper.js');
const { allowed, openedPdfs, normalize, allowPath } = require('./allowlist.js');
const { downloadPdf } = require('./pdfDownload.js');
const { summarize, KINDS: SUMMARY_KINDS, PROMPT_DEFAULTS, MAX_PROMPT_PART_CHARS } = require('./paperSummary.js');
const summaryStore = require('./summaryStore.js');
const memoFiles = require('./memoFiles.js');
const { translateMemo } = require('./memoTranslate.js');
const {
  buildExportMarkdown, defaultExportFileName, sanitizeExportFileName, MAX_EXPORT_CHARS,
} = require('./summaryExport.js');
const { triggerShortcutDict } = require('./shortcutDict.js');
const markerStore = require('./markerStore.js');
const project = require('./project.js');
const recentFiles = require('./recentFiles.js');
const openFiles = require('./openFiles.js');
const settings = require('./settings.js');
const { createTranslationJobs } = require('./translationJobs.js');
const { getPdfHandler, setPdfHandler } = require('./defaultApp.js');

// 형광펜 팔레트. 렌더러 pdfMarkers의 기본 노랑과 같은 투명도(0.45) 계열.
const HIGHLIGHT_COLORS = [
  { label: '노랑', color: 'rgba(255, 214, 74, 0.45)' },
  { label: '초록', color: 'rgba(122, 224, 122, 0.45)' },
  { label: '파랑', color: 'rgba(96, 180, 255, 0.45)' },
  { label: '분홍', color: 'rgba(255, 128, 192, 0.45)' },
];

// 창(webContents.id)별 번역 job — 여러 창에서 동시에 서로 다른 PDF를 번역할 수 있다.
const jobs = createTranslationJobs();
// 요약 job도 같은 레지스트리를 쓴다. 창을 닫거나 앱을 끝낼 때 자식 프로세스(agy/claude)를
// 남기지 않으려면 번역과 똑같이 창별로 추적해야 하기 때문 — 아래 cancel* 함수에서 함께 정리한다.
const summaryJobs = createTranslationJobs();
const memoJobs = createTranslationJobs(); // 메모 번역 — 창당 1개, 취소 가능

function readWithPath(p) {
  const meta = readFile(p);
  return { path: p, ext: path.basename(p), ...meta };
}

// ===== 번역본(.ko.pdf) 삭제 =====
// 지울 파일 이름은 렌더러가 절대 지목하지 못한다. 렌더러는 "이 원본의 번역본"이라고만 말하고,
// 실제 경로는 여기서 원본 경로로부터 다시 유도한다 — pdf:translate가 출력 경로를 정하는 규칙과
// 똑같은 규칙을 쓴다. 삭제는 이 앱에서 유일하게 파일을 없애는 동작이라, 경로를 만드는 주체가
// main 하나뿐이라는 allowlist 원칙이 여기서 가장 중요하다.
//
// 후보 자리를 세는 규칙은 transpaper.js의 순수 함수(translationCandidates)에 있다 — 단위 테스트 대상.
// 여기서는 그 후보 중 실재하는 것만 남긴다. 순서가 중요하다 — 반드시 lstat으로 먼저 걸러낸 뒤에 normalize한다.
// normalize는 realpath라, 심볼릭 링크를 먼저 통과시키면 링크가 가리키는 "다른 파일"이 삭제 대상이
// 되어 버린다. lstat().isFile()은 심링크에 false라 그 통로가 막힌다. 디렉터리·소켓도 같이 걸러진다.
// 살아남은 경로는 normalize해서 돌려준다: 렌더러의 pdfPaths도 같은 정규화를 거친 값이라,
// 그래야 "지운 파일이 지금 화면에 열려 있는가"를 문자열로 비교할 수 있다(macOS의 /var ↔ /private/var).
function existingTranslations(srcPath) {
  return translationCandidates(srcPath, settings.dirFor('translations'))
    .filter((c) => { try { return fs.lstatSync(c).isFile(); } catch { return false; } })
    .map((c) => normalize(c));
}

// 실제 삭제. 휴지통으로 옮긴다 — 수 분짜리 AI 작업의 결과물이라 오조작의 대가가 크고,
// 되돌릴 길을 남겨 두는 편이 옳다. 실패하면 그대로 throw한다: "휴지통으로 옮긴다"고 물어 놓고
// 되돌릴 수 없게 지우는 대체 경로는 두지 않는다.
// WCOMPARE_TEST_TRASH='rm'은 e2e 전용 심이다 — 테스트를 돌릴 때마다 사용자의 휴지통에
// 테스트 파일이 쌓이면 안 되기 때문(테스트가 사용자 환경을 어지럽히지 않는다는 규율).
async function removeTranslationFile(target) {
  if (process.env.WCOMPARE_TEST_TRASH === 'rm') { fs.rmSync(target, { force: true }); return; }
  await shell.trashItem(target);
}

// 삭제 재확인. project.js의 덮어쓰기 확인과 같은 테스트 심(WCOMPARE_TEST_CONFIRM)을 쓴다 —
// e2e에서 모달이 이벤트 루프를 막지 않게. 기본 버튼은 '취소'다: 파괴적 동작을 Enter 한 번에
// 흘려보내지 않기 위해서.
async function confirmDeleteTranslation(win, targets) {
  const forced = process.env.WCOMPARE_TEST_CONFIRM;
  if (forced === 'delete') return true;
  if (forced === 'cancel') return false;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: '한국어 번역본을 삭제할까요?',
    detail: `${targets.map((t) => path.basename(t)).join('\n')}\n\n`
      + '휴지통으로 옮깁니다. 다시 만들려면 페이지마다 AI를 불러야 해서 수 분이 걸립니다.',
    buttons: ['휴지통으로 이동', '취소'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

// file이 dir 하위(또는 같음)인지. path.relative가 ..로 시작하지 않으면 하위.
function isInside(dir, file) {
  const rel = path.relative(dir, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 설정이 켜져 있으면 연 PDF를 보관 폴더(documents)에 사본으로 남긴다 —
// 원본이 외장 드라이브 등에서 사라져도 기록이 남게. 실패해도 열기는 계속한다(콘솔 경고만).
function archivePdfIfEnabled(p) {
  try {
    const s = settings.get();
    if (!s.archivePdfOnOpen || !/\.pdf$/i.test(p)) return;
    const docs = settings.dirFor('documents'); // storageDir/documents 보장
    if (isInside(normalize(s.storageDir), p)) return; // 이미 보관 폴더 안에서 연 파일
    const base = path.basename(p).replace(/\.pdf$/i, '');
    const srcSize = fs.statSync(p).size;
    // 같은 이름이 있고 크기가 같으면 이미 보관된 것으로 보고 skip. 다르면 base-2.pdf, base-3.pdf … 로.
    for (let n = 1; n < 1000; n++) {
      const dst = path.join(docs, n === 1 ? `${base}.pdf` : `${base}-${n}.pdf`);
      if (!fs.existsSync(dst)) { fs.copyFileSync(p, dst); return; }
      if (fs.statSync(dst).size === srcSize) return; // 이미 동일 사본이 있다
    }
  } catch (e) {
    console.warn('PDF 보관 실패(무시):', e?.message || e);
  }
}

function registerIpc() {
  ipcMain.handle('dialog:openFile', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const p = allowPath(res.filePaths[0]);
    recentFiles.record(p);
    return readWithPath(p);
  });

  // ===== 프로젝트 =====
  // 경로 문자열은 렌더러에서 받지 않는다: 열기는 main이 dialog를 띄우고, 최근 항목은 id로 연다.
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('project:open', (e) => project.open(winOf(e)));
  ipcMain.handle('project:open-recent', (e, id) => project.openRecent(winOf(e), id));
  // name은 문자열만 통과시킨다(렌더러 이름 모달 결과). 나머지 경로 결정은 main이 한다.
  ipcMain.handle('project:save', (e, snapshot, name) =>
    project.save(winOf(e), snapshot, { name: typeof name === 'string' ? name : undefined }));
  ipcMain.handle('project:save-as', (e, snapshot, name) =>
    project.save(winOf(e), snapshot, { saveAs: true, name: typeof name === 'string' ? name : undefined }));
  ipcMain.handle('project:recents', () => project.list().map(({ id, name }) => ({ id, name })));

  ipcMain.handle('file:read', (_e, rawPath) => {
    const p = allowPath(rawPath); // 사용자가 명시 선택(dialog/CLI/DnD/프로젝트)한 경로만 렌더러가 보냄
    recentFiles.record(p); // pane에 파일을 올리는 모든 경로가 여기를 지난다
    return readWithPath(p);
  });

  ipcMain.handle('file:write', (_e, { path: rawPath, content, eol, encoding, bom }) => {
    const p = normalize(rawPath);
    if (!allowed.has(p)) throw new Error('write denied: path not in session whitelist');
    writeFile(p, content, { eol, encoding, bom });
    return { ok: true, mtimeMs: fs.statSync(p).mtimeMs };
  });

  ipcMain.handle('file:readBytes', (_e, rawPath) => {
    const p = allowPath(rawPath);
    recentFiles.record(p);
    const { bytes, byteSize } = readBytes(p);
    // 설정: PDF를 열 때 보관 폴더에 사본 저장 (원본이 외장 드라이브 등에서 사라져도 기록이 남게)
    archivePdfIfEnabled(p);
    return { path: p, ext: path.basename(p), bytes, byteSize };
  });

  // ===== 설정 =====
  ipcMain.handle('settings:get', () => settings.get());
  // 렌더러가 바꿀 수 있는 키는 아래 화이트리스트뿐이다 (storageDir는 빠져 있다 — 보관 폴더는
  // dialog를 거쳐야만 바뀐다. 렌더러가 임의 경로를 설정에 앉히면 그 경로가 곧 쓰기 대상이 된다).
  ipcMain.handle('settings:set', (_e, patch = {}) => {
    const next = {};
    if (typeof patch.archivePdfOnOpen === 'boolean') next.archivePdfOnOpen = patch.archivePdfOnOpen;
    if (typeof patch.keepTranslationsInStorage === 'boolean') next.keepTranslationsInStorage = patch.keepTranslationsInStorage;
    // shortcuts/translate/ui는 object면 그대로 넘기고 settingsStore가 하위 키·타입을 재검증한다.
    if (patch.shortcuts && typeof patch.shortcuts === 'object') next.shortcuts = patch.shortcuts;
    if (patch.ui && typeof patch.ui === 'object' && !Array.isArray(patch.ui)) next.ui = patch.ui;
    if (patch.translate && typeof patch.translate === 'object' && !Array.isArray(patch.translate)) {
      next.translate = patch.translate;
    }
    // 요약 프롬프트 override도 같은 관용구로 통과시킨다. 이 화이트리스트에 키를 더하는 것을
    // 잊으면 settingsStore는 멀쩡한데 렌더러의 저장만 조용히 사라진다 — 오류도 안 난다.
    if (patch.summaryPrompts && typeof patch.summaryPrompts === 'object' && !Array.isArray(patch.summaryPrompts)) {
      // 저장 시점에도 칸당 상한을 건다. 프롬프트로 쓰일 때는 sanitizePromptPart가 어차피 여기서
      // 자르므로, 더 긴 값을 디스크에 남겨 봐야 두 가지만 남는다: "칸에는 보이는데 프롬프트에는
      // 안 나가는" 글자, 그리고 settings.json 비대 — 설정 파일은 dirFor()가 마커·요약·번역을
      // 저장할 때마다 동기로 읽으므로 여기가 커지면 앱 전체가 느려진다. UI의 maxlength가 1차
      // 방어지만 렌더러 방어는 신뢰하지 않는 것이 이 파일의 원칙이다. 문자열 아닌 값은
      // settingsStore가 걸러 주니 여기서는 길이만 본다.
      next.summaryPrompts = {};
      for (const [k, v] of Object.entries(patch.summaryPrompts)) {
        next.summaryPrompts[k] = typeof v === 'string' ? v.slice(0, MAX_PROMPT_PART_CHARS) : v;
      }
    }
    return settings.set(next);
  });
  ipcMain.handle('settings:pick-storage-dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    return settings.set({ storageDir: res.filePaths[0] }); // 절대경로만 통과(settingsStore가 검증)
  });

  // agy 모델 목록 새로고침: "agy models"를 실행해 줄 단위 모델명을 뽑아 설정에 저장한다.
  // 렌더러는 인자를 넘기지 않는다 — 실행 파일 탐색·경로 결정은 전부 main이 한다(allowlist 원칙).
  ipcMain.handle('models:refresh', () => new Promise((resolve) => {
    const bin = resolveAgyBin();
    if (!bin) return resolve({ ok: false, error: 'agy 실행 파일을 찾을 수 없습니다 (~/.local/bin 등 확인)' });

    const child = spawn(bin, ['models'], { env: envWithPath(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errTail = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 이미 종료됨 */ }
      finish({ ok: false, error: 'agy models 실행이 시간 초과되었습니다(15초)' });
    }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errTail += d; });
    child.on('error', (e) => finish({ ok: false, error: `agy 실행 실패: ${e.message}` }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: `agy models 오류 (exit ${code})\n${errTail.slice(-400)}` });
      const models = parseModelList(out);
      settings.set({ translate: { agyModels: models } });
      finish({ ok: true, models });
    });
  }));

  // 전체 텍스트 복사 등 "DOM 선택이 아닌" 텍스트의 클립보드 기록.
  // (선택 복사는 반드시 role:'copy' — 아래 컨텍스트 메뉴 주석 참고.)
  ipcMain.handle('clipboard:writeText', (_e, text) => {
    const t = String(text ?? '');
    if (t.length > 20 * 1024 * 1024) throw new Error('텍스트가 너무 커서 복사할 수 없습니다');
    clipboard.writeText(t);
    return { ok: true, length: t.length };
  });

  // ===== 실시간 사전 (외부 앱 위임) =====
  // 인자를 받지 않는다: 선택 텍스트는 ShortcutDictionary가 자체적으로 읽으므로
  // 렌더러가 경로/명령/텍스트를 조립할 필요가 없다(allowlist 원칙 유지).
  // main은 Control+Shift+D 키 이벤트만 시스템에 합성한다.
  // 테스트(WCOMPARE_DICT_FAKE): 실제 osascript(시스템 키 이벤트) 대신 성공을 흉내 낸다
  // — transpaper의 env 주입 시맨틱과 동일한 테스트 심(seam).
  const fakeDictRun = process.env.WCOMPARE_DICT_FAKE ? () => Promise.resolve({}) : null;
  ipcMain.handle('dict:external', async () =>
    triggerShortcutDict(fakeDictRun ? { run: fakeDictRun } : undefined));

  ipcMain.handle('lint:run', (_e, payload) => lint(payload));

  // PDF 기본 앱 — 조회와 지정. 번들 ID는 렌더러가 아니라 app에서 가져온다(렌더러가 임의 앱을
  // 기본으로 앉히지 못하게). 지정에 실패해도 사유를 그대로 돌려주어 안내가 갈리도록 한다.
  ipcMain.handle('system:pdf-default', (_e, { set } = {}) => {
    const self = app.getBundleId?.() || 'com.wooix.wcompare';
    if (!set) {
      const { duti, handler } = getPdfHandler();
      return { duti, handler, self, isOurs: handler === self };
    }
    const res = setPdfHandler(self);
    return { ...res, self, isOurs: res.handler === self };
  });

  // ===== PDF 마커 자동 영속화 =====
  // 경로는 렌더러가 보낸 값을 normalize(realpath) 후 "이 세션에서 연 PDF"(openedPdfs)에 있을 때만 다룬다.
  // 이 앱의 보안 원칙(allowlist) 그대로 — 임의 경로에 쓰거나 임의 경로를 읽지 못하게 한다.
  //  - save: 미허용 경로면 throw로 명확히 거부(테스트 가능). markers는 markerStore가 sanitize 후 기록.
  //  - load: 미허용 경로면 조용히 [] 반환(복원은 열기 직후 자동 실행이라 예외로 흐름을 깨지 않는다).
  ipcMain.handle('markers:save', (_e, rawPath, markers) => {
    const p = normalize(rawPath);
    if (!openedPdfs.has(p)) throw new Error('markers save denied: 이 세션에서 연 PDF가 아닙니다');
    return markerStore.save(settings.dirFor('markers'), p, markers);
  });
  ipcMain.handle('markers:load', (_e, rawPath) => {
    const p = normalize(rawPath);
    if (!openedPdfs.has(p)) return [];
    return markerStore.load(settings.dirFor('markers'), p);
  });

  // ===== URL로 PDF 열기 =====
  // 다운로드는 반드시 main이 한다: 렌더러 CSP가 connect-src 'self'라 외부 요청 자체가 막혀 있고,
  // 무엇보다 "경로를 만들어 내는 주체는 main 하나"라는 allowlist 원칙을 지켜야 한다.
  // 받은 파일은 보관 폴더 downloads/에 두고 allowPath로 등록한다 → 이후 열기·번역·마커 저장이
  // 로컬 PDF와 완전히 같은 경로를 지난다. net.fetch를 쓰는 이유는 앱 세션의 프록시·인증서 설정을 따르기 위함.
  // force=true면 이미 받아 둔 파일을 무시하고 서버에서 새로 받는다. 이 탈출구가 없으면
  // 버전 없는 arXiv URL처럼 "같은 주소가 갱신되는" 문서를 처음 받은 바이트에 영원히 고정하게 된다.
  ipcMain.handle('pdf:open-url', async (_e, rawUrl, { force } = {}) => {
    const res = await downloadPdf(rawUrl, {
      dir: settings.dirFor('downloads'),
      force: force === true,
      fetch: (u, opts) => net.fetch(u, opts),
    });
    const p = allowPath(res.path);
    recentFiles.record(p);
    return { ...res, path: p };
  });

  ipcMain.handle('pdf:translate', async (e, { path: rawPath, force } = {}) => {
    const wc = e.sender;
    const wcId = wc.id;
    const p = normalize(rawPath);
    if (!openedPdfs.has(p)) throw new Error('translate denied: 이 세션에서 연 PDF가 아닙니다');
    if (jobs.has(wcId)) throw new Error('이 창에서 이미 번역이 진행 중입니다');

    const s = settings.get();
    const output = s.keepTranslationsInStorage
      ? path.join(settings.dirFor('translations'), path.basename(p).replace(/\.pdf$/i, '') + '.ko.pdf')
      : outputPathFor(p);
    if (!force && fs.existsSync(output)) return { output, existed: true };
    // 같은 출력 경로를 다른 창이 이미 쓰고 있으면 거부 — 같은 파일을 두 창에서 동시에 덮어쓰는 것을 막는다.
    if (jobs.outputInUse(output)) throw new Error('같은 파일을 다른 창에서 번역 중입니다');

    const job = translate(p, {
      onProgress: (d) => { if (!wc.isDestroyed()) wc.send('pdf:translate:progress', d); },
      output,
      translateSettings: s.translate,
    });
    jobs.add(wcId, output, job);
    try {
      const res = await job.promise;
      const out = normalize(res.output);
      allowed.add(out);
      openedPdfs.add(out);
      return { ...res, output: out, existed: false };
    } finally {
      jobs.remove(wcId);
    }
  });

  ipcMain.handle('pdf:translate:cancel', (e) => {
    jobs.cancel(e.sender.id);
    return { ok: true };
  });

  // 지금 열려 있는 PDF들 중 "번역본이 실제로 있는" 첫 원본을 찾아 알려준다.
  // 렌더러는 이 결과로 삭제 버튼의 활성 여부와 안내 문구만 정하고, 경로는 다시 넘기지 않는다.
  // 조회는 조용하다 — 미허용 경로는 예외 대신 건너뛴다(문서를 열고 닫을 때마다 불리는 질의라
  // 예외를 던지면 정상 흐름이 오류로 시끄러워진다).
  ipcMain.handle('pdf:translation:info', (_e, rawPaths) => {
    const list = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
    for (const raw of list) {
      if (typeof raw !== 'string' || !raw) continue;
      const p = normalize(raw);
      if (!openedPdfs.has(p)) continue;
      const targets = existingTranslations(p);
      if (targets.length) return { source: p, targets };
    }
    return { source: null, targets: [] };
  });

  // 번역본 삭제. 받는 것은 "원본 경로" 하나뿐이고 지울 파일은 여기서 유도한다.
  // 완전 삭제가 아니라 휴지통으로 옮긴다 — 수 분짜리 AI 작업의 결과물이라 오조작의 대가가 크다.
  // 휴지통이 실패하면 거기서 멈춘다: 되돌릴 수 있다고 물어 놓고 되돌릴 수 없게 지우지 않는다.
  ipcMain.handle('pdf:translation:delete', async (e, rawPath) => {
    const p = normalize(rawPath);
    if (!openedPdfs.has(p)) throw new Error('삭제 거부: 이 세션에서 연 PDF가 아닙니다');

    const targets = existingTranslations(p);
    if (!targets.length) return { removed: [], canceled: false };
    // 지금 만들어지고 있는 파일은 지우지 않는다 — 다른 창이 쓰는 중인 출력까지 포함해서 막는다.
    if (targets.some((t) => jobs.outputInUse(t))) throw new Error('번역이 진행 중인 파일은 삭제할 수 없습니다');

    const win = BrowserWindow.fromWebContents(e.sender);
    if (!(await confirmDeleteTranslation(win, targets))) return { removed: [], canceled: true };

    const removed = [];
    for (const t of targets) {
      await removeTranslationFile(t); // 실패하면 throw → 렌더러가 사유를 그대로 보여준다
      removed.push(t);
    }
    return { removed, canceled: false };
  });

  // ===== 논문 요약 =====
  // 본문 텍스트는 렌더러가 보낸다: PDF 파싱(pdf.js)이 렌더러에만 있고, 이미 로드된 문서에서
  // 뽑는 편이 main에서 다시 파싱하는 것보다 훨씬 싸다. 경로는 여전히 allowlist로 검문한다
  // — 경로가 곧 캐시 키이자 "이 세션에서 연 PDF인가"의 근거이기 때문.
  // ===== memo 모드 =====
  // 경로는 전부 여기서 만든다. 렌더러는 '이름'만 넘기고, 실제 경로는 dirFor('memos') 아래로만
  // 만들어져 allowPath로 등록된다 — 그래야 file:read/file:write의 allowlist 검문을 통과할 수 있고,
  // 렌더러가 보낸 문자열이 보관 폴더 밖을 가리킬 방법이 없다.
  ipcMain.handle('memo:list', () => memoFiles.listMemos(settings.dirFor('memos'))
    .map((m) => ({ ...m, path: allowPath(m.path) })));

  // 새 메모. 파일을 실제로 만들어 둔다 — 만들지 않으면 저장 전까지 목록에 안 보여
  // "새로 만들었는데 사라졌다"가 된다.
  ipcMain.handle('memo:new', (_e, rawName) => {
    const p = memoFiles.uniqueMemoPath(settings.dirFor('memos'), rawName);
    fs.writeFileSync(p, '', 'utf8');
    return { path: allowPath(p), name: path.basename(p).replace(/\.md$/i, '') };
  });

  // 번역본 경로. 파일을 만들지는 않고 경로만 등록해 준다(저장 시점에 생긴다).
  ipcMain.handle('memo:translation-path', (_e, rawSrc) => {
    const src = normalize(rawSrc);
    if (!allowed.has(src)) throw new Error('memo denied: 이 세션에서 연 메모가 아닙니다');
    return allowPath(memoFiles.translationPathFor(src));
  });

  // 번역 실행. 내용은 렌더러가 보낸 '지금 편집 중인 값'을 쓴다 — 저장 전 상태로도 번역할 수
  // 있어야 하고, 파일을 다시 읽으면 저장 안 된 편집이 빠진 채 번역된다.
  ipcMain.handle('memo:translate', async (e, { path: rawPath, content } = {}) => {
    const wcId = e.sender.id;
    const p = normalize(rawPath);
    if (!allowed.has(p)) throw new Error('memo translate denied: 이 세션에서 연 메모가 아닙니다');
    if (memoJobs.has(wcId)) throw new Error('이 창에서 이미 번역이 진행 중입니다');
    const job = translateMemo(content, { translateSettings: settings.get().translate });
    memoJobs.add(wcId, p, job);
    try {
      return await job.promise;
    } finally {
      memoJobs.remove(wcId);
    }
  });

  // 지금 이 창에 올라와 있는 파일 목록 — 메뉴가 경로를 보여주기 위한 것.
  // 렌더러는 상태가 바뀔 만한 자리마다 부담 없이 부르고, 값이 같으면 openFiles가 되돌린다.
  ipcMain.handle('window:set-open-files', (e, entries) => {
    openFiles.set(e.sender.id, entries);
    return { ok: true };
  });

  ipcMain.handle('memo:translate:cancel', (e) => {
    memoJobs.cancel(e.sender.id);
    return { ok: true };
  });

  ipcMain.handle('pdf:summarize', async (e, { path: rawPath, kind, title, outline, text } = {}) => {
    const wcId = e.sender.id;
    const p = normalize(rawPath);
    if (!openedPdfs.has(p)) throw new Error('summarize denied: 이 세션에서 연 PDF가 아닙니다');
    if (!SUMMARY_KINDS.includes(kind)) throw new Error(`알 수 없는 요약 종류: ${kind}`);
    if (summaryJobs.has(wcId)) throw new Error('이 창에서 이미 요약이 진행 중입니다');

    const s = settings.get();
    // summaryPrompts는 사용자가 설정창에서 고친 프롬프트 문구다. 여기서는 설정을 그대로 넘기기만 하고
    // 빈 칸→기본값 대체·제어문자 제거·칸당 길이 상한은 paperSummary가 한다 — 프롬프트를 조립하는
    // 곳이 한 군데뿐이어야 "빈 문자열 = 내장 기본값" 관례가 호출부마다 갈리지 않는다.
    const job = summarize(kind, { title, outline, text }, {
      translateSettings: s.translate,
      summaryPrompts: s.summaryPrompts,
    });
    summaryJobs.add(wcId, `${p}::${kind}`, job);
    try {
      return await job.promise;
    } finally {
      summaryJobs.remove(wcId);
    }
  });

  ipcMain.handle('pdf:summarize:cancel', (e) => {
    summaryJobs.cancel(e.sender.id);
    return { ok: true };
  });

  // 요약 캐시. 마커와 같은 규율 — save는 미허용 경로면 throw로 명확히 거부하고,
  // load는 조용히 빈 값을 준다(복원은 열기 직후 자동 실행이라 예외로 흐름을 끊지 않는다).
  ipcMain.handle('summary:load', (_e, rawPath) => {
    const p = normalize(rawPath);
    if (!openedPdfs.has(p)) return { parts: { overview: '', sections: '', flow: '' }, meta: null };
    return summaryStore.load(settings.dirFor('summaries'), p);
  });
  ipcMain.handle('summary:save', (_e, rawPath, parts, meta) => {
    const p = normalize(rawPath);
    if (!openedPdfs.has(p)) throw new Error('summary save denied: 이 세션에서 연 PDF가 아닙니다');
    return summaryStore.save(settings.dirFor('summaries'), p, parts, meta);
  });

  // 내장 요약 프롬프트 원문. 설정창이 편집 칸을 열 때 "저장된 override가 없으면 기본값을 채워
  // 보여주기" 위해 필요하다 — 여러 줄짜리 긴 지시문이라 placeholder로는 보여줄 수 없다.
  //
  // 이 파일의 다른 핸들러들과 달리 normalize/openedPdfs 검문이 없는데, 빠뜨린 것이 아니다:
  // 인자를 하나도 받지 않고 돌려주는 것도 paperSummary.js에 박혀 있는 정적 문자열뿐이라,
  // 렌더러가 값을 흘려 넣어 경로를 만들어 낼 여지 자체가 없다. 검문할 입력이 없는 것이다.
  // (나중에 인자를 받도록 고치는 순간 이 면제는 깨진다 — 그때는 검문을 되살려야 한다.)
  // 반환값을 그대로 내보내도 안전하다: IPC는 structured clone이라 렌더러가 받는 것은 사본이고,
  // 렌더러에서 뭘 하든 main의 기본값 객체는 그대로 남는다.
  ipcMain.handle('summary:prompt-defaults', () => PROMPT_DEFAULTS);

  // ===== 요약 내보내기 (복사/저장 공통 1단계 + 저장) =====
  // 마크다운 조립(특히 flow를 ```mermaid로 감싸는 규칙)은 summaryExport.js 한 곳에서만 한다.
  // 복사(클립보드)와 저장(파일)이 서로 다른 곳에서 각자 조립하면 두 경로의 결과가 갈릴 수 있어서다.
  // 이 핸들러는 순수 계산만 한다 — 다이얼로그도 파일 쓰기도 하지 않는다. docPath는 파일을
  // 읽거나 쓰는 데 전혀 쓰이지 않고(path.basename으로 표시용 이름만 뽑는다) 그 결과도
  // sanitizeFileNamePart를 거치므로, 다른 핸들러들과 달리 openedPdfs 검문이 필요 없다.
  ipcMain.handle('summary:export-text', (_e, { parts, title, docPath, scope, tab } = {}) => {
    const text = buildExportMarkdown(parts, { title, docPath, scope, tab });
    if (text.length > MAX_EXPORT_CHARS) {
      throw new Error(`내보낼 요약이 너무 큽니다(${MAX_EXPORT_CHARS.toLocaleString()}자 초과)`);
    }
    return { text, fileName: defaultExportFileName(docPath, { scope, tab }) };
  });

  // 요약 저장. 신뢰 경계가 이 파일의 핵심이다: 렌더러는 경로를 만들지 않는다 — 렌더러는
  // "무엇을 저장할지"(텍스트와 기본 파일명 힌트)만 넘기고, 실제 경로는 사용자가 다이얼로그에서
  // 고른 것만 쓴다. defaultFileName은 힌트일 뿐이라 여기서도 다시 정화한다(위 export-text를
  // 거치지 않고 직접 호출되거나, 렌더러 상태가 그 사이 바뀌었을 가능성까지 방어).
  // 취소하면 조용히 null을 돌려준다. 쓰기 실패는 그대로 throw해 렌더러가 사유를 보여주게 한다
  // — 요약은 수 분짜리 AI 작업의 결과물이라 "저장한 줄 알았는데 안 됐다"가 가장 나쁜 실패다.
  ipcMain.handle('summary:export', async (e, { text, defaultFileName } = {}) => {
    const t = typeof text === 'string' ? text : '';
    if (!t) throw new Error('내보낼 내용이 없습니다');
    // 상한: 요약 파트 하나가 아무리 길어도 20만자(summaryStore.MAX_PART_CHARS)고 세 파트를 합쳐도
    // 60만자 남짓이다. MAX_EXPORT_CHARS(2MB)는 그 3배 이상 여유를 둔 최종 방어선 — 이 핸들러가
    // 위 export-text를 거치지 않고 직접 불릴 가능성(향후 변경)까지 대비한다.
    if (t.length > MAX_EXPORT_CHARS) {
      throw new Error(`내보낼 텍스트가 너무 큽니다(${MAX_EXPORT_CHARS.toLocaleString()}자 초과)`);
    }
    const win = BrowserWindow.fromWebContents(e.sender);
    // 확장자를 지켜 주는 쪽으로 정화한다 — sanitizeFileNamePart를 그대로 쓰면 80자 상한이
    // '-요약.md'까지 잘라, 파일명이 긴 논문에서 확장자 없는 기본값이 다이얼로그에 떴다.
    const name = sanitizeExportFileName(defaultFileName);
    const res = await dialog.showSaveDialog(win, {
      defaultPath: name,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, t, 'utf8');
    return { path: res.filePath };
  });

  // PDF 우클릭 메뉴. 렌더러가 "선택이 있는가 / 이 좌표에 마커가 있는가"만 알려주고,
  // 메뉴 구성은 메인이 한다(렌더러가 임의 메뉴를 띄우지 못하게).
  // 복사는 반드시 role:'copy' — clipboard.writeText로 직접 쓰면 pdf.js textLayer의
  // copy 핸들러(유니코드 정규화)를 건너뛰어 깨진 텍스트가 들어간다.
  ipcMain.handle('ui:pdf-context-menu', (e, { hasSelection, hasMarker, hasDoc, canMirror } = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return null;

    let settle = null; // Promise 안에서 채워진다. click 콜백은 popup 이후에만 불린다.
    const pick = (id) => settle?.(id);

    const tpl = [];
    if (hasSelection) {
      tpl.push({ role: 'copy', label: '복사', enabled: true });
      tpl.push({ type: 'separator' });
      tpl.push({
        label: '형광펜',
        submenu: HIGHLIGHT_COLORS.map((c) => ({ label: c.label, click: () => pick(`highlight:${c.color}`) })),
      });
      tpl.push({ label: '밑줄', click: () => pick('underline') });
    }
    if (hasMarker) {
      if (tpl.length) tpl.push({ type: 'separator' });
      tpl.push({ label: '마커 삭제', click: () => pick('remove') });
    }
    if (canMirror) {
      if (tpl.length) tpl.push({ type: 'separator' });
      tpl.push({ label: '반대편 같은 위치 보기', click: () => pick('mirror-jump') });
    }
    if (hasDoc) {
      if (tpl.length) tpl.push({ type: 'separator' });
      tpl.push({ label: '전체 텍스트 복사', click: () => pick('copy-all') });
    }
    if (!tpl.length) return null;

    return new Promise((resolve) => {
      let done = false;
      settle = (id) => { if (!done) { done = true; resolve(id); } };
      const menu = Menu.buildFromTemplate(tpl);
      // 닫힘 콜백이 click보다 먼저 도착할 수 있으므로 한 틱 미뤄 null로 마감한다.
      menu.popup({ window: win, callback: () => setTimeout(() => settle(null), 0) });
    });
  });
}

// Finder에서 연 파일을 놓을 자리가 없을 때, 렌더러가 새 창을 청하는 통로.
// 경로는 여기서 다시 검문한다 — 렌더러가 임의 경로로 창을 열 수 있으면 허용목록 원칙이 무너진다.
// main이 open-file에서 allowPath로 등록한 경로만 통과한다.
function registerOpenInNewWindow(createWindow) {
  ipcMain.handle('window:open-files', (_e, rawPaths) => {
    const paths = (Array.isArray(rawPaths) ? rawPaths : [])
      .filter((p) => typeof p === 'string' && p)
      .map((p) => normalize(p))
      .filter((p) => allowed.has(p));
    if (!paths.length) return { ok: false };
    createWindow({ left: paths[0], right: paths[1] || null });
    return { ok: true };
  });
}

// 앱 종료 시 호출 — detached로 띄운 transpaper·요약 CLI(및 그 자식 agy/claude)가 살아남지 않도록.
// 요약도 여기서 함께 정리한다: 같은 detached 관용구라 빠뜨리면 앱을 꺼도 프로세스가 남는다.
function cancelTranslation() { jobs.cancelAll(); summaryJobs.cancelAll(); memoJobs.cancelAll(); }

// 특정 창이 파괴될 때 그 창의 작업만 취소한다(main.js의 webContents 'destroyed' 훅에서 호출).
// 창이 사라질 때 호출. 파일 목록도 함께 지운다 — 남겨 두면 다음에 같은 id를 받은 창이
// 남의 파일 경로를 메뉴에 달고 시작한다.
function cancelForWebContents(wcId) {
  jobs.cancel(wcId); summaryJobs.cancel(wcId); memoJobs.cancel(wcId);
  openFiles.clear(wcId);
}

module.exports = {
  registerIpc, allowPath, cancelTranslation, cancelForWebContents, registerOpenInNewWindow,
};
