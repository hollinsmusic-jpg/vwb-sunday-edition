// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Service Pack Browser & Loader
//  Loads and manages VWB Service Packs. Each pack contains
//  12 category folders with MIDI or audio files per instrument.
//  Depends on: state.js, midi-player.js, ui.js
// ═══════════════════════════════════════════════════════════════

// ── Service Pack State ─────────────────────────────────────────
let spPackDir    = '';         // path to loaded pack root folder
let spPackInfo   = {};         // pack-info.json contents
let spCategories = {};         // { catKey: { label, files[] } }
let spSelections = {};         // { catKey: selectedFileIndex }
let spLoaded     = false;

const SP_CATEGORY_ORDER = [
  '01_Prelude', '02_Invocation', '03_PraiseWorship', '04_Fellowship',
  '05_Announcements', '06_HighPraise', '07_DanceShout', '08_SpecialMusic',
  '09_PreachingChords', '10_PrayerTalkingMusic', '11_DiscipleshipInvitation', '12_Dismissal'
];

const SP_CATEGORY_ICONS = {
  '01_Prelude':               '🎵',
  '02_Invocation':            '🙏',
  '03_PraiseWorship':         '🙌',
  '04_Fellowship':            '🤝',
  '05_Announcements':         '📢',
  '06_HighPraise':            '🔥',
  '07_DanceShout':            '💃',
  '08_SpecialMusic':          '🎤',
  '09_PreachingChords':       '⛪',
  '10_PrayerTalkingMusic':    '🕊',
  '11_DiscipleshipInvitation':'✝️',
  '12_Dismissal':             '👋'
};

// ── Open a Service Pack ────────────────────────────────────────

async function openServicePack() {
  const result = await window.vwb.openServicePack();
  if (result.canceled) return;
  if (result.error) { showNotification('❌ Error loading Service Pack: ' + result.error); return; }

  spPackDir    = result.packDir;
  spPackInfo   = result.packInfo;
  spCategories = result.categories;
  spSelections = {};
  spLoaded     = true;

  // Default: select index 0 for any category that has files
  for (const cat of SP_CATEGORY_ORDER) {
    const data = spCategories[cat];
    if (data && data.files.length > 0) {
      spSelections[cat] = 0;
    }
  }

  renderServicePackBrowser();
  showNotification('📦 Service Pack loaded: ' + (spPackInfo.name || 'Untitled Pack'));
}

// ── Render the Service Pack Browser ───────────────────────────

function renderServicePackBrowser() {
  const wrap = document.getElementById('spBrowserWrap');
  if (!wrap) return;

  if (!spLoaded) {
    wrap.innerHTML = `
      <div style="text-align:center;padding:3rem 2rem;">
        <div style="font-size:3rem;margin-bottom:1rem;">📦</div>
        <div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:.5rem;">No Service Pack Loaded</div>
        <div style="font-size:.85rem;color:var(--text-dim);margin-bottom:1.5rem;">
          Load a VWB Service Pack to browse all 12 service categories and quickly load music for your worship service.
        </div>
        <button class="btn btn-primary" onclick="openServicePack()">📂 Load Service Pack</button>
      </div>`;
    return;
  }

  // Count total files
  const totalFiles = SP_CATEGORY_ORDER.reduce((sum, cat) => {
    return sum + ((spCategories[cat] && spCategories[cat].files.length) || 0);
  }, 0);

  const filledCats = SP_CATEGORY_ORDER.filter(cat =>
    spCategories[cat] && spCategories[cat].files.length > 0
  ).length;

  wrap.innerHTML = `
    <!-- Pack Header -->
    <div style="background:linear-gradient(135deg,rgba(64,224,208,.12),rgba(64,224,208,.04));
                border:1px solid var(--accent);border-radius:12px;padding:1.25rem;margin-bottom:1.25rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;">
        <div>
          <div style="font-size:1.1rem;font-weight:700;color:var(--accent);">
            📦 ${escHtml(spPackInfo.name || 'Untitled Pack')}
          </div>
          <div style="font-size:.8rem;color:var(--text-secondary);margin-top:.25rem;">
            ${escHtml(spPackInfo.artist || 'Unknown Artist')}
            ${spPackInfo.version ? ' · v' + escHtml(spPackInfo.version) : ''}
          </div>
          <div style="font-size:.75rem;color:var(--text-dim);margin-top:.2rem;">
            ${filledCats} of 12 categories · ${totalFiles} file${totalFiles !== 1 ? 's' : ''}
          </div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-small" onclick="openServicePack()">↻ Load Different Pack</button>
        </div>
      </div>
    </div>

    <!-- Category Grid -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:.75rem;" id="spCategoryGrid">
      ${SP_CATEGORY_ORDER.map(cat => renderSpCategory(cat)).join('')}
    </div>
  `;
}

