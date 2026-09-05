// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Bundle Handler (Renderer)
//  js/vwb-bundle.js
//
//  Handles opening .vwbp bundles from the renderer side.
//  Receives the parsed bundle result from main.js via IPC,
//  then routes every section to the correct VWB system:
//
//    songs.json       → Song Library (songLibraryIngestFromBundle)
//    house-band/      → Song Library + House Band engine
//    service/         → Service Pack browser
//    rubato/          → Rubato Mode
//    loops/           → Loop Library
//    organ/           → Armor Bearer organ module
//    stems/           → Song Setup stem slots
//    settings.json    → Mixer / tempo / reverb
//
//  Called by: index.html → vwbOpenBundle()
//  Depends on: song-library.js, service-pack.js, rubato.js,
//              loop-library.js, armor-bearer.js, state.js
// ═══════════════════════════════════════════════════════════════


// ── Entry Point ────────────────────────────────────────────────

/**
 * Opens a .vwbp bundle via file picker, parses it, and routes all
 * content to the appropriate VWB systems. Called from the Service
 * Packs tab "Open .vwbp Bundle" button.
 */
async function vwbOpenBundle() {
  if (!window.vwb || typeof window.vwb.openVwbBundle !== 'function') {
    console.error('[VwbBundle] window.vwb.openVwbBundle is not available.');
    return;
  }

  let result;
  try {
    result = await window.vwb.openVwbBundle();
  } catch (e) {
    console.error('[VwbBundle] IPC error opening bundle:', e);
    if (typeof showNotification === 'function') {
      showNotification('⚠ Could not open bundle — ' + e.message);
    }
    return;
  }

  if (!result || result.canceled) return;
  if (!result.success) {
    console.error('[VwbBundle] Bundle open failed:', result.error);
    if (typeof showNotification === 'function') {
      showNotification('⚠ Bundle error: ' + (result.error || 'Unknown error'));
    }
    return;
  }

  await vwbIngestBundle(result);
}


/**
 * Ingests a parsed bundle result object (as returned by main.js
 * vwb:openVwbBundle handler). Can also be called programmatically
 * if a bundle was opened through another path.
 *
 * @param {Object} result - the full bundle result from main process
 */
