// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Preload Script
//  Exposes safe window.vwb API to the renderer (index.html)
// ═══════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vwb', {

  // Pick one or more audio files via native file dialog
  pickFile:         (opts)              => ipcRenderer.invoke('vwb:pickFile', opts),

  // Pick any file type — no extension filter (used by Rubato Mode)
  pickAnyFile:      (opts)              => ipcRenderer.invoke('vwb:pickAnyFile', opts),

  // Pick a folder and return all MIDI files inside it (used by Rubato Mode)
  pickMidiFolder:   ()                  => ipcRenderer.invoke('vwb:pickMidiFolder'),

  // Pick one or more audio files (multi = true allows multiple selection)
  pickAudioFiles:   (multi)             => ipcRenderer.invoke('vwb:pickAudioFiles', multi),

  // Pick a single loop/pad file
  pickLoopFile:     ()                  => ipcRenderer.invoke('vwb:pickLoopFile'),

  // Pick a single MIDI file
  pickMidiFile:     ()                  => ipcRenderer.invoke('vwb:pickMidiFile'),

  // Pick a Flex File — accepts .mid or .vwbs (song chart)
  pickFlexFile:     ()                  => ipcRenderer.invoke('vwb:pickFlexFile'),

  // Store a stem file permanently in app data folder
  storeStem:        (opts)              => ipcRenderer.invoke('vwb:storeStem', opts),

  // Check if a stored stem file still exists on disk
  stemExists:       (filePath)          => ipcRenderer.invoke('vwb:stemExists', filePath),

  // Read a file from disk and return its raw bytes
  readFileBuffer:   (filePath)          => ipcRenderer.invoke('vwb:readFileBuffer', filePath),

  // Copy a file into the app's persistent storage folder
  copyToStems:      (srcPath)           => ipcRenderer.invoke('vwb:copyToStems', srcPath),

  // Generic JSON read/write
  saveJson:         (name, data)        => ipcRenderer.invoke('vwb:saveJson', name, data),
  loadJson:         (name)              => ipcRenderer.invoke('vwb:loadJson', name),

  // Named shortcuts
  saveSetlist:      (data)              => ipcRenderer.invoke('vwb:saveSetlist', data),
  loadSetlist:      ()                  => ipcRenderer.invoke('vwb:loadSetlist'),
  saveSettings:     (data)              => ipcRenderer.invoke('vwb:saveSettings', data),
  loadSettings:     ()                  => ipcRenderer.invoke('vwb:loadSettings'),
  saveService:      (data)              => ipcRenderer.invoke('vwb:saveService', data),
  loadService:      ()                  => ipcRenderer.invoke('vwb:loadService'),
  saveMrcMap:       (data)              => ipcRenderer.invoke('vwb:saveMrcMap', data),
  loadMrcMap:       ()                  => ipcRenderer.invoke('vwb:loadMrcMap'),

  // Session file management
  openSessionFile:  ()                  => ipcRenderer.invoke('vwb:openSessionFile'),
  readSessionFile:  (filePath)           => ipcRenderer.invoke('vwb:readSessionFile', filePath),
  saveSessionFile:  (filePath, content) => ipcRenderer.invoke('vwb:saveSessionFile', filePath, content),
  saveSessionFileAs:(name, content)     => ipcRenderer.invoke('vwb:saveSessionFileAs', name, content),

  // Quit the app
  quitApp:          ()                  => ipcRenderer.invoke('vwb:quitApp'),

  // Read a sample .mp3 file for the built-in synth (bypasses fetch)
  readSampleFile:   (sfName, note)      => ipcRenderer.invoke('vwb:readSampleFile', sfName, note),

  // Bundle export/import
  exportBundle:     (opts)              => ipcRenderer.invoke('vwb:exportBundle', opts),
  openBundle:       ()                  => ipcRenderer.invoke('vwb:openBundle'),

  // Service Pack browser
  openServicePack:        ()            => ipcRenderer.invoke('vwb:openServicePack'),
  readServicePackFile:    (filePath)    => ipcRenderer.invoke('vwb:readServicePackFile', filePath),
  saveServicePackState:   (state)       => ipcRenderer.invoke('vwb:saveServicePackState', state),
  loadServicePackState:   ()            => ipcRenderer.invoke('vwb:loadServicePackState'),

  // Armor Bearer — Hammond organ module
  pickFolder:                 (opts)    => ipcRenderer.invoke('vwb:pickFolder', opts),
  scanArmorBearerFolder:      (rootPath)=> ipcRenderer.invoke('vwb:scanArmorBearerFolder', rootPath),

  // House Band chunk library — reads all chunk JSON files from disk
  loadHouseBandLibrary: () => ipcRenderer.invoke('vwb:loadHouseBandLibrary'),

  // House Band content updater — downloads and installs new style packages
  downloadHouseBandPackage: (opts) => ipcRenderer.invoke('vwb:downloadHouseBandPackage', opts),

  // VWB Service Pack Bundle system (.vwbp files) — open and populate all VWB systems
  // .vwbp is distinct from .vwb (Rubato packs) and .vwbs (Session files)
  openVwbBundle:  ()         => ipcRenderer.invoke('vwb:openVwbBundle'),
  readBundleFile: (filePath) => ipcRenderer.invoke('vwb:readBundleFile', filePath),

  // VWB Rubato Song Bundle (.vwbrs files) — one file loads both pack + MIDI
  openRubatoBundle: ()       => ipcRenderer.invoke('vwb:openRubatoBundle'),
  openVwbs:         ()       => ipcRenderer.invoke('vwb:openVwbs'),

  // Open a URL in the system default browser
  openExternal:     (url)              => ipcRenderer.invoke('vwb:openExternal', url),

  // Piano Talk Music — serves bundled MP3 files by pianist ID and key
  pianoTalkFile:    (opts)             => ipcRenderer.invoke('vwb:pianoTalkFile', opts),

  // Organ Samples — returns path to bundled organ-samples/ folder
  getOrganSamplesPath: ()             => ipcRenderer.invoke('vwb:getOrganSamplesPath'),

  // Whisper offline speech recognition (Rubato Mode)
  whisperStart:     ()                 => ipcRenderer.invoke('vwb:whisperStart'),
  whisperStop:      ()                 => ipcRenderer.invoke('vwb:whisperStop'),

  // VWB Remote server
  remoteGetInfo:    ()                  => ipcRenderer.invoke('remote:getInfo'),
  remoteStart:      ()                  => ipcRenderer.invoke('remote:start'),
  remoteStateUpdate:(state)             => ipcRenderer.send('remote:stateUpdate', state),
  remoteToast:      (text)              => ipcRenderer.send('remote:toast', text),

  // ── House Band content packs (phrases, chords, licks) ──────────
  saveHBPack:         (data)     => ipcRenderer.invoke('hb:savePack',            data),
  loadHBPack:         (packId)   => ipcRenderer.invoke('hb:loadPack',            packId),
  readHBPackMidi:     (packId)   => ipcRenderer.invoke('hb:readPackMidi',        packId),
  listHBPacks:        ()         => ipcRenderer.invoke('hb:listPacks'),
  deleteHBPack:       (packId)   => ipcRenderer.invoke('hb:deletePack',          packId),

  // ── Rubato song packs (.vwb files) ─────────────────────────────
  saveRubatoPack:     (data)     => ipcRenderer.invoke('vwb:saveRubatoPack',     data),
  listRubatoPacks:    ()         => ipcRenderer.invoke('vwb:listRubatoPacks'),
  readRubatoPack:     (packId)   => ipcRenderer.invoke('vwb:readRubatoPack',     packId),

  // ── Organ sample packs ──────────────────────────────────────────
  saveOrganPack:      (data)     => ipcRenderer.invoke('vwb:saveOrganPack',      data),
  saveOrganSamples:   (data)     => ipcRenderer.invoke('vwb:saveOrganSamples',   data),

  // ── Service Pack (.vwbp) — opens bundle, routes all content ────
  openVwbServicePack: (filePath) => ipcRenderer.invoke('vwb:openServicePack',    filePath),

});
