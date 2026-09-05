// ═══════════════════════════════════════════════════════════════
//  VWB — Piano Talk Music Player
//  js/piano-talk.js
//
//  A self-contained talk music player for the Piano Engine.
//  Plays background piano accompaniment in any of the 12 keys.
//  Supports multiple pianists via the Talk Music Registry.
//
//  To add a new pianist:
//    1. Add their entry to PT_REGISTRY below
//    2. Place their 12 MP3/WAV files in the correct folder
//    3. The UI will automatically include them in the selector
//
//  Depends on: nothing (fully self-contained Web Audio player)
// ═══════════════════════════════════════════════════════════════


// ── Talk Music Registry ────────────────────────────────────────
//  Each entry represents one pianist and their 12-key audio set.
//  Files are resolved relative to the app root via window.vwb.
//
//  To add a new pianist, copy the pattern below and add their
//  folder and files. The key in PT_FILES must match exactly.

const PT_REGISTRY = [
  {
    id:      'kenneth-hollins',
    name:    'Kenneth Hollins',
    title:   'Pianist',
    style:   'Gospel / Contemporary',
    bio:     'Kenneth Hollins is the founder of HMPI and a veteran gospel musician. His talk music covers all 12 keys with a warm, full gospel sound that works equally well under preaching, prayer, and altar ministry.',
    folder:  'VWB PIANO TALK MUSIC/Talk Piano Music Audio',
    files: {
      'C':  'C major piano talk music.mp3',
      'Db': 'Db major piano talk music.mp3',
      'D':  'D major piano talk music.mp3',
      'Eb': 'Eb major piano talk music.mp3',
      'E':  'E major piano talk music.mp3',
      'F':  'F major piano talk music.mp3',
      'Gb': 'Gb major piano talk music.mp3',
      'G':  'G major piano talk music.mp3',
      'Ab': 'Ab major piano talk music.mp3',
      'A':  'A major piano talk music.mp3',
      'Bb': 'Bb major piano talk music.mp3',
      'B':  'B major piano talk music.mp3',
    }
  }

  // ── Future Pianists ──────────────────────────────────────────
  // To add a new talk music artist, add an entry here:
  //
  // {
  //   id:      'artist-id',
  //   name:    'Artist Name',
  //   title:   'Pianist',
  //   style:   'Gospel / Traditional',
  //   bio:     'Brief bio...',
  //   folder:  'folder-name-in-app',
  //   files: {
  //     'C': 'filename-c.mp3', 'Db': 'filename-db.mp3', ...
  //   }
  // },
];

// Key display order — chromatic, flats preferred (gospel standard)
const PT_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];


// ── Player State ───────────────────────────────────────────────

let _ptActivePianistId = PT_REGISTRY[0]?.id || null;
let _ptSelectedKey     = 'Bb';   // Default key — most common gospel key
let _ptAudio           = null;   // HTMLAudioElement
let _ptPlaying         = false;
let _ptLoop            = true;   // Loop by default — talk music plays continuously


// ── Public API ─────────────────────────────────────────────────

function ptGetActivePianist() {
  return PT_REGISTRY.find(p => p.id === _ptActivePianistId) || PT_REGISTRY[0] || null;
}

function ptSetPianist(id) {
  if (_ptPlaying) ptStop();
  _ptActivePianistId = id;
  renderPianoTalkCard();
}

function ptSetKey(key) {
  const wasPlaying = _ptPlaying;
  if (_ptPlaying) ptStop();
  _ptSelectedKey = key;
  renderPianoTalkCard();
  if (wasPlaying) ptPlay(); // Resume in new key
}

function ptToggleLoop() {
  _ptLoop = !_ptLoop;
  if (_ptAudio) _ptAudio.loop = _ptLoop;
  renderPianoTalkCard();
}

async function ptPlay() {
  const pianist = ptGetActivePianist();
  if (!pianist) return;

  const fileName = pianist.files[_ptSelectedKey];
  if (!fileName) {
    if (typeof showNotification === 'function')
      showNotification('No file found for key ' + _ptSelectedKey);
    return;
  }

  // Stop any current playback
  ptStop();

  try {
    // Read file via Electron IPC — files live in piano-talk/{pianistId}/ in app root
    const result = await window.vwb.pianoTalkFile({
      pianistId: pianist.id,
      key:       _ptSelectedKey,
      fileName:  fileName
    });

    if (!result || !result.success) {
      console.warn('[PianoTalk] File not found:', result?.error);
      if (typeof showNotification === 'function')
        showNotification('Piano talk file not found. Make sure piano-talk/' + pianist.id + '/ folder is in your app directory.');
      return;
    }

    const blob = new Blob([result.buffer], { type: 'audio/mpeg' });
    const url  = URL.createObjectURL(blob);

    _ptAudio       = new Audio(url);
    _ptAudio.loop  = _ptLoop;
    _ptAudio.volume = 1.0;

    _ptAudio.onended = () => {
      if (!_ptLoop) {
        _ptPlaying = false;
        renderPianoTalkCard();
        URL.revokeObjectURL(url);
      }
    };

    await _ptAudio.play();
    _ptPlaying = true;
    renderPianoTalkCard();

  } catch (e) {
    console.warn('[PianoTalk] Play error:', e.message);
    if (typeof showNotification === 'function')
      showNotification('Could not play piano talk music: ' + e.message);
  }
}

