// ═══════════════════════════════════════════════════════════════
//  VWB — Audio Engine
//  Playback control, sample-accurate section jumping,
//  solo/mute, and the animation loop.
//  Depends on: state.js, audio-processor.js
// ═══════════════════════════════════════════════════════════════

// ── Transport ──────────────────────────────────────────────────

function togglePlay() {
  if (AC.state === 'suspended') AC.resume();
  if (typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi') {
    toggleMidiPlay();
    return;
  }
  playing ? doPause() : doPlay();
}

function doPlay() {
  if (!stemCount()) {
    alert('No stems loaded. Load audio files in Song Setup first.');
    return;
  }
  killSources();
  const rate = (typeof getPlaybackRate === 'function') ? getPlaybackRate() : 1.0;
  SK.forEach(k => {
    if (!S[k].buf) return;
    const src = AC.createBufferSource();
    src.buffer = (typeof getProcessedBuffer === 'function')
      ? getProcessedBuffer(S[k].buf, k)
      : S[k].buf;
    src.playbackRate.value = rate;
    src.connect(S[k].gn);
    src.start(0, pauseAt);
    S[k].src = src;
  });
  auxTracks.forEach((t, i) => {
    if (!t.buf) return;
    const src = AC.createBufferSource();
    src.buffer = (typeof getProcessedAuxBuffer === 'function')
      ? getProcessedAuxBuffer(t.buf, i)
      : t.buf;
    src.playbackRate.value = rate;
    src.connect(t.gn);
    src.start(0, pauseAt);
    t.src = src;
  });
  MONITOR_SLOTS.forEach(k => {
    if (!MON[k].buf) return;
    const src = AC.createBufferSource();
    src.buffer = MON[k].buf;
    src.playbackRate.value = rate;
    src.connect(MON[k].gn);
    src.start(0, pauseAt);
    MON[k].src = src;
  });
  startAt = AC.currentTime - pauseAt;
  playing = true;
  updTransUI();
  applySoloMute();
  runLoop();
}

function doPause() {
  if (!playing) return;
  cancelPendingJump();
  pauseAt = AC.currentTime - startAt;
  killSources();
  playing = false;
  updTransUI();
  cancelAnim();
}

function doStop() {
  if (typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi') {
    stopMidiPlay();
    return;
  }
  cancelPendingJump();
  killSources();
  playing = false;
  pauseAt = 0;
  qSec = -1;
  curSec = -1;
  secLoopJumping = false;
  if (panicActive) {
    panicActive = false;
    const btn = document.getElementById('panicBtn');
    if (btn) { btn.classList.remove('active'); btn.textContent = '⚠ PANIC'; }
    SK.forEach(k => { if (S[k].gn && !S[k].muted) S[k].gn.gain.value = S[k].vol / 100; });
    auxMasterGain.gain.value = auxMasterMuted ? 0 : auxMasterVol / 100;
  }
  updTransUI();
  updDisplays(0);
  cancelAnim();
}

function killSources() {
  SK.forEach(k => {
    if (S[k].src) {
      try { S[k].src.stop(); }       catch(e) {}
      try { S[k].src.disconnect(); } catch(e) {}
      S[k].src = null;
    }
  });
  auxTracks.forEach(t => {
    if (t.src) {
      try { t.src.stop(); }       catch(e) {}
      try { t.src.disconnect(); } catch(e) {}
      t.src = null;
    }
  });
  MONITOR_SLOTS.forEach(k => {
    if (MON[k].src) {
      try { MON[k].src.stop(); }       catch(e) {}
      try { MON[k].src.disconnect(); } catch(e) {}
      MON[k].src = null;
    }
  });
}

function cancelAnim() { if (afId) { cancelAnimationFrame(afId); afId = null; } }
function getCurTime()  { return playing ? AC.currentTime - startAt : pauseAt; }

// ── Seek ───────────────────────────────────────────────────────

function jumpTo(targetTime) {
  targetTime = Math.max(0, Math.min(targetTime, getDur()));
  const rate = (typeof getPlaybackRate === 'function') ? getPlaybackRate() : 1.0;
  if (playing) {
    killSources();
    pauseAt = targetTime;
    SK.forEach(k => {
      if (!S[k].buf) return;
      const src = AC.createBufferSource();
      src.buffer = (typeof getProcessedBuffer === 'function')
        ? getProcessedBuffer(S[k].buf, k)
        : S[k].buf;
      src.playbackRate.value = rate;
      src.connect(S[k].gn);
      src.start(0, targetTime);
      S[k].src = src;
    });
    auxTracks.forEach((t, i) => {
      if (!t.buf) return;
      const src = AC.createBufferSource();
      src.buffer = (typeof getProcessedAuxBuffer === 'function')
        ? getProcessedAuxBuffer(t.buf, i)
        : t.buf;
      src.playbackRate.value = rate;
      src.connect(t.gn);
      src.start(0, targetTime);
      t.src = src;
    });
    startAt = AC.currentTime - targetTime;
    applySoloMute();
  } else {
    pauseAt = targetTime;
    updDisplays(targetTime);
  }
}

