// ═══════════════════════════════════════════════════════════════
//  VWB Sunday Edition — Preload Script
//  Exposes safe window.vwb API to the renderer (index.html)
// ═══════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vwb', {

  // Pick one or more audio files via native file dialog
  pickFile:       (opts)        => ipcRenderer.invoke('vwb:pickFile', opts),

  // Read a file from disk and return its raw bytes
  readFileBuffer: (filePath)    => ipcRenderer.invoke('vwb:readFileBuffer', filePath),

  // Copy a file into the app's persistent storage folder
  copyToStems:    (srcPath)     => ipcRenderer.invoke('vwb:copyToStems', srcPath),

  // Generic JSON read/write
  saveJson:       (name, data)  => ipcRenderer.invoke('vwb:saveJson', name, data),
  loadJson:       (name)        => ipcRenderer.invoke('vwb:loadJson', name),

  // Named shortcuts
  saveSetlist:    (data)        => ipcRenderer.invoke('vwb:saveSetlist', data),
  loadSetlist:    ()            => ipcRenderer.invoke('vwb:loadSetlist'),
  saveSettings:   (data)        => ipcRenderer.invoke('vwb:saveSettings', data),
  loadSettings:   ()            => ipcRenderer.invoke('vwb:loadSettings'),
  saveService:    (data)        => ipcRenderer.invoke('vwb:saveService', data),
  loadService:    ()            => ipcRenderer.invoke('vwb:loadService'),
  saveMrcMap:     (data)        => ipcRenderer.invoke('vwb:saveMrcMap', data),
  loadMrcMap:     ()            => ipcRenderer.invoke('vwb:loadMrcMap'),

});
