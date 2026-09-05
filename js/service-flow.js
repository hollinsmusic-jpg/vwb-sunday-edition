// ═══════════════════════════════════════════════════════════════
//  VWB Sunday Edition — Service Flow
//  Order of service cues, live mode, song preloader, auto-advance.
//  Depends on: state.js, audio-engine.js, stems.js, loop-library.js
// ═══════════════════════════════════════════════════════════════

// Cue types: 'song' | 'loop' | 'moment'
let svcCues    = [];
let svcCurIdx  = -1;
let svcLive    = false;

const MOMENT_PRESETS = [
  'Devotion / Prayer', 'Praise & Worship', 'Tithes & Offering',
  'Congregational Song', 'Scripture Reading', "Pastor's Message",
  'Altar Call', 'Benediction', 'Announcements', 'Special Music',
  'Communion', 'Baptism', 'Custom…'
];

// ── Add Cue Helpers ────────────────────────────────────────────

function svcAddSong() {
  if (!setlist.length) {
    alert('No songs in your Setlist yet. Add songs in Song Setup first, then come back here.');
    return;
  }
  var opts = '';
  setlist.forEach(function(s, i) {
    opts += '<option value="' + i + '">' + (s.title || 'Untitled') + ' \u2014 ' + s.tempo + ' BPM, ' + s.secs.length + ' sections</option>';
  });
  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:2000;display:flex;align-items:center;justify-content:center;';
  wrap.innerHTML =
    '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:1.5rem;min-width:340px;max-width:500px;width:90%;">' +
    '<h3 style="font-size:1rem;font-weight:600;margin-bottom:1rem;color:var(--accent)">\uD83C\uDFB5 Add Song Cue</h3>' +
    '<div style="margin-bottom:1rem"><label style="font-size:.75rem;color:var(--text-dim);display:block;margin-bottom:.35rem">SELECT SONG</label>' +
    '<select id="svcSongPick" style="width:100%;font-size:.9rem;">' + opts + '</select></div>' +
    '<div style="display:flex;justify-content:flex-end;gap:.5rem">' +
    '<button class="btn btn-secondary btn-small" onclick="this.closest(\'.svc-modal\').remove()">Cancel</button>' +
    '<button class="btn btn-primary btn-small" onclick="svcConfirmAddSong()">Add to Service</button>' +
    '</div></div>';
  wrap.className = 'svc-modal';
  document.body.appendChild(wrap);
  wrap.addEventListener('click', function(e) { if (e.target === wrap) wrap.remove(); });
}

function svcConfirmAddSong() {
  const sel = document.getElementById('svcSongPick');
  if (!sel) return;
  const idx = parseInt(sel.value);
  const s = setlist[idx];
  svcCues.push({ type:'song', songIdx:idx, title:s.title || 'Untitled' });
  document.querySelector('.svc-modal').remove();
  saveSvcCues(); renderSvcCues();
}

function svcAddLoop() {
  const label = prompt('Background pad name (e.g. "Soft Piano Pad", "Organ Pad"):', 'Soft Piano Pad');
  if (!label) return;
  svcCues.push({ type:'loop', title:label.trim() });
  saveSvcCues(); renderSvcCues();
}

