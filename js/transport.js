// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Unified Transport Coordinator
//  Engine selector (Audio / MIDI), unified playback controls,
//  section jumping, timeline, and progress updates.
//  Depends on: state.js, audio-engine.js, midi-player.js,
//              midi-sections.js, ui.js
// ═══════════════════════════════════════════════════════════════

// ── Tempo Sync — MIDI engine keeps Song Info and MIDI player in sync ──

// Called when user changes tempo in Song Info (songTempo input)
function onSongTempoChange(val) {
  const bpm = parseInt(val) || 72;
  song.tempo = bpm;
  // If MIDI engine active, sync to MIDI BPM
  if (vwbActiveEngine === 'midi' && typeof setMidiBpm === 'function') {
    setMidiBpm(bpm);
  }
  if (typeof updMInfo === 'function') updMInfo();
}

// Called when MIDI tempo changes — syncs back to Song Info
function syncMidiTempoToSongInfo(bpm) {
  song.tempo = bpm;
  const el = document.getElementById('songTempo');
  if (el) el.value = bpm;
  // Also update Perform BPM display
  const perfTempo = document.getElementById('pTempo');
  if (perfTempo) perfTempo.textContent = bpm + ' BPM';
  if (typeof updMInfo === 'function') updMInfo();
}

// ── Active Engine State ────────────────────────────────────────
// 'audio' | 'midi' | 'organ' | 'piano'
let vwbActiveEngine = 'audio';

// ── Set Engine ─────────────────────────────────────────────────