async function vwbIngestBundle(result) {
  const { packInfo, summary, settings } = result;
  const bundleName = packInfo ? packInfo.name : 'Bundle';

  console.group('[VwbBundle] Ingesting: ' + bundleName);
  console.log('Summary:', summary);

  let sectionsLoaded = [];

  // ── 1. Song Library (songs.json) ─────────────────────────────
  // This is the primary Song Library integration. If the bundle has
  // a songs.json, every song in it is registered into the library.
  if (result.bundleSongs && result.bundleSongs.length > 0) {
    const count = await _bundleIngestSongs(result.bundleSongs, result, packInfo);
    if (count > 0) {
      sectionsLoaded.push(count + ' song' + (count !== 1 ? 's' : '') + ' → Library');
    }
  }

  // ── 2. House Band charts (house-band/*.json) ──────────────────
  // These are full VWB Song Chart JSON files. Each one is also
  // registered into the Song Library as a house-band engine song.
  if (result.houseBandCharts && result.houseBandCharts.length > 0) {
    const count = await _bundleIngestHouseBandCharts(result.houseBandCharts);
    if (count > 0) {
      sectionsLoaded.push(count + ' chart' + (count !== 1 ? 's' : '') + ' → House Band');
    }
  }

  // ── 3. Service Pack categories (service/**) ───────────────────
  if (summary && summary.hasServiceCategories && result.categories) {
    _bundleIngestServiceCategories(result.categories, packInfo);
    sectionsLoaded.push('Service Pack content → Service Packs');
  }

  // ── 4. Rubato MIDI files (rubato/*.mid) ───────────────────────
  if (result.rubatoFiles && result.rubatoFiles.length > 0) {
    _bundleIngestRubatoFiles(result.rubatoFiles);
    sectionsLoaded.push(result.rubatoFiles.length + ' Rubato file' +
      (result.rubatoFiles.length !== 1 ? 's' : '') + ' → Rubato Mode');
  }

  // ── 5. Loop Library (loops/**) ────────────────────────────────
  if (result.loopFiles && result.loopFiles.length > 0) {
    _bundleIngestLoops(result.loopFiles);
    sectionsLoaded.push(result.loopFiles.length + ' loop' +
      (result.loopFiles.length !== 1 ? 's' : '') + ' → Loop Library');
  }

  // ── 6. Organ samples (organ/**) ───────────────────────────────
  if (result.organFiles && result.organFiles.length > 0) {
    _bundleIngestOrganSamples(result.organFiles);
    sectionsLoaded.push(result.organFiles.length + ' organ sample' +
      (result.organFiles.length !== 1 ? 's' : '') + ' → Organ');
  }

  // ── 7. Audio stems (stems/**) ────────────────────────────────
  if (result.stemSongs && Object.keys(result.stemSongs).length > 0) {
    _bundleIngestStems(result.stemSongs);
    const count = Object.keys(result.stemSongs).length;
    sectionsLoaded.push(count + ' stem song' + (count !== 1 ? 's' : '') + ' → Song Setup');
  }

  // ── 8. Percussion loops (percussion/*.mid) ────────────────────
  if (result.percussionLoops && result.percussionLoops.length > 0) {
    const count = await _bundleIngestPercussionLoops(result.percussionLoops);
    if (count > 0) {
      sectionsLoaded.push(count + ' drum loop' + (count !== 1 ? 's' : '') + ' → Percussion Center');
    }
  }

  // ── 9. Settings preset ────────────────────────────────────────
  if (settings) {
    _bundleApplySettings(settings);
    sectionsLoaded.push('Settings → Applied');
  }

  console.log('[VwbBundle] Loaded:', sectionsLoaded.join(' | '));
  console.groupEnd();

  // ── Notify + Navigate ─────────────────────────────────────────
  const summary_str = sectionsLoaded.length > 0
    ? sectionsLoaded.join(' · ')
    : 'No content found in bundle';

  if (typeof showNotification === 'function') {
    showNotification('📦 ' + bundleName + ' loaded — ' + summary_str);
  }

  // Show the bundle summary modal
  _bundleShowSummary(bundleName, packInfo, sectionsLoaded, result);

  // Navigate to Song Library if songs were added — that's the most
  // useful landing spot for a new purchase
  if ((result.bundleSongs && result.bundleSongs.length > 0) ||
      (result.houseBandCharts && result.houseBandCharts.length > 0)) {
    if (typeof goView === 'function') goView('library');
  } else if (summary && summary.hasServiceCategories) {
    if (typeof goView === 'function') goView('library');
  }
}


// ── Section Handlers ───────────────────────────────────────────

/**
 * Ingests songs.json entries into the Song Library.
 * Each entry is a full song descriptor with engine, key, style, etc.
 * File paths in the entry (e.g. for rubato midiPath or stems paths)
 * are resolved against the bundle's extracted temp directory.
 */
async function _bundleIngestSongs(bundleSongs, result, packInfo) {
  if (typeof songLibraryInit !== 'function') {
    console.warn('[VwbBundle] Song Library not available — song-library.js may not be loaded.');
    return 0;
  }
  await songLibraryInit();

  let count = 0;
  for (const song of bundleSongs) {
    if (!song.id || !song.title || !song.engine) {
      console.warn('[VwbBundle] Skipping invalid song entry (missing id/title/engine):', song);
      continue;
    }

    // Resolve any file paths relative to the bundle's temp directory
    const resolved = { ...song, source: 'bundle' };

    // Rubato songs: resolve midiPath to extracted temp file
    if (song.engine === 'rubato' && song.midiFile && result.rubatoFiles) {
      const match = result.rubatoFiles.find(f => f.name === song.midiFile);
      if (match) resolved.midiPath = match.path;
    }

    // Audio stem songs: resolve stem paths from stemSongs
    if (song.engine === 'audio' && song.stemSongTitle && result.stemSongs) {
      const stems = result.stemSongs[song.stemSongTitle];
      if (stems) resolved.stems = stems;
    }

    // House band songs with inline chart
    if (song.engine === 'house-band' && song.chartFile && result.houseBandCharts) {
      const match = result.houseBandCharts.find(c => c.name === song.chartFile.replace('.json',''));
      if (match) resolved.chart = match.chart;
    }

    // Add creator credit from pack-info if not already on song
    if (!resolved.artist && packInfo && packInfo.creator) {
      resolved.artist = packInfo.creator;
    }

    const ok = await songLibraryAddSong(resolved);
    if (ok) count++;
  }
  return count;
}

