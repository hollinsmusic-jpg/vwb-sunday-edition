// ═══════════════════════════════════════════════════════════════
//  VWB Sunday Edition — Loop Library
//  Background loop library: add, play, stop, switch loops.
//  Depends on: state.js
// ═══════════════════════════════════════════════════════════════

const loopGain = AC.createGain();
loopGain.gain.value = 0.6;
loopGain.connect(mGain);

// Loop library: array of { buf, fn, storedPath, dur }
let loopLibrary  = [];
let activeLoopIdx = -1;   // which library item is currently selected/playing
let loopSrc      = null;
let loopPlaying  = false;
let loopEnabled  = true;

// Legacy compat vars — kept so session save/load code can read them
let loopBuf        = null;
let loopFileName   = '';
let loopStoredPath = '';

// ── Add / Load ─────────────────────────────────────────────────

async function addLoopFromPath(filePath, fileName) {
  try {
    const result = await window.vwb.readFileBuffer(filePath);
    if (!result.success) { alert('Could not read: ' + fileName); return; }
    const buf = await AC.decodeAudioData(result.buffer);
    loopLibrary.push({ buf, fn: fileName, storedPath: filePath, dur: buf.duration });
    renderLoopLibrary();
    showLoopMasterControls();
  } catch(e) { alert('Could not load loop: ' + fileName); }
}

async function pickAndAddLoops() {
  const result = await window.vwb.pickAudioFiles(true);
  if (result.canceled || !result.files.length) return;
  const songTitle = document.getElementById('songTitle').value || 'untitled';
  for (const file of result.files) {
    const stored = await window.vwb.storeStem({
      songTitle,
      stemKey: 'bgloop_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      sourcePath: file.path,
      fileName: file.name
    });
    if (stored.success) await addLoopFromPath(stored.storedPath, file.name);
  }
}

// Legacy alias
async function pickAndLoadLoop() { await pickAndAddLoops(); }

// Legacy alias used by loadSongData
async function loadLoopFromPath(filePath, fileName) {
  await addLoopFromPath(filePath, fileName);
}

// ── Remove ─────────────────────────────────────────────────────

function removeLoopFromLibrary(idx) {
  if (idx === activeLoopIdx) {
    stopLoop();
    activeLoopIdx = -1;
    loopBuf = null; loopFileName = ''; loopStoredPath = '';
  } else if (idx < activeLoopIdx) {
    activeLoopIdx--;
  }
  loopLibrary.splice(idx, 1);
  renderLoopLibrary();
  updatePerfLoopUI();
}

// Legacy — clears active loop without removing from library
function removeLoop() {
  stopLoop();
  activeLoopIdx = -1;
  loopBuf = null; loopFileName = ''; loopStoredPath = '';
  renderLoopLibrary();
  updatePerfLoopUI();
}

// ── Playback ───────────────────────────────────────────────────

function selectAndToggleLoop(idx) {
  if (activeLoopIdx === idx && loopPlaying) {
    stopLoop();
  } else if (activeLoopIdx === idx && !loopPlaying) {
    startLoop();
  } else {
    stopLoop();
    activeLoopIdx = idx;
    const lp = loopLibrary[idx];
    loopBuf = lp.buf; loopFileName = lp.fn; loopStoredPath = lp.storedPath;
    startLoop();
  }
  renderLoopLibrary();
  updatePerfLoopUI();
}

function toggleLoop() {
  if (AC.state === 'suspended') AC.resume();
  if (activeLoopIdx < 0 && loopLibrary.length > 0) {
    selectAndToggleLoop(0);
    return;
  }
  loopPlaying ? stopLoop() : startLoop();
  renderLoopLibrary();
  updatePerfLoopUI();
}

