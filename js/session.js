// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Session & Song Data
//  Session file I/O, bundle export/import, setlist render,
//  song data load/save, crossfade engine, and utility functions.
//  Depends on: state.js, audio-engine.js, stems.js,
//              loop-library.js, midi-player.js, service-flow.js
// ═══════════════════════════════════════════════════════════════

// ── Utility ────────────────────────────────────────────────────

function showNotification(msg) {
  const n = document.createElement('div');
  n.style.cssText = 'position:fixed;top:1rem;right:1rem;background:var(--accent);color:var(--bg-primary);padding:.6rem 1.5rem;border-radius:8px;font-weight:500;font-size:.9rem;z-index:9999;animation:pulse 2s ease-in-out;pointer-events:none;';
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 2500);
}

function syncSongFromInputs() {
  song.title = document.getElementById('songTitle').value;
  song.tempo = parseInt(document.getElementById('songTempo').value) || 72;
  song.ts    = document.getElementById('songTimeSig').value;
}

function updMInfo() {
  const d = getDur(), bars = totalBars(), spb = secPerBar();
  document.getElementById('measureInfo').textContent =
    d > 0
      ? 'Song: ' + fmt(d) + ' | ' + bars + ' measures | 1 bar = ' + spb.toFixed(2) + 's'
      : 'At ' + song.tempo + ' BPM in ' + song.ts + ', 1 bar = ' + spb.toFixed(2) + 's';
}

// ── File Menu ──────────────────────────────────────────────────

function toggleFileMenu() {
  const drop = document.getElementById('fileMenuDrop');
  if (drop) {
    drop.classList.toggle('open');
    if (drop.classList.contains('open')) renderRecentSessions();
  }
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('fileMenu');
  if (menu && !menu.contains(e.target)) {
    const drop = document.getElementById('fileMenuDrop');
    if (drop) drop.classList.remove('open');
  }
});

function updateSessionNameDisplay() {
  const el = document.getElementById('sessionNameDisplay');
  if (!el) return;
  if (currentSessionPath) {
    const name = currentSessionPath.split('/').pop().replace('.vwbs', '');
    el.textContent = name;
    el.title = currentSessionPath;
  } else {
    el.textContent = 'No session';
    el.title = '';
  }
}

// ── Recent Sessions ────────────────────────────────────────────

const MAX_RECENT = 5;

async function addToRecentSessions(filePath) {
  try {
    const name = filePath.split('/').pop().replace('.vwbs', '');
    let recents = await loadRecentSessions();
    // Remove if already exists, then add to front
    recents = recents.filter(r => r.path !== filePath);
    recents.unshift({ path: filePath, name, openedAt: new Date().toISOString() });
    recents = recents.slice(0, MAX_RECENT);
    await window.vwb.saveJson('recentSessions', recents);
    renderRecentSessions();
  } catch(e) {}
}

async function loadRecentSessions() {
  try {
    const result = await window.vwb.loadJson('recentSessions');
    return (result.success && Array.isArray(result.data)) ? result.data : [];
  } catch(e) { return []; }
}

async function openRecentSession(filePath) {
  toggleFileMenu();
  try {
    // Use the same IPC handler that sessionOpen uses — reads as UTF-8 text
    const result = await window.vwb.readSessionFile(filePath);
    if (!result || result.canceled || !result.content) {
      showNotification('⚠ Could not find that session file.');
      renderRecentSessions();
      return;
    }
    const data = JSON.parse(result.content);
    currentSessionPath = filePath;
    updateSessionNameDisplay();
    await addToRecentSessions(filePath);
    await restoreSessionData(data);
  } catch(e) {
    showNotification('⚠ Could not open session: ' + filePath.split('/').pop());
  }
}

