// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Remote Bridge & License
//  VWB Remote broadcast, remoteAction handler, QR code,
//  and Lemon Squeezy license validation.
//  Depends on: state.js, audio-engine.js, armor-bearer.js,
//              rubato.js, band-registry.js, house-band-engine.js
//
//  v2 — Added Armor Bearer (Preacher module), Rubato Mode,
//       and House Band 7-member mixer to remote state + actions.
// ═══════════════════════════════════════════════════════════════

// ── Remote Bridge ──────────────────────────────────────────────

let remoteInfo       = null;
let remotePanelOpen  = false;
let remoteStateTimer = null;
let remoteFading     = false;
let remoteFadeTimer  = null;

function toggleRemotePanel() {
  remotePanelOpen = !remotePanelOpen;
  const body  = document.getElementById('remotePanelBody');
  const arrow = document.getElementById('remoteToggleArrow');
  const hint  = document.getElementById('remotePanelHint');
  if (body)  body.style.display    = remotePanelOpen ? 'block' : 'none';
  if (arrow) arrow.style.transform  = remotePanelOpen ? 'rotate(90deg)' : '';
  if (hint)  hint.textContent = remotePanelOpen ? 'Click to collapse' : 'Click to expand';
  if (remotePanelOpen) refreshRemoteInfo();
}

async function refreshRemoteInfo() {
  try {
    remoteInfo = await window.vwb.remoteGetInfo();
    const urlEl = document.getElementById('remoteUrl');
    if (urlEl) urlEl.textContent = remoteInfo.url;
    drawQRCode(remoteInfo.url);
  } catch(e) { console.log('Remote info error:', e); }
}

function drawQRCode(url) {
  const canvas = document.getElementById('qrCanvas');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const size = 150;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, size, size);
  const img   = new Image();
  img.onload  = () => { ctx.fillStyle='white'; ctx.fillRect(0,0,size,size); ctx.drawImage(img,0,0,size,size); };
  img.onerror = () => {
    ctx.fillStyle = '#0a0e14'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#40E0D0'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
    ctx.fillText('Scan URL below', size/2, size/2 - 6);
    ctx.font = '9px monospace'; ctx.fillStyle = '#8892a4';
    const parts = url.replace('http://','').split(':');
    ctx.fillText(parts[0], size/2, size/2 + 10);
    ctx.fillText(':' + (parts[1]||'7878'), size/2, size/2 + 24);
  };
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=' + encodeURIComponent(url) + '&bgcolor=ffffff&color=0a0e14&margin=2';
}

// ── Armor Bearer state helpers ─────────────────────────────────
// Reads from armor-bearer.js globals/functions defensively.
// All reads are wrapped so remote bridge never crashes if
// armor-bearer.js isn't loaded yet or its API changes.

function _abGetState() {
  try {
    return {
      active:      typeof abActive !== 'undefined'      ? !!abActive      : false,
      vadOn:       typeof abVadOn  !== 'undefined'      ? !!abVadOn       : false,
      currentKey:  typeof abCurrentKey !== 'undefined'  ? abCurrentKey    : '',
      currentChord:typeof abCurrentChord !== 'undefined'? abCurrentChord  : '',
      level:       (function() {
        if (typeof abCurrentLevel === 'undefined') return 1;
        var lvMap = { 'Level1': 1, 'Level2': 2, 'Level3': 3, 'TalkingMusic': 4 };
        return lvMap[abCurrentLevel] || 1;
      })(),
      reverbType:  typeof abReverbType !== 'undefined'  ? abReverbType    : 'hall',
    };
  } catch(e) {
    return { active: false, vadOn: false, currentKey: '', currentChord: '', level: 1, reverbType: 'hall' };
  }
}

// ── Rubato state helpers ───────────────────────────────────────
// Reads from rubato.js globals defensively.