function startLoop() {
  if (activeLoopIdx < 0 || activeLoopIdx >= loopLibrary.length) return;
  const lp = loopLibrary[activeLoopIdx];
  if (!lp || !lp.buf) return;
  stopLoop();
  loopSrc = AC.createBufferSource();
  loopSrc.buffer = lp.buf;
  loopSrc.loop   = loopEnabled;
  loopSrc.connect(loopGain);
  loopSrc.start(0);
  loopSrc.onended = () => {
    if (loopPlaying && !loopEnabled) {
      loopPlaying = false;
      renderLoopLibrary();
      updateLoopBtns();
      updatePerfLoopUI();
    }
  };
  loopPlaying = true;
  updateLoopBtns();
  updatePerfLoopUI();
}

function stopLoop() {
  if (loopSrc) {
    try { loopSrc.stop(); }       catch(e) {}
    try { loopSrc.disconnect(); } catch(e) {}
    loopSrc = null;
  }
  loopPlaying = false;
  updateLoopBtns();
  updatePerfLoopUI();
}

// Legacy aliases
function switchLoop(idx) { selectAndToggleLoop(idx); }

function setLoopEnabled(val) {
  loopEnabled = val;
  if (loopSrc) loopSrc.loop = loopEnabled;
}

function setLoopVol(v) {
  const val = parseInt(v);
  loopGain.gain.value = val / 100;
  try { localStorage.setItem('vwb_loopVol', val); } catch(e) {}
  document.querySelectorAll('.loop-vol-slider').forEach(el => { el.value = val; });
  const pct = document.getElementById('loopPct');
  if (pct) pct.textContent = val + '%';
}

// ── Render ─────────────────────────────────────────────────────

function renderLoopLibrary() {
  const c = document.getElementById('loopLibrary');
  if (!c) return;
  if (!loopLibrary.length) {
    c.innerHTML = '<div style="font-size:.8rem;color:var(--text-dim);font-style:italic;padding:.5rem 0">No loops loaded yet. Add loops above.</div>';
    return;
  }
  c.innerHTML = '';
  loopLibrary.forEach((lp, i) => {
    const isActive = i === activeLoopIdx;
    c.innerHTML +=
      '<div class="loop-lib-item' + (isActive ? ' active-loop' : '') + '">' +
      '<button class="ll-play' + (isActive && loopPlaying ? ' on' : '') + '" onclick="selectAndToggleLoop(' + i + ')">' +
      (isActive && loopPlaying ? '⏸' : '▶') + '</button>' +
      '<span class="ll-name" title="' + lp.fn + '">' + lp.fn + '</span>' +
      '<span class="ll-dur">' + fmt(lp.dur) + '</span>' +
      '<button class="ll-rm" onclick="removeLoopFromLibrary(' + i + ')">&times;</button>' +
      '</div>';
  });
}

function showLoopMasterControls() {
  const el = document.getElementById('loopMasterControls');
  if (el) el.style.display = 'flex';
}

function updateLoopBtns() {
  const perfBtn = document.getElementById('perfLoopBtn');
  if (perfBtn) {
    perfBtn.classList.toggle('on', loopPlaying);
    perfBtn.innerHTML = loopPlaying ? '⏸' : '▶';
  }
}

function updatePerfLoopUI() {
  const bar = document.getElementById('perfLoopBar');
  if (!bar) return;
  const hasLoop = loopLibrary.length > 0;
  if (hasLoop) {
    bar.style.display = 'flex';
    bar.classList.toggle('active', loopPlaying);
    const activeLp = activeLoopIdx >= 0 ? loopLibrary[activeLoopIdx] : null;
    document.getElementById('perfLoopName').textContent =
      activeLp ? activeLp.fn : (loopLibrary.length + ' loops loaded');
    const status = document.getElementById('perfLoopStatus');
    status.textContent  = loopPlaying
      ? (loopEnabled ? 'Looping' : 'Playing')
      : (activeLp ? 'Ready' : 'Select a loop');
    status.classList.toggle('playing', loopPlaying);
  } else {
    bar.style.display = 'none';
  }
}