/**
 * Ingests house-band/*.json chart files into the Song Library.
 * Builds a minimal song descriptor from the chart data itself.
 * (songs.json is the preferred path; this is the fallback for
 * bundles that include charts but no songs.json.)
 */
async function _bundleIngestHouseBandCharts(charts) {
  if (typeof songLibraryIngestBundleCharts === 'function') {
    await songLibraryIngestBundleCharts(charts.map(c => c.chart));
    return charts.length;
  }
  return 0;
}

/**
 * Loads service/* category files into the Service Pack browser.
 * Delegates to the existing service-pack.js loadBundleCategories()
 * if available, otherwise falls back to direct state mutation.
 */
function _bundleIngestServiceCategories(categories, packInfo) {
  if (typeof loadBundleCategories === 'function') {
    loadBundleCategories(categories, packInfo);
    return;
  }
  // Fallback: store in window state for service-pack.js to pick up
  window._vwbBundleCategories = categories;
  window._vwbBundlePackInfo   = packInfo;
  if (typeof refreshServicePackUI === 'function') refreshServicePackUI();
}

/**
 * Loads rubato/*.mid files into Rubato Mode's folder.
 */
function _bundleIngestRubatoFiles(rubatoFiles) {
  if (typeof rubatoLoadBundleFiles === 'function') {
    rubatoLoadBundleFiles(rubatoFiles.map(f => f.path));
    return;
  }
  // Fallback: store for rubato.js to consume
  window._vwbBundleRubatoFiles = rubatoFiles;
}

/**
 * Adds loop files to the Loop Library.
 */
function _bundleIngestLoops(loopFiles) {
  if (typeof loopLibraryAddFiles === 'function') {
    loopLibraryAddFiles(loopFiles.map(f => f.path));
    return;
  }
  window._vwbBundleLoopFiles = loopFiles;
}

/**
 * Loads percussion/*.mid files from a bundle directly into the
 * Percussion Center's Saved Loops list (mmpcLoops).
 * Each MIDI file is parsed and added as a named loop — available
 * immediately for playback without any manual import step.
 */
async function _bundleIngestPercussionLoops(loopFiles) {
  if (!loopFiles || loopFiles.length === 0) return 0;
  let count = 0;
  for (const f of loopFiles) {
    try {
      // Read the MIDI file buffer via IPC
      const rb = await window.vwb.readFileBuffer(f.path);
      if (!rb || !rb.success || !rb.buffer) continue;

      // Parse it using the existing MPC MIDI parser
      if (typeof mmpcParseMidi !== 'function') {
        console.warn('[VwbBundle] mmpcParseMidi not available — percussion loops skipped');
        break;
      }
      const parsed = mmpcParseMidi(rb.buffer);
      if (!parsed || !parsed.notes || parsed.notes.length === 0) continue;

      // Derive a clean display title from the file name
      // e.g. "ITSO_Lord_You_Are_Good.mid" → "ITSO — Lord You Are Good"
      const raw = f.name.replace(/\.mid$/i, '');
      const title = raw.replace(/_/g, ' ').replace(/^ITSO\s+/i, 'ITSO — ');

      // Avoid duplicate titles
      if (typeof mmpcLoops !== 'undefined' && mmpcLoops.some(l => l.title === title)) continue;

      // Push into the drum machine loop list
      if (typeof mmpcLoops !== 'undefined') {
        mmpcLoops.push({
          title,
          bpm:      parsed.bpm      || 120,
          events:   parsed.notes,
          duration: parsed.duration || 0,
          speed:    1.0
        });
        count++;
      }
    } catch (e) {
      console.warn('[VwbBundle] Percussion loop load error:', f.name, e.message);
    }
  }
  // Refresh the loop list UI if visible
  if (count > 0 && typeof mmpcRenderLoopList === 'function') {
    mmpcRenderLoopList();
  }
  return count;
}