function seekTL(e) {
  const r = document.getElementById('tlBar').getBoundingClientRect();
  jumpTo(((e.clientX - r.left) / r.width) * getDur());
}

// ── Sample-Accurate Section Jumping ───────────────────────────

let pendingJumpTimer     = null;
let pendingJumpACTime    = 0;
let pendingNewSources    = [];
let pendingNewAuxSources = [];

function findSectionAtTime(t) {
  const bar = time2bar(t);
  for (let i = song.secs.length - 1; i >= 0; i--) {
    if (bar >= song.secs[i].sb) return i;
  }
  return -1;
}

function queueSection(idx) {
  // ── MIDI Engine: use Web Audio clock for sample-accurate jumps ──
  if (typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi') {
    if (idx < 0 || idx >= song.secs.length) return;
    curSec = idx;
    refreshAllSectionUI();

    const sb          = song.secs[idx].sb;
    const quantize    = (typeof sectionJumpQuantize !== 'undefined') ? sectionJumpQuantize : '1bar';
    const isPlaying   = typeof midiPlaying !== 'undefined' && midiPlaying;

    if (!isPlaying || quantize === 'immediate') {
      // Not playing or immediate — jump right now
      if (typeof jumpMidiSectionByBar === 'function') jumpMidiSectionByBar(sb);
      return;
    }

    // ── Quantize math ──────────────────────────────────────────
    // getMidiCurrentTime() returns unscaled file position in seconds.
    // midiSecsPerBar() returns unscaled seconds per bar at original BPM.
    // Both are on the same scale — no tempo scaling needed here.
    // The setTimeout delay is in wall-clock ms, so we convert the
    // unscaled wait time to wall-clock by dividing by tempoScale.
    const tempoScale = (typeof midiTempoPct !== 'undefined') ? midiTempoPct / 100 : 1;
    const spb        = (typeof midiSecsPerBar === 'function') ? midiSecsPerBar() : 0.5;
    const curTime    = (typeof getMidiCurrentTime === 'function') ? getMidiCurrentTime() : 0;
    let unscaledWait = 0;

    if (quantize === 'halfbar') {
      const halfBar   = spb / 2;
      const posInHalf = curTime % halfBar;
      unscaledWait    = halfBar - posInHalf;
      if (unscaledWait < 0.05) unscaledWait += halfBar;
    } else if (quantize === '2bar') {
      const pos2   = curTime % (spb * 2);
      unscaledWait = (spb * 2) - pos2;
      if (unscaledWait < 0.05) unscaledWait += spb * 2;
    } else {
      // 1 bar (default) — wait until beat 1 of the very next bar
      const posInBar = curTime % spb;
      unscaledWait   = spb - posInBar;
      if (unscaledWait < 0.05) unscaledWait += spb;
    }

    // Convert unscaled wait to wall-clock milliseconds
    const waitMs = (unscaledWait / tempoScale) * 1000;

    const qTimer = setTimeout(() => {
      if (typeof midiPlaying !== 'undefined' && midiPlaying) {
        if (typeof jumpMidiSectionByBar === 'function') jumpMidiSectionByBar(sb);
      }
    }, Math.max(0, waitMs));

    if (typeof midiTimers !== 'undefined') midiTimers.push(qTimer);
    return;
  }

  if (idx < 0 || idx >= song.secs.length) return;
  cancelPendingJump();

  if (!playing) {
    curSec = idx;
    jumpTo(bar2time(song.secs[idx].sb));
    refreshAllSectionUI();
    return;
  }

  // ── Quantize: calculate wait time based on setting ──
  const quantize = (typeof sectionJumpQuantize !== 'undefined') ? sectionJumpQuantize : '1bar';
  const now      = AC.currentTime;
  const songPos  = now - startAt;
  const spb      = secPerBar();
  let timeToFire = 0;

  if (quantize === 'immediate') {
    timeToFire = 0;
  } else if (quantize === 'halfbar') {
    const halfBar = spb / 2;
    const posInHalf = songPos % halfBar;
    timeToFire = halfBar - posInHalf;
    if (timeToFire < 0.03) timeToFire += halfBar;
  } else if (quantize === '2bar') {
    const pos2 = songPos % (spb * 2);
    timeToFire = (spb * 2) - pos2;
    if (timeToFire < 0.03) timeToFire += spb * 2;
  } else {
    // Default: 1 bar
    const barPos = songPos % spb;
    timeToFire = spb - barPos;
    if (timeToFire < 0.03) timeToFire += spb;
  }

  // Immediate jump
  if (timeToFire === 0) {
    curSec = idx;
    jumpTo(bar2time(song.secs[idx].sb));
    refreshAllSectionUI();
    return;
  }

  const downbeatACTime = now + timeToFire;
  const targetOffset   = bar2time(song.secs[idx].sb);
  const rate = (typeof getPlaybackRate === 'function') ? getPlaybackRate() : 1.0;

  SK.forEach(k => {
    if (S[k].src) try { S[k].src.stop(downbeatACTime); } catch(e) {}
  });
  auxTracks.forEach(t => {
    if (t.src) try { t.src.stop(downbeatACTime); } catch(e) {}
  });

  const newSources = {};
  SK.forEach(k => {
    if (!S[k].buf) return;
    const src = AC.createBufferSource();
    src.buffer = (typeof getProcessedBuffer === 'function')
      ? getProcessedBuffer(S[k].buf, k)
      : S[k].buf;
    src.playbackRate.value = rate;
    src.connect(S[k].gn);
    src.start(downbeatACTime, targetOffset);
    newSources[k] = src;
  });
  const newAuxSources = [];
  auxTracks.forEach((t, i) => {
    if (!t.buf) return;
    const src = AC.createBufferSource();
    src.buffer = (typeof getProcessedAuxBuffer === 'function')
      ? getProcessedAuxBuffer(t.buf, i)
      : t.buf;
    src.playbackRate.value = rate;
    src.connect(t.gn);
    src.start(downbeatACTime, targetOffset);
    newAuxSources[i] = src;
  });

  pendingNewSources    = newSources;
  pendingNewAuxSources = newAuxSources;
  pendingJumpACTime    = downbeatACTime;
  qSec = idx;
  refreshAllSectionUI();

  const msUntilJump = timeToFire * 1000;
  pendingJumpTimer = setTimeout(() => {
    SK.forEach(k => {
      if (S[k].src) try { S[k].src.disconnect(); } catch(e) {}
      if (newSources[k]) S[k].src = newSources[k];
    });
    auxTracks.forEach((t, i) => {
      if (t.src) try { t.src.disconnect(); } catch(e) {}
      if (newAuxSources[i]) t.src = newAuxSources[i];
    });
    startAt = downbeatACTime - targetOffset;
    curSec = idx;
    qSec = -1;
    pendingJumpTimer = null;
    pendingNewSources = [];
    pendingNewAuxSources = [];
    applySoloMute();
    refreshAllSectionUI();
  }, Math.max(0, msUntilJump - 5));
}
  const targetOffset   = bar2time(song.secs[idx].sb);
  const rate = (typeof getPlaybackRate === 'function') ? getPlaybackRate() : 1.0;

  SK.forEach(k => {
    if (S[k].src) try { S[k].src.stop(downbeatACTime); } catch(e) {}
  });
  auxTracks.forEach(t => {
    if (t.src) try { t.src.stop(downbeatACTime); } catch(e) {}
  });

  const newSources = {};
  SK.forEach(k => {
    if (!S[k].buf) return;
    const src = AC.createBufferSource();
    src.buffer = (typeof getProcessedBuffer === 'function')
      ? getProcessedBuffer(S[k].buf, k)
      : S[k].buf;
    src.playbackRate.value = rate;
    src.connect(S[k].gn);
    src.start(downbeatACTime, targetOffset);
    newSources[k] = src;
  });
  const newAuxSources = [];
  auxTracks.forEach((t, i) => {
    if (!t.buf) return;
    const src = AC.createBufferSource();
    src.buffer = (typeof getProcessedAuxBuffer === 'function')
      ? getProcessedAuxBuffer(t.buf, i)
      : t.buf;
    src.playbackRate.value = rate;
    src.connect(t.gn);
    src.start(downbeatACTime, targetOffset);
    newAuxSources[i] = src;
  });

  pendingNewSources    = newSources;
  pendingNewAuxSources = newAuxSources;
  pendingJumpACTime    = downbeatACTime;
  qSec = idx;
  refreshAllSectionUI();