async function renderRecentSessions() {
  const wrap = document.getElementById('recentSessionsList');
  if (!wrap) return;
  const recents = await loadRecentSessions();
  if (!recents.length) {
    wrap.innerHTML = '<div style="padding:.35rem .75rem;font-size:.75rem;color:var(--text-dim);font-style:italic">No recent sessions</div>';
    return;
  }
  wrap.innerHTML = recents.map((r, i) =>
    '<button class="file-menu-item" onclick="openRecentSession(' + JSON.stringify(r.path) + ')" title="' + r.path.replace(/"/g,'&quot;') + '">' +
    '<span class="fm-icon">🕐</span> ' + r.name + '</button>'
  ).join('');
}



// ── Session Build / Restore ────────────────────────────────────

function buildSessionData() {
  syncSongFromInputs();
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    setlist,
    svcCues,
    crossfadeMode,
    crossfadeDuration,
    masterVol: document.querySelector('.master-vol input') ? parseInt(document.querySelector('.master-vol input').value) : 80,
    theme: document.body.classList.contains('light-mode') ? 'light' : 'dark',
    currentSong: song,
    currentStemPaths: (() => {
      const p = {};
      SK.forEach(k => { if (S[k].storedPath) p[k] = { path: S[k].storedPath, fn: S[k].fn }; });
      return p;
    })(),
    currentAuxPaths:   auxTracks.map(t => ({ path: t.storedPath, fn: t.fn })),
    loopLibraryPaths:  loopLibrary.map(lp => ({ path: lp.storedPath, fn: lp.fn })),
    activeLoopIdx,
    midiPlaylist:    typeof getMidiPlaylistForSave === 'function'
      ? getMidiPlaylistForSave()
      : midiPlaylist.map(m => ({ fileName: m.fileName, storedPath: m.storedPath })),
    midiActiveIdx,
    midiTranspose,
    midiTempoPct,
  };
}

async function restoreSessionData(data) {
  if (data.setlist)    { setlist  = data.setlist;  renderSetlist(); }
  if (data.svcCues)    { svcCues  = data.svcCues;  renderSvcCues(); }
  if (data.crossfadeMode)     crossfadeMode     = data.crossfadeMode;
  if (data.crossfadeDuration) crossfadeDuration = data.crossfadeDuration;
  renderCrossfadeUI();
  if (data.masterVol) {
    mGain.gain.value = data.masterVol / 100;
    const mvEl = document.querySelector('.master-vol input');
    if (mvEl) mvEl.value = data.masterVol;
  }
  if (data.theme && typeof setTheme === 'function') setTheme(data.theme);
  if (data.currentSong) {
    // Merge stem paths back into song object before loading
    const songToLoad = Object.assign({}, data.currentSong);
    if (data.currentStemPaths) {
      songToLoad.spaths = songToLoad.spaths || {};
      songToLoad.sfn    = songToLoad.sfn    || {};
      Object.entries(data.currentStemPaths).forEach(([k, v]) => {
        if (v && v.path) { songToLoad.spaths[k] = v.path; songToLoad.sfn[k] = v.fn || k; }
      });
    }
    if (data.currentAuxPaths && data.currentAuxPaths.length) {
      songToLoad.auxpaths = data.currentAuxPaths.map(a => a.path || '');
      songToLoad.auxfn    = data.currentAuxPaths.map(a => a.fn   || '');
    }
    if (data.loopLibraryPaths && data.loopLibraryPaths.length) {
      songToLoad.loopLibrary = data.loopLibraryPaths;
    }
    if (typeof data.activeLoopIdx === 'number') songToLoad.activeLoopIdx = data.activeLoopIdx;
    if (data.midiPlaylist && data.midiPlaylist.length) {
      songToLoad.midiPlaylist  = data.midiPlaylist;
      songToLoad.midiActiveIdx = data.midiActiveIdx;
      songToLoad.midiTranspose = data.midiTranspose;
      songToLoad.midiTempoPct  = data.midiTempoPct;
    }
    await loadSongData(songToLoad);
  }
  showNotification('Session loaded successfully');
}

// ── Session File Operations ────────────────────────────────────

async function sessionNew() {
  toggleFileMenu();
  if (setlist.length > 0 || song.title) {
    if (!confirm('Start a new session?\n\nAny unsaved changes will be lost. Save your current session first if you want to keep your work.')) return;
  }
  currentSessionPath = '';
  updateSessionNameDisplay();
  setlist = []; svcCues = []; svcLive = false; svcCurIdx = -1;
  newSong();
  renderSetlist(); renderSvcCues();
  showNotification('New session started');
}