function _rubatoGetState() {
  try {
    // rubatoChunks = array of { label, filePath } loaded from .vwb pack
    // rubatoActiveIdx = index of currently selected chunk
    // rubatoPlaying = bool
    const chunks = (typeof rubatoChunks !== 'undefined' && Array.isArray(rubatoChunks))
      ? rubatoChunks.map(c => ({ label: c.label || c.fileName || 'Chunk' }))
      : [];
    return {
      chunks,
      activeIdx:  typeof rubatoActiveIdx !== 'undefined'  ? rubatoActiveIdx  : -1,
      playing:    typeof rubatoPlaying    !== 'undefined'  ? !!rubatoPlaying  : false,
      vadEnabled: typeof rubatoVadEnabled !== 'undefined'  ? !!rubatoVadEnabled : false,
      songKey:    typeof rubatoSongKey    !== 'undefined'  ? rubatoSongKey    : '',
    };
  } catch(e) {
    return { chunks: [], activeIdx: -1, playing: false, vadEnabled: false, songKey: '' };
  }
}

// ── House Band mixer state helpers ─────────────────────────────
// Reads per-member volume and mute state from the MIDI engine.
// HB_SLOT_TO_CHANNEL maps slot names to MIDI channels (from house-band-engine.js).
// Per-channel mute and volume are tracked in midi-player.js.

const HB_REMOTE_MEMBERS = [
  { slot: 'drums',      name: 'Jason Washington',  icon: '🥁' },
  { slot: 'percussion', name: 'Diane Moore',        icon: '🪘' },
  { slot: 'bass',       name: 'Terry Washington',   icon: '🎸' },
  { slot: 'keys',       name: 'Julian Cross',       icon: '🎹' },
  { slot: 'organ',      name: 'Paul Simmons',       icon: '🎹' },
  { slot: 'guitar',     name: 'Sanchez Rivera',     icon: '🎸' },
  { slot: 'aux',        name: 'Larry Evans',        icon: '🎛' },
];

function _bandGetMixerState() {
  // midiChMutes and midiChVols are expected to live in midi-player.js
  // as channel-indexed objects: { [ch]: bool } and { [ch]: 0-100 }
  // They may not exist if MIDI engine hasn't initialized yet — safe fallback.
  const slotMap = (typeof HB_SLOT_TO_CHANNEL !== 'undefined') ? HB_SLOT_TO_CHANNEL : {};
  return HB_REMOTE_MEMBERS.map(m => {
    const ch = slotMap[m.slot];
    const muted = (typeof midiChMute !== 'undefined' && ch !== undefined) ? (midiChMute[ch] || false) : false;
    const vol   = (typeof midiChVolumes !== 'undefined' && ch !== undefined) ? (midiChVolumes[ch] ?? 80) : 80;
    // Also pull assigned musician name from band-registry if available
    let displayName = m.name;
    if (typeof bandGetActive === 'function') {
      const musician = bandGetActive(m.slot);
      if (musician && musician.name) displayName = musician.name;
    }
    return { slot: m.slot, name: displayName, icon: m.icon, muted, vol, ch };
  });
}

// ── Main state broadcast ───────────────────────────────────────