function cancelPendingJump() {
  if (pendingJumpTimer) { clearTimeout(pendingJumpTimer); pendingJumpTimer = null; }
  if (pendingNewSources && typeof pendingNewSources === 'object') {
    Object.values(pendingNewSources).forEach(src => {
      try { src.stop(0); }       catch(e) {}
      try { src.disconnect(); }  catch(e) {}
    });
    pendingNewSources = [];
  }
  if (pendingNewAuxSources && pendingNewAuxSources.length) {
    pendingNewAuxSources.forEach(src => {
      if (src) { try { src.stop(0); } catch(e) {} try { src.disconnect(); } catch(e) {} }
    });
    pendingNewAuxSources = [];
  }
  qSec = -1;
}

function checkQueue(t) {}

function autoDetectSection(t) {
  if (qSec >= 0 || pendingJumpTimer) return;
  const newSec = findSectionAtTime(t);
  if (newSec !== curSec) {
    curSec = newSec;
    refreshAllSectionUI();
  }
}

// ── Section Loop ───────────────────────────────────────────────

function toggleSecLoop() {
  secLoopOn = !secLoopOn;
  const btn = document.getElementById('secLoopBtn');
  if (btn) btn.classList.toggle('on', secLoopOn);
  renderPerfSections();
}

function checkSectionLoop(t) {
  if (secLoopJumping) return;
  if (curSec < 0 || curSec >= song.secs.length) return;
  const sec = song.secs[curSec];
  const shouldLoop = secLoopOn || sec.loop === true;
  if (!shouldLoop) return;
  const secEndTime = bar2time(sec.eb + 1);
  if (t >= secEndTime - 0.05) {
    secLoopJumping = true;
    jumpTo(bar2time(sec.sb));
    setTimeout(() => { secLoopJumping = false; }, 200);
  }
}

