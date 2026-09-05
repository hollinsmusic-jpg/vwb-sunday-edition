// ═══════════════════════════════════════════════════════════════
//  VWB — MIDI Section System
//  Section definition, jump, loop, timeline strip, and editor UI.
//  Depends on: state.js, midi-player.js
// ═══════════════════════════════════════════════════════════════

// ── Section State ──────────────────────────────────────────────
// Each section: { id, type, label, sb, eb }  (sb/eb = bar numbers, 1-based)
let midiSections     = [];
let midiCurSec       = -1;
let midiQueuedSec    = -1;
let midiSecLoopOn    = false;
let midiSecAnimFrame = null;
let midiBpm          = 120;
let midiTimeSig      = 4;
let midiShowBars     = true;

const MIDI_SEC_TYPES = [
  'Intro','Verse','Pre-Chorus','Chorus','Bridge',
  'Vamp','Altar Call','Outro','Interlude','Tag','Custom'
];

// ── Bar ↔ Time helpers ─────────────────────────────────────────
function midiSecsPerBar() { return (60 / midiBpm) * midiTimeSig; }
function midiBar2Time(bar) { return Math.max(0, (bar - 1) * midiSecsPerBar()); }
function midiTime2Bar(t)   { return Math.floor(t / midiSecsPerBar()) + 1; }
function midiTotalBars() {
  const active = getMidiActive();
  if (!active || !active.duration) return 100;
  return Math.ceil(active.duration / midiSecsPerBar()) + 1;
}

function setMidiBpm(bpm) {
  midiBpm = Math.max(40, Math.min(300, parseInt(bpm) || 120));
  const el = document.getElementById('midiBpmInput');
  if (el) el.value = midiBpm;
  const active = getMidiActive();
  if (active) active.bpm = midiBpm;
  // Keep Song Info tempo and Perform BPM display in sync
  if (typeof syncMidiTempoToSongInfo === 'function') syncMidiTempoToSongInfo(midiBpm);
  renderMidiSectionEditor();
}

function setMidiTimeSig(beats) {
  midiTimeSig = parseInt(beats) || 4;
  const active = getMidiActive();
  if (active) active.timeSig = midiTimeSig;
  renderMidiSectionEditor();
}

// ═══════════════════════════════════════════════════════════════
//  MIDI SECTION SYSTEM
//  Define, jump, loop, and display sections for MIDI files.
//  Sections save with the song session automatically.
// ═══════════════════════════════════════════════════════════════

// ── Section CRUD ───────────────────────────────────────────────

function midiAddSection() {
  const active = getMidiActive();
  if (!active) return;
  const id = 'ms_' + Date.now();
  // Default: place after the last section, 8 bars long
  const lastSec = midiSections.length > 0 ? midiSections[midiSections.length - 1] : null;
  const sb = lastSec ? lastSec.eb + 1 : 1;
  const eb = sb + 7;
  midiSections.push({ id, type: 'Verse', label: '', sb, eb, loop: false });
  _saveMidiSections();
  renderMidiSectionEditor();
  updatePerfMidiSecUI();
}

function midiRemoveSection(id) {
  midiSections = midiSections.filter(s => s.id !== id);
  _saveMidiSections();
  renderMidiSectionEditor();
  updatePerfMidiSecUI();
}

function midiUpdateSection(id, field, value) {
  const sec = midiSections.find(s => s.id === id);
  if (!sec) return;
  if (field === 'sb' || field === 'eb') {
    const v = parseInt(value);
    if (!isNaN(v) && v >= 1) sec[field] = v;
    // Keep sb <= eb
    if (sec.sb > sec.eb) sec.eb = sec.sb;
  } else {
    sec[field] = value;
  }
  // Keep sections sorted by start bar
  midiSections.sort((a, b) => a.sb - b.sb);
  _saveMidiSections();
  renderMidiSectionEditor();
  updatePerfMidiSecUI();
}