function svcAddMoment() {
  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:2000;display:flex;align-items:center;justify-content:center;';
  var presetOpts = MOMENT_PRESETS.map(function(p) { return '<option>' + p + '</option>'; }).join('');
  wrap.innerHTML =
    '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:1.5rem;min-width:340px;max-width:500px;width:90%;">' +
    '<h3 style="font-size:1rem;font-weight:600;margin-bottom:1rem;color:var(--accent)">\uD83D\uDCCB Add Service Moment</h3>' +
    '<div style="margin-bottom:.75rem"><label style="font-size:.75rem;color:var(--text-dim);display:block;margin-bottom:.35rem">MOMENT TYPE</label>' +
    '<select id="svcMomPreset" style="width:100%;font-size:.9rem;" onchange="svcMomPresetChange(this)">' + presetOpts + '</select></div>' +
    '<div style="margin-bottom:1rem"><label style="font-size:.75rem;color:var(--text-dim);display:block;margin-bottom:.35rem">LABEL (edit if needed)</label>' +
    '<input type="text" id="svcMomLabel" value="' + MOMENT_PRESETS[0] + '" style="width:100%;font-size:.9rem;"></div>' +
    '<div style="margin-bottom:1rem"><label style="font-size:.75rem;color:var(--text-dim);display:block;margin-bottom:.35rem">NOTES (optional)</label>' +
    '<input type="text" id="svcMomNote" placeholder="e.g. Pastor Smith leads, approx 5 min" style="width:100%;font-size:.9rem;"></div>' +
    '<div style="display:flex;justify-content:flex-end;gap:.5rem">' +
    '<button class="btn btn-secondary btn-small" onclick="this.closest(\'.svc-modal\').remove()">Cancel</button>' +
    '<button class="btn btn-primary btn-small" onclick="svcConfirmAddMoment()">Add to Service</button>' +
    '</div></div>';
  wrap.className = 'svc-modal';
  document.body.appendChild(wrap);
  wrap.addEventListener('click', function(e) { if (e.target === wrap) wrap.remove(); });
}

function svcMomPresetChange(sel) {
  const lbl = document.getElementById('svcMomLabel');
  if (!lbl) return;
  if (sel.value === 'Custom…') { lbl.value = ''; lbl.focus(); }
  else lbl.value = sel.value;
}

function svcConfirmAddMoment() {
  const label = document.getElementById('svcMomLabel').value.trim() || 'Moment';
  const note  = document.getElementById('svcMomNote').value.trim();
  svcCues.push({ type:'moment', label, note });
  document.querySelector('.svc-modal').remove();
  saveSvcCues(); renderSvcCues();
}

// ── Render ─────────────────────────────────────────────────────

function svcCueIcon(cue) {
  if (cue.type === 'song')   return '🎵';
  if (cue.type === 'loop')   return '🔁';
  if (cue.type === 'moment') return '📋';
  return '▪';
}

function svcCueMeta(cue) {
  if (cue.type === 'song') {
    const s = setlist[cue.songIdx];
    if (s) return s.tempo + ' BPM · ' + s.secs.length + ' sections';
    return 'Song no longer in setlist';
  }
  if (cue.type === 'loop')   return 'Background audio pad';
  if (cue.type === 'moment') return cue.note || 'Service moment';
  return '';
}

function renderSvcCues() {
  const c = document.getElementById('svcCueList');
  if (!c) return;

  if (!svcCues.length) {
    c.innerHTML = '<div class="svc-empty">No cues yet.<br>Add songs, background pads, and service moments below to build your order of service.</div>';
    return;
  }

  c.innerHTML = '';
  svcCues.forEach((cue, i) => {
    const isActive = svcLive && i === svcCurIdx;
    const isNext   = svcLive && i === svcCurIdx + 1;
    const isDone   = svcLive && i < svcCurIdx;

    let cls = 'svc-cue';
    if (isActive) cls += ' cue-active';
    else if (isNext) cls += ' cue-next';
    else if (isDone) cls += ' cue-done';

    let badge = '';
    if (isActive) badge = '<span class="cue-badge">▶ NOW</span>';
    else if (isNext) badge = '<span class="cue-badge">NEXT</span>';

    const acts = svcLive ? '' :
      '<div class="cue-acts">' +
      '<button onclick="svcMoveCue(' + i + ',-1)" title="Move up"' + (i===0?' disabled':'') + '>↑</button>' +
      '<button onclick="svcMoveCue(' + i + ',1)" title="Move down"' + (i===svcCues.length-1?' disabled':'') + '>↓</button>' +
      '<button onclick="svcRemoveCue(' + i + ')" style="color:var(--red)" title="Remove">✕</button>' +
      '</div>';

    c.innerHTML +=
      '<div class="' + cls + '" id="svc-cue-' + i + '">' +
      '<span class="cue-num">' + (i+1) + '</span>' +
      '<span class="cue-icon">' + svcCueIcon(cue) + '</span>' +
      '<div class="cue-body">' +
        '<div class="cue-title">' + (cue.title || cue.label || '—') + '</div>' +
        '<div class="cue-meta">' + svcCueMeta(cue) + '</div>' +
      '</div>' +
      badge + acts +
      '</div>';
  });

  if (svcLive && svcCurIdx >= 0) {
    const el = document.getElementById('svc-cue-' + svcCurIdx);
    if (el) el.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }

  updateSvcLiveBar();
}