/**
 * Makes organ sample files available to the Armor Bearer module.
 */
function _bundleIngestOrganSamples(organFiles) {
  if (typeof abIngestOrganSamples === 'function') {
    abIngestOrganSamples(organFiles.map(f => f.path));
    return;
  }
  window._vwbBundleOrganFiles = organFiles;
}

/**
 * Loads audio stem songs into Song Setup.
 */
function _bundleIngestStems(stemSongs) {
  window._vwbBundleStemSongs = stemSongs;
  if (typeof showNotification === 'function' && Object.keys(stemSongs).length > 0) {
    const titles = Object.keys(stemSongs).slice(0, 3).join(', ');
    const extra  = Object.keys(stemSongs).length > 3 ? ' and more' : '';
    showNotification('🎵 Stems loaded: ' + titles + extra + ' — open Song Setup to use');
  }
}

/**
 * Applies a settings.json preset to VWB's mixer, tempo, and reverb.
 */
function _bundleApplySettings(settings) {
  try {
    if (settings.tempo && typeof onSongTempoChange === 'function') {
      const tempoEl = document.getElementById('songTempo');
      if (tempoEl) { tempoEl.value = settings.tempo; onSongTempoChange(settings.tempo); }
    }
    if (settings.masterVolume !== undefined && typeof setMasterVolume === 'function') {
      setMasterVolume(settings.masterVolume);
    }
    if (settings.reverbLevel !== undefined && typeof setReverbLevel === 'function') {
      setReverbLevel(settings.reverbLevel);
    }
  } catch (e) {
    console.warn('[VwbBundle] Settings apply error:', e);
  }
}


// ── Summary Modal ──────────────────────────────────────────────

/**
 * Shows a brief summary panel after a bundle is opened so the
 * worship leader knows exactly what was loaded and where it went.
 */
