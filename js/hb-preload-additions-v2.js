// ═══════════════════════════════════════════════════════════════
//  VWB — Complete Preload Bridge Additions v2
//
//  Add ALL of these entries to the contextBridge.exposeInMainWorld()
//  block in preload.js, inside the existing window.vwb = { ... }
//  object. This covers House Band packs, Rubato packs, Organ
//  packs, and Service Pack (.vwbp) opening.
// ═══════════════════════════════════════════════════════════════

// ── Paste these inside window.vwb = { ... } in preload.js ──────

// House Band content packs
saveHBPack:       (data)   => ipcRenderer.invoke('hb:savePack',          data),
loadHBPack:       (packId) => ipcRenderer.invoke('hb:loadPack',          packId),
readHBPackMidi:   (packId) => ipcRenderer.invoke('hb:readPackMidi',      packId),
listHBPacks:      ()       => ipcRenderer.invoke('hb:listPacks'),
deleteHBPack:     (packId) => ipcRenderer.invoke('hb:deletePack',        packId),

// Rubato song packs
saveRubatoPack:   (data)   => ipcRenderer.invoke('vwb:saveRubatoPack',   data),
listRubatoPacks:  ()       => ipcRenderer.invoke('vwb:listRubatoPacks'),
readRubatoPack:   (packId) => ipcRenderer.invoke('vwb:readRubatoPack',   packId),

// Organ sample packs
saveOrganPack:    (data)   => ipcRenderer.invoke('vwb:saveOrganPack',    data),
saveOrganSamples: (data)   => ipcRenderer.invoke('vwb:saveOrganSamples', data),

// Service Pack (.vwbp) — opens bundle and routes all content
openServicePack:  (path)   => ipcRenderer.invoke('vwb:openServicePack',  path),


// ── Add these two lines to main.js ─────────────────────────────
//
//   // After other require() calls at the top:
//   const hbIpc = require('./hb-ipc-handlers');
//
//   // After app.whenReady() and mainWindow is created:
//   hbIpc.register(ipcMain, app);


// ── Add this to index.html script load order ───────────────────
//
//  Place AFTER band-registry.js, BEFORE band-ui.js:
//    <script src="js/hb-content-updater.js"></script>


// ── Add these calls to showMainApp() in remote-bridge.js ───────
//
//  After the existing init calls at the bottom of showMainApp():
//    // Initialize content updater (checks for updates in background)
//    if (typeof hbContentUpdaterInit === 'function') hbContentUpdaterInit();
//
//  Add a "Open Service Pack" menu item or button that calls:
//    vwbPickAndOpenServicePack()


// ── Add the update panel div to band-ui.js ─────────────────────
//
//  In _buildBandPage(), inside hb-perform-section before closing </div>:
//    <div id="hbUpdatePanel"></div>
//
//  At the end of bandUiRender():
//    if (typeof hbRenderUpdatePanel === 'function') hbRenderUpdatePanel();


// ── Add rbLoadVwbPackFromData() to rubato.js ───────────────────
//
//  This function lets the content updater load a Rubato pack from
//  already-downloaded data without prompting the user for a file.
//  Paste this into rubato.js alongside rbLoadVwbPack():

/*
async function rbLoadVwbPackFromData(vwbJsonString, displayName) {
  try {
    const pack = JSON.parse(vwbJsonString);
    if (pack.format !== 'vwb-rubato-pack') {
      showNotification('⚠ Not a valid VWB song pack');
      return false;
    }
    rbVwbPack     = pack;
    rbPackLoaded  = true;
    rbSongTitle   = pack.song?.title   || displayName || '';
    rbArtistName  = pack.artist?.name  || '';
    rbArtistRole  = pack.artist?.role  || 'Pianist';
    rbArtistPhoto = pack.artist?.photo || null;
    const packKey = pack.song?.key || 'C';
    const keyIdx  = RB_KEY_NAMES.indexOf(packKey);
    if (keyIdx >= 0) rbTranspose = keyIdx;
    rbPhrases    = [];
    rbChunkFiles = {};
    if (pack.phrases && pack.phrases.length) {
      pack.phrases.forEach((p) => {
        if (!p.trigger) return;
        if (p.trigger === 'verse' || p.trigger === 'chorus') return;
        if (p.startTime === null || p.startTime === undefined) return;
        if (p.duration !== null && p.duration <= 0) return;
        rbPhrases.push({
          line: p.line || p.trigger, trigger: p.trigger,
          firstWord: p.trigger, section: p.section || '',
          startTime: p.startTime, endTime: p.endTime,
          duration: p.duration, midiData: null
        });
        rbChunkFiles[p.trigger] = '__vwb_pack__';
      });
    }
    if (pack.melodicStructure && pack.melodicStructure.length) {
      _rbBuildFingerprintFromPack(pack);
    }
    rbCurrentIdx  = -1;
    rbPitchLocked = false;
    renderRubatoCard();
    showNotification('✅ ' + rbSongTitle + ' — ' + rbPhrases.length + ' phrases loaded');
    return true;
  } catch(e) {
    showNotification('❌ Could not load song pack: ' + e.message);
    return false;
  }
}

// Refresh list of installed rubato packs from userData
async function rbRefreshInstalledPacks() {
  try {
    const res = await window.vwb.listRubatoPacks();
    if (res.success && res.packs.length) {
      console.log('[Rubato] Installed packs:', res.packs.length);
      // Render pack list in Rubato UI if it's currently open
      if (typeof renderRubatoCard === 'function') renderRubatoCard();
    }
  } catch(e) { console.warn('[Rubato] Could not refresh pack list:', e.message); }
}
*/