async function sessionOpen() {
  toggleFileMenu();
  const result = await window.vwb.openSessionFile();
  if (result.canceled || !result.path) return;
  try {
    const data = JSON.parse(result.content);
    currentSessionPath = result.path;
    updateSessionNameDisplay();
    await addToRecentSessions(result.path);
    await restoreSessionData(data);
  } catch(e) {
    alert('Could not open session file. The file may be corrupted.');
  }
}

async function sessionSave() {
  toggleFileMenu();
  if (!currentSessionPath) { await sessionSaveAs(); return; }
  const data   = buildSessionData();
  const result = await window.vwb.saveSessionFile(currentSessionPath, JSON.stringify(data, null, 2));
  if (result.success) {
    showNotification('💾 Session saved');
  } else {
    alert('Could not save session: ' + (result.error || 'Unknown error'));
  }
}

async function sessionSaveAs() {
  toggleFileMenu();
  const data          = buildSessionData();
  const suggestedName = (song.title || 'My VWB Session').replace(/[^a-zA-Z0-9 _-]/g, '');
  const result        = await window.vwb.saveSessionFileAs(suggestedName, JSON.stringify(data, null, 2));
  if (result.canceled) return;
  if (result.success) {
    currentSessionPath = result.path;
    updateSessionNameDisplay();
    await addToRecentSessions(result.path);
    showNotification('💾 Session saved as: ' + result.path.split('/').pop());
  } else {
    alert('Could not save session: ' + (result.error || 'Unknown error'));
  }
}

function sessionQuit() {
  toggleFileMenu();
  if (confirm('Quit VWB?\n\nMake sure you have saved your session before quitting.')) window.vwb.quitApp();
}

// ── Bundle Export / Open ───────────────────────────────────────

async function exportBundle() {
  toggleFileMenu();
  const allPaths = [];
  SK.forEach(k => { if (S[k].storedPath) allPaths.push(S[k].storedPath); });
  auxTracks.forEach(t => { if (t.storedPath) allPaths.push(t.storedPath); });
  MONITOR_SLOTS.forEach(k => { if (MON[k].storedPath) allPaths.push(MON[k].storedPath); });
  loopLibrary.forEach(lp => { if (lp.storedPath) allPaths.push(lp.storedPath); });
  midiPlaylist.forEach(m => { if (m.storedPath) allPaths.push(m.storedPath); });
  setlist.forEach(s => {
    Object.values(s.spaths || {}).forEach(p => { if (p && !allPaths.includes(p)) allPaths.push(p); });
    (s.auxpaths || []).forEach(p => { if (p && !allPaths.includes(p)) allPaths.push(p); });
    Object.values(s.monpaths || {}).forEach(p => { if (p && !allPaths.includes(p)) allPaths.push(p); });
    (s.loopLibrary || []).forEach(lp => { if (lp.storedPath && !allPaths.includes(lp.storedPath)) allPaths.push(lp.storedPath); });
    (s.midiPlaylist || []).forEach(m => { if (m.storedPath && !allPaths.includes(m.storedPath)) allPaths.push(m.storedPath); });
  });

  if (!allPaths.length) {
    alert('No audio files loaded. Load some stems and save your songs to the setlist first, then export.');
    return;
  }

  const sessionName = song.title || 'My VWB Bundle';

  // Build session data and rewrite absolute paths to relative paths (audio/filename)
  // so the bundle works on any customer's machine, not just the machine that saved it.
  const rawSessionData = buildSessionData();
  const uniquePaths = [...new Set(allPaths)];

  function makeRelative(absPath) {
    if (!absPath || typeof absPath !== 'string') return absPath;
    const fn = absPath.split('/').pop().split('\\').pop();
    return 'audio/' + fn;
  }

  function rewritePathsToRelative(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && uniquePaths.includes(val)) {
        obj[key] = makeRelative(val);
      } else if (Array.isArray(val)) {
        val.forEach(item => rewritePathsToRelative(item));
      } else if (typeof val === 'object') {
        rewritePathsToRelative(val);
      }
    }
  }
  rewritePathsToRelative(rawSessionData);

  const sessionData = JSON.stringify(rawSessionData, null, 2);
  showNotification('📦 Exporting bundle... please wait');
  const result = await window.vwb.exportBundle({ sessionName, sessionData, filePaths: uniquePaths });
  if (result.canceled) return;
  if (result.success) {
    showNotification('✅ Bundle exported! ' + result.fileCount + ' audio files included.');
    alert('Bundle exported successfully!\n\nLocation: ' + result.bundlePath + '\n\nFiles included: ' + result.fileCount + ' audio file(s)\n\nZip the folder and share it with your users.');
  } else {
    alert('Export failed: ' + (result.error || 'Unknown error'));
  }
}

