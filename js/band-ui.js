// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Band UI
//  js/band-ui.js
//
//  Renders the "My Band" tab inside VWB — the VWB House Band
//  page showing all seven musicians, their photos, bios, and
//  slot assignment controls.
//
//  Depends on: band-registry.js, state.js (showNotification)
// ═══════════════════════════════════════════════════════════════

// ── Image path helper ─────────────────────────────────────────
//  All band photos live in /band-assets/ relative to index.html

const BAND_AVATAR_PATHS = {
  'hb-drums-jason':   'band-assets/jason-washington.png',
  'hb-perc-diane':    'band-assets/diane-moore.png',
  'hb-bass-terry':    'band-assets/terry-washington.png',
  'hb-keys-julian':   'band-assets/julian-cross.png',
  'hb-organ-paul':    'band-assets/paul-simmons.png',
  'hb-guitar-sanchez':'band-assets/sanchez-rivera.png',
  'hb-aux-larry':     'band-assets/larry-evans.png'
};

// ── State ──────────────────────────────────────────────────────
let _bandUiActiveSlot  = null;   // which slot detail panel is open
// Note: chart player state lives in _cp (chart-player.js)


// ── Main entry point ──────────────────────────────────────────
//  Called by goView('band') in ui.js

function bandUiRender() {
  const wrap = document.getElementById('bandUiRoot');
  if (!wrap) return;
  wrap.innerHTML = _buildBandPage();
  _bandUiBindEvents();

}

// Alias so goView('myband') calling renderBandUI() works
function renderBandUI() { bandUiRender(); }

// ── Public refresh — called by band-registry when assignments change
function bandUiRefresh() {
  const view = document.getElementById('view-myband');
  if (view && view.classList.contains('active')) {
    bandUiRender();
  }
}


// ── Page builder ──────────────────────────────────────────────

function _buildBandPage() {
  const installedPacks = bandGetInstalledPacks();

  return `
<div class="band-page">

  <!-- Header -->
  <div class="band-header">
    <div class="band-header-left">
      <div class="band-header-title">The VWB House Band</div>
      <div class="band-header-sub">Your full-time gospel band — ready every service</div>
    </div>
    <div class="band-header-right">
      <button class="btn btn-secondary btn-small" onclick="bandUiResetAll()">↩ Reset All to House Band</button>
    </div>
  </div>

  <!-- Band grid — percussion hidden until samples are finalized -->
  <div class="band-grid">
    ${BAND_SLOTS.filter(slot => slot !== 'percussion').map(slot => _buildMusicianCard(slot)).join('')}
  </div>

  <!-- Artist Packs section -->
  <div class="band-packs-section">
    <div class="band-section-label">
      <span>🎵 Installed Artist Packs</span>
      <span class="band-pack-count">${installedPacks.length} installed</span>
    </div>
    ${installedPacks.length === 0
      ? _buildEmptyPacks()
      : installedPacks.map(pack => _buildPackRow(pack)).join('')
    }
  </div>

</div>`;
}


// ── Musician card ─────────────────────────────────────────────