function toggleSecLoopFlag(idx) {
  if (idx < 0 || idx >= song.secs.length) return;
  song.secs[idx].loop = !song.secs[idx].loop;
  if (song.secs[idx].loop && idx === curSec) secLoopJumping = false;
  refreshAllSectionUI();
  renderSections();
}

// ── Solo / Mute ────────────────────────────────────────────────

function toggleMute(k) { S[k].muted = !S[k].muted; applySoloMute(); renderMixer(); }
function toggleSolo(k) { S[k].solo  = !S[k].solo;  applySoloMute(); renderMixer(); }

function applySoloMute() {
  const anySolo = SK.some(k => S[k].solo) || auxSolo;
  SK.forEach(k => {
    let on = true;
    if (S[k].muted)            on = false;
    if (anySolo && !S[k].solo) on = false;
    S[k].gn.gain.value = on ? S[k].vol / 100 : 0;
  });
  applyAuxGains();
}

function setVol(k, v) { S[k].vol = parseInt(v); applySoloMute(); }
function setMasterVol(v) {
  const pct = parseFloat(v) / 100;

  // Always control the Web Audio stem engine
  mGain.gain.value = pct;

  // Control the MIDI synth engine via its dedicated master vol function
  if (typeof synthSetMasterVol === 'function') {
    synthSetMasterVol(v);
  } else if (typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi') {
    // Fallback — direct Tone.js control if synthSetMasterVol not available
    try {
      if (typeof Tone !== 'undefined') {
        if (pct <= 0) {
          Tone.getDestination().volume.value = -Infinity;
        } else {
          Tone.getDestination().volume.value = 20 * Math.log10(pct) + 10;
        }
      }
    } catch(e) {}
  }

  // Persist the value so it survives page reloads
  try { localStorage.setItem('vwb_masterVol', v); } catch(e) {}

  // Send CC7 to external MIDI output for hardware synths
  if (typeof midiOutPort !== 'undefined' && midiOutPort) {
    const midiVol = Math.round(pct * 127);
    for (let ch = 0; ch < 16; ch++) {
      try { midiOutPort.send([0xB0 | ch, 7, midiVol]); } catch(e) {}
    }
  }
}

// ── Animation Loop ─────────────────────────────────────────────

function runLoop() {
  function tick() {
    if (!playing) return;
    const t = getCurTime();
    if (t >= getDur()) {
      songEndedNaturally = true;
      doStop();
      songEndedNaturally = false;
      return;
    }
    checkQueue(t);
    if (qSec < 0) autoDetectSection(t);
    checkSectionLoop(t);
    updDisplays(t);
    if (typeof uniOnAudioTick === 'function') uniOnAudioTick();
    afId = requestAnimationFrame(tick);
  }
  cancelAnim();
  afId = requestAnimationFrame(tick);
}