async function openBundle() {
  toggleFileMenu();
  const result = await window.vwb.openBundle();
  if (result.canceled || !result.path) return;
  try {
    const bundleDir = result.bundleDir;
    const parsed    = JSON.parse(result.content);
    function resolveRelativePaths(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (typeof val === 'string') {
          // Resolve any path that looks like audio/filename or just a relative path
          // Also catch any lingering absolute paths that might reference audio files
          if (val.startsWith('audio/') && !val.startsWith('/')) {
            obj[key] = bundleDir + '/' + val;
          } else if (!val.startsWith('/') && !val.startsWith('C:\\') && val.includes('.') &&
                     /\.(wav|mp3|ogg|flac|aif|aiff|mid|midi)$/i.test(val)) {
            // Relative path without audio/ prefix — resolve relative to bundleDir
            obj[key] = bundleDir + '/audio/' + val.split('/').pop();
          }
        } else if (typeof val === 'object') {
          resolveRelativePaths(val);
        }
      }
    }
    resolveRelativePaths(parsed);
    currentSessionPath = result.path;
    updateSessionNameDisplay();
    await restoreSessionData(parsed);
    showNotification('📦 Bundle loaded successfully!');
  } catch(e) {
    alert('Could not open bundle: ' + e.message);
  }
}

// ── Setlist ────────────────────────────────────────────────────

function renderSetlist() {
  const c = document.getElementById('slItems'), e = document.getElementById('slEmpty');
  c.innerHTML = '';
  if (!setlist.length) { e.style.display = 'block'; return; }
  e.style.display = 'none';
  setlist.forEach((s, i) => {
    const stemCt = s.sfn ? Object.keys(s.sfn).length : 0;
    const auxCt  = s.auxfn ? s.auxfn.length : 0;
    const stemInfo = stemCt + ' stems' + (auxCt > 0 ? ' + ' + auxCt + ' aux' : '');
    c.innerHTML +=
      '<div class="sl-item"><span class="sl-num">' + (i+1) + '</span>' +
      '<div class="sl-info"><h4>' + (s.title || 'Untitled') + '</h4>' +
      '<p>' + s.tempo + ' BPM | ' + s.ts + ' | ' + s.secs.length + ' sections | ' + stemInfo + '</p></div>' +
      '<div class="sl-acts">' +
      '<button class="btn btn-secondary btn-small" onclick="loadSongAndSetup(' + i + ')">Load</button>' +
      '<button class="btn btn-secondary btn-small" onclick="loadSongData(setlist[' + i + ']);goView(\'setup\');">Edit</button>' +
      '<button class="btn btn-secondary btn-small" style="color:var(--red)" onclick="setlist.splice(' + i + ',1);window.vwb.saveSetlist(setlist);renderSetlist();">×</button>' +
      '</div></div>';
  });
}

async function loadSongAndSetup(idx) {
  await loadSongData(setlist[idx]);
  await window.vwb.saveSettings({ lastSongIdx: idx });
  goView('setup');
  renderReloadPanel();
}

// ── Crossfade Engine ───────────────────────────────────────────

function saveCrossfadeSettings() {
  try {
    localStorage.setItem('vwb_crossfadeMode', crossfadeMode);
    localStorage.setItem('vwb_crossfadeDur',  crossfadeDuration);
  } catch(e) {}
}

function loadCrossfadeSettings() {
  try {
    const m = localStorage.getItem('vwb_crossfadeMode');
    const d = localStorage.getItem('vwb_crossfadeDur');
    if (m) crossfadeMode     = m;
    if (d) crossfadeDuration = parseFloat(d) || 3;
  } catch(e) {}
  renderCrossfadeUI();
}