// ── Render a single category card ─────────────────────────────

function renderSpCategory(cat) {
  const data  = spCategories[cat];
  const icon  = SP_CATEGORY_ICONS[cat] || '🎵';
  const label = data ? data.label : cat;
  const files = data ? data.files : [];
  const selIdx = spSelections[cat] !== undefined ? spSelections[cat] : 0;
  const hasFiles = files.length > 0;
  const selFile = hasFiles ? files[selIdx] : null;

  const emptyStyle = !hasFiles
    ? 'opacity:.45;border-style:dashed;'
    : '';

  const fileTypeTag = selFile
    ? (selFile.isMidi
        ? `<span style="font-size:.65rem;font-weight:700;color:var(--orange);background:rgba(255,136,68,.15);
                        border:1px solid rgba(255,136,68,.3);border-radius:4px;padding:.1rem .35rem;">MIDI</span>`
        : `<span style="font-size:.65rem;font-weight:700;color:var(--accent);background:rgba(64,224,208,.1);
                        border:1px solid rgba(64,224,208,.2);border-radius:4px;padding:.1rem .35rem;">AUDIO</span>`)
    : '';

  const fileSelector = hasFiles && files.length > 1
    ? `<select onchange="spSelectFile('${cat}', parseInt(this.value))"
         style="width:100%;background:var(--bg-primary);border:1px solid var(--border);
                color:var(--text-primary);padding:.3rem .5rem;border-radius:6px;
                font-size:.75rem;margin-bottom:.5rem;">
         ${files.map((f, i) =>
           `<option value="${i}" ${i === selIdx ? 'selected' : ''}>${escHtml(f.name)}</option>`
         ).join('')}
       </select>`
    : hasFiles
      ? `<div style="font-size:.75rem;color:var(--text-secondary);margin-bottom:.5rem;
                     white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
              title="${escHtml(selFile.name)}">
           ${escHtml(selFile.name)}
         </div>`
      : `<div style="font-size:.75rem;color:var(--text-dim);font-style:italic;margin-bottom:.5rem;">
           No files in this category
         </div>`;

  const metaRow = selFile
    ? `<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem;">
         ${fileTypeTag}
         ${selFile.instrument
           ? `<span style="font-size:.7rem;color:var(--text-dim);">🎸 ${escHtml(selFile.instrument)}</span>`
           : ''}
         ${selFile.key
           ? `<span style="font-size:.7rem;color:var(--text-dim);">🎵 Key: ${escHtml(selFile.key)}</span>`
           : ''}
         ${files.length > 1
           ? `<span style="font-size:.7rem;color:var(--text-dim);margin-left:auto;">${files.length} files</span>`
           : ''}
       </div>`
    : '';

  const loadBtn = hasFiles
    ? `<button onclick="spLoadFile('${cat}')"
         style="width:100%;padding:.45rem;border-radius:7px;border:1px solid var(--accent);
                background:rgba(64,224,208,.1);color:var(--accent);font-size:.8rem;
                font-weight:600;cursor:pointer;transition:all .2s;font-family:'Outfit',sans-serif;"
         onmouseover="this.style.background='rgba(64,224,208,.2)'"
         onmouseout="this.style.background='rgba(64,224,208,.1)'">
         ▶ Load into VWB
       </button>`
    : `<button disabled
         style="width:100%;padding:.45rem;border-radius:7px;border:1px solid var(--border);
                background:none;color:var(--text-dim);font-size:.8rem;cursor:not-allowed;
                font-family:'Outfit',sans-serif;">
         Empty
       </button>`;

  return `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;
                padding:.9rem;transition:border-color .2s;${emptyStyle}"
         ${hasFiles ? `onmouseover="this.style.borderColor='var(--border-hover)'"
                       onmouseout="this.style.borderColor='var(--border)'"` : ''}>
      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.65rem;">
        <span style="font-size:1.2rem;">${icon}</span>
        <span style="font-size:.8rem;font-weight:700;color:var(--text-primary);
                     text-transform:uppercase;letter-spacing:.06em;">${escHtml(label)}</span>
      </div>
      ${fileSelector}
      ${metaRow}
      ${loadBtn}
    </div>`;
}