function broadcastRemoteState() {
  if (!window.vwb || !window.vwb.remoteStateUpdate) return;
  try {
    const isMidi    = typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi';
    const isPlaying = isMidi ? (typeof midiPlaying !== 'undefined' && midiPlaying) : playing;

    const secs   = song.secs || [];
    const curIdx = typeof curSec !== 'undefined' ? curSec : -1;
    let curSecName = '—';
    if (curIdx >= 0 && secs[curIdx]) curSecName = secs[curIdx].label || secs[curIdx].type || 'Section ' + (curIdx + 1);

    // Progress — from whichever engine is active
    let progress = 0, elapsed = 0, duration = 0;
    if (isMidi) {
      const mt  = (typeof getMidiCurrentTime === 'function') ? getMidiCurrentTime() : 0;
      const dur = (typeof midiDuration !== 'undefined' && typeof midiTempoPct !== 'undefined')
        ? midiDuration / (midiTempoPct / 100) : 0;
      elapsed  = mt;
      duration = dur;
      if (dur > 0) progress = Math.min(100, (mt / dur) * 100);
    } else {
      elapsed  = isPlaying ? Math.max(0, AC.currentTime - startAt) : pauseAt;
      duration = getDur();
      if (duration > 0) progress = Math.min(100, (elapsed / duration) * 100);
    }

    let nextSongTitle = '';
    if (typeof svcCues !== 'undefined' && typeof svcCurIdx !== 'undefined') {
      for (let i = svcCurIdx + 1; i < svcCues.length; i++) {
        if (svcCues[i] && svcCues[i].type === 'song') { nextSongTitle = svcCues[i].title || ''; break; }
      }
    }

    const stemMutes = {};
    SK.forEach(k => { stemMutes[k] = S[k] ? (S[k].muted || false) : false; });

    const state = {
      // ── Existing state (unchanged) ──
      playing: isPlaying,
      panicActive,
      engine: isMidi ? 'midi' : 'audio',
      songTitle:        song.title || '',
      nextSong:         nextSongTitle,
      currentSection:   curSecName,
      currentSectionIdx: curIdx,
      sections:         secs.map(s => ({ type: s.type || '', label: s.label || s.type || '' })),
      progress:         Math.round(progress),
      duration,
      elapsed,
      masterVol:        Math.round((mGain.gain.value || 0.8) * 100),
      secLoop:          (isMidi ? (typeof midiSecLoopOn !== 'undefined' && midiSecLoopOn) : secLoopOn) || false,
      loopOn:           typeof loopPlaying !== 'undefined' ? loopPlaying : false,
      loops:            loopLibrary.map(lp => ({ fn: lp.fn || '', duration: lp.buf ? lp.buf.duration : 0, vol: lp.vol || 80 })),
      activeLoopIdx:    typeof activeLoopIdx !== 'undefined' ? activeLoopIdx : -1,
      midiFiles:        midiPlaylist.map(m => ({ fn: m.fileName || '', duration: m.duration || 0 })),
      midiActiveIdx, midiPlaying,
      setlist:          setlist.map(s => ({ title: s.title || '', tempo: s.tempo || '', ts: s.ts || '4/4' })),
      activeSongTitle:  song.title || '',
      stemMutes,
      auxMuted:         auxMasterMuted || false,
      fading:           remoteFading || false,

      // ── NEW: Armor Bearer / Preacher module ──
      armorBearer: _abGetState(),

      // ── NEW: Rubato Mode ──
      rubato: _rubatoGetState(),

      // ── NEW: House Band 7-member mixer ──
      bandMixer: _bandGetMixerState(),

      // ── NEW: Flex Engine / Chart Player ──
      chart: (function() {
        if (typeof _cp === 'undefined' || !_cp.chart) return null;
        const sections = _cp.chart.sections || [];
        const origKey  = _cp.originalKey || _cp.chart.song?.key || 'C';
        const liveKey  = (typeof cpTransposeRoot === 'function')
                         ? cpTransposeRoot(origKey, _cp.keyOffset || 0) : origKey;
        return {
          playing:        _cp.playing,
          looping:        _cp.looping,
          title:          _cp.chart.song?.title || _cp.fileName || '',
          key:            liveKey,
          keyOffset:      _cp.keyOffset || 0,
          bpm:            _cp.tempo || _cp.chart.song?.bpm || 70,
          activeSectionIdx: _cp.activeSectionIdx,
          activeMeasureIdx: _cp.activeMeasureIdx,
          sections:       sections.map(s => ({ label: s.label || '' })),
        };
      })(),

      // ── NEW: Piano Talk Music ──
      pianoTalk: (function() {
        if (typeof _ptPlaying === 'undefined') return null;
        return {
          playing: _ptPlaying,
          key:     typeof _ptSelectedKey !== 'undefined' ? _ptSelectedKey : 'C',
          loop:    typeof _ptLoop !== 'undefined' ? _ptLoop : true,
        };
      })(),
    };
    window.vwb.remoteStateUpdate(state);
  } catch(e) {}
}