function setVwbEngine(eng, notify = true) {
  const prev = vwbActiveEngine;
  vwbActiveEngine = (['audio','midi','organ','piano'].includes(eng)) ? eng : 'audio';

  // Stop engines being deactivated
  if (prev === 'midi' && vwbActiveEngine !== 'midi') {
    if (typeof midiPlaying !== 'undefined' && midiPlaying) stopMidiPlay();
  }
  if (prev === 'audio' && vwbActiveEngine !== 'audio') {
    if (typeof playing !== 'undefined' && playing) doStop();
  }
  if (prev === 'organ' && vwbActiveEngine !== 'organ') {
    if (typeof abStop === 'function') abStop();
  }
  if (prev === 'piano' && vwbActiveEngine !== 'piano') {
    if (typeof stopRubato === 'function') stopRubato();
  }

  // Show/hide Setup page cards
  const audioCards  = document.getElementById('setupAudioCards');
  const midiCard    = document.getElementById('setupMidiCard');
  const organCard   = document.getElementById('setupOrganCard');
  const pianoCard   = document.getElementById('setupPianoCard');
  const sectionCard = document.getElementById('setupSectionCard');
  const hbSecCard   = document.getElementById('hbSectionsCard');
  const padsLoops   = document.getElementById('setupPadsLoopsCard');
  if (audioCards)  audioCards.style.display  = vwbActiveEngine === 'audio' ? '' : 'none';
  if (midiCard)    midiCard.style.display    = vwbActiveEngine === 'midi'  ? '' : 'none';
  if (organCard)   organCard.style.display   = vwbActiveEngine === 'organ' ? '' : 'none';
  if (pianoCard)   pianoCard.style.display   = vwbActiveEngine === 'piano' ? '' : 'none';
  // Mount Piano Talk Music player when Piano Engine is shown
  if (vwbActiveEngine === 'piano' && typeof ptMount === 'function') {
    setTimeout(ptMount, 50);
  }
  // Section card: bar-range labels over an existing performance —
  // applies to Audio Engine only. Flex/House Band songs use the
  // separate House Band Chart Sections card below instead, since a
  // chart's sections carry their own chord content rather than just
  // labeling a pre-recorded timeline. Not applicable to Organ
  // (auto-accompaniment) or Piano (Rubato, voice-triggered) either way.
  if (sectionCard) sectionCard.style.display = vwbActiveEngine === 'audio' ? '' : 'none';
  // House Band Chart Sections card: shown on the Flex Engine tab only —
  // see songLibraryLaunch()'s 'house-band' case for why a House Band
  // chart currently displays under the Flex/midi engine slot.
  if (hbSecCard)   hbSecCard.style.display   = vwbActiveEngine === 'midi'  ? '' : 'none';
  // Pads and Loops shown only for audio engine
  if (padsLoops)   padsLoops.style.display   = vwbActiveEngine === 'audio' ? '' : 'none';

  if (vwbActiveEngine === 'midi') {
    // Hide MIDI playlist Transpose/Tempo controls using precise IDs
    // midiPlaylistControls = the controls row in setupMidiCard (Song Setup page)
    // midiPerfControls     = the controls row in uniMidiControls (Perform page)
    var playlistControls = document.getElementById('midiPlaylistControls');
    var perfControls     = document.getElementById('midiPerfControls');
    var progressWrap     = document.querySelector('#uniMidiControls .midi-progress-wrap');
    var progressStrip    = document.getElementById('midiTimelineStripPerf');
    if (playlistControls) playlistControls.style.display = 'none';
    if (perfControls)     perfControls.style.display     = 'none';
    if (progressWrap)     progressWrap.style.display     = 'none';
    if (progressStrip)    progressStrip.style.display    = 'none';
  }

  // Update Setup page engine buttons
  _abUpdateSetupEngineBtns();

  // Update Perform page read-only engine label
  const uniLabel = document.getElementById('uniEngineLabel');
  if (uniLabel) {
    if (vwbActiveEngine === 'midi') {
      uniLabel.textContent        = '🎸 Flex';
      uniLabel.style.borderColor  = 'var(--orange)';
      uniLabel.style.background   = 'rgba(255,136,68,.15)';
      uniLabel.style.color        = 'var(--orange)';
    } else if (vwbActiveEngine === 'organ') {
      uniLabel.textContent        = '🎹 Organ';
      uniLabel.style.borderColor  = '#AA44FF';
      uniLabel.style.background   = 'rgba(170,68,255,.15)';
      uniLabel.style.color        = '#AA44FF';
    } else if (vwbActiveEngine === 'piano') {
      uniLabel.textContent        = '🎵 Piano';
      uniLabel.style.borderColor  = '#63B3ED';
      uniLabel.style.background   = 'rgba(99,179,237,.15)';
      uniLabel.style.color        = '#63B3ED';
    } else {
      uniLabel.textContent        = '🎵 Audio';
      uniLabel.style.borderColor  = 'var(--accent)';
      uniLabel.style.background   = 'rgba(64,224,208,.15)';
      uniLabel.style.color        = 'var(--accent)';
    }
  }

  // Show/hide Organ Perform panel and transport controls
  const abPanel          = document.getElementById('abPerfPanel');
  const uniTransport     = document.getElementById('uniTransportControls');
  const uniOrganTransport= document.getElementById('uniOrganTransport');
  if (abPanel)           abPanel.style.display           = vwbActiveEngine === 'organ' ? '' : 'none';
  if (uniTransport)      uniTransport.style.display      = vwbActiveEngine === 'organ' ? 'none' : 'flex';
  if (uniOrganTransport) uniOrganTransport.style.display = vwbActiveEngine === 'organ' ? 'flex' : 'none';

  // Hide song header and timeline for engines where they don't apply
  const perfHdr       = document.querySelector('.perf-hdr');
  const timelineWrap  = document.getElementById('uniTimelineWrap');
  const perfMix       = document.querySelector('.perf-mix');
  const hideHeader    = (vwbActiveEngine === 'organ' || vwbActiveEngine === 'piano');
  if (perfHdr)      perfHdr.style.display      = hideHeader ? 'none' : '';
  if (timelineWrap) timelineWrap.style.display  = hideHeader ? 'none' : '';
  if (perfMix)      perfMix.style.display       = vwbActiveEngine === 'organ' ? 'none' : '';

  _uniUpdateTransportUI();
  uniUpdateMidiControls();

  // Organ perform UI (timeline, hotkeys, organist card)
  if (typeof window._setOrganPerformUI === 'function') {
    window._setOrganPerformUI(vwbActiveEngine === 'organ');
  }

  // Piano engine — auto-expand Rubato Mode card
  if (vwbActiveEngine === 'piano') {
    const rb   = document.getElementById('rubatoCardBody');
    const hint = document.getElementById('rubatoCardHint');
    const arr  = document.getElementById('rubatoToggleArrow');
    if (rb && rb.style.display === 'none') {
      rb.style.display = 'block';
      if (hint) hint.textContent = 'Click to collapse';
      if (arr)  arr.style.transform = 'rotate(90deg)';
      if (typeof renderRubatoCard === 'function') renderRubatoCard();
    }
  }

  if (notify) {
    const labels = {
      audio: '🎵 Audio Engine',
      midi:  '🎹 MIDI Engine',
      organ: '🎹 Organ Engine',
      piano: '🎵 Piano Engine'
    };
    showNotification(labels[vwbActiveEngine] + ' active');
  }
}

