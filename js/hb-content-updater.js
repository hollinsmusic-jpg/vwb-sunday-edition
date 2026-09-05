// ═══════════════════════════════════════════════════════════════
//  VWB — House Band Content Updater
//  js/hb-content-updater.js
//
//  Manages the growing House Band phrase library:
//    • Checks Netlify manifest on startup (silent, background)
//    • Auto-installs small fixes and corrections silently
//    • Notifies the user of substantial new content
//    • Supports replacing existing content by ID (version upgrade)
//    • Stores all library content locally for offline use
//
//  Three content types supported:
//    phrases  — multi-chord progressions with voice leading
//    chords   — single chord voicings (all keys)
//    licks    — full-band hits, runs, transitional figures
//
//  Depends on: state.js (showNotification), band-ui.js (badge update)
//  Called by: initApp() in remote-bridge.js (after license check)
// ═══════════════════════════════════════════════════════════════

const HB_MANIFEST_URL =
  'https://virtualworshipband.netlify.app/house-band-library/vwb-hb-manifest.json';

const HB_UPDATER_VERSION = '1.0';

// ── State ──────────────────────────────────────────────────────
let _hbUpdateState = {
  lastChecked:      null,
  installedPacks:   {},   // { [packId]: { version, installedAt, metaFile, midiFile } }
  pendingPacks:     [],   // packs available but not yet installed (needs user action)
  checking:         false,
  downloading:      false,
};

let _hbUpdaterReady = false;


// ── Initialization ─────────────────────────────────────────────

async function hbContentUpdaterInit() {
  if (_hbUpdaterReady) return;

  // Load what's already installed from disk
  await _hbLoadInstalledIndex();
  _hbUpdaterReady = true;

  // Check for updates on startup — non-blocking
  setTimeout(() => hbCheckForUpdates(false), 3000); // 3s delay so app finishes loading first
}


// ── Manifest Check ─────────────────────────────────────────────

/**
 * Check the Netlify manifest for new or updated content.
 * @param {boolean} userInitiated - true = user tapped "Check for Updates"
 *   false = silent background check on startup
 */
