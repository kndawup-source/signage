'use strict';
// 로컬 화면(설정/연결 코드/오프라인, file://)에서만 쓰는 최소 API. 원격 플레이어 페이지에는 노출하지 않는다.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('signageApp', {
    getConfig: () => ipcRenderer.invoke('setup:get'),
    save: (cfg) => ipcRenderer.invoke('setup:save', cfg),
    pairWithCode: (cfg) => ipcRenderer.invoke('setup:pair', cfg),
    cancel: () => ipcRenderer.invoke('setup:cancel'),
    quit: () => ipcRenderer.invoke('setup:quit'),
    openSetup: () => ipcRenderer.invoke('setup:open'),
    retry: () => ipcRenderer.invoke('offline:retry'),
    pairInfo: () => ipcRenderer.invoke('pair:info'),
    pairRequest: () => ipcRenderer.invoke('pair:request'),
    pairPoll: (code) => ipcRenderer.invoke('pair:poll', code)
  });
}