// ── Remote action handler ──────────────────────────────────────

function remoteAction(msg) {
  const a = msg.action;
  try {

    // ── Existing actions (unchanged) ──
    if      (a === 'playPause')     { if (typeof uniTogglePlay === 'function') uniTogglePlay(); else togglePlay(); }
    else if (a === 'stop')          { if (typeof uniStop === 'function') uniStop(); else doStop(); }
    else if (a === 'panic')         panicActive ? panicRecover() : panicEngage();
    else if (a === 'nextSec') {
      const ni = Math.min(song.secs.length - 1, (curSec < 0 ? 0 : curSec) + 1);
      if (ni >= 0) queueSection(ni);
    }
    else if (a === 'prevSec') {
      const pi = Math.max(0, (curSec < 0 ? 0 : curSec) - 1);
      queueSection(pi);
    }
    else if (a === 'jumpToSection') queueSection(msg.idx);
    else if (a === 'secLoop') {
      if (typeof uniToggleSecLoop === 'function') uniToggleSecLoop();
      else { secLoopOn = !secLoopOn; updatePerfLoopUI(); }
    }
    else if (a === 'loopToggle')    toggleLoop();
    else if (a === 'setActiveLoop') switchLoop(msg.idx);
    else if (a === 'setLoopVol')    { if (loopLibrary[msg.idx]) { loopLibrary[msg.idx].vol = msg.value; applyLoopVol(); } }
    else if (a === 'midiPlay')      toggleMidiPlay();
    else if (a === 'midiNext')      { if (midiPlaylist.length > 0) selectMidiFile((midiActiveIdx + 1) % midiPlaylist.length); }
    else if (a === 'midiSelect')    selectMidiFile(msg.idx);
    else if (a === 'setVol' && msg.volType === 'master') {
      if (typeof setMasterVol === 'function') setMasterVol(msg.value);
      else mGain.gain.value = msg.value / 100;
    }
    else if (a === 'stemMute')      { if (S[msg.stem]) { S[msg.stem].muted = !S[msg.stem].muted; applySoloMute(); } }
    else if (a === 'auxMute')       { auxMasterMuted = !auxMasterMuted; auxMasterGain.gain.value = auxMasterMuted ? 0 : auxMasterVol / 100; renderMixer(); }
    else if (a === 'fadeOut')       remoteDoFade();
    else if (a === 'loadSong')      { if (setlist[msg.idx]) loadSongData(setlist[msg.idx]); }
    else if (a === 'seekTo') {
      const isMidi = typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi';
      if (isMidi) {
        if (typeof seekMidi === 'function') seekMidi(msg.pct * 100);
      } else {
        const dur = getDur();
        if (dur > 0) jumpTo(msg.pct * dur);
      }
    }

    // ── NEW: Armor Bearer / Preacher actions ──
    // ab* functions expected from armor-bearer.js

    else if (a === 'abToggle') {
      // Main on/off toggle for the entire Armor Bearer organ module
      if (typeof abLoaded !== 'undefined' && abLoaded) { if (typeof abTrigger === 'function') abTrigger((typeof abCurrentKey !== 'undefined' ? abCurrentKey : 'C'), (typeof abCurrentLevel !== 'undefined' ? abCurrentLevel : 1)); } else { if (typeof abAutoLoadBundled === 'function') abAutoLoadBundled(); }
    }
    else if (a === 'abVadToggle') {
      // Toggle VAD (voice activity detection) mode on/off
      if (typeof abKeyDetecting !== 'undefined' && abKeyDetecting) { if (typeof abStopKeyDetection === 'function') abStopKeyDetection(); } else { if (typeof abStartKeyDetection === 'function') abStartKeyDetection(); }
    }
    else if (a === 'abManualTrigger') {
      // Manual tap — plays the next chord hit / run immediately
      if (typeof abTrigger === 'function') abTrigger((typeof abCurrentKey !== 'undefined' ? abCurrentKey : 'C'), (typeof abCurrentLevel !== 'undefined' ? abCurrentLevel : 1));
    }
    else if (a === 'abSetLevel') {
      // Map number to string level — abSetLevel expects 'Level1', 'Level2', 'Level3', 'TalkingMusic'
      var lvlMap = { 1: 'Level1', 2: 'Level2', 3: 'Level3', 4: 'TalkingMusic' };
      var lvlStr = lvlMap[msg.level];
      if (typeof abSetLevel === 'function' && lvlStr) abSetLevel(lvlStr);
    }
    else if (a === 'abSetKey') {
      // Override the current organ key
      if (typeof abSetKey === 'function' && msg.key) abSetKey(msg.key);
    }
    else if (a === 'abSetReverb') {
      // Switch reverb type: 'hall' or 'plate'
      if (typeof abSetReverbType === 'function' && msg.reverbType) abSetReverbType(msg.reverbType);
    }
    else if (a === 'abAllNotesOff') {
      // Emergency all-notes-off for the organ — same as panic but organ-only
      if (typeof abStop === 'function') abStop();
    }

    // ── NEW: Rubato Mode actions ──
    // rubato* functions expected from rubato.js

    else if (a === 'rubatoTrigger') {
      // Tap-trigger: play a specific chunk by index (replaces voice trigger)
      if (typeof rubatoTriggerByIndex === 'function') rubatoTriggerByIndex(msg.idx);
      else if (typeof rubatoTrigger === 'function')   rubatoTrigger(msg.idx);
    }
    else if (a === 'rubatoStop') {
      if (typeof rubatoStop === 'function') rubatoStop();
    }
    else if (a === 'rubatoToggleVad') {
      // Toggle whether Rubato also listens for voice commands
      if (typeof rubatoToggleVad === 'function') rubatoToggleVad();
    }

    // ── NEW: House Band 7-member mixer actions ──
    // These write to midiChMutes and midiChVols which midi-player.js reads
    // on every scheduled event. Channel map comes from house-band-engine.js.

    else if (a === 'bandMemberMute') {
      // msg.slot: 'drums' | 'percussion' | 'bass' | 'keys' | 'organ' | 'guitar' | 'aux'
      const ch = (typeof HB_SLOT_TO_CHANNEL !== 'undefined') ? HB_SLOT_TO_CHANNEL[msg.slot] : undefined;
      if (ch !== undefined) {
        if (typeof midiChMute === 'undefined') window.midiChMute = {};
        midiChMute[ch] = !midiChMute[ch];
        // If midi-player has a refresh function, call it so the desktop UI reflects the change
        // Refresh all visible mixer rows after mute/solo change
        Object.keys(midiChMute || {}).forEach(ch => { if (typeof _updateMixerRowState === 'function') _updateMixerRowState(parseInt(ch)); });
      }
    }
    else if (a === 'bandMemberVol') {
      // msg.slot: slot name, msg.value: 0-100
      const ch = (typeof HB_SLOT_TO_CHANNEL !== 'undefined') ? HB_SLOT_TO_CHANNEL[msg.slot] : undefined;
      if (ch !== undefined && typeof msg.value === 'number') {
        if (typeof midiChVolumes === 'undefined') window.midiChVolumes = {};
        midiChVolumes[ch] = Math.max(0, Math.min(100, msg.value));
        if (typeof synthSetVolume === 'function') synthSetVolume(ch, midiChVolumes[ch]);
      }
    }
    else if (a === 'bandMemberSolo') {
      // Solo this member (mute all others). msg.slot: slot name, or null to unsolo all.
      const slotMap = (typeof HB_SLOT_TO_CHANNEL !== 'undefined') ? HB_SLOT_TO_CHANNEL : {};
      if (typeof midiChMutes === 'undefined') window.midiChMutes = {};
      if (msg.slot) {
        const soloChannel = slotMap[msg.slot];
        Object.entries(slotMap).forEach(([slot, ch]) => {
          midiChMutes[ch] = (ch !== soloChannel);
        });
      } else {
        // Clear all mutes
        Object.values(slotMap).forEach(ch => { midiChMutes[ch] = false; });
      }
      // Refresh all visible mixer rows after mute/solo change
        Object.keys(midiChMute || {}).forEach(ch => { if (typeof _updateMixerRowState === 'function') _updateMixerRowState(parseInt(ch)); });
    }

    // ── Flex Engine / Chart Player actions ──────────────────────
    else if (a === 'cpPlay') {
      if (typeof cpTogglePlay === 'function') cpTogglePlay();
      else if (typeof uniTogglePlay === 'function') uniTogglePlay();
    }
    else if (a === 'cpStop') {
      if (typeof cpStop === 'function') cpStop();
      else if (typeof uniStop === 'function') uniStop();
    }
    else if (a === 'cpJumpSection') {
      // msg.idx: section index to jump to
      if (typeof cpJumpToSection === 'function' && typeof msg.idx === 'number') cpJumpToSection(msg.idx);
    }
    else if (a === 'cpLoopToggle') {
      if (typeof cpToggleSectionLoop === 'function') cpToggleSectionLoop();
    }
    else if (a === 'cpSetKey') {
      // msg.offset: semitone offset (-11 to +11)
      if (typeof cpSetKeyOffset === 'function' && typeof msg.offset === 'number') cpSetKeyOffset(msg.offset);
    }
    else if (a === 'cpSetTempo') {
      // msg.bpm: tempo in BPM
      if (typeof cpSetTempo === 'function' && typeof msg.bpm === 'number') cpSetTempo(msg.bpm);
    }
    else if (a === 'cpClear') {
      if (typeof cpClearChart === 'function') cpClearChart();
    }

    // ── Piano Talk Music actions ──────────────────────────────
    else if (a === 'ptPlay') {
      if (typeof ptPlay === 'function') ptPlay();
    }
    else if (a === 'ptStop') {
      if (typeof ptStop === 'function') ptStop();
    }
    else if (a === 'ptSetKey') {
      // msg.key: key name e.g. 'Bb', 'C', 'Db'
      if (typeof ptSetKey === 'function' && msg.key) ptSetKey(msg.key);
    }
    else if (a === 'ptFade') {
      if (typeof ptFadeOut === 'function') ptFadeOut();
    }

    setTimeout(broadcastRemoteState, 150);
  } catch(e) { console.log('Remote action error:', e); }
}