function _saveMidiSections() {
  const active = getMidiActive();
  if (active) active.sections = midiSections.map(s => Object.assign({}, s));
  // Clear strips so they rebuild on next progress tick
  ['midiTimelineStrip','midiTimelineStripPerf'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
}

// ── Section Jump ───────────────────────────────────────────────
// Jump to a section by index using bar-to-time conversion.

function jumpMidiSection(idx) {
  if (idx < 0 || idx >= midiSections.length) return;
  const sec = midiSections[idx];
  const unscaledTime = midiBar2Time(sec.sb);
  const scaledTime   = unscaledTime / (midiTempoPct / 100);

  midiCurSec    = idx;
  midiQueuedSec = -1;
  _cancelLoopSchedule();

  const wasLooping = midiSecLoopOn;

  if (midiPlaying) {
    if (typeof _jumpToPosition === 'function') {
      _jumpToPosition(scaledTime);
    } else {
      midiTimers.forEach(t => clearTimeout(t));
      midiTimers = [];
      allNotesOff();
      midiPlaying = false;
      midiPauseAt = scaledTime;
      startMidiPlay(scaledTime);
    }
  } else {
    midiPauseAt = scaledTime;
    updateMidiProgress();
  }

  midiSecLoopOn = wasLooping;
  updatePerfMidiSecUI();
}

function toggleMidiSectionLoop() {
  midiSecLoopOn = !midiSecLoopOn;
  if (!midiSecLoopOn) _cancelLoopSchedule();
  else if (midiCurSec >= 0 && midiPlaying) {
    // Turned on — schedule immediately for current section
    const isMidiEng = typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi';
    const sections  = (isMidiEng && song && song.secs && song.secs.length) ? song.secs : midiSections;
    _scheduleLoopForSection(midiCurSec, sections);
  }
  updatePerfMidiSecUI();
}

// Toggle loop flag on a specific section by id
function toggleMidiSecFlag(id) {
  const sec = midiSections.find(s => s.id === id);
  if (!sec) return;
  sec.loop = !sec.loop;
  _saveMidiSections();
  renderMidiSectionEditor();
  updatePerfMidiSecUI();
}

// ── Section Loop Pre-Scheduler ─────────────────────────────────
// Instead of polling every animation frame and hoping we catch the
// exact moment, we calculate exactly how many ms until the loop
// point and fire a setTimeout. This eliminates rAF drift entirely.

let _loopScheduleTimer = null;   // the pending setTimeout for loop restart
let _loopScheduledSec  = -1;    // which section index the timer is for

function _cancelLoopSchedule() {
  if (_loopScheduleTimer) { clearTimeout(_loopScheduleTimer); _loopScheduleTimer = null; }
  _loopScheduledSec = -1;
}

function _scheduleLoopForSection(secIdx, sections) {
  _cancelLoopSchedule();
  if (secIdx < 0 || secIdx >= sections.length) return;
  const sec = sections[secIdx];
  const shouldLoop = midiSecLoopOn || (typeof secLoopOn !== 'undefined' && secLoopOn) || sec.loop === true;
  if (!shouldLoop) return;

  const loopEndBar  = sec.eb + 1;
  const loopEndTime = midiBar2Time(loopEndBar) / (midiTempoPct / 100);  // scaled seconds
  const targetTime  = midiBar2Time(sec.sb)    / (midiTempoPct / 100);  // loop back target

  const now     = getMidiCurrentTime();
  const msUntil = (loopEndTime - now) * 1000;

  if (msUntil <= 0) {
    // Already past — jump immediately
    _doLoopJump(targetTime);
    return;
  }

  _loopScheduledSec = secIdx;
  _loopScheduleTimer = setTimeout(() => {
    _loopScheduleTimer = null;
    if (!midiPlaying) return;
    // Only fire if we're still in the same section and loop is still on
    const stillLooping = midiSecLoopOn || (typeof secLoopOn !== 'undefined' && secLoopOn) || sec.loop === true;
    if (!stillLooping) return;
    _doLoopJump(targetTime);
  }, Math.max(0, msUntil));
}

function _doLoopJump(targetScaled) {
  if (!midiPlaying) return;
  const savedSec = midiCurSec;
  midiCurSec = -1;
  _loopScheduledSec = -1;
  if (typeof _jumpToPosition === 'function') {
    _jumpToPosition(targetScaled);
  } else {
    midiTimers.forEach(t => clearTimeout(t));
    midiTimers = [];
    allNotesOff();
    midiPlaying = false;
    midiPauseAt = targetScaled;
    startMidiPlay(targetScaled);
  }
  midiCurSec = savedSec;
}

// Called on every progress tick — tracks current section and triggers loop schedule
function _updateMidiSectionTracking() {
  const isMidiEng = typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi';
  const sections  = (isMidiEng && song && song.secs && song.secs.length)
    ? song.secs
    : midiSections;

  if (!sections.length) return;

  const t         = getMidiCurrentTime();
  const tUnscaled = t * (midiTempoPct / 100);
  const curBar    = midiTime2Bar(tUnscaled);

  // Find which section we're in
  let newSec = -1;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (curBar >= sections[i].sb) { newSec = i; break; }
  }

  if (newSec !== midiCurSec) {
    midiCurSec = newSec;
    if (isMidiEng) curSec = midiCurSec;
    updatePerfMidiSecUI();
    if (typeof uniRenderSections === 'function') uniRenderSections();
  }

  // Reschedule loop if: entering a new section, OR re-entering same section
  // after a loop jump (_loopScheduledSec was reset to -1 in _doLoopJump)
  if (midiCurSec >= 0 && midiPlaying) {
    const sec = sections[midiCurSec];
    const shouldLoop = midiSecLoopOn || (typeof secLoopOn !== 'undefined' && secLoopOn) || sec.loop === true;
    if (shouldLoop && _loopScheduledSec !== midiCurSec) {
      _scheduleLoopForSection(midiCurSec, sections);
    }
  }
}