function ptStop() {
  if (_ptAudio) {
    _ptAudio.pause();
    _ptAudio.currentTime = 0;
    _ptAudio = null;
  }
  _ptPlaying = false;
  renderPianoTalkCard();
}

function ptTogglePlay() {
  if (_ptPlaying) ptStop();
  else ptPlay();
}


// ── UI Render ──────────────────────────────────────────────────

function renderPianoTalkCard() {
  const wrap = document.getElementById('pianoTalkWrap');
  if (!wrap) return;

  const pianist   = ptGetActivePianist();
  const hasMulti  = PT_REGISTRY.length > 1;

  const btnStyle = 'font-family:\'Outfit\',sans-serif;font-size:.78rem;font-weight:600;' +
                   'padding:.4rem .85rem;border-radius:8px;cursor:pointer;transition:all .15s;';

  // Build key grid
  const keyBtns = PT_KEYS.map(k => {
    const isSelected = k === _ptSelectedKey;
    return '<button onclick="ptSetKey(\'' + k + '\')" style="' +
      'font-family:\'Space Mono\',monospace;font-size:.75rem;font-weight:700;' +
      'padding:.35rem .5rem;border-radius:6px;cursor:pointer;min-width:38px;' +
      'border:1px solid ' + (isSelected ? 'var(--accent)' : 'var(--border)') + ';' +
      'background:' + (isSelected ? 'rgba(64,224,208,.15)' : 'none') + ';' +
      'color:' + (isSelected ? 'var(--accent)' : 'var(--text-dim)') + ';' +
      (isSelected ? 'box-shadow:0 0 6px rgba(64,224,208,.2);' : '') +
      '">' + k + '</button>';
  }).join('');

  // Pianist selector (only shown if multiple pianists installed)
  const pianistSelector = hasMulti
    ? '<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem;">' +
        PT_REGISTRY.map(p =>
          '<button onclick="ptSetPianist(\'' + p.id + '\')" style="' +
          btnStyle +
          'border:1px solid ' + (p.id === _ptActivePianistId ? 'var(--orange)' : 'var(--border)') + ';' +
          'background:' + (p.id === _ptActivePianistId ? 'rgba(255,136,68,.1)' : 'none') + ';' +
          'color:' + (p.id === _ptActivePianistId ? 'var(--orange)' : 'var(--text-dim)') + ';' +
          'font-size:.72rem;">' +
          p.name + '</button>'
        ).join('') +
      '</div>'
    : '';

  wrap.innerHTML =
    '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;' +
    'padding:1.1rem 1.25rem;margin-top:1rem;">' +

      // Header
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.9rem;">' +
        '<div>' +
          '<div style="font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;' +
          'color:var(--orange);font-weight:700;margin-bottom:.2rem;">🎹 Piano Talk Music</div>' +
          '<div style="font-size:.8rem;color:var(--text-secondary);">' +
          (pianist ? pianist.title + ' · ' + pianist.name : 'No pianist loaded') + '</div>' +
        '</div>' +
        // Now playing indicator
        (_ptPlaying
          ? '<div style="font-size:.72rem;color:var(--accent);font-weight:700;' +
            'display:flex;align-items:center;gap:.35rem;">' +
            '<span style="width:7px;height:7px;border-radius:50%;background:var(--accent);' +
            'display:inline-block;animation:hb-play-pulse 1.2s ease-in-out infinite;"></span>' +
            'Playing in ' + _ptSelectedKey + '</div>'
          : '<div style="font-size:.72rem;color:var(--text-dim);">Stopped</div>') +
      '</div>' +

      // Pianist selector (multi-pianist mode)
      pianistSelector +

      // Key grid
      '<div style="margin-bottom:.85rem;">' +
        '<div style="font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;' +
        'color:var(--text-dim);font-weight:700;margin-bottom:.45rem;">Select Key</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:.35rem;">' + keyBtns + '</div>' +
      '</div>' +

      // Transport controls
      '<div style="display:flex;align-items:center;gap:.5rem;">' +
        // Play/Stop button
        '<button onclick="ptTogglePlay()" style="' +
        btnStyle +
        'padding:.5rem 1.3rem;font-size:.85rem;font-weight:700;' +
        'border:1px solid ' + (_ptPlaying ? '#e63946' : 'var(--accent)') + ';' +
        'background:' + (_ptPlaying ? 'rgba(230,57,70,.15)' : 'rgba(64,224,208,.12)') + ';' +
        'color:' + (_ptPlaying ? '#e63946' : 'var(--accent)') + ';' +
        'box-shadow:0 0 8px ' + (_ptPlaying ? 'rgba(230,57,70,.2)' : 'rgba(64,224,208,.15)') + ';">' +
        (_ptPlaying ? '⏹ Stop' : '▶ Play') +
        '</button>' +

        // Loop toggle
        '<button onclick="ptToggleLoop()" title="Loop on/off" style="' +
        btnStyle +
        'border:1px solid ' + (_ptLoop ? 'var(--gold,#f0c040)' : 'var(--border)') + ';' +
        'background:' + (_ptLoop ? 'rgba(240,192,64,.1)' : 'none') + ';' +
        'color:' + (_ptLoop ? 'var(--gold,#f0c040)' : 'var(--text-dim)') + ';' +
        'font-size:.78rem;">' +
        '🔁 Loop' +
        '</button>' +

        // Fade button — only shown while playing
        (_ptPlaying && !_ptFadeInterval
          ? '<button onclick="ptFadeOut()" title="Fade out and stop" style="' +
            btnStyle +
            'border:1px solid var(--border);background:none;color:var(--text-dim);font-size:.78rem;">↓ Fade</button>'
          : (_ptFadeInterval
            ? '<button disabled style="' + btnStyle +
              'border:1px solid var(--border);background:none;color:var(--orange);font-size:.78rem;">↓ Fading…</button>'
            : '')) +

        // Volume (simple slider)
        '<div style="display:flex;align-items:center;gap:.4rem;margin-left:auto;">' +
          '<span style="font-size:.6rem;color:var(--text-dim);">VOL</span>' +
          '<input type="range" min="0" max="100" value="100" step="1" id="ptVolSlider"' +
          ' oninput="if(_ptAudio)_ptAudio.volume=this.value/100;"' +
          ' style="width:70px;accent-color:var(--accent);height:3px;cursor:pointer;">' +
        '</div>' +
      '</div>' +

    '</div>';
}


