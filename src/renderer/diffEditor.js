// src/renderer/diffEditor.js
import * as monaco from 'monaco-editor';
import { extToLanguageId } from './languageMap.js';

export function createDiff(container) {
  const diff = monaco.editor.createDiffEditor(container, {
    renderSideBySide: true, originalEditable: true, automaticLayout: true,
    ignoreTrimWhitespace: false,
  });
  diff.setModel({
    original: monaco.editor.createModel('', 'plaintext'),
    modified: monaco.editor.createModel('', 'plaintext'),
  });

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
    getValue: (side) => modelOf(side).getValue(),
    getState: (side) => state[side],
    setDirty: (side, v) => { state[side].dirty = v; dirtyCbs.forEach((cb) => cb(side, v)); },
    onDirty: (cb) => dirtyCbs.push(cb),
    getLineChanges: () => lineChanges,
    languageOf: (side) => modelOf(side).getLanguageId(),
    updateOptions: (o) => diff.updateOptions(o),
    goToDiff: (dir) => diff.goToDiff(dir),
    copyCurrentBlock,
  };
}