function remoteDoFade() {
  if (!playing || remoteFading) return;
  remoteFading = true;
  const fadeDuration = 4, steps = 40;
  const stepTime = (fadeDuration * 1000) / steps;
  const startVol = mGain.gain.value;
  let step = 0;
  remoteFadeTimer = setInterval(() => {
    step++;
    mGain.gain.value = Math.max(0, startVol * (1 - step / steps));
    if (step >= steps) {
      clearInterval(remoteFadeTimer);
      if (typeof uniStop === 'function') uniStop(); else doStop();
      mGain.gain.value = startVol;
      remoteFading = false;
      broadcastRemoteState();
    }
  }, stepTime);
}

function startRemoteBroadcast() {
  if (remoteStateTimer) clearInterval(remoteStateTimer);
  remoteStateTimer = setInterval(broadcastRemoteState, 1000);
}

async function initRemote() {
  try {
    remoteInfo = await window.vwb.remoteGetInfo();
    const urlEl = document.getElementById('remoteUrl');
    if (urlEl) urlEl.textContent = remoteInfo.url;
    startRemoteBroadcast();
  } catch(e) { console.log('Remote init:', e); }
}

setTimeout(initRemote, 2000);

// ── License System ─────────────────────────────────────────────

const LS_API_KEY       = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI5NGQ1OWNlZi1kYmI4LTRlYTUtYjE3OC1kMjU0MGZjZDY5MTkiLCJqdGkiOiJhNjAxMGEwZTZhN2Q3NWVjZDJhNjg3M2E4YTMyOTg4MzUwZjEwNDNjMTliNjJlMGM0OWMyOGZmYzA0NTljOGE5MDBjNGEwOTliMmUxOTQ2NCIsImlhdCI6MTc4MDY2ODE3OC42MTI4MTEsIm5iZiI6MTc4MDY2ODE3OC42MTI4MTQsImV4cCI6MjExNDI5NDQwMC4wMzcxNzYsInN1YiI6IjczMDc5MDEiLCJzY29wZXMiOltdfQ.kuscrjL01tTaE2SlwZ4cEJgJgOnSc93xXaGW-oO23ofLZWj20C0aykuFnJ1DgewESwE8ssTaGRe6v-XXt5kkgUcaBCYkDfIbrlbADERKpt9LEOoztOI7sSRlkDaScgrXJFJpcJtgGXWkVsneSSTb6Bar6VDZPaUbAgJegOhGfsfoVn-ZvkDwCyBZSX3Z7eXCxOT21DlVhxAalGWoVjSHzPLyev451PRy6A_I9AwAasLRFD1iHzfkYxMZqSrZD7Cn2mnfPi_kxtN-QvQQUEcCCY6V5B5J6tCoJ9Fi-ODLjpKcHZsL7pMDsZVV9yYL91-MKjr0m4lWomrc_Oz3GnItkDGHBlHAI039GBuuY-xc9XFptI-rrol39A04DULmA5ctL_VI-jjY_ricFc7-FFvgY_ljiwKVnTBmmKQAUXd5FLNHUCSDc7OBTfCGTCsxBDgSz16BnjVVuT9aCqpSoggAoc53IYVHVpkYmzk1Gn70O3ZkoWWlhtPGBVpBCGEYvBGN5A0ky3ldXFcC9Lvf2-gu5LgSwqfB1q1so2xEzOHYe7BnrjlwBc9r476TON06mVqw2zoHlONha1KQ77hDHkMN8lP4kQalUiXBiAL72Ty7rWAoRqRTxC76SbCECuTDAucSipIYbJ0DK4uqUTQGU8bKdzNlYkUUes6Ez_dbWFgPwxo';
const LS_STORE_ID      = '395278';
const LICENSE_KEY      = 'vwb_license_key';
const LICENSE_INSTANCE = 'vwb_license_instance';

