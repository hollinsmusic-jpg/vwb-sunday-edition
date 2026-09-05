// ═══════════════════════════════════════════════════════════════
//  VWB Sunday Edition — MIDI Remote Control (MRC)
//  MIDI input mapping, learn mode, and performance triggers.
//  Depends on: state.js, midi-player.js, audio-engine.js
// ═══════════════════════════════════════════════════════════════

let mrcPanelOpen       = false;
let mrcInput           = null;         // selected MIDI input port
let mrcLearning        = null;         // function ID in learn mode (null = none)
let mrcActivityTimeout = null;

// All mappable functions (service cues appended by initSvcMrcFunctions)
const MRC_FUNCTIONS = [
  { id:'play_pause', label:'Play / Pause',          fn: () => togglePlay() },
  { id:'stop',       label:'Stop',                  fn: () => doStop() },
  { id:'next_sec',   label:'Next Section',           fn: () => { if (curSec < song.secs.length-1) queueSection(curSec+1); } },
  { id:'prev_sec',   label:'Prev Section',           fn: () => { if (curSec > 0) queueSection(curSec-1); } },
  { id:'sec_loop',   label:'Section Loop Toggle',    fn: () => toggleSecLoop() },
  { id:'bg_loop',    label:'Background Loop Toggle', fn: () => toggleLoop() },
  { id:'midi_play',  label:'MIDI File Toggle',       fn: () => toggleMidiPlay() },
  { id:'sec1', label:'Go to Section 1', fn: () => { if (0 < song.secs.length) queueSection(0); } },
  { id:'sec2', label:'Go to Section 2', fn: () => { if (1 < song.secs.length) queueSection(1); } },
  { id:'sec3', label:'Go to Section 3', fn: () => { if (2 < song.secs.length) queueSection(2); } },
  { id:'sec4', label:'Go to Section 4', fn: () => { if (3 < song.secs.length) queueSection(3); } },
  { id:'sec5', label:'Go to Section 5', fn: () => { if (4 < song.secs.length) queueSection(4); } },
  { id:'sec6', label:'Go to Section 6', fn: () => { if (5 < song.secs.length) queueSection(5); } },
  { id:'sec7', label:'Go to Section 7', fn: () => { if (6 < song.secs.length) queueSection(6); } },
  { id:'sec8', label:'Go to Section 8', fn: () => { if (7 < song.secs.length) queueSection(7); } },
  { id:'sec9', label:'Go to Section 9', fn: () => { if (8 < song.secs.length) queueSection(8); } },
];

// Mappings: { functionId: { type:'note'|'cc', number:60, channel:0 } }
let mrcMap = {};

// ── Panel ──────────────────────────────────────────────────────

function toggleMrcPanel() {
  mrcPanelOpen = !mrcPanelOpen;
  const body = document.getElementById('mrcPanelBody');
  const icon = document.getElementById('mrcToggleIcon');
  if (body) body.style.display = mrcPanelOpen ? 'block' : 'none';
  if (icon) icon.innerHTML = mrcPanelOpen
    ? '<span style="font-size:.75rem;color:var(--text-dim);">Click to collapse</span> <span style="display:inline-block;transform:rotate(90deg);color:var(--text-dim);">&#9654;</span>'
    : '<span style="font-size:.75rem;color:var(--text-dim);">Click to expand</span> <span style="color:var(--text-dim);">&#9654;</span>';
}

// ── Input Selection ────────────────────────────────────────────

function refreshMrcInputs() {
  if (!midiAccess) { initMidi().then(() => refreshMrcInputs()); return; }
  const sel = document.getElementById('mrcInputSelect');
  if (!sel) return;
  const curVal = sel.value;
  sel.innerHTML = '<option value="">-- Select MIDI Input --</option>';
  midiAccess.inputs.forEach(port => {
    const opt = document.createElement('option');
    opt.value = port.id;
    opt.textContent = port.name || ('MIDI Input ' + port.id);
    sel.appendChild(opt);
  });
  if (curVal) sel.value = curVal;
  if (midiAccess.inputs.size === 0) {
    setMrcHint('No MIDI inputs found. Connect a Bluetooth MIDI device or USB controller and click Refresh.');
  }
}

function selectMrcInput(portId) {
  if (mrcInput) { mrcInput.onmidimessage = null; mrcInput = null; }
  if (!portId || !midiAccess) return;
  mrcInput = midiAccess.inputs.get(portId);
  if (mrcInput) {
    mrcInput.onmidimessage = handleMrcMessage;
    setMrcHint('Connected to: ' + (mrcInput.name || portId) + '. Click a function to start mapping.');
  }
}