// ── Select a file within a category ───────────────────────────

function spSelectFile(cat, idx) {
  spSelections[cat] = idx;
  // Re-render just this category card
  const grid = document.getElementById('spCategoryGrid');
  if (!grid) return;
  const cards = grid.querySelectorAll(':scope > div');
  const catIdx = SP_CATEGORY_ORDER.indexOf(cat);
  if (catIdx >= 0 && cards[catIdx]) {
    cards[catIdx].outerHTML = renderSpCategory(cat);
  }
  _spSaveState();
}

// ── Load a selected Service Pack file into VWB ────────────────

async function spLoadFile(cat) {
  const data   = spCategories[cat];
  const selIdx = spSelections[cat] !== undefined ? spSelections[cat] : 0;
  if (!data || !data.files.length) return;

  const file = data.files[selIdx];
  showNotification('⏳ Loading ' + file.name + '…');

  try {
    const result = await window.vwb.readServicePackFile(file.path);
    if (!result.success) {
      showNotification('❌ Could not load file: ' + (result.error || 'Unknown error'));
      return;
    }

    if (result.isMidi) {
      // Load into MIDI player and switch to MIDI engine
      await addMidiFileFromBuffer(result.buffer, result.fileName, result.filePath, {});
      if (typeof setVwbEngine === 'function') setVwbEngine('midi');
      const midiBody = document.getElementById('midiPanelBody');
      if (midiBody && midiBody.style.display === 'none') toggleMidiPanel();
      showNotification('🎹 Loaded MIDI: ' + file.name);
    } else {
      // Load into Aux tracks and switch to audio engine
      await _spLoadAudioFile(result.buffer, result.fileName, result.filePath);
      if (typeof setVwbEngine === 'function') setVwbEngine('audio');
      const ext = file.ext.replace('.', '').toUpperCase();
      showNotification('🎵 Loaded Audio (' + ext + '): ' + file.name);
    }

    _spSaveState();
  } catch (e) {
    showNotification('❌ Load error: ' + e.message);
  }
}

// ── Load audio from buffer into Aux tracks ────────────────────

async function _spLoadAudioFile(buffer, fileName, filePath) {
  try {
    const audioBuffer = await AC.decodeAudioData(buffer.slice(0));
    const gn = AC.createGain();
    gn.gain.value = auxMasterVol / 100;
    gn.connect(auxMasterGain);
    auxTracks.push({
      buf: audioBuffer,
      src: null,
      gn,
      vol: 80,
      fn: fileName,
      muted: false,
      storedPath: filePath
    });
    renderAuxTracks();
  } catch (e) {
    throw new Error('Audio decode failed: ' + e.message);
  }
}

// ── Persist Service Pack selection state ──────────────────────

async function _spSaveState() {
  if (!window.vwb) return;
  await window.vwb.saveServicePackState({
    packDir:    spPackDir,
    packInfo:   spPackInfo,
    selections: spSelections
  });
}

// ── Utility ───────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