function renderCrossfadeUI() {
  const modeEl  = document.getElementById('xfadeMode');
  const durEl   = document.getElementById('xfadeDur');
  const durLabel = document.getElementById('xfadeDurLabel');
  if (modeEl)   modeEl.value     = crossfadeMode;
  if (durEl)    durEl.value      = crossfadeDuration;
  if (durLabel) durLabel.textContent = crossfadeDuration + 's';
}

function fadeOutStems(dur, callback) {
  if (!playing) { callback(); return; }
  const now = AC.currentTime;
  SK.forEach(k => {
    if (S[k].src && S[k].gn) {
      S[k].gn.gain.cancelScheduledValues(now);
      S[k].gn.gain.setValueAtTime(S[k].gn.gain.value, now);
      S[k].gn.gain.linearRampToValueAtTime(0, now + dur);
    }
  });
  auxTracks.forEach(t => {
    if (t.src && t.gn) {
      t.gn.gain.cancelScheduledValues(now);
      t.gn.gain.setValueAtTime(t.gn.gain.value, now);
      t.gn.gain.linearRampToValueAtTime(0, now + dur);
    }
  });
  setTimeout(() => {
    doStop();
    SK.forEach(k => { S[k].gn.gain.value = S[k].vol / 100; });
    auxTracks.forEach(t => { t.gn.gain.value = t.vol / 100; });
    callback();
  }, dur * 1000);
}

function fadeInStems(dur) {
  const now = AC.currentTime;
  SK.forEach(k => {
    if (S[k].src && S[k].gn) {
      const targetVol = S[k].muted ? 0 : (S[k].vol / 100);
      S[k].gn.gain.cancelScheduledValues(now);
      S[k].gn.gain.setValueAtTime(0, now);
      S[k].gn.gain.linearRampToValueAtTime(targetVol, now + dur);
    }
  });
  auxTracks.forEach(t => {
    if (t.src && t.gn) {
      const targetVol = t.muted ? 0 : (t.vol / 100);
      t.gn.gain.cancelScheduledValues(now);
      t.gn.gain.setValueAtTime(0, now);
      t.gn.gain.linearRampToValueAtTime(targetVol, now + dur);
    }
  });
}

async function crossfadeToSong(songData) {
  if (crossfading) return;
  crossfading = true;
  const dur = crossfadeDuration;
  showNotification('↔ Crossfading...');
  const doLoad = async () => {
    await loadSongData(songData);
    setTimeout(() => {
      if (stemCount()) { doPlay(); fadeInStems(dur); }
      crossfading = false;
      showNotification('▶ Now: ' + (songData.title || 'Song'));
    }, 300);
  };
  if (playing) { fadeOutStems(dur, doLoad); } else { doLoad(); }
}

async function triggerManualCrossfade() {
  if (crossfading) return;
  const nextIdx = svcCues.findIndex((c, i) => i > svcCurIdx && c.type === 'song');
  if (nextIdx === -1) { showNotification('⚠️ No next song in service flow'); return; }
  const s = setlist[svcCues[nextIdx].songIdx];
  if (!s) { showNotification('⚠️ Song not found in setlist'); return; }
  svcCurIdx = nextIdx;
  renderSvcCues();
  await crossfadeToSong(s);
}

// ── Song Save / Load ───────────────────────────────────────────