async function checkLicenseActivation() {
  try {
    const savedKey = await window.vwb.loadJson('license');
    if (!savedKey.success || !savedKey.data || !savedKey.data.key) return false;
    const { key, instanceId } = savedKey.data;
    if (!key || !instanceId) return false;
    return await verifyLicenseKey(key, instanceId);
  } catch(e) {
    try {
      const savedKey = await window.vwb.loadJson('license');
      return savedKey.success && savedKey.data && savedKey.data.key;
    } catch(e2) { return false; }
  }
}

async function verifyLicenseKey(key, instanceId) {
  try {
    const resp = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key, instance_id: instanceId })
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.valid === true;
  } catch(e) { return true; } // allow offline use if already activated
}

async function activateLicense() {
  const keyInput = document.getElementById('licenseKeyInput');
  const btn      = document.getElementById('licenseActivateBtn');
  const errEl    = document.getElementById('licenseError');
  const sucEl    = document.getElementById('licenseSuccess');
  const key      = (keyInput.value || '').trim();
  if (!key) { errEl.textContent = 'Please enter your license key.'; return; }

  // Owner bypass
  if (key === 'HMPI-OWNER-2026' || key === 'HMPI-DEV-BYPASS') {
    await window.vwb.saveJson('license', { key, instanceId: 'owner-bypass', activatedAt: new Date().toISOString() });
    sucEl.textContent = '✓ Owner access granted. Loading VWB...';
    btn.textContent   = '✓ Activated!';
    setTimeout(() => showMainApp(), 1000);
    return;
  }

  errEl.textContent = ''; sucEl.textContent = '';
  btn.disabled = true; btn.textContent = 'Activating...';

  try {
    const resp = await fetch('https://api.lemonsqueezy.com/v1/licenses/activate', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key, instance_name: 'VWB-' + (navigator.platform || 'Desktop') })
    });
    const data = await resp.json();
    if (resp.ok && data.activated) {
      await window.vwb.saveJson('license', {
        key, instanceId: data.instance ? data.instance.id : '', activatedAt: new Date().toISOString()
      });
      sucEl.textContent = '✓ Activated successfully! Loading VWB...';
      btn.textContent   = '✓ Activated!';
      setTimeout(() => showMainApp(), 1500);
    } else {
      const errMsg = data.error || (data.errors && data.errors[0] && data.errors[0].detail) || '';
      if (errMsg.toLowerCase().includes('limit')) {
        errEl.textContent = 'Activation limit reached. This key is already active on the maximum number of computers. Contact hollinsmusic@gmail.com for help.';
      } else if (errMsg.toLowerCase().includes('invalid') || errMsg.toLowerCase().includes('not found')) {
        errEl.textContent = 'Invalid license key. Please check your purchase email and try again.';
      } else {
        errEl.textContent = 'Activation failed: ' + (errMsg || 'Unknown error. Please try again or contact support.');
      }
      btn.disabled = false; btn.textContent = 'Activate VWB';
    }
  } catch(e) {
    errEl.textContent = 'Network error. Please check your internet connection and try again.';
    btn.disabled = false; btn.textContent = 'Activate VWB';
  }
}