function _bundleShowSummary(name, packInfo, sectionsLoaded, result) {
  // Remove any existing summary
  const existing = document.getElementById('vwbBundleSummary');
  if (existing) existing.remove();

  const desc = (packInfo && packInfo.description) ? packInfo.description : '';
  const creator = (packInfo && packInfo.creator) ? packInfo.creator : '';
  const songCount = (result.bundleSongs && result.bundleSongs.length) ||
                    (result.houseBandCharts && result.houseBandCharts.length) || 0;

  const sectionHtml = sectionsLoaded.map(s =>
    `<div style="display:flex;align-items:center;gap:.5rem;font-size:.82rem;color:var(--text-secondary);padding:.25rem 0;">
      <span style="color:var(--green);font-size:.9rem;">✓</span> ${s}
    </div>`
  ).join('');

  const panel = document.createElement('div');
  panel.id = 'vwbBundleSummary';
  panel.style.cssText = `
    position:fixed;bottom:1.5rem;right:1.5rem;z-index:900;
    background:var(--bg-card);border:1px solid rgba(64,224,208,.35);
    border-radius:14px;padding:1.25rem 1.5rem;
    box-shadow:0 8px 32px rgba(0,0,0,.5);
    max-width:340px;animation:slSummaryIn .25s ease;
  `;

  panel.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:.75rem;">
      <div>
        <div style="font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:.2rem;">Bundle Loaded</div>
        <div style="font-size:.95rem;font-weight:600;color:var(--text-primary);">${_bundleEscape(name)}</div>
        ${creator ? `<div style="font-size:.75rem;color:var(--text-dim);margin-top:.1rem;">by ${_bundleEscape(creator)}</div>` : ''}
      </div>
      <button onclick="document.getElementById('vwbBundleSummary').remove()" style="
        background:none;border:none;cursor:pointer;color:var(--text-dim);
        font-size:1.1rem;padding:.1rem .3rem;line-height:1;margin-left:.75rem;flex-shrink:0;">✕</button>
    </div>
    ${desc ? `<div style="font-size:.78rem;color:var(--text-secondary);margin-bottom:.75rem;line-height:1.5;">${_bundleEscape(desc)}</div>` : ''}
    <div style="border-top:1px solid var(--border);padding-top:.75rem;">
      ${sectionHtml || '<div style="font-size:.82rem;color:var(--text-dim);">No content was found in this bundle.</div>'}
    </div>
    ${songCount > 0 ? `
    <button onclick="if(typeof goView==='function')goView('library');document.getElementById('vwbBundleSummary').remove();" style="
      margin-top:.85rem;width:100%;font-family:'Outfit',sans-serif;font-size:.82rem;font-weight:600;
      padding:.45rem 1rem;border-radius:8px;cursor:pointer;
      border:1.5px solid var(--accent);background:rgba(64,224,208,.12);color:var(--accent);">
      📚 View in Song Library
    </button>` : ''}
  `;

  // Auto-dismiss after 12 seconds
  document.body.appendChild(panel);
  setTimeout(() => { if (panel.parentNode) panel.remove(); }, 12000);
}

// Inject summary animation
(function() {
  const style = document.createElement('style');
  style.textContent = `@keyframes slSummaryIn {
    from { opacity:0; transform:translateY(12px); }
    to   { opacity:1; transform:translateY(0); }
  }`;
  document.head.appendChild(style);
})();

function _bundleEscape(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}


// ── songs.json Format Documentation ───────────────────────────
//
//  songs.json is the Song Library manifest for a .vwbp bundle.
//  It lives in the root of the zip archive alongside pack-info.json.
//
//  Format:
//  {
//    "version": "1.0",
//    "songs": [
//      {
//        REQUIRED:
//        "id":     "unique-song-id",        string, unique per song
//        "title":  "Song Title",            string
//        "engine": "house-band",            "house-band"|"audio"|"rubato"|"organ"
//
//        RECOMMENDED:
//        "artist":  "Songwriter Name",
//        "style":   "Congregational / Hymn",  matches SL_STYLES taxonomy
//        "feel":    "Straight",               "Straight"|"Swing"
//        "mood":    "Peaceful / Calm",         matches SL_MOODS taxonomy
//        "key":     "Bb",                     key of C, Db, D, ... B
//        "tempo":   76,                       BPM
//        "description": "Short description of the song and its use.",
//        "tags":    ["hymn", "congregational", "slow"],
//
//        ENGINE-SPECIFIC (one of these per engine type):
//
//        house-band engine:
//        "chartFile": "my-song-chart.json"   filename in house-band/ folder
//
//        rubato engine:
//        "midiFile": "my-song.mid"           filename in rubato/ folder
//
//        audio engine:
//        "stemSongTitle": "My Song"          folder name under stems/
//
//        organ engine:
//        (no extra fields — user configures organ separately)
//      }
//    ]
//  }
//
//  EXAMPLE — a bundle with one of each engine type:
//  {
//    "version": "1.0",
//    "songs": [
//      {
//        "id":          "hmpi-amazing-grace-hb",
//        "title":       "Amazing Grace",
//        "artist":      "John Newton / HMPI",
//        "engine":      "house-band",
//        "style":       "Congregational / Hymn",
//        "feel":        "Straight",
//        "mood":        "Solemn / Reverent",
//        "key":         "Bb",
//        "tempo":       66,
//        "description": "Classic hymn performed by the VWB House Band.",
//        "tags":        ["hymn", "congregational", "classic"],
//        "chartFile":   "amazing-grace-chart.json"
//      },
//      {
//        "id":          "hmpi-preaching-groove-rubato",
//        "title":       "Preaching Groove in Bb",
//        "artist":      "Kenneth Hollins / HMPI",
//        "engine":      "rubato",
//        "style":       "Preacher / Talking Music Groove",
//        "feel":        "Swing",
//        "mood":        "Standard / Neutral",
//        "key":         "Bb",
//        "tempo":       72,
//        "description": "Voice-triggered preaching groove for Rubato Mode.",
//        "tags":        ["preaching", "rubato", "vamp"],
//        "midiFile":    "preaching-groove-Bb.mid"
//      }
//    ]
//  }