function _abUpdateSetupEngineBtns() {
  const sAudio = document.getElementById('setupEngBtnAudio');
  const sMidi  = document.getElementById('setupEngBtnMidi');
  const sOrgan = document.getElementById('setupEngBtnOrgan');
  const sPiano = document.getElementById('setupEngBtnPiano');
  if (sAudio) {
    sAudio.style.borderColor = vwbActiveEngine === 'audio' ? 'var(--accent)' : 'var(--border)';
    sAudio.style.background  = vwbActiveEngine === 'audio' ? 'rgba(64,224,208,.15)' : 'none';
    sAudio.style.color       = vwbActiveEngine === 'audio' ? 'var(--accent)' : 'var(--text-dim)';
  }
  if (sMidi) {
    sMidi.style.borderColor  = vwbActiveEngine === 'midi' ? 'var(--orange)' : 'var(--border)';
    sMidi.style.background   = vwbActiveEngine === 'midi' ? 'rgba(255,136,68,.15)' : 'none';
    sMidi.style.color        = vwbActiveEngine === 'midi' ? 'var(--orange)' : 'var(--text-dim)';
  }
  if (sOrgan) {
    sOrgan.style.borderColor = vwbActiveEngine === 'organ' ? '#AA44FF' : 'var(--border)';
    sOrgan.style.background  = vwbActiveEngine === 'organ' ? 'rgba(170,68,255,.15)' : 'none';
    sOrgan.style.color       = vwbActiveEngine === 'organ' ? '#AA44FF' : 'var(--text-dim)';
  }
  if (sPiano) {
    sPiano.style.borderColor = vwbActiveEngine === 'piano' ? '#63B3ED' : 'var(--border)';
    sPiano.style.background  = vwbActiveEngine === 'piano' ? 'rgba(99,179,237,.15)' : 'none';
    sPiano.style.color       = vwbActiveEngine === 'piano' ? '#63B3ED' : 'var(--text-dim)';
  }
}

// ── Unified Transport Commands ─────────────────────────────────

function uniTogglePlay() {
  if (AC.state === 'suspended') AC.resume();
  if (vwbActiveEngine === 'organ') {
    if (typeof abTrigger === 'function') abTrigger(abCurrentKey, abCurrentLevel);
    return;
  }
  if (vwbActiveEngine === 'midi') {
    // ── House Band chart player takes priority over MIDI playlist ──
    const hasChart = typeof _cp !== 'undefined' && _cp !== null && _cp.chart !== null;
    if (hasChart) {
      if (typeof cpTogglePlay === 'function') cpTogglePlay();
      _uniUpdateTransportUI();
      return;
    }
    if (typeof getMidiActive === 'function' && !getMidiActive()) {
      showNotification('⚠ No file loaded. Add a MIDI file or load a song chart first.');
      return;
    }
    if (typeof toggleMidiPlay === 'function') toggleMidiPlay();
  } else {
    if (!stemCount() && !auxTracks.length) {
      showNotification('⚠ No audio loaded. Load stems in Song Setup first.');
      return;
    }
    togglePlay();
  }
  _uniUpdateTransportUI();
}

