// ═══════════════════════════════════════════════════════════════
//  VWB Sunday Edition — Stems, Aux & Monitor
//  Stem load / pick / remove, Aux sub-mixer,
//  Monitor Bus (Q/Click), and Stem Reload Panel.
//  Depends on: state.js
// ═══════════════════════════════════════════════════════════════

// ── Stem Load / Pick / Remove ──────────────────────────────────

async function loadStemFromPath(k, filePath, fileName) {
  try {
    const result = await window.vwb.readFileBuffer(filePath);
    if (!result.success) { console.error('Could not read stem:', result.error); return false; }
    S[k].buf = await AC.decodeAudioData(result.buffer);
    S[k].fn  = fileName || filePath.split('/').pop();
    S[k].storedPath = filePath;
    renderStems(); updMInfo();
    return true;
  } catch(e) { console.error('Could not decode stem:', e); return false; }
}

async function pickAndLoadStem(k) {
  const result = await window.vwb.pickAudioFiles(false);
  if (result.canceled || !result.files.length) return;
  const file = result.files[0];
  const songTitle = document.getElementById('songTitle').value || 'untitled';
  const stored = await window.vwb.storeStem({
    songTitle, stemKey: k, sourcePath: file.path, fileName: file.name
  });
  if (stored.success) await loadStemFromPath(k, stored.storedPath, file.name);
}

// Legacy alias used by reload panel
async function loadStem(k, filePath, fileName) {
  return loadStemFromPath(k, filePath, fileName);
}

function rmStem(k) {
  if (S[k].src) {
    try { S[k].src.stop(); }       catch(e) {}
    try { S[k].src.disconnect(); } catch(e) {}
    S[k].src = null;
  }
  S[k].buf = null; S[k].fn = ''; S[k].storedPath = '';
  renderStems(); updMInfo();
}

// ── Aux Sub-Mixer ──────────────────────────────────────────────

function addAuxTrackFromPath(filePath, fileName) {
  return new Promise(async (resolve, reject) => {
    try {
      const result = await window.vwb.readFileBuffer(filePath);
      if (!result.success) { alert('Could not read: ' + fileName); reject(result.error); return; }
      const buf = await AC.decodeAudioData(result.buffer);
      const gn  = AC.createGain();
      gn.gain.value = 0.8;
      gn.connect(auxMasterGain);
      const track = { buf, src: null, gn, vol: 80, fn: fileName, muted: false, storedPath: filePath };
      auxTracks.push(track);
      renderAuxPanel(); renderMixer(); updMInfo();
      resolve(track);
    } catch(e) { alert('Could not load ' + fileName); reject(e); }
  });
}

async function pickAndAddAuxTracks() {
  const result = await window.vwb.pickAudioFiles(true);
  if (result.canceled || !result.files.length) return;
  const songTitle = document.getElementById('songTitle').value || 'untitled';
  for (const file of result.files) {
    const stored = await window.vwb.storeStem({
      songTitle,
      stemKey: 'aux_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      sourcePath: file.path,
      fileName: file.name
    });
    if (stored.success) await addAuxTrackFromPath(stored.storedPath, file.name);
  }
}

// Legacy compatibility alias
async function addAuxTrack(filePath, fileName) {
  return addAuxTrackFromPath(filePath, fileName);
}

function removeAuxTrack(idx) {
  if (idx < 0 || idx >= auxTracks.length) return;
  const t = auxTracks[idx];
  if (t.src) { try{t.src.stop();}catch(e){} try{t.src.disconnect();}catch(e){} }
  try { t.gn.disconnect(); } catch(e) {}
  auxTracks.splice(idx, 1);
  renderAuxPanel(); renderMixer(); updMInfo();
}

function setAuxTrackVol(idx, v) {
  if (idx < 0 || idx >= auxTracks.length) return;
  auxTracks[idx].vol = parseInt(v);
  applyAuxGains();
}

function toggleAuxTrackMute(idx) {
  if (idx < 0 || idx >= auxTracks.length) return;
  auxTracks[idx].muted = !auxTracks[idx].muted;
  applyAuxGains(); renderMixer();
}

function setAuxMasterVolFn(v) { auxMasterVol = parseInt(v); applyAuxGains(); }

function applyAuxGains() {
  const anySolo = SK.some(k => S[k].solo) || auxSolo;
  let masterOn = true;
  if (auxMasterMuted)         masterOn = false;
  if (anySolo && !auxSolo)   masterOn = false;
  auxMasterGain.gain.value = masterOn ? auxMasterVol / 100 : 0;
  auxTracks.forEach(t => { t.gn.gain.value = t.muted ? 0 : t.vol / 100; });
}

function toggleAuxMute()  { auxMasterMuted = !auxMasterMuted; applyAuxGains(); renderMixer(); }
function toggleAuxSolo()  { auxSolo = !auxSolo; applySoloMute(); renderMixer(); }

// ── Monitor Bus (Q/Click) ──────────────────────────────────────