// ── Fade Out ───────────────────────────────────────────────────

let _ptFadeInterval = null;

function ptFadeOut() {
  if (!_ptAudio || !_ptPlaying) return;
  if (_ptFadeInterval) return; // already fading

  const steps  = 40;
  const stepMs = 150; // 6 seconds total fade
  let step     = 0;
  const startVol = _ptAudio.volume;

  _ptFadeInterval = setInterval(() => {
    step++;
    const pct = Math.max(0, 1 - step / steps);
    if (_ptAudio) _ptAudio.volume = startVol * pct;
    if (step >= steps) {
      clearInterval(_ptFadeInterval);
      _ptFadeInterval = null;
      ptStop();
    }
  }, stepMs);

  renderPianoTalkCard();
}

function ptCancelFade() {
  if (_ptFadeInterval) {
    clearInterval(_ptFadeInterval);
    _ptFadeInterval = null;
  }
}
//  Called from index.html after the Piano Engine card is shown.
//  Injects the Talk Music Player into the Piano Engine card.

function ptMount() {
  // pianoTalkWrap is defined directly in index.html inside setupPianoCard
  renderPianoTalkCard();
}

// Auto-mount when Piano Engine is shown
// transport.js calls setVwbEngine('piano') — we hook into that
// by watching for the pianoCard becoming visible.

// Export for use by transport.js and index.html
window.ptMount            = ptMount;
window.ptPlay             = ptPlay;
window.ptStop             = ptStop;
window.ptTogglePlay       = ptTogglePlay;
window.ptSetKey           = ptSetKey;
window.ptSetPianist       = ptSetPianist;
window.ptToggleLoop       = ptToggleLoop;
window.ptFadeOut          = ptFadeOut;
window.renderPianoTalkCard = renderPianoTalkCard;

// Render on load so the card shows immediately when Piano Engine is active
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderPianoTalkCard);
} else {
  setTimeout(renderPianoTalkCard, 100);
}

console.log('[PianoTalk] piano-talk.js loaded —',
  PT_REGISTRY.length, 'pianist(s) in registry');