function uniStop() {
  if (vwbActiveEngine === 'organ') {
    if (typeof abStop === 'function') { abStop(); if (typeof renderArmorBearerPerform === 'function') renderArmorBearerPerform(); }
    return;
  }
  if (vwbActiveEngine === 'midi') {
    const hasChart = typeof _cp !== 'undefined' && _cp !== null && _cp.chart !== null;
    if (hasChart && typeof cpStop === 'function') {
      cpStop();
    } else {
      stopMidiPlay();
    }
  } else {
    doStop();
  }
  _uniUpdateTransportUI();
}

function uniToggleSecLoop() {
  if (vwbActiveEngine === 'midi') {
    toggleMidiSectionLoop();
  } else {
    toggleSecLoop();
  }
  _uniUpdateTransportUI();
}

// ── Unified Section Jump ───────────────────────────────────────
// Always routes through queueSection which handles both engines.
// queueSection detects vwbActiveEngine and bridges to MIDI when needed.

function uniJumpSection(idx) {
  if (typeof queueSection === 'function') {
    queueSection(idx);
  }
}

// ── Unified Fade Out ───────────────────────────────────────────

let _fadeInterval  = null;
let _fadeActive    = false;

function uniFadeOut() {
  if (_fadeActive) return; // already fading
  const dur     = (typeof vwbFadeDuration !== 'undefined') ? vwbFadeDuration : 4;
  const steps   = 40;
  const stepMs  = (dur * 1000) / steps;
  _fadeActive   = true;

  // Update button to show fading
  const fadeBtn = document.getElementById('uniFadeBtn');
  if (fadeBtn) {
    fadeBtn.textContent  = '↓ Fading…';
    fadeBtn.style.color  = 'var(--orange)';
    fadeBtn.style.border = '1px solid var(--orange)';
  }

  if (vwbActiveEngine === 'organ') {
    // Organ — fade the abGain node
    if (typeof abGain === 'undefined' || !abGain) { _fadeCleanup(); return; }
    const startVol = abGain.gain.value;
    let step = 0;
    _fadeInterval = setInterval(() => {
      step++;
      abGain.gain.value = Math.max(0, startVol * (1 - step / steps));
      if (step >= steps) {
        if (typeof abStop === 'function') abStop();
        abGain.gain.value = startVol; // restore
        _fadeCleanup();
      }
    }, stepMs);

  } else if (vwbActiveEngine === 'midi') {
    // MIDI/Flex — fade via Tone.js destination
    let step = 0;
    let startDb = 0;
    try { startDb = (typeof Tone !== 'undefined') ? Tone.getDestination().volume.value : 0; } catch(e) {}
    const hasChart = typeof _cp !== 'undefined' && _cp !== null && _cp.chart !== null;
    _fadeInterval = setInterval(() => {
      step++;
      const pct = Math.max(0, 1 - step / steps);
      try {
        if (typeof Tone !== 'undefined') {
          Tone.getDestination().volume.value = pct <= 0 ? -Infinity : 20 * Math.log10(pct);
        }
      } catch(e) {}
      if (step >= steps) {
        // Stop the right engine
        if (hasChart) {
          if (typeof cpStop === 'function') cpStop();
        } else {
          if (typeof stopMidiPlay === 'function') stopMidiPlay();
        }
        // Restore Tone.js volume so next playback isn't silent
        try { if (typeof Tone !== 'undefined') Tone.getDestination().volume.value = startDb; } catch(e) {}
        _fadeCleanup();
      }
    }, stepMs);

  } else {
    // Audio — fade the master mGain node
    const startVol = mGain.gain.value;
    let step = 0;
    _fadeInterval = setInterval(() => {
      step++;
      mGain.gain.value = Math.max(0, startVol * (1 - step / steps));
      if (step >= steps) {
        doStop();
        mGain.gain.value = startVol; // restore after stop
        _fadeCleanup();
      }
    }, stepMs);
  }
}