function updateSvcLiveBar() {
  const bar = document.getElementById('svcLiveBar');
  const btn = document.getElementById('svcGoLiveBtn');
  if (!bar || !btn) return;

  bar.classList.toggle('on', svcLive);

  if (svcLive) {
    btn.textContent = '▶ Service Running';
    btn.disabled = true;
    btn.style.opacity = '.5';
    const cur = svcCues[svcCurIdx];
    const nxt = svcCues[svcCurIdx + 1];
    document.getElementById('svcLiveCur').textContent  = cur ? (svcCueIcon(cur) + ' ' + (cur.title || cur.label)) : 'Service Started';
    document.getElementById('svcLiveNext').textContent = nxt ? ('Up next: ' + svcCueIcon(nxt) + ' ' + (nxt.title || nxt.label)) : 'Last cue';
  } else {
    btn.textContent = '▶ Start Service';
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

// ── Live Mode ──────────────────────────────────────────────────

async function svcGoLive() {
  if (!svcCues.length) { alert('Add at least one cue to the service before starting.'); return; }
  await preloadAllServiceSongs();
  svcLive = true;
  svcCurIdx = 0;
  renderSvcCues();
  svcActivateCue(0);
  showNotification('▶ Service Started — all songs pre-loaded');
}

function svcEndLive() {
  if (!confirm('End the service? This will stop all audio and reset the service order.')) return;
  svcLive = false;
  svcCurIdx = -1;
  if (autoAdvanceTimer) { clearInterval(autoAdvanceTimer); autoAdvanceTimer = null; }
  svcPreloadCache = {};
  doStop(); stopLoop();
  renderSvcCues();
  showNotification('Service ended');
}

function svcNext() {
  if (!svcLive) return;
  if (svcCurIdx < svcCues.length - 1) {
    svcCurIdx++;
    svcActivateCue(svcCurIdx);
    renderSvcCues();
  } else {
    showNotification('Last cue — end of service order');
  }
}

function svcPrev() {
  if (!svcLive) return;
  if (svcCurIdx > 0) {
    svcCurIdx--;
    svcActivateCue(svcCurIdx);
    renderSvcCues();
  }
}

async function svcActivateCue(idx) {
  const cue = svcCues[idx];
  if (!cue) return;

  if (cue.type === 'song') {
    const s = setlist[cue.songIdx];
    if (!s) { showNotification('⚠️ Song not found in setlist'); return; }

    if (crossfadeMode === 'autoadvance' || crossfadeMode === 'auto') {
      const cache = svcPreloadCache[cue.songIdx];
      if (cache) {
        if (playing) {
          fadeOutStems(crossfadeDuration, async () => {
            await loadSongFromCache(s, cue.songIdx);
            doPlay();
            fadeInStems(crossfadeDuration);
            crossfading = false;
            showNotification('▶ Now: ' + (s.title || 'Song'));
          });
          crossfading = true;
        } else {
          await loadSongFromCache(s, cue.songIdx);
          doPlay();
          fadeInStems(crossfadeDuration);
          showNotification('▶ Now: ' + (s.title || 'Song'));
        }
      } else {
        await crossfadeToSong(s);
      }
    } else {
      doStop();
      if (svcPreloadCache[cue.songIdx]) {
        await loadSongFromCache(s, cue.songIdx);
      } else {
        await loadSongData(s);
      }
      setTimeout(() => { pauseAt = 0; goView('perform'); showNotification('▶ Now: ' + (s.title || 'Song')); }, 100);
    }

    if (crossfadeMode === 'autoadvance') watchForSongEnd(idx);
  }

  if (cue.type === 'loop') {
    if (loopLibrary.length > 0) {
      stopLoop();
      if (activeLoopIdx < 0) activeLoopIdx = 0;
      startLoop();
      showNotification('🔁 Background pad playing');
    } else {
      showNotification('⚠️ No background loop loaded. Load one in Song Setup.');
    }
  }

  if (cue.type === 'moment') {
    var msg = cue.note ? ('📋 ' + cue.label + ' — ' + cue.note) : ('📋 ' + cue.label);
    showNotification(msg);
  }
}

// ── Auto-advance ───────────────────────────────────────────────

let autoAdvanceTimer = null;

function watchForSongEnd(cueIdx) {
  if (autoAdvanceTimer) { clearInterval(autoAdvanceTimer); autoAdvanceTimer = null; }
  autoAdvanceTimer = setInterval(() => {
    if (!svcLive || svcCurIdx !== cueIdx || crossfadeMode !== 'autoadvance') {
      clearInterval(autoAdvanceTimer); autoAdvanceTimer = null; return;
    }
    const t = getCurTime(), dur = getDur();
    if (dur <= 0) return;
    const nearEnd = playing && t >= dur - crossfadeDuration - 0.2;
    const stoppedNaturally = songEndedNaturally || (!playing && pauseAt === 0 && dur > 0 && t === 0);
    if (nearEnd || stoppedNaturally) {
      clearInterval(autoAdvanceTimer); autoAdvanceTimer = null;
      if (svcCurIdx < svcCues.length - 1) {
        svcCurIdx++;
        renderSvcCues();
        svcActivateCue(svcCurIdx);
      } else {
        showNotification('✓ Service complete');
      }
    }
  }, 250);
}

// ── Preloader ──────────────────────────────────────────────────

let svcPreloadCache = {};

function showPreloadOverlay(msg) {
  let el = document.getElementById('preloadOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'preloadOverlay';
    el.className = 'preload-overlay';
    el.innerHTML =
      '<div class="preload-box">' +
      '<h3>⏳ Preparing Service…</h3>' +
      '<p>Loading all songs into memory so transitions are instant. This only takes a moment.</p>' +
      '<div class="preload-bar-wrap"><div class="preload-bar" id="preloadBar" style="width:0%"></div></div>' +
      '<div class="preload-status" id="preloadStatus">Starting…</div>' +
      '</div>';
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  if (msg) document.getElementById('preloadStatus').textContent = msg;
}

function updatePreloadProgress(done, total, label) {
  const bar    = document.getElementById('preloadBar');
  const status = document.getElementById('preloadStatus');
  if (bar)    bar.style.width      = Math.round((done / total) * 100) + '%';
  if (status) status.textContent   = label;
}

function hidePreloadOverlay() {
  const el = document.getElementById('preloadOverlay');
  if (el) el.style.display = 'none';
}

async function preloadSongIntoCache(songData, cacheKey) {
  if (svcPreloadCache[cacheKey]) return;
  const cache = { bufs: {}, auxBufs: [], loopBufs: [] };

  const spaths = songData.spaths || {};
  for (const k of SK) {
    if (spaths[k]) {
      try {
        const exists = await window.vwb.stemExists(spaths[k]);
        if (exists) {
          const result = await window.vwb.readFileBuffer(spaths[k]);
          if (result.success) cache.bufs[k] = await AC.decodeAudioData(result.buffer);
        }
      } catch(e) { console.warn('Preload stem failed:', k, e); }
    }
  }

  const auxpaths = songData.auxpaths || [];
  const auxfn    = songData.auxfn    || [];
  for (let i = 0; i < auxpaths.length; i++) {
    if (auxpaths[i]) {
      try {
        const exists = await window.vwb.stemExists(auxpaths[i]);
        if (exists) {
          const result = await window.vwb.readFileBuffer(auxpaths[i]);
          if (result.success) {
            cache.auxBufs.push({
              buf: await AC.decodeAudioData(result.buffer),
              fn: auxfn[i] || '', storedPath: auxpaths[i], vol: 80, muted: false
            });
          }
        }
      } catch(e) { console.warn('Preload aux failed:', i, e); }
    }
  }

  svcPreloadCache[cacheKey] = cache;
}

async function preloadAllServiceSongs() {
  const songCues = svcCues.filter(c => c.type === 'song');
  if (!songCues.length) return true;

  showPreloadOverlay('Loading songs…');
  svcPreloadCache = {};

  for (let i = 0; i < songCues.length; i++) {
    const cue = songCues[i];
    const s   = setlist[cue.songIdx];
    if (!s) continue;
    updatePreloadProgress(i, songCues.length, 'Loading ' + (i+1) + ' of ' + songCues.length + ': ' + (s.title || 'Song'));
    await preloadSongIntoCache(s, cue.songIdx);
  }

  updatePreloadProgress(songCues.length, songCues.length, 'All songs ready!');
  await new Promise(r => setTimeout(r, 500));
  hidePreloadOverlay();
  return true;
}

async function loadSongFromCache(songData, cacheKey) {
  const cache = svcPreloadCache[cacheKey];
  if (!cache) { await loadSongData(songData); return; }

  doStop(); killSources();

  SK.forEach(k => {
    if (S[k].src) { try{S[k].src.stop();}catch(e){} try{S[k].src.disconnect();}catch(e){} S[k].src = null; }
    S[k].buf = null; S[k].fn = ''; S[k].storedPath = '';
  });
  auxTracks.forEach(t => {
    if (t.src) { try{t.src.stop();}catch(e){} try{t.src.disconnect();}catch(e){} }
    try { t.gn.disconnect(); } catch(e) {}
  });
  auxTracks = [];

  song = JSON.parse(JSON.stringify(songData));
  document.getElementById('songTitle').value   = song.title  || '';
  document.getElementById('songTempo').value   = song.tempo  || 72;
  document.getElementById('songTimeSig').value = song.ts     || '4/4';

  const sfn = songData.sfn || {}, spaths = songData.spaths || {};
  SK.forEach(k => {
    if (cache.bufs[k]) {
      S[k].buf = cache.bufs[k]; S[k].fn = sfn[k] || k; S[k].storedPath = spaths[k] || '';
    }
  });
  cache.auxBufs.forEach(t => {
    const gn = AC.createGain();
    gn.gain.value = t.vol / 100;
    gn.connect(auxMasterGain);
    auxTracks.push({ buf: t.buf, src: null, gn, vol: t.vol, fn: t.fn, muted: t.muted, storedPath: t.storedPath });
  });

  pauseAt = 0;
  renderStems(); renderAuxPanel(); renderSections(); updMInfo();
  refreshPerfView();
}

// ── Cue Management ─────────────────────────────────────────────

function svcMoveCue(idx, dir) {
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= svcCues.length) return;
  const temp = svcCues[idx]; svcCues[idx] = svcCues[newIdx]; svcCues[newIdx] = temp;
  saveSvcCues(); renderSvcCues();
}

function svcRemoveCue(idx) { svcCues.splice(idx, 1); saveSvcCues(); renderSvcCues(); }

function svcClear() {
  if (!svcCues.length) return;
  if (!confirm('Clear all service cues?')) return;
  svcCues = []; svcLive = false; svcCurIdx = -1;
  saveSvcCues(); renderSvcCues();
}

// ── Persistence ────────────────────────────────────────────────

async function saveSvcCues() {
  try { await window.vwb.saveService({ cues: svcCues }); }
  catch(e) { console.warn('Could not save service cues:', e); }
}

async function loadSvcCues() {
  try {
    const result = await window.vwb.loadService();
    if (result && result.success && result.data && result.data.cues) {
      svcCues = result.data.cues;
    }
  } catch(e) { console.warn('Could not load service cues:', e); }
}

// ── Append service cue controls to MRC_FUNCTIONS list ─────────
function initSvcMrcFunctions() {
  MRC_FUNCTIONS.push(
    { id:'svc_next', label:'Service: Next Cue', fn: svcNext },
    { id:'svc_prev', label:'Service: Prev Cue', fn: svcPrev }
  );
  renderMrcGrid();
}