// ── Display Updates ────────────────────────────────────────────

function refreshAllSectionUI() {
  renderPerfSections();
  highlightSetupSections();
}

function highlightSetupSections() {
  const isMidiEng  = typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi';
  const isPlayingNow = isMidiEng ? (typeof midiPlaying !== 'undefined' && midiPlaying) : playing;
  document.querySelectorAll('#secList .sec-row').forEach((row, i) => {
    row.classList.toggle('now-playing', isPlayingNow && i === curSec);
  });
}

function updDisplays(t) {
  // When MIDI engine is active, update mini transport from MIDI time
  if (typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi') {
    const mt        = (typeof getMidiCurrentTime === 'function') ? getMidiCurrentTime() : 0;
    const bpm       = (typeof midiBpm !== 'undefined') ? midiBpm : 120;
    const timeSig   = (typeof midiTimeSig !== 'undefined') ? midiTimeSig : 4;
    const tUnscaled = mt * ((typeof midiTempoPct !== 'undefined' ? midiTempoPct : 100) / 100);
    const mBar      = (typeof midiTime2Bar === 'function') ? midiTime2Bar(tUnscaled) : 1;
    const mDur      = (typeof midiDuration !== 'undefined') ? midiDuration / ((typeof midiTempoPct !== 'undefined' ? midiTempoPct : 100) / 100) : 0;
    const mPct      = mDur > 0 ? Math.min(100, (mt / mDur) * 100) : 0;
    const el        = id => document.getElementById(id);

    if (el('mtMeas')) el('mtMeas').textContent = 'Bar ' + mBar;
    if (el('mtTime')) el('mtTime').textContent = fmt(mt);
    const scrubProg = el('mtScrubProg');
    if (scrubProg) scrubProg.style.width = mPct + '%';

    // Beat dots — pulse based on MIDI BPM
    const secPerBeat = 60 / bpm;
    const beatIdx    = Math.floor((tUnscaled % (secPerBeat * timeSig)) / secPerBeat) % timeSig;
    document.querySelectorAll('#mtBeat .mt-bd').forEach((dot, i) => {
      dot.classList.remove('act', 'db');
      dot.style.display = i < timeSig ? '' : 'none';
      if (i === beatIdx) dot.classList.add(i === 0 ? 'db' : 'act');
    });
    highlightSetupSections();
    return;
  }

  const bar  = time2bar(t);
  const beat = beatInBar(t);
  const d    = getDur();
  const pct  = d > 0 ? (t / d) * 100 : 0;
  const bp   = bpb();
  const el   = id => document.getElementById(id);

  if (el('curMeas')) el('curMeas').textContent = bar;
  if (el('tlBar1'))  el('tlBar1').textContent  = 'Bar ' + bar;
  if (el('tlTime'))  el('tlTime').textContent  = fmt(t);
  if (el('tlProg'))  el('tlProg').style.width  = pct + '%';

  document.querySelectorAll('#beatInd .b-dot').forEach((dot, i) => {
    dot.classList.remove('act', 'db');
    dot.style.display = i < bp ? '' : 'none';
    if (i === beat) dot.classList.add(i === 0 ? 'db' : 'act');
  });

  document.querySelectorAll('.tl-sec').forEach((e, i) => e.classList.toggle('on', i === curSec));

  if (el('mtMeas')) el('mtMeas').textContent = 'Bar ' + bar;
  if (el('mtTime')) el('mtTime').textContent = fmt(t);
  document.querySelectorAll('#mtBeat .mt-bd').forEach((dot, i) => {
    dot.classList.remove('act', 'db');
    dot.style.display = i < bp ? '' : 'none';
    if (i === beat) dot.classList.add(i === 0 ? 'db' : 'act');
  });
  updMtScrubBar();
  highlightSetupSections();
}

function updTransUI() {
  const isMidiEng = typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi';
  const isPlaying = isMidiEng ? (typeof midiPlaying !== 'undefined' && midiPlaying) : playing;
  const setBtn = (id, state) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.classList.toggle('on', state);
    b.innerHTML = state ? '⏸' : '▶';
  };
  setBtn('playBtn',    isPlaying);
  setBtn('mtPlay',     isPlaying);
  setBtn('uniPlayBtn', isPlaying);
}