// ── Message Handler ────────────────────────────────────────────

function handleMrcMessage(e) {
  const data = e.data;
  if (!data || data.length < 2) return;

  const status  = data[0] & 0xF0;
  const channel = data[0] & 0x0F;
  const num     = data[1];
  const vel     = data.length > 2 ? data[2] : 0;

  const act = document.getElementById('mrcActivity');
  if (act) {
    act.classList.add('on');
    clearTimeout(mrcActivityTimeout);
    mrcActivityTimeout = setTimeout(() => act.classList.remove('on'), 150);
  }

  // Learn mode: capture incoming message
  if (mrcLearning) {
    let type = null;
    if (status === 0x90 && vel > 0) type = 'note';
    else if (status === 0xB0)       type = 'cc';
    if (type) {
      mrcMap[mrcLearning] = { type, number: num, channel };
      const label = type === 'note'
        ? 'Note ' + num + ' (Ch ' + (channel+1) + ')'
        : 'CC ' + num  + ' (Ch ' + (channel+1) + ')';
      setMrcHint('Assigned: ' + label + ' → ' + MRC_FUNCTIONS.find(f => f.id === mrcLearning).label);
      mrcLearning = null;
      renderMrcGrid();
      return;
    }
  }

  // Performance mode: trigger mapped functions
  if (status === 0x90 && vel > 0) {
    triggerMrcAction('note', num, channel);
  } else if (status === 0xB0 && vel > 63) {
    triggerMrcAction('cc', num, channel);
  }
}

function triggerMrcAction(type, number, channel) {
  for (const [fnId, mapping] of Object.entries(mrcMap)) {
    if (mapping.type === type && mapping.number === number && mapping.channel === channel) {
      const func = MRC_FUNCTIONS.find(f => f.id === fnId);
      if (func) func.fn();
      return;
    }
  }
}

// ── Render ─────────────────────────────────────────────────────

function renderMrcGrid() {
  const grid = document.getElementById('mrcMapGrid');
  if (!grid) return;
  grid.innerHTML = '';
  MRC_FUNCTIONS.forEach(f => {
    const mapping    = mrcMap[f.id];
    const isLearning = mrcLearning === f.id;
    let valText  = '—';
    let valClass = 'mrc-val empty';
    if (mapping) {
      valText  = (mapping.type === 'note' ? 'N' : 'CC') + mapping.number + ' Ch' + (mapping.channel+1);
      valClass = 'mrc-val';
    }
    if (isLearning) { valText = 'Press a key...'; valClass = 'mrc-val'; }

    grid.innerHTML +=
      '<div class="mrc-map-row' + (isLearning ? ' learning' : '') + '" onclick="startLearn(\'' + f.id + '\')">' +
      '<span class="mrc-fn">' + f.label + '</span>' +
      '<span class="' + valClass + '">' + valText + '</span>' +
      (mapping ? '<button class="mrc-clr" onclick="event.stopPropagation();clearMapping(\'' + f.id + '\')">×</button>' : '') +
      '</div>';
  });
}

// ── Learn / Clear ──────────────────────────────────────────────

function startLearn(fnId) {
  if (mrcLearning === fnId) {
    mrcLearning = null;
    setMrcHint('Learning cancelled.');
  } else {
    mrcLearning = fnId;
    const label = MRC_FUNCTIONS.find(f => f.id === fnId).label;
    setMrcHint('Waiting for MIDI input... Press a key/button on your controller to assign it to "' + label + '"');
  }
  renderMrcGrid();
}

function clearMapping(fnId) { delete mrcMap[fnId]; renderMrcGrid(); }

function clearAllMappings() {
  if (confirm('Clear all MIDI mappings?')) {
    mrcMap = {};
    renderMrcGrid();
    setMrcHint('All mappings cleared.');
  }
}

// ── Persistence ────────────────────────────────────────────────

async function saveMrcMappings() {
  try {
    await window.vwb.saveMrcMap(mrcMap);
    setMrcHint('Mappings saved! They will persist between sessions.');
  } catch(e) {
    setMrcHint('Could not save mappings.');
  }
}

async function loadMrcMappings() {
  try {
    const result = await window.vwb.loadMrcMap();
    if (result.success && result.data) {
      mrcMap = result.data;
      renderMrcGrid();
      setMrcHint('Loaded ' + Object.keys(mrcMap).length + ' saved mappings.');
    } else {
      setMrcHint('No saved mappings found.');
    }
  } catch(e) {
    setMrcHint('Could not load mappings.');
  }
}

function setMrcHint(msg) {
  const el = document.getElementById('mrcHint');
  if (el) el.textContent = msg;
}