function _buildMusicianCard(slot) {
  const musician  = bandGetActive(slot);
  const isHouse   = bandIsHouseMember(slot);
  const available = bandGetAvailable(slot);
  const hasPacks  = available.length > 1;
  const avatarSrc = musician ? (BAND_AVATAR_PATHS[musician.id] || '') : '';
  const slotLabel = BAND_SLOT_LABELS[slot] || slot;
  const slotDesc  = BAND_SLOT_DESCRIPTIONS[slot] || '';

  const artistBadge = !isHouse
    ? `<span class="band-artist-badge">Artist Pack</span>`
    : `<span class="band-house-badge">House Band</span>`;

  const swapBtn = hasPacks
    ? `<button class="band-swap-btn" onclick="bandUiOpenSwap('${slot}')">⇄ Swap Musician</button>`
    : `<button class="band-swap-btn band-swap-disabled" title="No Artist Packs installed for this slot">⇄ Swap Musician</button>`;

  const resetBtn = !isHouse
    ? `<button class="band-reset-btn" onclick="bandUiResetSlot('${slot}')">↩ Use House Band</button>`
    : '';

  return `
<div class="band-card" id="band-card-${slot}">

  <!-- Photo -->
  <div class="band-card-photo-wrap">
    ${avatarSrc
      ? `<img class="band-card-photo" src="${avatarSrc}" alt="${musician ? musician.name : slot}"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
         <div class="band-card-photo-fallback" style="display:none;">${_slotEmoji(slot)}</div>`
      : `<div class="band-card-photo-fallback">${_slotEmoji(slot)}</div>`
    }
    <div class="band-card-slot-pill">${slotLabel}</div>
    ${artistBadge}
  </div>

  <!-- Info -->
  <div class="band-card-info">
    <div class="band-card-name">${musician ? musician.name : 'Unassigned'}</div>
    <div class="band-card-style">${musician ? musician.style : slotDesc}</div>
    <div class="band-card-bio">${musician ? musician.bio : ''}</div>
  </div>

  <!-- Actions -->
  <div class="band-card-actions">
    ${swapBtn}
    ${resetBtn}
  </div>

</div>`;
}


// ── Empty packs state ─────────────────────────────────────────

function _buildEmptyPacks() {
  return `
<div class="band-packs-empty">
  <div class="band-packs-empty-icon">🎵</div>
  <div class="band-packs-empty-title">No Artist Packs installed yet</div>
  <div class="band-packs-empty-sub">
    Purchase an Artist Series pack from the HMPI store to bring a real gospel musician's
    playing style into your band. Each pack replaces one slot with that artist's
    personal playing DNA.
  </div>
  <a class="band-packs-shop-btn" href="#"
     onclick="if(window.vwb&&window.vwb.openExternal)window.vwb.openExternal('https://virtualworshipband.netlify.app');return false;">
    Browse Artist Packs →
  </a>
</div>`;
}


// ── Installed pack row ────────────────────────────────────────

function _buildPackRow(pack) {
  const isActive = bandAssignments && bandAssignments[pack.slot] === pack.id;
  const slotLabel = BAND_SLOT_LABELS[pack.slot] || pack.slot;

  return `
<div class="band-pack-row ${isActive ? 'band-pack-active' : ''}">
  <div class="band-pack-slot-pill">${slotLabel}</div>
  <div class="band-pack-info">
    <div class="band-pack-name">${escHtml(pack.name || 'Unknown Pack')}</div>
    <div class="band-pack-artist">${escHtml(pack.artist || '')}</div>
  </div>
  <div class="band-pack-actions">
    ${isActive
      ? `<span class="band-pack-active-label">✓ Active</span>`
      : `<button class="band-swap-btn btn-small" onclick="bandAssign('${pack.slot}','${pack.id}');bandUiRefresh();">Use This Artist</button>`
    }
    <button class="band-reset-btn btn-small" onclick="bandUiConfirmRemovePack('${pack.id}')">Remove</button>
  </div>
</div>`;
}


// ── Swap modal ────────────────────────────────────────────────
//  Opens inline within the card so the user can pick a musician

