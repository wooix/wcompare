// src/renderer/diffEditor.js
import * as monaco from 'monaco-editor';
import { extToLanguageId } from './languageMap.js';
import { withRememberedRatio } from './paneEqualize.js';

export function createDiff(container) {
  const diff = monaco.editor.createDiffEditor(container, {
    renderSideBySide: true, originalEditable: true, automaticLayout: true,
    ignoreTrimWhitespace: false,
    // 좌우 여백을 같게 만드는 유일한 방법. diff 편집기는 왼쪽 편집기의 glyphMargin을
    // renderSideBySide 값으로 덮어써 항상 켜 버린다(diffEditorEditors.js). 오른쪽은
    // 손대지 않으므로, 여기서 켜 주지 않으면 왼쪽만 18px 더 들어가 같은 폭이어도
    // 글자 칸이 어긋난다 — 그러면 접히는 자리가 좌우에서 달라진다.
    glyphMargin: true,
  });
  diff.setModel({
    original: monaco.editor.createModel('', 'plaintext'),
    modified: monaco.editor.createModel('', 'plaintext'),
  });

  let splitRatio = null; // 마지막으로 넣은 좌우 분할 비율(아래 updateOptions 참고)
  const state = { left: { path: null, eol: '\n', bom: false, dirty: false },
                  right: { path: null, eol: '\n', bom: false, dirty: false } };
  let lineChanges = null;
  const dirtyCbs = [];

  const innerOf = (side) => side === 'left' ? diff.getOriginalEditor() : diff.getModifiedEditor();
  const modelOf = (side) => innerOf(side).getModel();

  diff.onDidUpdateDiff(() => { lineChanges = diff.getLineChanges(); });

  // per-side dirty 추적
  for (const side of ['left', 'right']) {
    modelOf(side).onDidChangeContent(() => {
      if (!state[side].dirty) { state[side].dirty = true; dirtyCbs.forEach((cb) => cb(side, true)); }
    });
  }

  function open(side, file) {
    // file: { path, content, ext, eol, bom, isBinary, byteSize }
    const langId = extToLanguageId(file.ext || file.path || '');
    const model = modelOf(side);
    monaco.editor.setModelLanguage(model, langId);
    model.setValue(file.content);
    Object.assign(state[side], { path: file.path, eol: file.eol || '\n', bom: !!file.bom, dirty: false });
    dirtyCbs.forEach((cb) => cb(side, false));
    return langId;
  }

  // 현재 커서가 속한 diff 블록을 fromSide → toSide로 복사한다.
  function copyCurrentBlock(fromSide, toSide) {
    const changes = lineChanges; // onDidUpdateDiff로 갱신된 캐시
    if (!changes || changes.length === 0) return false;
    const fromInner = innerOf(fromSide);
    const pos = fromInner.getPosition();
    if (!pos) return false;
    const line = pos.lineNumber;
    const inOriginal = fromSide === 'left';
    const blk = changes.find((c) => {
      const s = inOriginal ? c.originalStartLineNumber : c.modifiedStartLineNumber;
      const e = inOriginal ? c.originalEndLineNumber : c.modifiedEndLineNumber;
      return line >= s && line <= (e || s);
    });
    if (!blk) return false;
    const fromModel = modelOf(fromSide);
    const sFrom = inOriginal ? blk.originalStartLineNumber : blk.modifiedStartLineNumber;
    const eFrom = inOriginal ? blk.originalEndLineNumber : blk.modifiedEndLineNumber;
    const text = eFrom === 0 ? '' : fromModel.getValueInRange({
      startLineNumber: sFrom, startColumn: 1,
      endLineNumber: eFrom, endColumn: fromModel.getLineMaxColumn(eFrom),
    });
    const sTo = inOriginal ? blk.modifiedStartLineNumber : blk.originalStartLineNumber;
    const eTo = inOriginal ? blk.modifiedEndLineNumber : blk.originalEndLineNumber;
    const toModel = modelOf(toSide);
    const toInner = innerOf(toSide);
    const range = eTo === 0
      ? { startLineNumber: sTo + 1, startColumn: 1, endLineNumber: sTo + 1, endColumn: 1 } // 삽입
      : { startLineNumber: sTo, startColumn: 1, endLineNumber: eTo, endColumn: toModel.getLineMaxColumn(eTo) };
    toInner.executeEdits('wcompare-copy', [{ range, text }]);
    return true;
  }

  return {
    raw: diff,
    innerOf, modelOf,
    open,
    // 파일을 닫아 빈 모델로 되돌린다. setValue('')가 onDidChangeContent로 dirty를 다시 켜므로
    // 반드시 그 뒤에 dirty=false로 되돌리고 콜백을 흘려 최종 상태를 "비었고 깨끗함"으로 맞춘다.
    close: (side) => {
      const model = modelOf(side);
      monaco.editor.setModelLanguage(model, 'plaintext');
      model.setValue('');
      Object.assign(state[side], { path: null, eol: '\n', bom: false, dirty: false });
      dirtyCbs.forEach((cb) => cb(side, false));
    },
    getValue: (side) => modelOf(side).getValue(),
    getState: (side) => state[side],
    setDirty: (side, v) => { state[side].dirty = v; dirtyCbs.forEach((cb) => cb(side, v)); },
    onDirty: (cb) => dirtyCbs.push(cb),
    getLineChanges: () => lineChanges,
    languageOf: (side) => modelOf(side).getLanguageId(),
    // 옵션을 바꿀 때마다 마지막 좌우 비율을 같이 실어 보낸다. Monaco가 이 키만
    // 현재 값이 아니라 상수 0.5로 되돌리기 때문이다 — withRememberedRatio 주석 참고.
    // 여기 한 곳에서 막아야 한다. 부르는 쪽(줄바꿈·공백·린트…)이 저마다 기억할 수는 없다.
    updateOptions: (o) => {
      const next = withRememberedRatio(o, splitRatio);
      splitRatio = next.ratio;
      diff.updateOptions(next.options);
    },
    // 좌우 창 폭 실측. 이 세 값이면 균등 비율이 나온다 — 거터 폭이나 개요 눈금 폭을
    // 따로 알 필요가 없다(paneEqualize.js 참고). 폭은 Monaco가 .editor.original /
    // .editor.modified 에 직접 넣는 값이라, 계산해 둔 레이아웃 그대로다.
    // 비교 화면이 숨겨져 있으면(PDF 모드) 전부 0으로 재이고, 그건 호출한 쪽이 거른다.
    paneMetrics: () => {
      const root = container.querySelector('.monaco-diff-editor');
      const org = root && root.querySelector('.editor.original');
      const mod = root && root.querySelector('.editor.modified');
      if (!org || !mod) return null;
      const rootBox = root.getBoundingClientRect();
      const modBox = mod.getBoundingClientRect();
      return {
        originalWidth: org.getBoundingClientRect().width,
        modifiedWidth: modBox.width,
        sashLeft: modBox.left - rootBox.left,
      };
    },
    goToDiff: (dir) => diff.goToDiff(dir),
    copyCurrentBlock,
  };
}