async function pickMonitorSlot(slot) {
  const result = await window.vwb.pickAudioFiles(false);
  if (result.canceled || !result.files.length) return;
  const file = result.files[0];
  const songTitle = document.getElementById('songTitle').value || 'untitled';
  const stored = await window.vwb.storeStem({
    songTitle, stemKey: 'mon_' + slot, sourcePath: file.path, fileName: file.name
  });
  if (stored.success) {
    await loadMonitorFromPath(slot, stored.storedPath, file.name);
  } else {
    await loadMonitorFromPath(slot, file.path, file.name);
  }
}

async function loadMonitorFromPath(slot, filePath, fileName) {
  try {
    const result = await window.vwb.readFileBuffer(filePath);
    if (!result.success) { alert('Could not read: ' + fileName); return; }
    const buf = await AC.decodeAudioData(result.buffer);
    MON[slot].buf = buf; MON[slot].fn = fileName; MON[slot].storedPath = filePath;
    renderMonitorPanel(); renderMixer(); updMInfo();
  } catch(e) { alert('Could not load monitor track: ' + fileName); }
}

function rmMonitorSlot(slot) {
  if (MON[slot].src) {
    try{MON[slot].src.stop();}catch(e){}
    try{MON[slot].src.disconnect();}catch(e){}
    MON[slot].src = null;
  }
  MON[slot].buf = null; MON[slot].fn = ''; MON[slot].storedPath = '';
  renderMonitorPanel(); renderMixer(); updMInfo();
}

function setMonitorVol(slot, v) { MON[slot].vol = parseInt(v); applyMonitorGains(); }

function toggleMonitorMute(slot) {
  MON[slot].muted = !MON[slot].muted;
  applyMonitorGains(); renderMonitorPanel();
}

function applyMonitorGains() {
  MONITOR_SLOTS.forEach(k => {
    MON[k].gn.gain.value = MON[k].muted ? 0 : MON[k].vol / 100;
  });
}

function toggleMonitorPanel() {
  const panel = document.getElementById('monitorBusPanel');
  const arrow = document.getElementById('monitorToggleArrow');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if (arrow) arrow.style.transform = isOpen ? '' : 'rotate(90deg)';
}

function renderMonitorPanel() {
  const c = document.getElementById('monitorBusList');
  if (!c) return;
  c.innerHTML = '';
  MONITOR_SLOTS.forEach(slot => {
    const m     = MON[slot];
    const color = MONITOR_COLORS[slot];
    const label = MONITOR_LABELS[slot];
    if (m.buf) {
      c.innerHTML +=
        '<div class="stem-slot loaded" style="border-color:'+color+';background:rgba(255,100,100,.05);flex-direction:row;justify-content:flex-start;gap:.75rem;min-height:52px;padding:.6rem 1rem;margin-bottom:.4rem">' +
        '<span style="font-size:1.1rem">'+label.split(' ')[0]+'</span>' +
        '<span style="font-size:.8rem;font-weight:600;color:'+color+';min-width:42px">'+label.split(' ')[1]+'</span>' +
        '<span style="font-size:.8rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)" title="'+m.fn+'">'+m.fn+'</span>' +
        '<div style="display:flex;align-items:center;gap:.35rem"><span style="font-size:.65rem;color:var(--text-dim)">Vol</span><input type="range" min="0" max="100" value="'+m.vol+'" style="-webkit-appearance:none;width:64px;height:3px;border-radius:2px;background:var(--bg-primary)" oninput="setMonitorVol(\''+slot+'\',this.value)"></div>' +
        '<button style="font-size:.7rem;padding:.2rem .45rem;border-radius:4px;border:1px solid var(--border);background:'+(m.muted?'rgba(255,100,100,.25)':'none')+';color:'+(m.muted?'#ff6464':'var(--text-dim)')+';cursor:pointer" onclick="toggleMonitorMute(\''+slot+'\')">'+( m.muted?'🔇':'🔉')+'</button>' +
        '<span style="font-size:.7rem;color:var(--text-dim);font-family:\'Space Mono\',monospace">'+fmt(m.buf.duration)+'</span>' +
        '<button class="s-rm" style="position:static;display:block" onclick="event.stopPropagation();rmMonitorSlot(\''+slot+'\')">×</button>' +
        '</div>';
    } else {
      c.innerHTML +=
        '<div style="display:flex;align-items:center;gap:.6rem;padding:.4rem .25rem;margin-bottom:.25rem">' +
        '<span style="font-size:1rem">'+label.split(' ')[0]+'</span>' +
        '<span style="font-size:.8rem;font-weight:600;color:'+color+';min-width:42px">'+label.split(' ')[1]+'</span>' +
        '<span style="font-size:.75rem;color:var(--text-dim);font-style:italic">No file loaded</span>' +
        '</div>';
    }
  });
}

// ── Stem Reload Panel ──────────────────────────────────────────