function _fadeCleanup() {
  clearInterval(_fadeInterval);
  _fadeInterval = null;
  _fadeActive   = false;
  const fadeBtn = document.getElementById('uniFadeBtn');
  if (fadeBtn) {
    fadeBtn.textContent  = '↓ Fade';
    fadeBtn.style.color  = 'var(--text-dim)';
    fadeBtn.style.border = '1px solid var(--border)';
  }
  _uniUpdateTransportUI();
}

// ── Unified Seek ───────────────────────────────────────────────

function uniSeek(pct) {
  if (vwbActiveEngine === 'midi') {
    seekMidi(pct);
  } else {
    const dur = getDur();
    jumpTo((pct / 100) * dur);
  }
}

// ── Engine Selector UI ─────────────────────────────────────────

function _uniRenderEngineSelector() {
  const wrap = document.getElementById('uniEngineSelector');
  if (!wrap) return;

  const audioActive = vwbActiveEngine === 'audio';
  const midiActive  = vwbActiveEngine === 'midi';

  const btnBase = `font-family:'Outfit',sans-serif;font-size:.85rem;font-weight:600;
                   padding:.45rem 1.25rem;border-radius:8px;cursor:pointer;
                   transition:all .2s;border:2px solid;letter-spacing:.04em;`;

  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:.5rem;">
      <span style="font-size:.72rem;color:var(--text-dim);text-transform:uppercase;
                   letter-spacing:.08em;font-weight:600;">Engine</span>
      <button onclick="setVwbEngine('audio')"
        style="${btnBase}
               background:${audioActive ? 'rgba(64,224,208,.15)' : 'none'};
               border-color:${audioActive ? 'var(--accent)' : 'var(--border)'};
               color:${audioActive ? 'var(--accent)' : 'var(--text-dim)'};">
        🎵 Audio
      </button>
      <button onclick="setVwbEngine('midi')"
        style="${btnBase}
               background:${midiActive ? 'rgba(255,136,68,.15)' : 'none'};
               border-color:${midiActive ? 'var(--orange)' : 'var(--border)'};
               color:${midiActive ? 'var(--orange)' : 'var(--text-dim)'};">
        🎹 MIDI
      </button>
    </div>`;
}

// ── Unified Section Cards ──────────────────────────────────────
// Always uses song.secs — same sections for both audio and MIDI.
// Jump routing is handled by queueSection which bridges to MIDI.

function uniRenderSections() {
  const wrap = document.getElementById('uniSecs');
  if (!wrap) return;

  if (!song.secs || !song.secs.length) {
    wrap.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'flex';
  const isMidi = vwbActiveEngine === 'midi';

  wrap.innerHTML = song.secs.map((s, i) => {
    // For MIDI engine, highlight based on curSec which queueSection sets
    const a = i === curSec;
    const q = i === qSec;
    const hasLoopFlag = s.loop === true;
    const isLooping   = a && (isMidi ? midiSecLoopOn : secLoopOn) && hasLoopFlag;
    const loopInd = isLooping
      ? '<span class="sec-loop-indicator on">🔁 LOOPING</span>'
      : (hasLoopFlag ? '<span class="sec-loop-indicator" style="opacity:.45">🔁 preset</span>' : '');
    const secDisplayName = (s.type === 'Custom' && s.customLabel) ? s.customLabel : s.type;
    const accentColor = isMidi ? 'var(--orange)' : 'var(--accent)';
    const accentBg    = isMidi ? 'rgba(255,136,68,.15)' : 'rgba(64,224,208,.15)';
    return `
      <div class="p-sec${a ? ' act' : ''}${q ? ' q' : ''}"
           onclick="uniJumpSection(${i})"
           style="${a ? ('border-color:' + accentColor + ';') : ''}">
        <span class="s-hk">${i + 1}</span>
        <div class="s-inf">
          <h4>${secDisplayName}${s.label ? ' — ' + s.label : ''}</h4>
          <div class="s-meas">Bars ${s.sb} – ${s.eb} ${loopInd}</div>
        </div>
        <button style="font-size:.65rem;padding:.15rem .35rem;border-radius:4px;
                       border:1px solid ${hasLoopFlag ? accentColor : 'var(--border)'};
                       background:${hasLoopFlag ? accentBg : 'none'};
                       color:${hasLoopFlag ? accentColor : 'var(--text-dim)'};
                       cursor:pointer;margin-left:auto;flex-shrink:0"
                onclick="event.stopPropagation();toggleSecLoopFlag(${i})">🔁</button>
        <div class="s-qlbl">NEXT ▶</div>
      </div>`;
  }).join('');
}

// ── Unified Timeline ───────────────────────────────────────────

function uniRenderTimeline() {
  const c = document.getElementById('uniTimeline');
  if (!c) return;
  c.innerHTML = '';

  if (!song.secs || !song.secs.length) return;

  if (vwbActiveEngine === 'midi') {
    const active = (typeof getMidiActive === 'function') ? getMidiActive() : null;
    const dur = active ? (active.duration || 0) : 0;
    if (dur <= 0) return;
    song.secs.forEach((s, i) => {
      const st = (typeof midiBar2Time === 'function') ? midiBar2Time(s.sb) : 0;
      const et = (typeof midiBar2Time === 'function') ? midiBar2Time(s.eb + 1) : 0;
      const wp = ((et - st) / dur) * 100;
      const label = (s.type === 'Custom' && s.customLabel) ? s.customLabel : s.type;
      c.innerHTML += `<div class="tl-sec${i === curSec ? ' on' : ''}"
        style="width:${Math.min(wp, 100)}%;position:relative"
        onclick="event.stopPropagation();uniJumpSection(${i})">${label}</div>`;
    });
    return;
  }

  // Audio timeline
  const d = getDur();
  if (d <= 0) return;
  song.secs.forEach((s, i) => {
    const st = bar2time(s.sb), et = bar2time(s.eb + 1);
    const wp = ((et - st) / d) * 100;
    const tlLabel = (s.type === 'Custom' && s.customLabel) ? s.customLabel : s.type;
    c.innerHTML += `<div class="tl-sec${i === curSec ? ' on' : ''}"
      style="width:${Math.min(wp, 100)}%;position:relative"
      onclick="event.stopPropagation();uniJumpSection(${i})">${tlLabel}</div>`;
  });
}

// ── Progress Bar Update ────────────────────────────────────────

function uniUpdateProgress() {
  let t = 0, dur = 0;

  if (vwbActiveEngine === 'midi') {
    t   = (typeof getMidiCurrentTime === 'function') ? getMidiCurrentTime() : 0;
    const active = (typeof getMidiActive === 'function') ? getMidiActive() : null;
    dur = active ? (active.duration || 0) : 0;
  } else {
    t   = getCurTime();
    dur = getDur();
  }

  const pct  = dur > 0 ? (t / dur) * 100 : 0;
  const prog = document.getElementById('uniProgFill');
  if (prog) prog.style.width = pct + '%';

  const timeEl = document.getElementById('uniTimeDisplay');
  if (timeEl) timeEl.textContent = fmt(t) + ' / ' + fmt(dur);

  // Bar display — guard against NaN when nothing is loaded
  let bar = 1;
  const hasChart = typeof _cp !== 'undefined' && _cp !== null && _cp.chart !== null;
  if (hasChart) {
    // Chart playback — calculate absolute bar number from section + measure position
    let absBar = 1;
    const sections = _cp.chart.sections || [];
    for (let s = 0; s < _cp.activeSectionIdx && s < sections.length; s++) {
      absBar += (sections[s].measures || []).length;
    }
    absBar += _cp.activeMeasureIdx;
    bar = absBar;
  } else if (vwbActiveEngine === 'midi' && typeof midiTime2Bar === 'function') {
    const _tempoPct = (typeof midiTempoPct !== 'undefined') ? midiTempoPct : 100;
    const computed  = midiTime2Bar(t * (_tempoPct / 100));
    bar = (isFinite(computed) && computed > 0) ? Math.floor(computed) : 1;
  } else if (typeof time2bar === 'function') {
    const computed = time2bar(t);
    bar = (isFinite(computed) && computed > 0) ? Math.floor(computed) : 1;
  }
  const barEl = document.getElementById('uniBarDisplay');
  if (barEl) barEl.textContent = 'Bar ' + bar;
}

// ── MIDI Controls Visibility ───────────────────────────────────

function uniUpdateMidiControls() {
  const midiCtrl = document.getElementById('uniMidiControls');
  if (midiCtrl) midiCtrl.style.display = vwbActiveEngine === 'midi' ? 'flex' : 'none';
}

// ── Transport Button Sync ──────────────────────────────────────

function _uniUpdateTransportUI() {
  // When a chart is loaded, _cp.playing is the authoritative playing state.
  // midiPlaying tracks the MIDI playlist only — it stays false during chart playback.
  const hasChart   = typeof _cp !== 'undefined' && _cp !== null && _cp.chart !== null;
  const _midiPlay  = (typeof midiPlaying   !== 'undefined') ? midiPlaying   : false;
  const _midiLoop  = (typeof midiSecLoopOn !== 'undefined') ? midiSecLoopOn : false;
  const _audioPlay = (typeof playing       !== 'undefined') ? playing       : false;
  const _audioLoop = (typeof secLoopOn     !== 'undefined') ? secLoopOn     : false;
  const isPlaying  = vwbActiveEngine === 'midi'
    ? (hasChart ? (typeof _cp !== 'undefined' && _cp.playing) : _midiPlay)
    : _audioPlay;
  const playBtn    = document.getElementById('uniPlayBtn');
  if (playBtn) {
    playBtn.innerHTML = isPlaying ? '⏸' : '▶';
    playBtn.classList.toggle('on', isPlaying);
  }

  const loopBtn = document.getElementById('uniSecLoopBtn');
  if (loopBtn) {
    const loopOn = vwbActiveEngine === 'midi' ? _midiLoop : _audioLoop;
    loopBtn.classList.toggle('on', loopOn);
  }

  uniRenderSections();
  uniRenderTimeline();
  uniUpdateMidiControls();
  _uniRenderEngineSelector();
}

// ── Audio Engine Tick Hook ─────────────────────────────────────

function uniOnAudioTick() {
  if (vwbActiveEngine !== 'audio') return;
  uniUpdateProgress();
  const tlSecs = document.getElementById('uniTimeline');
  if (tlSecs) {
    tlSecs.querySelectorAll('.tl-sec').forEach((e, i) => e.classList.toggle('on', i === curSec));
  }
}

// ── MIDI Engine Tick Hook ──────────────────────────────────────

function uniOnMidiTick() {
  if (vwbActiveEngine !== 'midi') return;
  uniUpdateProgress();
  const tlSecs = document.getElementById('uniTimeline');
  if (tlSecs) {
    tlSecs.querySelectorAll('.tl-sec').forEach((e, i) => e.classList.toggle('on', i === curSec));
  }
  // Highlight active section card using curSec
  const wrap = document.getElementById('uniSecs');
  if (wrap) {
    wrap.querySelectorAll('.p-sec').forEach((el, i) => {
      el.classList.toggle('act', i === curSec);
    });
  }
}

// ── Full Perform View Refresh ──────────────────────────────────

function uniRefreshPerfView() {
  _uniUpdateTransportUI();
  uniUpdateProgress();
  uniUpdateMidiControls();
  setVwbEngine(vwbActiveEngine, false);
  const perfTempo = document.getElementById('pTempo');
  if (perfTempo) {
    const bpm = (vwbActiveEngine === 'midi' && typeof midiBpm !== 'undefined')
      ? midiBpm : (song.tempo || 72);
    perfTempo.textContent = bpm + ' BPM';
  }
  // Organ panel visibility
  const abPanel = document.getElementById('abPerfPanel');
  if (abPanel) abPanel.style.display = vwbActiveEngine === 'organ' ? '' : 'none';
  if (typeof renderArmorBearerPerform === 'function') renderArmorBearerPerform();
}
