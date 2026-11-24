'use strict';
// 로컬 설정/오프라인 화면(file://)에서만 사용하는 최소 API. 원격 플레이어 페이지에는 노출하지 않는다.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('signageApp', {
    getConfig: () => ipcRenderer.invoke('setup:get'),
    save: (cfg) => ipcRenderer.invoke('setup:save', cfg),
    cancel: () => ipcRenderer.invoke('setup:cancel'),
    quit: () => ipcRenderer.invoke('setup:quit'),
    retry: () => ipcRenderer.invoke('offline:retry')
  });
}