function bandUiOpenSwap(slot) {
  const available = bandGetAvailable(slot);
  const current   = bandGetActive(slot);
  const slotLabel = BAND_SLOT_LABELS[slot] || slot;

  // Build modal HTML
  const modal = document.createElement('div');
  modal.id = 'bandSwapModal';
  modal.className = 'band-swap-modal-overlay';
  modal.innerHTML = `
<div class="band-swap-modal">
  <div class="band-swap-modal-header">
    <span class="band-swap-modal-title">Choose musician for ${slotLabel}</span>
    <button class="band-swap-modal-close" onclick="bandUiCloseSwap()">✕</button>
  </div>
  <div class="band-swap-modal-list">
    ${available.map(m => {
      const isSelected = current && m.id === current.id;
      const avatarSrc  = BAND_AVATAR_PATHS[m.id] || '';
      return `
<div class="band-swap-option ${isSelected ? 'band-swap-selected' : ''}"
     onclick="bandUiSelectMusician('${slot}', '${m.id}')">
  <div class="band-swap-option-photo">
    ${avatarSrc
      ? `<img src="${avatarSrc}" alt="${m.name}" onerror="this.style.display='none'">`
      : `<span>${_slotEmoji(slot)}</span>`
    }
  </div>
  <div class="band-swap-option-info">
    <div class="band-swap-option-name">${m.name}</div>
    <div class="band-swap-option-style">${m.style}</div>
    <span class="band-swap-option-type">${m.type === 'house' ? 'House Band' : 'Artist Pack'}</span>
  </div>
  ${isSelected ? '<div class="band-swap-check">✓</div>' : ''}
</div>`;
    }).join('')}
  </div>
  <div class="band-swap-modal-footer">
    <button class="btn btn-secondary" onclick="bandUiCloseSwap()">Cancel</button>
  </div>
</div>`;

  document.body.appendChild(modal);

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) bandUiCloseSwap();
  });
}

function bandUiCloseSwap() {
  const modal = document.getElementById('bandSwapModal');
  if (modal) modal.remove();
}

function bandUiSelectMusician(slot, musicianId) {
  bandAssign(slot, musicianId);
  bandUiCloseSwap();
  bandUiRefresh();
}


// ── Actions ───────────────────────────────────────────────────

function bandUiResetSlot(slot) {
  bandResetSlot(slot);
  bandUiRefresh();
}

function bandUiResetAll() {
  if (!confirm('Reset all slots back to the VWB House Band?')) return;
  bandResetAll();
  bandUiRefresh();
}

function bandUiConfirmRemovePack(packId) {
  const pack = bandGetInstalledPacks().find(p => p.id === packId);
  if (!pack) return;
  if (!confirm('Remove "' + pack.name + '"?\n\nIf this artist is currently assigned to a slot, that slot will reset to the house band.')) return;
  bandRemovePack(packId);
  bandUiRefresh();
}


// ── Event binding ─────────────────────────────────────────────

function _bandUiBindEvents() {
  // Nothing needed — all events are inline onclick for now
  // This hook is here for future keyboard navigation etc.
}


// ── Helpers ───────────────────────────────────────────────────

function _slotEmoji(slot) {
  return { drums: '🥁', percussion: '🪘', bass: '🎸', keys: '🎹', organ: '🎹', guitar: '🎸', aux: '🎛' }[slot] || '🎵';
}

function escHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ── CSS — injected once into <head> ───────────────────────────
//  Matches VWB's existing dark theme CSS variables exactly.