async function saveSong() {
  syncSongFromInputs();
  const d = JSON.parse(JSON.stringify(song));
  d.sfn = {}; d.spaths = {};
  SK.forEach(k => {
    if (S[k].fn)         d.sfn[k]    = S[k].fn;
    if (S[k].storedPath) d.spaths[k] = S[k].storedPath;
  });
  d.auxfn    = auxTracks.map(t => t.fn);
  d.auxpaths = auxTracks.map(t => t.storedPath || '');
  d.monfn = {}; d.monpaths = {}; d.monvols = {}; d.monmuted = {};
  MONITOR_SLOTS.forEach(k => {
    if (MON[k].fn)         d.monfn[k]    = MON[k].fn;
    if (MON[k].storedPath) d.monpaths[k] = MON[k].storedPath;
    d.monvols[k]  = MON[k].vol;
    d.monmuted[k] = MON[k].muted;
  });
  d.loopLibrary  = loopLibrary.map(lp => ({ fn: lp.fn, storedPath: lp.storedPath }));
  d.activeLoopIdx = activeLoopIdx;
  if (loopFileName) { d.loopfn = loopFileName; d.looppath = loopStoredPath || ''; }
  d.midiPlaylist   = typeof getMidiPlaylistForSave === 'function'
    ? getMidiPlaylistForSave()
    : midiPlaylist.map(m => ({ fileName: m.fileName, storedPath: m.storedPath }));
  d.midiActiveIdx  = midiActiveIdx;
  d.midiTranspose  = midiTranspose;
  d.midiTempoPct   = midiTempoPct;
  if (midiFileName) { d.midifn = midiFileName; d.midipath = midiStoredPath || ''; }

  // Save which engine this song uses so it auto-restores on load
  d.engine = (typeof vwbActiveEngine !== 'undefined') ? vwbActiveEngine : 'audio';

  // Save Armor Bearer state
  if (typeof getArmorBearerState === 'function') d.armorBearer = getArmorBearerState();

  const idx = setlist.findIndex(s => s.title === d.title);
  if (idx >= 0) setlist[idx] = d; else setlist.push(d);
  await window.vwb.saveSetlist(setlist);
  showNotification('Saved: ' + d.title);
}