function renderReloadPanel() {
  const wrap = document.getElementById('reloadWrap');
  if (!wrap) return;
  const sfn  = song.sfn  || {};
  const auxfn = song.auxfn || [];
  const neededStems = SK.filter(k => sfn[k] && !S[k].buf);
  const neededAux   = auxfn.filter(fn => !auxTracks.some(t => t.fn === fn));
  const totalNeeded = neededStems.length + neededAux.length;

  if (!Object.keys(sfn).length && !auxfn.length) { wrap.innerHTML = ''; return; }

  let h = '<div class="reload-panel"><h4>Stem Files — ' + (song.title || 'Song') + '</h4>';
  h += '<p style="font-size:.8rem;color:var(--text-dim);margin-bottom:.75rem">';
  h += totalNeeded === 0
    ? '<span style="color:var(--green)">All stems loaded and ready!</span>'
    : totalNeeded + ' file' + (totalNeeded > 1 ? 's' : '') + ' need reloading. Click "Browse" to load each file.';
  h += '</p>';

  SK.forEach(k => {
    if (!sfn[k]) return;
    const isLoaded = !!S[k].buf;
    const icon = SL[k].split(' ')[0];
    h += '<div class="reload-row">';
    h += '<span class="rl-name" style="color:'+SC[k]+'">'+icon+' '+SL[k].split(' ')[1]+'</span>';
    h += '<span class="rl-file">'+sfn[k]+'</span>';
    if (isLoaded) {
      h += '<span class="rl-status loaded">✓ Ready</span>';
    } else {
      h += '<span class="rl-status needed">Needed</span>';
      h += '<button class="rl-btn" onclick="pickAndReloadStem(\''+k+'\')">Browse</button>';
    }
    h += '</div>';
  });

  auxfn.forEach((fn) => {
    const isLoaded = auxTracks.some(t => t.fn === fn);
    h += '<div class="reload-row">';
    h += '<span class="rl-name" style="color:#f0c040">🎶 Aux</span>';
    h += '<span class="rl-file">'+fn+'</span>';
    if (isLoaded) {
      h += '<span class="rl-status loaded">✓ Ready</span>';
    } else {
      h += '<span class="rl-status needed">Needed</span>';
      h += '<button class="rl-btn" onclick="pickAndReloadAuxTrack()">Browse</button>';
    }
    h += '</div>';
  });

  h += '<div style="margin-top:.75rem;display:flex;gap:.5rem">';
  if (totalNeeded > 0) {
    h += '<button class="btn btn-secondary btn-small" onclick="bulkReloadStems()">Load All at Once</button>';
  }
  h += '<button class="btn btn-primary btn-small" onclick="goPerform()" ' + (totalNeeded > 0 ? 'style="opacity:.5" title="Load stems first"' : '') + '>▶ Perform</button>';
  h += '</div></div>';
  wrap.innerHTML = h;
}

async function pickAndReloadAuxTrack() {
  const result = await window.vwb.pickAudioFiles(false);
  if (result.canceled || !result.files.length) return;
  const file = result.files[0];
  const songTitle = document.getElementById('songTitle').value || 'untitled';
  const stored = await window.vwb.storeStem({
    songTitle, stemKey: 'aux_' + Date.now(), sourcePath: file.path, fileName: file.name
  });
  if (stored.success) await addAuxTrackFromPath(stored.storedPath, file.name);
  renderReloadPanel();
}

async function pickAndReloadStem(k) {
  const result = await window.vwb.pickAudioFiles(false);
  if (result.canceled || !result.files.length) return;
  const file = result.files[0];
  const songTitle = document.getElementById('songTitle').value || 'untitled';
  const stored = await window.vwb.storeStem({
    songTitle, stemKey: k, sourcePath: file.path, fileName: file.name
  });
  if (stored.success) await loadStemFromPath(k, stored.storedPath, file.name);
  renderReloadPanel();
}

async function reloadStem(k, filePath, fileName) {
  await loadStemFromPath(k, filePath, fileName);
  renderReloadPanel();
}

async function bulkReloadStems() {
  const result = await window.vwb.pickAudioFiles(true);
  if (result.canceled || !result.files.length) return;
  const files    = result.files;
  const sfn      = song.sfn  || {};
  const auxfn    = song.auxfn || [];
  const songTitle = document.getElementById('songTitle').value || 'untitled';

  for (const k of SK) {
    if (!sfn[k] || S[k].buf) continue;
    const match = files.find(f => f.name === sfn[k]);
    if (match) {
      const stored = await window.vwb.storeStem({ songTitle, stemKey: k, sourcePath: match.path, fileName: match.name });
      if (stored.success) await loadStemFromPath(k, stored.storedPath, match.name);
    }
  }
  for (const fn of auxfn) {
    if (auxTracks.some(t => t.fn === fn)) continue;
    const match = files.find(f => f.name === fn);
    if (match) {
      const stored = await window.vwb.storeStem({ songTitle, stemKey: 'aux_' + Date.now(), sourcePath: match.path, fileName: match.name });
      if (stored.success) await addAuxTrackFromPath(stored.storedPath, match.name);
    }
  }
  renderReloadPanel();
}