(function _injectBandStyles() {
  if (document.getElementById('band-ui-styles')) return;
  const style = document.createElement('style');
  style.id = 'band-ui-styles';
  style.textContent = `

/* ── Band Page Layout ── */
.band-page { max-width: 1100px; padding-bottom: 2rem; }

.band-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.band-header-title {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: .06em;
}
.band-header-sub {
  font-size: .85rem;
  color: var(--text-secondary);
  margin-top: .2rem;
}

/* ── Band Grid ── */
.band-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.25rem;
  margin-bottom: 2rem;
}

/* ── Musician Card ── */
.band-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: border-color .2s, box-shadow .2s;
}
.band-card:hover {
  border-color: var(--border-hover);
  box-shadow: 0 4px 24px rgba(64,224,208,.08);
}

/* Photo area */
.band-card-photo-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  background: var(--bg-tertiary);
  overflow: hidden;
}
.band-card-photo {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.band-card-photo-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 3.5rem;
  background: var(--bg-tertiary);
}
.band-card-slot-pill {
  position: absolute;
  bottom: 10px;
  left: 10px;
  background: rgba(0,0,0,.72);
  color: var(--accent);
  font-size: .7rem;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  padding: .25rem .6rem;
  border-radius: 20px;
  border: 1px solid rgba(64,224,208,.3);
  backdrop-filter: blur(4px);
}
.band-house-badge {
  position: absolute;
  top: 10px;
  right: 10px;
  background: rgba(64,224,208,.15);
  color: var(--accent);
  font-size: .65rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  padding: .2rem .55rem;
  border-radius: 4px;
  border: 1px solid rgba(64,224,208,.3);
}
.band-artist-badge {
  position: absolute;
  top: 10px;
  right: 10px;
  background: rgba(255,136,68,.15);
  color: var(--orange);
  font-size: .65rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  padding: .2rem .55rem;
  border-radius: 4px;
  border: 1px solid rgba(255,136,68,.3);
}

/* Info */
.band-card-info {
  padding: 1rem 1.1rem .75rem;
  flex: 1;
}
.band-card-name {
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: .2rem;
}
.band-card-style {
  font-size: .75rem;
  color: var(--accent);
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
  margin-bottom: .65rem;
}
.band-card-bio {
  font-size: .8rem;
  color: var(--text-secondary);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Actions */
.band-card-actions {
  padding: .75rem 1.1rem 1rem;
  display: flex;
  gap: .5rem;
  border-top: 1px solid var(--border);
}
.band-swap-btn {
  flex: 1;
  padding: .45rem .75rem;
  border-radius: 7px;
  border: 1px solid var(--accent);
  background: rgba(64,224,208,.08);
  color: var(--accent);
  font-size: .8rem;
  font-weight: 600;
  cursor: pointer;
  transition: background .15s;
  font-family: 'Outfit', sans-serif;
}
.band-swap-btn:hover { background: rgba(64,224,208,.18); }
.band-swap-disabled {
  border-color: var(--border);
  background: none;
  color: var(--text-dim);
  cursor: not-allowed;
  opacity: .5;
}
.band-swap-disabled:hover { background: none; }
.band-reset-btn {
  padding: .45rem .75rem;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text-secondary);
  font-size: .8rem;
  cursor: pointer;
  transition: border-color .15s, color .15s;
  font-family: 'Outfit', sans-serif;
}
.band-reset-btn:hover { border-color: var(--red); color: var(--red); }

/* ── Section label ── */
.band-section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: .75rem;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--text-dim);
  padding-bottom: .6rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1rem;
}
.band-pack-count {
  font-size: .75rem;
  color: var(--text-dim);
  font-weight: 400;
}

/* ── Empty packs ── */
.band-packs-empty {
  background: var(--bg-card);
  border: 1px dashed var(--border);
  border-radius: 12px;
  padding: 2.5rem 2rem;
  text-align: center;
}
.band-packs-empty-icon { font-size: 2.5rem; margin-bottom: .75rem; }
.band-packs-empty-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: .5rem;
}
.band-packs-empty-sub {
  font-size: .85rem;
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 480px;
  margin: 0 auto 1.25rem;
}
.band-packs-shop-btn {
  display: inline-block;
  padding: .6rem 1.5rem;
  border-radius: 8px;
  background: rgba(64,224,208,.1);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: .875rem;
  font-weight: 600;
  text-decoration: none;
  transition: background .15s;
}
.band-packs-shop-btn:hover { background: rgba(64,224,208,.2); }

/* ── Pack rows ── */
.band-pack-row {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: .85rem 1rem;
  display: flex;
  align-items: center;
  gap: .85rem;
  margin-bottom: .6rem;
  transition: border-color .15s;
}
.band-pack-row:hover { border-color: var(--border-hover); }
.band-pack-active { border-color: var(--accent); background: rgba(64,224,208,.04); }
.band-pack-slot-pill {
  font-size: .65rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--accent);
  background: rgba(64,224,208,.1);
  border: 1px solid rgba(64,224,208,.2);
  padding: .25rem .6rem;
  border-radius: 20px;
  white-space: nowrap;
  flex-shrink: 0;
}
.band-pack-info { flex: 1; min-width: 0; }
.band-pack-name {
  font-size: .9rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: .15rem;
}
.band-pack-artist { font-size: .8rem; color: var(--text-secondary); }
.band-pack-actions { display: flex; gap: .5rem; align-items: center; flex-shrink: 0; }
.band-pack-active-label {
  font-size: .8rem;
  font-weight: 600;
  color: var(--green);
}

/* ── House Band Perform Section ── */
.hb-perform-section {
  background: var(--bg-card);
  border: 1px solid rgba(64,224,208,0.15);
  border-radius: 16px;
  padding: 1.5rem;
  margin-bottom: 2rem;
}
.hb-perform-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.hb-perform-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: .04em;
  margin-bottom: .2rem;
}
.hb-perform-sub {
  font-size: .8rem;
  color: var(--text-secondary);
}

/* Chart drop zone */
.hb-chart-drop-zone {
  border: 2px dashed rgba(64,224,208,0.25);
  border-radius: 12px;
  padding: 2rem 1.5rem;
  text-align: center;
  cursor: pointer;
  transition: border-color .2s, background .2s;
  background: rgba(64,224,208,0.03);
}
.hb-chart-drop-zone:hover,
.hb-chart-drop-zone.drag-over {
  border-color: var(--accent);
  background: rgba(64,224,208,0.07);
}
.hb-chart-drop-icon { font-size: 2rem; margin-bottom: .5rem; }
.hb-chart-drop-title {
  font-size: .95rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: .35rem;
}
.hb-chart-drop-sub {
  font-size: .8rem;
  color: var(--text-secondary);
  line-height: 1.5;
}

/* Song info bar */
.hb-song-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.hb-song-title {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: .2rem;
}
.hb-song-meta {
  font-size: .78rem;
  color: var(--accent);
  font-weight: 600;
  letter-spacing: .04em;
}
.hb-change-chart-btn {
  flex-shrink: 0;
  padding: .4rem .9rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text-secondary);
  font-size: .8rem;
  cursor: pointer;
  transition: border-color .15s, color .15s;
  font-family: 'Outfit', sans-serif;
}
.hb-change-chart-btn:hover { border-color: var(--accent); color: var(--accent); }

/* Transport */
.hb-transport {
  display: flex;
  gap: .75rem;
  align-items: center;
  margin-bottom: 1.25rem;
}
.hb-play-btn {
  display: flex;
  align-items: center;
  gap: .6rem;
  padding: .65rem 1.5rem;
  border-radius: 10px;
  border: 1px solid var(--accent);
  background: linear-gradient(135deg,rgba(64,224,208,.18),rgba(64,224,208,.06));
  color: var(--accent);
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: .04em;
  cursor: pointer;
  transition: all .15s;
  font-family: 'Outfit', sans-serif;
}
.hb-play-btn:hover {
  background: rgba(64,224,208,.25);
  box-shadow: 0 0 18px rgba(64,224,208,.2);
}
.hb-play-btn.hb-play-active {
  background: linear-gradient(135deg,rgba(68,221,136,.25),rgba(68,221,136,.1));
  border-color: var(--green);
  color: var(--green);
  box-shadow: 0 0 20px rgba(68,221,136,.2);
  animation: hb-play-pulse 2s ease-in-out infinite;
}
@keyframes hb-play-pulse {
  0%,100% { box-shadow: 0 0 16px rgba(68,221,136,.2); }
  50%      { box-shadow: 0 0 30px rgba(68,221,136,.4); }
}
.hb-stop-btn {
  padding: .65rem 1.25rem;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text-secondary);
  font-size: .9rem;
  font-weight: 600;
  cursor: pointer;
  transition: border-color .15s, color .15s;
  font-family: 'Outfit', sans-serif;
}
.hb-stop-btn:hover { border-color: var(--red); color: var(--red); }

/* Chord Timeline */
.hb-timeline-wrap { margin-bottom: 1.25rem; }
.hb-timeline-label,
.hb-segments-label {
  font-size: .7rem;
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: .6rem;
}
.hb-timeline {
  display: flex;
  gap: 4px;
  width: 100%;
  overflow-x: auto;
  padding-bottom: 4px;
  min-height: 64px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.hb-timeline::-webkit-scrollbar { height: 3px; }
.hb-timeline::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
.hb-tl-block {
  flex-shrink: 0;
  border-radius: 7px;
  padding: .4rem .5rem;
  cursor: default;
  min-width: 60px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hb-tl-section {
  font-size: .6rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  line-height: 1;
}
.hb-tl-chords {
  font-size: .7rem;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hb-tl-bars {
  font-size: .55rem;
  font-family: 'Space Mono', monospace;
  line-height: 1;
  margin-top: 1px;
}

/* Segment detail table */
.hb-segments-wrap {
  max-height: 260px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.hb-segments-wrap::-webkit-scrollbar { width: 3px; }
.hb-segments-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
.hb-seg-section { margin-bottom: 1rem; }
.hb-seg-section-name {
  font-size: .7rem;
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
  padding-bottom: .35rem;
  margin-bottom: .4rem;
}
.hb-seg-rows { display: flex; flex-direction: column; gap: 2px; }
.hb-seg-row {
  display: flex;
  align-items: center;
  gap: .75rem;
  padding: .3rem .5rem;
  border-radius: 6px;
  background: rgba(255,255,255,.03);
}
.hb-seg-row:hover { background: rgba(255,255,255,.06); }
.hb-seg-measure {
  font-size: .72rem;
  font-family: 'Space Mono', monospace;
  color: var(--text-dim);
  min-width: 38px;
}
.hb-seg-beat {
  font-size: .6rem;
  color: rgba(255,255,255,.25);
}
.hb-seg-chord {
  font-size: .85rem;
  font-weight: 700;
  color: var(--text-primary);
  min-width: 60px;
}
.hb-seg-style {
  font-size: .68rem;
  color: var(--text-secondary);
  font-style: italic;
}

/* ── Swap Modal ── */
.band-swap-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.65);
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.band-swap-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-hover);
  border-radius: 16px;
  width: 100%;
  max-width: 480px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.band-swap-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
.band-swap-modal-title {
  font-size: .95rem;
  font-weight: 600;
  color: var(--text-primary);
}
.band-swap-modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 1rem;
  padding: .25rem;
  line-height: 1;
}
.band-swap-modal-close:hover { color: var(--text-primary); }
.band-swap-modal-list {
  flex: 1;
  overflow-y: auto;
  padding: .75rem;
  display: flex;
  flex-direction: column;
  gap: .5rem;
}
.band-swap-option {
  display: flex;
  align-items: center;
  gap: .85rem;
  padding: .85rem 1rem;
  border-radius: 10px;
  border: 1px solid var(--border);
  cursor: pointer;
  transition: border-color .15s, background .15s;
  background: var(--bg-card);
}
.band-swap-option:hover { border-color: var(--accent); background: rgba(64,224,208,.05); }
.band-swap-selected { border-color: var(--accent); background: rgba(64,224,208,.08); }
.band-swap-option-photo {
  width: 52px;
  height: 52px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-tertiary);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
}
.band-swap-option-photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.band-swap-option-info { flex: 1; }
.band-swap-option-name {
  font-size: .9rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: .2rem;
}
.band-swap-option-style {
  font-size: .75rem;
  color: var(--text-secondary);
  margin-bottom: .3rem;
}
.band-swap-option-type {
  font-size: .65rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--accent);
  background: rgba(64,224,208,.1);
  border: 1px solid rgba(64,224,208,.2);
  padding: .15rem .5rem;
  border-radius: 4px;
}
.band-swap-check {
  color: var(--accent);
  font-size: 1.1rem;
  font-weight: 700;
  flex-shrink: 0;
}
.band-swap-modal-footer {
  padding: .85rem 1.25rem;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
}

/* ── Chart Player Controls ── */
.cp-loop-btn {
  padding: .65rem 1.1rem;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text-secondary);
  font-size: .88rem;
  font-weight: 600;
  cursor: pointer;
  transition: all .15s;
  font-family: 'Outfit', sans-serif;
}
.cp-loop-btn:hover { border-color: var(--accent); color: var(--accent); }
.cp-loop-btn.cp-loop-active {
  border-color: var(--gold);
  color: var(--gold);
  background: rgba(240,192,64,.1);
  box-shadow: 0 0 12px rgba(240,192,64,.15);
}

.cp-control-row {
  display: flex;
  align-items: center;
  gap: .7rem;
  margin-bottom: .75rem;
  padding: .6rem .75rem;
  background: rgba(255,255,255,.03);
  border-radius: 8px;
  border: 1px solid var(--border);
}
.cp-control-label {
  font-size: .7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: var(--text-dim);
  min-width: 44px;
}
.cp-control-val {
  font-size: .95rem;
  font-weight: 700;
  color: var(--accent);
  min-width: 72px;
  font-family: 'Space Mono', monospace;
}
.cp-nudge-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  width: 26px; height: 26px;
  border-radius: 5px;
  cursor: pointer;
  font-size: .85rem;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.cp-nudge-btn:hover { border-color: var(--accent); color: var(--accent); }
.cp-slider {
  flex: 1;
  accent-color: var(--accent);
  height: 3px;
  cursor: pointer;
}

.cp-sections-label,
.cp-measures-label {
  font-size: .7rem;
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin: .9rem 0 .5rem;
}

/* Section jump buttons */
.cp-section-btns {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  margin-bottom: 1rem;
}
.cp-sec-btn {
  padding: .45rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,.04);
  color: var(--text-secondary);
  font-size: .82rem;
  font-weight: 600;
  cursor: pointer;
  font-family: 'Outfit', sans-serif;
  transition: all .15s;
  text-transform: uppercase;
  letter-spacing: .05em;
}
.cp-sec-btn:hover { border-color: var(--accent); color: var(--accent); }
.cp-sec-btn.cp-sec-active {
  border-color: var(--gold);
  color: var(--gold);
  background: rgba(240,192,64,.1);
}
.cp-sec-btn.cp-sec-pending {
  border-color: var(--green);
  color: var(--green);
  background: rgba(68,221,136,.08);
  animation: cp-pending-pulse 1s ease-in-out infinite;
}
@keyframes cp-pending-pulse {
  0%,100% { opacity: 1; }
  50%      { opacity: .6; }
}

/* Measure grid */
.cp-measure-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.cp-measure {
  background: rgba(255,255,255,.03);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 5px 6px;
  min-width: 90px;
}
.cp-measure.cp-measure-active {
  border-color: var(--gold);
  background: rgba(240,192,64,.06);
}
.cp-measure-num {
  font-size: .65rem;
  color: var(--text-dim);
  font-family: 'Space Mono', monospace;
  margin-bottom: 4px;
}
.cp-beats {
  display: flex;
  gap: 3px;
}
.cp-beat {
  flex: 1;
  background: rgba(255,255,255,.05);
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 4px;
  padding: 3px 2px;
  font-size: .72rem;
  font-weight: 700;
  text-align: center;
  color: var(--accent);
  font-family: 'Space Mono', monospace;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cp-beat.cp-beat-active {
  background: rgba(64,224,208,.2);
  border-color: var(--accent);
  box-shadow: 0 0 8px rgba(64,224,208,.3);
}
.cp-beat.cp-beat-empty {
  color: var(--text-dim);
  border-color: transparent;
  background: transparent;
}

.hb-play-btn.cp-playing {
  background: linear-gradient(135deg,rgba(68,221,136,.25),rgba(68,221,136,.1));
  border-color: var(--green);
  color: var(--green);
  box-shadow: 0 0 20px rgba(68,221,136,.2);
  animation: hb-play-pulse 2s ease-in-out infinite;
}

`;
  document.head.appendChild(style);
})();


