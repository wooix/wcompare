const { contextBridge } = require('electron');
// 스파이크 단계에서는 노출 API가 없다. Phase 3에서 채운다.
contextBridge.exposeInMainWorld('wcompare', {
  ping: () => 'pong',
});