async function loadSongData(d) {
  doStop(); killSources();
  SK.forEach(k => rmStem(k));
  auxTracks.forEach(t => {
    if (t.src) { try{t.src.stop();}catch(e){} try{t.src.disconnect();}catch(e){} }
    try { t.gn.disconnect(); } catch(e) {}
  });
  auxTracks = [];
  MONITOR_SLOTS.forEach(k => rmMonitorSlot(k));
  removeLoop();
  stopMidiPlay();
  midiPlaylist = []; midiActiveIdx = -1;
  midiEvents = []; midiDuration = 0; midiFileName = ''; midiStoredPath = '';
  midiTranspose = 0; midiTempoPct = 100;
  midiSections = []; midiCurSec = -1; midiQueuedSec = -1; midiSecLoopOn = false;
  renderMidiPlaylist();

  song = JSON.parse(JSON.stringify(d));
  document.getElementById('songTitle').value   = d.title;
  document.getElementById('songTempo').value   = d.tempo;
  document.getElementById('songTimeSig').value = d.ts;
  renderSections(); updMInfo(); renderStems(); renderAuxPanel(); renderMonitorPanel();

  const spaths = d.spaths || {}, sfn = d.sfn || {};
  let loadCount = 0;
  for (const k of SK) {
    if (spaths[k]) {
      const exists = await window.vwb.stemExists(spaths[k]);
      if (exists && await loadStemFromPath(k, spaths[k], sfn[k])) loadCount++;
    }
  }

  const auxpaths = d.auxpaths || [], auxfn = d.auxfn || [];
  for (let i = 0; i < auxpaths.length; i++) {
    if (auxpaths[i]) {
      const exists = await window.vwb.stemExists(auxpaths[i]);
      if (exists) { await addAuxTrackFromPath(auxpaths[i], auxfn[i] || ''); loadCount++; }
    }
  }

  const monpaths = d.monpaths || {}, monfn = d.monfn || {};
  const monvols  = d.monvols  || {}, monmuted = d.monmuted || {};
  for (const k of MONITOR_SLOTS) {
    if (monpaths[k]) {
      const exists = await window.vwb.stemExists(monpaths[k]);
      if (exists) {
        await loadMonitorFromPath(k, monpaths[k], monfn[k] || k);
        if (monvols[k] !== undefined)   MON[k].vol    = monvols[k];
        if (monmuted[k] !== undefined)  MON[k].muted  = monmuted[k];
        applyMonitorGains(); loadCount++;
      }
    }
  }
  renderMonitorPanel();

  stopLoop(); loopLibrary = []; activeLoopIdx = -1;
  loopBuf = null; loopFileName = ''; loopStoredPath = '';

  if (d.loopLibrary && d.loopLibrary.length) {
    for (const lp of d.loopLibrary) {
      if (lp.storedPath) {
        const exists = await window.vwb.stemExists(lp.storedPath);
        if (exists) { await addLoopFromPath(lp.storedPath, lp.fn || ''); loadCount++; }
      }
    }
    if (typeof d.activeLoopIdx === 'number' && d.activeLoopIdx >= 0 && d.activeLoopIdx < loopLibrary.length) {
      activeLoopIdx  = d.activeLoopIdx;
      loopBuf        = loopLibrary[activeLoopIdx].buf;
      loopFileName   = loopLibrary[activeLoopIdx].fn;
      loopStoredPath = loopLibrary[activeLoopIdx].storedPath;
    }
  } else if (d.looppath) {
    const exists = await window.vwb.stemExists(d.looppath);
    if (exists) { await addLoopFromPath(d.looppath, d.loopfn || ''); loadCount++; }
  }
  renderLoopLibrary(); updatePerfLoopUI();

  if (d.midiPlaylist && d.midiPlaylist.length) {
    if (typeof restoreMidiPlaylistFromSave === 'function') {
      // Full restore — sections and all per-file settings come back automatically
      await restoreMidiPlaylistFromSave(d.midiPlaylist);
      if (typeof d.midiActiveIdx === 'number' && d.midiActiveIdx >= 0)
        selectMidiFile(Math.min(d.midiActiveIdx, midiPlaylist.length - 1));
    } else {
      // Fallback: legacy restore without sections
      for (const m of d.midiPlaylist) {
        if (m.storedPath) {
          const ex = await window.vwb.stemExists(m.storedPath);
          if (ex) {
            const rb = await window.vwb.readFileBuffer(m.storedPath);
            if (rb.success) await addMidiFileFromBuffer(rb.buffer, m.fileName, m.storedPath);
          }
        }
      }
      if (typeof d.midiActiveIdx === 'number' && d.midiActiveIdx >= 0) selectMidiFile(Math.min(d.midiActiveIdx, midiPlaylist.length-1));
      if (typeof d.midiTranspose === 'number') { midiTranspose = d.midiTranspose; adjustMidiTranspose(0); }
      if (typeof d.midiTempoPct  === 'number') { midiTempoPct  = d.midiTempoPct;  adjustMidiTempo(0); }
    }
  } else if (d.midipath) {
    const exists = await window.vwb.stemExists(d.midipath);
    if (exists) {
      const rb = await window.vwb.readFileBuffer(d.midipath);
      if (rb.success) await loadMidiFromBuffer(rb.buffer, d.midifn || '', d.midipath);
      loadCount++;
    }
  }

  showNotification('Loaded: ' + d.title + ' (' + loadCount + ' files)');
  renderStems(); renderAuxPanel(); renderMonitorPanel(); renderReloadPanel();

  // Restore engine selection — auto-switches the Perform view to the right engine
  if (typeof setVwbEngine === 'function') {
    const eng = d.engine || (d.midiPlaylist && d.midiPlaylist.length ? 'midi' : 'audio');
    setVwbEngine(eng, false); // false = don't show notification on auto-restore

    // Restore Armor Bearer state
    if (d.armorBearer && typeof restoreArmorBearerState === 'function') {
      restoreArmorBearerState(d.armorBearer);
    }
  }
}

function newSong() {
  doStop();
  song = { title:'', tempo:100, ts:'4/4', secs:[] };
  document.getElementById('songTitle').value   = '';
  document.getElementById('songTempo').value   = 100;
  document.getElementById('songTimeSig').value = '4/4';
  SK.forEach(k => rmStem(k));
  auxTracks.forEach(t => {
    if (t.src) { try{t.src.stop();}catch(e){} try{t.src.disconnect();}catch(e){} }
    try { t.gn.disconnect(); } catch(e) {}
  });
  auxTracks = [];
  removeLoop();
  stopMidiPlay();
  midiPlaylist = []; midiActiveIdx = -1; midiEvents = []; midiDuration = 0;
  midiSections = []; midiCurSec = -1; midiQueuedSec = -1; midiSecLoopOn = false;
  renderStems(); renderAuxPanel(); renderSections(); updMInfo();
  renderMidiPlaylist(); renderLoopLibrary();
  // Default new songs to audio engine
  if (typeof setVwbEngine === 'function') setVwbEngine('audio', false);
}

function goPerform() {
  syncSongFromInputs();
  curSec = -1; qSec = -1; secLoopOn = false;
  goView('perform');
}