// ── App Init ───────────────────────────────────────────────────

async function initApp() {
  const isActivated = await checkLicenseActivation();
  if (!isActivated) {
    document.getElementById('splash').classList.add('hidden');
    setTimeout(() => { document.getElementById('splash').style.display = 'none'; }, 600);
    document.getElementById('licenseScreen').style.display = 'flex';
    return;
  }
  showMainApp();
}

async function showMainApp() {
  document.getElementById('splash').classList.add('hidden');
  document.getElementById('licenseScreen').style.display = 'none';
  setTimeout(() => { document.getElementById('splash').style.display = 'none'; }, 600);
  document.getElementById('app').style.display = 'block';
  if (AC.state === 'suspended') AC.resume();
  renderStems(); renderAuxPanel(); renderSections(); renderRouting();
  renderLoopLibrary(); updMInfo(); initMiniBeats(); initScrubButtons(); renderMrcGrid();
  if (typeof renderProcessorUI === 'function') renderProcessorUI();

  try {
    const savedLoopVol = localStorage.getItem('vwb_loopVol');
    if (savedLoopVol !== null) {
      const v = parseInt(savedLoopVol);
      loopGain.gain.value = v / 100;
      document.querySelectorAll('.loop-vol-slider').forEach(el => { el.value = v; });
      const pct = document.getElementById('loopPct');
      if (pct) pct.textContent = v + '%';
    }
  } catch(e) {}

  loadCrossfadeSettings();
  if (typeof initMidi === 'function') initMidi().then(() => { if (typeof refreshMrcInputs === 'function') refreshMrcInputs(); });
  await loadMrcMappings();

  // Fresh start — nothing auto-loads.
  // User opens what they need via File > Open Session or File > Open Recent.

  await loadSvcCues();
  initSvcMrcFunctions();

  // Initialize House Band content updater — checks Netlify manifest in background
  if (typeof hbContentUpdaterInit === 'function') hbContentUpdaterInit();

  document.getElementById('songTempo').addEventListener('change', () => {
    song.tempo = parseInt(document.getElementById('songTempo').value) || 72;
    updMInfo(); initMiniBeats();
  });
  document.getElementById('songTimeSig').addEventListener('change', () => {
    song.ts = document.getElementById('songTimeSig').value;
    updMInfo(); initMiniBeats();
  });
}