// ── Section Editor UI (Setup tab) ─────────────────────────────

function renderMidiSectionEditor() {
  const wrap = document.getElementById('midiSectionEditor');
  if (!wrap) return;
  const active = getMidiActive();
  if (!active) { wrap.innerHTML = ''; return; }

  const totalBars = midiTotalBars();
  const detectedLabel = active.detectedBpm
    ? `<span style="font-size:.7rem;color:var(--green);margin-left:.5rem;">✓ Auto-detected</span>`
    : `<span style="font-size:.7rem;color:var(--text-dim);margin-left:.5rem;">Set manually</span>`;

  const rows = midiSections.map((sec, i) => {
    const typeOpts = MIDI_SEC_TYPES.map(t =>
      `<option value="${t}"${t === sec.type ? ' selected' : ''}>${t}</option>`
    ).join('');
    const loopOn = sec.loop ? true : false;
    return `
      <div class="midi-sec-row" id="midiSecRow_${sec.id}">
        <span class="midi-sec-n">${i + 1}</span>
        <select class="midi-sec-type" onchange="midiUpdateSection('${sec.id}','type',this.value)">
          ${typeOpts}
        </select>
        <input class="midi-sec-label" type="text" placeholder="Label (optional)"
          value="${sec.label || ''}"
          onchange="midiUpdateSection('${sec.id}','label',this.value)">
        <input class="midi-sec-bar" type="number" min="1" max="${totalBars}" step="1"
          value="${sec.sb}"
          oninput="midiUpdateSection('${sec.id}','sb',this.value)"
          title="Start bar">
        <input class="midi-sec-bar" type="number" min="1" max="${totalBars}" step="1"
          value="${sec.eb}"
          oninput="midiUpdateSection('${sec.id}','eb',this.value)"
          title="End bar">
        <button onclick="toggleMidiSecFlag('${sec.id}')"
          title="${loopOn ? 'Loop ON — click to turn off' : 'Click to loop this section'}"
          style="font-size:.7rem;padding:.25rem .4rem;border-radius:5px;cursor:pointer;
                 border:1px solid ${loopOn ? 'var(--orange)' : 'var(--border)'};
                 background:${loopOn ? 'rgba(255,136,68,.15)' : 'none'};
                 color:${loopOn ? 'var(--orange)' : 'var(--text-dim)'};
                 font-weight:${loopOn ? '700' : '400'};transition:all .2s;">⟳</button>
        <button class="btn-rm" onclick="midiRemoveSection('${sec.id}')" title="Remove">×</button>
      </div>`;
  }).join('');

  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:.75rem;
                padding:.6rem .75rem;background:var(--bg-tertiary);border-radius:8px;
                border:1px solid var(--border);">
      <span style="font-size:.75rem;font-weight:600;color:var(--orange);">BPM</span>
      <input id="midiBpmInput" type="number" min="40" max="300" value="${midiBpm}"
        style="width:65px;font-family:'Space Mono',monospace;font-size:.9rem;text-align:center;
               background:var(--bg-primary);border:1px solid var(--border);
               color:var(--text-primary);padding:.3rem .4rem;border-radius:6px;"
        oninput="setMidiBpm(this.value)"
        title="Tempo — used to calculate bar positions">
      ${detectedLabel}
      <span style="font-size:.75rem;font-weight:600;color:var(--orange);margin-left:.5rem;">Time Sig</span>
      <select onchange="setMidiTimeSig(this.value)"
        style="background:var(--bg-primary);border:1px solid var(--border);
               color:var(--text-primary);padding:.3rem .4rem;border-radius:6px;font-size:.82rem;">
        <option value="4" ${midiTimeSig===4?'selected':''}>4/4</option>
        <option value="3" ${midiTimeSig===3?'selected':''}>3/4</option>
        <option value="6" ${midiTimeSig===6?'selected':''}>6/8</option>
        <option value="12" ${midiTimeSig===12?'selected':''}>12/8</option>
      </select>
    </div>
    <div class="midi-sec-hdr">
      <span>#</span><span>Type</span><span>Label</span>
      <span>Start</span><span>End</span><span>Loop</span><span></span>
    </div>
    ${rows || '<p style="font-size:.8rem;color:var(--text-dim);font-style:italic;padding:.25rem 0;">No sections yet. Click + Add Section.</p>'}
    <div style="display:flex;align-items:center;gap:.75rem;margin-top:.6rem;flex-wrap:wrap;">
      <button class="btn-add" style="border-color:var(--orange);color:var(--orange);
              background:rgba(255,136,68,.08);font-size:.78rem;"
        onclick="midiAddSection()">+ Add Section</button>
      <button class="btn btn-secondary btn-small" onclick="midiGrabBar()"
        title="Set start bar of last section to current playback position"
        style="font-size:.72rem;">⏱ Grab Current Bar</button>
    </div>
  `;
}

// Grab current playback bar and set it as start bar of the last section
function midiGrabBar(id) {
  const t   = getMidiCurrentTime() * (midiTempoPct / 100);
  const bar = midiTime2Bar(t);
  if (id) {
    midiUpdateSection(id, 'sb', bar);
  } else if (midiSections.length > 0) {
    const last = midiSections[midiSections.length - 1];
    midiUpdateSection(last.id, 'sb', bar);
  }
}

// ── Perform Section UI ─────────────────────────────────────────

function updatePerfMidiSecUI() {
  const wrap = document.getElementById('perfMidiSecs');
  if (!wrap) return;

  if (!midiSections.length) {
    wrap.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'flex';

  wrap.innerHTML = midiSections.map((sec, i) => {
    const isCur    = i === midiCurSec;
    const label    = sec.label ? sec.label : sec.type;
    const secLoop  = sec.loop ? true : false;
    const looping  = isCur && (midiSecLoopOn || secLoop);
    return `
      <div class="p-midi-sec${isCur ? ' act' : ''}"
           onclick="jumpMidiSection(${i})" title="Jump to ${label} (Bar ${sec.sb})">
        <span class="midi-sec-hk">${i + 1}</span>
        <div class="midi-sec-inf">
          <div class="midi-sec-name">${label}</div>
          <div style="font-size:.68rem;color:var(--text-dim);font-family:'Space Mono',monospace;">
            Bars ${sec.sb}–${sec.eb}${secLoop ? ' &nbsp;⟳' : ''}
          </div>
        </div>
        ${looping ? '<span class="midi-sec-loop-badge">⟳</span>' : ''}
      </div>`;
  }).join('');

  const loopBtn = document.getElementById('midiSecLoopBtn');
  if (loopBtn) {
    loopBtn.classList.toggle('on', midiSecLoopOn);
    loopBtn.title = midiSecLoopOn ? 'Global Loop ON — click to turn off' : 'Loop current section';
  }
}

// ── Unified Section Bridge ─────────────────────────────────────

function jumpMidiSectionByBar(sb) {
  const active = getMidiActive();
  if (active && active.detectedBpm) midiBpm = active.detectedBpm;
  else if (song && song.tempo) midiBpm = song.tempo;
  if (song && song.ts) {
    const tsMap = { '4/4': 4, '3/4': 3, '6/8': 6, '12/8': 12 };
    midiTimeSig = tsMap[song.ts] || 4;
  }

  const unscaledTime = midiBar2Time(sb);
  const scaledTarget = unscaledTime / (midiTempoPct / 100);

  // ── Quantize: wait for the right moment before jumping ──
  const quantize = (typeof sectionJumpQuantize !== 'undefined') ? sectionJumpQuantize : '1bar';

  // Quantize timing is handled upstream by queueSection() in audio-engine.js.
  // By the time this is called we are at the right moment — jump immediately.
  midiCurSec = -1;
  _cancelLoopSchedule();

  if (midiPlaying) {
    // Use _jumpToPosition — keeps midiPlaying=true, no stop/start gap
    if (typeof _jumpToPosition === 'function') {
      _jumpToPosition(scaledTarget);
    } else {
      midiTimers.forEach(t => clearTimeout(t));
      midiTimers = [];
      allNotesOff();
      midiPlaying = false;
      midiPauseAt = scaledTarget;
      startMidiPlay(scaledTarget);
    }
  } else {
    midiPauseAt = scaledTarget;
    updateMidiProgress();
  }
}

function syncMidiBpmFromActive() {
  const active = getMidiActive();
  if (!active) return;
  if (active.detectedBpm) {
    midiBpm = active.detectedBpm;
    const tempoEl = document.getElementById('songTempo');
    if (tempoEl) { tempoEl.value = midiBpm; song.tempo = midiBpm; }
    const perfTempo = document.getElementById('pTempo');
    if (perfTempo) perfTempo.textContent = midiBpm + ' BPM';
  }
  if (active.timeSig) {
    midiTimeSig = active.timeSig;
    const tsMap = { 4: '4/4', 3: '3/4', 6: '6/8', 12: '12/8' };
    const tsEl = document.getElementById('songTimeSig');
    if (tsEl && tsMap[midiTimeSig]) tsEl.value = tsMap[midiTimeSig];
  }
}

// ── Session serialization helpers ─────────────────────────────
// Called by session.js when saving/loading a song.

function getMidiPlaylistForSave() {
  return midiPlaylist.map(entry => ({
    fileName:    entry.fileName,
    storedPath:  entry.storedPath,
    sections:    entry.sections   || [],
    transpose:   entry.transpose  !== undefined ? entry.transpose : 0,
    tempoPct:    entry.tempoPct   !== undefined ? entry.tempoPct  : 100,
    bpm:         entry.bpm        || midiBpm,
    timeSig:     entry.timeSig    || midiTimeSig,
    chVolumes:   entry.chVolumes  || {},
    chPrograms:  entry.chPrograms || {},
    chOctave:    entry.chOctave   || {},
    noteCount:   entry.noteCount,
    trackCount:  entry.trackCount,
    duration:    entry.duration,
  }));
}

// Called by session.js when restoring a saved song.
// Pass in an array of saved entries; we re-read the files and restore.
async function restoreMidiPlaylistFromSave(savedEntries) {
  if (!savedEntries || !savedEntries.length) return;
  for (const saved of savedEntries) {
    try {
      const rb = await window.vwb.readFileBuffer(saved.storedPath);
      if (!rb.success) { console.warn('[MIDI] Could not reload:', saved.storedPath); continue; }
      await addMidiFileFromBuffer(rb.buffer, saved.fileName, saved.storedPath, saved);
    } catch(e) {
      console.warn('[MIDI] Restore error for', saved.fileName, e);
    }
  }
}