async function hbCheckForUpdates(userInitiated = false) {
  if (_hbUpdateState.checking) return;
  _hbUpdateState.checking = true;

  if (userInitiated) {
    _hbSetUpdaterStatus('Checking for new House Band content...');
  }

  try {
    const resp = await fetch(HB_MANIFEST_URL + '?t=' + Date.now(), {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!resp.ok) {
      console.log('[HBUpdater] Manifest fetch failed:', resp.status);
      _hbUpdateState.checking = false;
      if (userInitiated) _hbSetUpdaterStatus('Could not reach update server. Check your internet connection.');
      return;
    }

    const manifest = await resp.json();
    _hbUpdateState.lastChecked = new Date().toISOString();

    await _hbProcessManifest(manifest, userInitiated);

  } catch(e) {
    // Offline or network error — silent fail on startup, message if user-initiated
    console.log('[HBUpdater] Offline or network error:', e.message);
    if (userInitiated) {
      _hbSetUpdaterStatus('Could not connect. VWB will try again next time it opens.');
    }
  }

  _hbUpdateState.checking = false;
}


// ── Manifest Processing ────────────────────────────────────────

async function _hbProcessManifest(manifest, userInitiated) {
  const packs = manifest.contentPacks || [];
  const baseUrl = manifest.baseUrl || '';

  const autoInstallQueue = [];
  const notifyQueue      = [];

  for (const pack of packs) {
    const installed = _hbUpdateState.installedPacks[pack.id];

    // Already installed and up to date — skip
    if (installed && _hbVersionGte(installed.version, pack.version)) continue;

    // New or updated content
    if (pack.autoInstall) {
      autoInstallQueue.push({ ...pack, baseUrl });
    } else {
      notifyQueue.push({ ...pack, baseUrl });
    }
  }

  // ── Auto-install queue (silent) ──
  if (autoInstallQueue.length > 0) {
    console.log('[HBUpdater] Auto-installing', autoInstallQueue.length, 'pack(s)...');
    for (const pack of autoInstallQueue) {
      await _hbDownloadAndInstall(pack, false);
    }
    console.log('[HBUpdater] Auto-install complete.');
  }

  // ── Notify queue (user action required) ──
  if (notifyQueue.length > 0) {
    _hbUpdateState.pendingPacks = [
      ..._hbUpdateState.pendingPacks.filter(p => !notifyQueue.find(n => n.id === p.id)),
      ...notifyQueue
    ];
    _hbShowUpdateBadge(notifyQueue.length);
    if (userInitiated) {
      _hbSetUpdaterStatus(notifyQueue.length + ' new content pack(s) available. See below.');
    }
  } else if (userInitiated) {
    if (autoInstallQueue.length > 0) {
      _hbSetUpdaterStatus('Updated ' + autoInstallQueue.length + ' pack(s) automatically. Your House Band is current.');
    } else {
      _hbSetUpdaterStatus('Your House Band library is up to date.');
    }
  }

  // Refresh band UI to show updated library status
  if (autoInstallQueue.length > 0 && typeof bandUiRender === 'function') {
    bandUiRender();
  }
}


// ── Download & Install ─────────────────────────────────────────

async function _hbDownloadAndInstall(pack, showProgress = true) {
  if (showProgress) {
    _hbSetUpdaterStatus('Downloading: ' + pack.title + '...');
    _hbUpdateState.downloading = true;
  }

  try {
    // Download metadata JSON
    const metaUrl  = pack.baseUrl + pack.metaFile;
    const metaResp = await fetch(metaUrl, { cache: 'no-store' });
    if (!metaResp.ok) throw new Error('Metadata download failed: ' + metaUrl);
    const metadata = await metaResp.json();

    // Download MIDI file as binary
    const midiUrl  = pack.baseUrl + pack.midiFile;
    const midiResp = await fetch(midiUrl, { cache: 'no-store' });
    if (!midiResp.ok) throw new Error('MIDI download failed: ' + midiUrl);
    const midiBuffer = await midiResp.arrayBuffer();

    // Route to the correct destination based on content type
    if (pack.type === 'rubato') {
      await _vwbInstallRubatoPack(pack, metadata, midiBuffer);
    } else if (pack.type === 'organ') {
      await _vwbInstallOrganPack(pack, metadata, midiBuffer);
    } else {
      // Default: House Band phrases / chords / licks
      if (!window.vwb || typeof window.vwb.saveHBPack !== 'function') {
        throw new Error('window.vwb.saveHBPack() not available — IPC handler needed');
      }
      await window.vwb.saveHBPack({
        packId:   pack.id,
        metadata,
        midiData: Array.from(new Uint8Array(midiBuffer)), // IPC-safe array
      });
    }

    // Update installed index
    _hbUpdateState.installedPacks[pack.id] = {
      version:     pack.version,
      title:       pack.title,
      type:        pack.type,
      style:       pack.style,
      feel:        pack.feel,
      progression: pack.progression || null,
      keys:        pack.keys || [],
      installedAt: new Date().toISOString(),
      metaFile:    pack.metaFile,
      midiFile:    pack.midiFile,
    };

    await _hbSaveInstalledIndex();

    // Remove from pending if it was there
    _hbUpdateState.pendingPacks = _hbUpdateState.pendingPacks.filter(p => p.id !== pack.id);
    _hbUpdateBadgeCount();

    console.log('[HBUpdater] Installed:', pack.id, 'v' + pack.version);

    if (showProgress) {
      _hbSetUpdaterStatus('✓ ' + pack.title + ' installed successfully.');
      if (typeof showNotification === 'function') {
        showNotification('🎵 House Band updated: ' + pack.title);
      }
    }

    // Invalidate library cache so next playback uses fresh data
    if (typeof hbInvalidateLibraryCache === 'function') {
      hbInvalidateLibraryCache();
    }

    return true;

  } catch(e) {
    console.error('[HBUpdater] Install failed for', pack.id, ':', e.message);
    if (showProgress) {
      _hbSetUpdaterStatus('Download failed: ' + e.message);
    }
    return false;
  } finally {
    if (showProgress) _hbUpdateState.downloading = false;
  }
}

/**
 * Called when user taps "Download" on a specific pending pack
 * from the update notification panel.
 */
async function hbInstallPendingPack(packId) {
  const pack = _hbUpdateState.pendingPacks.find(p => p.id === packId);
  if (!pack) {
    console.warn('[HBUpdater] Pack not found in pending:', packId);
    return;
  }
  await _hbDownloadAndInstall(pack, true);
  _hbRenderUpdatePanel();
}

/**
 * Install all pending packs at once.
 */
async function hbInstallAllPending() {
  const packs = [..._hbUpdateState.pendingPacks];
  if (packs.length === 0) return;
  _hbSetUpdaterStatus('Downloading ' + packs.length + ' pack(s)...');
  for (const pack of packs) {
    await _hbDownloadAndInstall(pack, false);
  }
  _hbSetUpdaterStatus('✓ All ' + packs.length + ' pack(s) installed.');
  if (typeof showNotification === 'function') {
    showNotification('🎵 House Band library updated — ' + packs.length + ' new pack(s) installed.');
  }
  _hbRenderUpdatePanel();
  if (typeof bandUiRender === 'function') bandUiRender();
}


// ── Notification Badge ─────────────────────────────────────────

function _hbShowUpdateBadge(count) {
  // Badge on My Band tab button
  const tabBtn = document.getElementById('tab-band') ||
                 document.querySelector('[onclick*="band"]');
  if (tabBtn) {
    let badge = tabBtn.querySelector('.hb-update-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'hb-update-badge';
      tabBtn.style.position = 'relative';
      tabBtn.appendChild(badge);
    }
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }

  // Also show in the What's New feed if available
  if (typeof pushVwbNewsItem === 'function') {
    pushVwbNewsItem({
      type:    'library-update',
      title:   count + ' new House Band content pack' + (count > 1 ? 's' : '') + ' available',
      body:    'Open the Band tab to download new phrases, chords, and licks for your House Band.',
      date:    new Date().toISOString(),
    });
  }
}

function _hbUpdateBadgeCount() {
  const count = _hbUpdateState.pendingPacks.length;
  _hbShowUpdateBadge(count);
}


// ── Update Panel Renderer ──────────────────────────────────────
// Renders inside the My Band tab when pending packs exist.
// Called by bandUiRender() when pendingPacks.length > 0.

function hbRenderUpdatePanel() {
  _hbRenderUpdatePanel();
}

function _hbRenderUpdatePanel() {
  const el = document.getElementById('hbUpdatePanel');
  if (!el) return;

  const pending   = _hbUpdateState.pendingPacks;
  const installed = Object.values(_hbUpdateState.installedPacks);

  if (pending.length === 0) {
    el.innerHTML = installed.length > 0
      ? `<div class="hb-update-current">
           <span class="hb-update-check">✓</span>
           House Band library is up to date
           <span class="hb-update-count">${installed.length} pack${installed.length > 1 ? 's' : ''} installed</span>
         </div>`
      : '';
    return;
  }

  el.innerHTML = `
    <div class="hb-update-header">
      <div class="hb-update-title">
        🎵 New House Band Content Available
      </div>
      <div class="hb-update-sub">${pending.length} pack${pending.length > 1 ? 's' : ''} ready to download</div>
      <button class="hb-install-all-btn" onclick="hbInstallAllPending()">
        ⬇ Download All
      </button>
    </div>
    <div class="hb-update-list">
      ${pending.map(pack => `
        <div class="hb-update-item" id="hb-update-item-${pack.id}">
          <div class="hb-update-item-info">
            <div class="hb-update-item-title">${pack.title}</div>
            <div class="hb-update-item-meta">
              ${pack.style || ''} ${pack.feel ? '· ' + pack.feel : ''} ${pack.keys ? '· ' + pack.keys.join(', ') : ''}
              <span class="hb-update-size">${pack.sizeKb || '?'}KB</span>
            </div>
            <div class="hb-update-item-desc">${pack.description || ''}</div>
          </div>
          <button class="hb-install-btn" onclick="hbInstallPendingPack('${pack.id}')">
            ⬇ Get
          </button>
        </div>
      `).join('')}
    </div>
    <div class="hb-update-status" id="hbUpdaterStatus"></div>
  `;
}


// ── Installed Library Index ────────────────────────────────────

async function _hbLoadInstalledIndex() {
  try {
    const res = await window.vwb.loadJson('hbInstalledPacks');
    if (res && res.success && res.data) {
      _hbUpdateState.installedPacks = res.data.packs || {};
      console.log('[HBUpdater] Loaded installed index:',
        Object.keys(_hbUpdateState.installedPacks).length, 'pack(s)');
    }
  } catch(e) {
    console.log('[HBUpdater] No installed index yet (first run).');
    _hbUpdateState.installedPacks = {};
  }
}

async function _hbSaveInstalledIndex() {
  try {
    await window.vwb.saveJson('hbInstalledPacks', {
      version:   HB_UPDATER_VERSION,
      updatedAt: new Date().toISOString(),
      packs:     _hbUpdateState.installedPacks,
    });
  } catch(e) {
    console.warn('[HBUpdater] Could not save installed index:', e.message);
  }
}


// ── Public API ─────────────────────────────────────────────────

/** Returns all installed packs as an array */
function hbGetInstalledPacks() {
  return Object.entries(_hbUpdateState.installedPacks).map(([id, info]) => ({ id, ...info }));
}

/** Returns installed packs filtered by type, style, feel, progression */
function hbQueryInstalledPacks({ type, style, feel, progression } = {}) {
  return hbGetInstalledPacks().filter(p => {
    if (type        && p.type        !== type)        return false;
    if (style       && p.style       !== style)       return false;
    if (feel        && p.feel        !== feel)        return false;
    if (progression && p.progression !== progression) return false;
    return true;
  });
}

/** Returns true if a specific pack ID is installed */
function hbIsPackInstalled(packId) {
  return !!_hbUpdateState.installedPacks[packId];
}

/** Returns pending (available but not yet downloaded) packs */
function hbGetPendingPacks() {
  return [..._hbUpdateState.pendingPacks];
}

/** How many new packs are waiting */
function hbPendingCount() {
  return _hbUpdateState.pendingPacks.length;
}


// ── Helpers ────────────────────────────────────────────────────

function _hbVersionGte(installed, available) {
  // Simple semver-style comparison: "1.0" >= "1.0" → true
  const toNum = v => (v || '0').split('.').map(Number);
  const a = toNum(installed);
  const b = toNum(available);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true; // equal
}

function _hbSetUpdaterStatus(msg) {
  const el = document.getElementById('hbUpdaterStatus');
  if (el) el.textContent = msg;
  console.log('[HBUpdater]', msg);
}


// ── CSS (injected once) ────────────────────────────────────────

(function _injectHbUpdaterStyles() {
  if (document.getElementById('hb-updater-styles')) return;
  const style = document.createElement('style');
  style.id = 'hb-updater-styles';
  style.textContent = `

    /* ── Notification badge on Band tab ── */
    .hb-update-badge {
      position: absolute;
      top: -4px; right: -4px;
      min-width: 18px; height: 18px;
      background: var(--red, #ff3355);
      color: white;
      font-size: 10px; font-weight: 700;
      border-radius: 9px;
      display: flex; align-items: center; justify-content: center;
      padding: 0 4px;
      box-shadow: 0 0 8px rgba(255,51,85,.4);
      pointer-events: none;
      z-index: 10;
    }

    /* ── Update panel (inside My Band tab) ── */
    .hb-update-header {
      background: linear-gradient(135deg,rgba(64,224,208,.12),rgba(64,224,208,.04));
      border: 1px solid rgba(64,224,208,.3);
      border-radius: 14px;
      padding: 1rem 1.1rem;
      margin-bottom: 1rem;
      display: flex; flex-direction: column; gap: .4rem;
    }
    .hb-update-title {
      font-size: 1rem; font-weight: 700;
      color: var(--accent, #40E0D0);
    }
    .hb-update-sub {
      font-size: .8rem; color: var(--text-secondary, #8892a4);
    }
    .hb-install-all-btn {
      margin-top: .5rem;
      padding: .6rem 1.2rem;
      background: linear-gradient(135deg,rgba(64,224,208,.2),rgba(64,224,208,.08));
      border: 1px solid var(--accent, #40E0D0);
      border-radius: 10px;
      color: var(--accent, #40E0D0);
      font-size: .9rem; font-weight: 700;
      cursor: pointer;
      transition: all .15s;
      font-family: inherit; align-self: flex-start;
    }
    .hb-install-all-btn:hover {
      background: rgba(64,224,208,.28);
      box-shadow: 0 0 14px rgba(64,224,208,.2);
    }

    /* ── Individual pack items ── */
    .hb-update-list { display: flex; flex-direction: column; gap: .6rem; margin-bottom: .75rem; }
    .hb-update-item {
      background: var(--bg-card, #141920);
      border: 1px solid var(--border, #2a3340);
      border-radius: 12px;
      padding: .9rem 1rem;
      display: flex; align-items: center; gap: .75rem;
    }
    .hb-update-item-info { flex: 1; min-width: 0; }
    .hb-update-item-title {
      font-size: .9rem; font-weight: 600;
      color: var(--text-primary, #e8edf4);
      margin-bottom: .2rem;
    }
    .hb-update-item-meta {
      font-size: .72rem; color: var(--accent, #40E0D0);
      margin-bottom: .2rem;
    }
    .hb-update-size {
      color: var(--text-secondary, #8892a4);
      margin-left: .4rem;
    }
    .hb-update-item-desc {
      font-size: .72rem; color: var(--text-secondary, #8892a4);
      line-height: 1.4;
    }
    .hb-install-btn {
      flex-shrink: 0;
      padding: .5rem .9rem;
      background: rgba(64,224,208,.1);
      border: 1px solid rgba(64,224,208,.35);
      border-radius: 8px;
      color: var(--accent, #40E0D0);
      font-size: .8rem; font-weight: 700;
      cursor: pointer; transition: all .15s;
      font-family: inherit;
    }
    .hb-install-btn:hover { background: rgba(64,224,208,.2); }

    /* ── Status / up-to-date ── */
    .hb-update-status {
      font-size: .8rem; color: var(--text-secondary, #8892a4);
      min-height: 1.2rem; padding: .1rem 0;
    }
    .hb-update-current {
      display: flex; align-items: center; gap: .5rem;
      font-size: .82rem; color: var(--text-secondary, #8892a4);
      padding: .6rem 0;
    }
    .hb-update-check { color: var(--green, #44dd88); font-size: 1rem; }
    .hb-update-count {
      margin-left: auto;
      font-size: .72rem;
      background: rgba(68,221,136,.1);
      border: 1px solid rgba(68,221,136,.25);
      border-radius: 6px; padding: .15rem .5rem;
      color: var(--green, #44dd88);
    }
  `;
  document.head.appendChild(style);
})();


// ═══════════════════════════════════════════════════════════════
//  VWB Content Updater — Rubato + Organ + Service Pack routing
//  Extended delivery system for all three VWB content channels.
// ═══════════════════════════════════════════════════════════════


// ── Rubato Pack Installer ──────────────────────────────────────
//
//  Rubato packs are .vwb JSON files containing:
//    format: 'vwb-rubato-pack'
//    song: { title, key }
//    artist: { name, role, photo }
//    phrases: [{ trigger, line, startTime, endTime, duration, section }]
//    melodicStructure: [{ degree, note }]
//
//  We save the JSON to disk and then make it available to
//  rbLoadVwbPackFromData() — a new function we add to rubato.js
//  that loads a pack from already-parsed data rather than
//  prompting the user to pick a file.

async function _vwbInstallRubatoPack(pack, metadata, buffer) {
  if (!window.vwb || typeof window.vwb.saveRubatoPack !== 'function') {
    throw new Error('window.vwb.saveRubatoPack() not available');
  }

  // Buffer is the .vwb JSON file content
  const text    = new TextDecoder().decode(new Uint8Array(buffer));
  const vwbPack = JSON.parse(text);

  if (vwbPack.format !== 'vwb-rubato-pack') {
    throw new Error('Downloaded file is not a valid vwb-rubato-pack');
  }

  // Save to userData/rubato-packs/[packId]/pack.vwb
  await window.vwb.saveRubatoPack({
    packId:  pack.id,
    vwbData: text, // save as raw JSON string
    title:   vwbPack.song?.title || pack.title,
  });

  console.log('[VWBUpdater] Rubato pack installed:', pack.id, '—', vwbPack.song?.title);

  // If Rubato Mode is currently loaded, refresh its pack list
  if (typeof rbRefreshInstalledPacks === 'function') rbRefreshInstalledPacks();
}


// ── Organ Pack Installer ───────────────────────────────────────
//
//  Organ content packs contain WAV samples that extend what's
//  already in the user's organ folder. The pack is a ZIP archive
//  containing WAV files named in the existing VWB organ convention:
//    organ_[KEY]_[LEVEL]_[NUMBER].wav
//    e.g. organ_C_1_1.wav, organ_Db_2_3.wav
//
//  We extract the WAVs into the user's existing abRootFolder so
//  abScanFolder() picks them up automatically on next scan.
//  If the user hasn't set a root folder yet, we save to a default
//  location in userData/organ-samples/.

async function _vwbInstallOrganPack(pack, metadata, buffer) {
  if (!window.vwb || typeof window.vwb.saveOrganPack !== 'function') {
    throw new Error('window.vwb.saveOrganPack() not available');
  }

  // Target folder: user's existing organ root, or default userData folder
  const targetFolder = (typeof abRootFolder !== 'undefined' && abRootFolder)
    ? abRootFolder
    : null; // main process will use userData/organ-samples/ as default

  await window.vwb.saveOrganPack({
    packId:       pack.id,
    zipData:      Array.from(new Uint8Array(buffer)),
    targetFolder, // null = use default
  });

  console.log('[VWBUpdater] Organ pack installed:', pack.id);

  // Re-scan organ folder so new samples are immediately available
  if (typeof abScanFolder === 'function') {
    await abScanFolder();
    if (typeof renderArmorBearerSetup  === 'function') renderArmorBearerSetup();
    if (typeof renderArmorBearerPerform === 'function') renderArmorBearerPerform();
  }
}


// ── Service Pack Installer ─────────────────────────────────────
//
//  Service Packs are .vwbp files (renamed ZIP archives) that can
//  contain any combination of:
//    house-band/   → song charts → House Band chart loader
//    rubato/       → .vwb files  → Rubato Mode pack list
//    organ/        → WAV files   → Armor Bearer organ samples
//    service/      → audio/MIDI  → Service Pack categories
//    loops/        → audio files → Loop Library
//    settings.json → mixer/tempo presets
//
//  This is the premium content channel — purchased through
//  Lemon Squeezy, opened by the user in VWB.
//  The .vwbp format standard is documented in:
//    VWB_Bundle_Format_Standard_v1_0.docx

async function vwbOpenServicePack(filePath) {
  if (!window.vwb || typeof window.vwb.openServicePack !== 'function') {
    if (typeof showNotification === 'function')
      showNotification('Service Pack support not yet wired in main process.');
    return;
  }

  if (typeof showNotification === 'function')
    showNotification('⏳ Opening Service Pack…');

  try {
    const result = await window.vwb.openServicePack(filePath);
    if (!result.success) throw new Error(result.error || 'Unknown error');

    const summary = [];

    // ── Route each content type to its destination ──

    if (result.houseBandCharts && result.houseBandCharts.length) {
      // Load into House Band chart loader
      result.houseBandCharts.forEach(chart => {
        if (typeof hbLoadChartObject === 'function') {
          hbLoadChartObject(chart.data, chart.fileName);
        }
      });
      summary.push(result.houseBandCharts.length + ' chart(s)');
    }

    if (result.rubatoPacks && result.rubatoPacks.length) {
      // Save each .vwb file to rubato-packs folder
      for (const vwbFile of result.rubatoPacks) {
        await window.vwb.saveRubatoPack({
          packId:  'sp-' + vwbFile.fileName.replace('.vwb',''),
          vwbData: vwbFile.content,
          title:   vwbFile.fileName,
        });
      }
      if (typeof rbRefreshInstalledPacks === 'function') rbRefreshInstalledPacks();
      summary.push(result.rubatoPacks.length + ' Rubato song(s)');
    }

    if (result.organSamples && result.organSamples.length) {
      // Save WAV files to organ folder
      await window.vwb.saveOrganSamples({
        files:        result.organSamples,
        targetFolder: (typeof abRootFolder !== 'undefined' && abRootFolder) ? abRootFolder : null,
      });
      if (typeof abScanFolder === 'function') await abScanFolder();
      summary.push(result.organSamples.length + ' organ sample(s)');
    }

    if (result.loops && result.loops.length) {
      // Add to loop library
      if (typeof addLoopsToLibrary === 'function') {
        addLoopsToLibrary(result.loops);
      }
      summary.push(result.loops.length + ' loop(s)');
    }

    if (result.settings) {
      // Apply mixer/tempo presets
      if (result.settings.tempo && typeof setTempo === 'function') {
        setTempo(result.settings.tempo);
      }
      if (result.settings.masterVolume !== undefined && typeof setMasterVol === 'function') {
        setMasterVol(result.settings.masterVolume);
      }
    }

    const packName = result.packInfo?.name || 'Service Pack';
    const msg = summary.length
      ? '✅ ' + packName + ' loaded — ' + summary.join(', ')
      : '✅ ' + packName + ' loaded';

    if (typeof showNotification === 'function') showNotification(msg);
    console.log('[VWBUpdater]', msg);

    // Refresh Band UI to show any new charts
    if (typeof bandUiRender === 'function') bandUiRender();

  } catch(e) {
    console.error('[VWBUpdater] Service Pack open error:', e.message);
    if (typeof showNotification === 'function')
      showNotification('❌ Could not open Service Pack: ' + e.message);
  }
}

// User-facing: File picker → open Service Pack
async function vwbPickAndOpenServicePack() {
  try {
    const result = await window.vwb.pickAnyFile({ title: 'Open VWB Service Pack (.vwbp)' });
    if (!result || result.canceled || !result.filePaths?.length) return;
    await vwbOpenServicePack(result.filePaths[0]);
  } catch(e) {
    if (typeof showNotification === 'function')
      showNotification('❌ Could not open Service Pack: ' + e.message);
  }
}
