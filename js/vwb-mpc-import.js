// ═══════════════════════════════════════════════════════════════
//  VWB — MPC Percussion Loop Importer
//  js/vwb-mpc-import.js
//
//  Bridges the VWB Percussion Center (standalone MPC tool) to
//  VWB's House Band engine. Takes a .mid file exported from the
//  VWB MPC and:
//    1. Parses the MIDI file into a normalized event array
//    2. Registers it as a percussion chunk in the House Band
//       chunk library (Diane Moore's slot, channel 8, program 200)
//    3. Adds it to the Song Library as a 'house-band' song so it
//       appears in the Song Library tab and can be launched by name
//
//  Note layout contract (must match VWB MPC exactly):
//    Bank A: C3(60)=Kick1  C#3(61)=Kick2  D3(62)=Snare  D#3(63)=Clap
//            E3(64)=HiHat  F3(65)=Snap    F#3(66)=Shaker G3(67)=Tamborine
//            G#3(68)=Conga A3(69)=CongaSlp A#3(70)=Triangle B3(71)=WoodBlk
//    Bank B: C4(72)=Windchimes  C#4(73)=BongoHi  D4(74)=BongoLow
//            D#4(75)=CowBell    E4(76)=HighTam   F4(77)=Timpani
//            F#4(78)=TriClosed  G4(79)=TriOpen
//
//  Depends on: song-library.js, house-band-engine.js, midi-synth.js
// ═══════════════════════════════════════════════════════════════


// ── MIDI File Parser ───────────────────────────────────────────
// Parses a standard MIDI Type 0 or Type 1 file (ArrayBuffer)
// into a flat array of note events, normalized to seconds.

function mpcParseMidiFile(buffer) {
  const view = new DataView(buffer);
  let pos = 0;

  function readUint32() { const v = view.getUint32(pos); pos += 4; return v; }
  function readUint16() { const v = view.getUint16(pos); pos += 2; return v; }
  function readUint8()  { return view.getUint8(pos++); }

  function readVlq() {
    let val = 0;
    let b;
    do { b = readUint8(); val = (val << 7) | (b & 0x7f); } while (b & 0x80);
    return val;
  }

  // Read MThd header
  const headerChunk = readUint32(); // 'MThd'
  if (headerChunk !== 0x4D546864) throw new Error('Not a MIDI file');
  const headerLen  = readUint32(); // always 6
  const format     = readUint16();
  const numTracks  = readUint16();
  const ticksPerBeat = readUint16();

  let tempoMicros = 500000; // default 120 BPM

  const notes = [];

  // Read all tracks
  for (let t = 0; t < numTracks; t++) {
    const trackMagic = readUint32(); // 'MTrk'
    if (trackMagic !== 0x4D54726B) {
      console.warn('[MpcImport] Bad track chunk at track', t);
      break;
    }
    const trackLen = readUint32();
    const trackEnd = pos + trackLen;

    let tick = 0;
    let runningStatus = 0;

    while (pos < trackEnd) {
      const delta = readVlq();
      tick += delta;

      let status = view.getUint8(pos);
      if (status & 0x80) {
        runningStatus = status;
        pos++;
      } else {
        status = runningStatus;
      }

      const cmd = status & 0xf0;
      const ch  = status & 0x0f;

      if (cmd === 0x90) {
        // Note On
        const note = readUint8();
        const vel  = readUint8();
        if (vel > 0) {
          const timeSec = (tick / ticksPerBeat) * (tempoMicros / 1000000);
          notes.push({ tick, timeSec, note, vel, ch });
        }
      } else if (cmd === 0x80) {
        // Note Off
        readUint8(); readUint8(); // consume note + vel
      } else if (cmd === 0xA0 || cmd === 0xB0 || cmd === 0xE0) {
        readUint8(); readUint8();
      } else if (cmd === 0xC0 || cmd === 0xD0) {
        readUint8();
      } else if (status === 0xFF) {
        // Meta event
        const metaType = readUint8();
        const metaLen  = readVlq();
        if (metaType === 0x51 && metaLen === 3) {
          // Tempo
          tempoMicros = (view.getUint8(pos) << 16) |
                        (view.getUint8(pos+1) << 8) |
                         view.getUint8(pos+2);
        }
        pos += metaLen;
      } else if (status === 0xF0 || status === 0xF7) {
        // SysEx
        const sysLen = readVlq();
        pos += sysLen;
      } else {
        // Unknown — skip one byte
        pos++;
      }
    }

    pos = trackEnd; // ensure we're at end of track
  }

  const bpm = Math.round(60000000 / tempoMicros);

  return { notes, bpm, ticksPerBeat, tempoMicros };
}


// ── VWB MPC Note Label Map ─────────────────────────────────────
const MPC_NOTE_LABELS = {
  60: 'Kick 1',       61: 'Kick 2',      62: 'Snare',
  63: 'Clap',         64: 'Hi-Hat',      65: 'Snap',
  66: 'Shaker',       67: 'Tambourine',  68: 'Conga',
  69: 'Conga Slap',   70: 'Triangle',    71: 'Wood Block',
  72: 'Wind Chimes',  73: 'Bongo High',  74: 'Bongo Low',
  75: 'Cow Bell',     76: 'High Tam',    77: 'Timpani',
  78: 'Tri Closed',   79: 'Tri Open'
};


// ── Main Import Function ───────────────────────────────────────
/**
 * Imports a VWB MPC .mid file into VWB as a House Band percussion chunk.
 *
 * @param {ArrayBuffer} midiBuffer - raw bytes of the .mid file
 * @param {Object} meta - { title, key, style, mood, feel, tempo }
 *   title: display name for the Song Library
 *   key:   key this loop was recorded in (e.g. 'C', 'Bb')
 *   style: SL_STYLES value (e.g. 'Medium Groove Gospel')
 *   mood:  SL_MOODS value
 *   feel:  'Straight' or 'Swing'
 *   tempo: override BPM (if omitted, reads from MIDI file)
 * @returns {Object} { success, songId, noteCount, duration, bpm, warnings }
 */
async function mpcImportLoop(midiBuffer, meta) {
  const warnings = [];

  // ── 1. Parse the MIDI file ──
  let parsed;
  try {
    parsed = mpcParseMidiFile(midiBuffer);
  } catch(e) {
    return { success: false, error: 'MIDI parse failed: ' + e.message };
  }

  const { notes, bpm: fileBpm, ticksPerBeat } = parsed;
  const bpm = meta.tempo || fileBpm;

  if (notes.length === 0) {
    return { success: false, error: 'No note events found in MIDI file.' };
  }

  // ── 2. Validate note range ──
  const validNotes = notes.filter(n => n.note >= 48 && n.note <= 67);
  const invalidNotes = notes.filter(n => n.note < 48 || n.note > 67);

  if (invalidNotes.length > 0) {
    warnings.push(
      `${invalidNotes.length} note(s) outside VWB MPC range (48-67) were ignored: ` +
      [...new Set(invalidNotes.map(n => n.note))].join(', ')
    );
  }

  if (validNotes.length === 0) {
    return { success: false, error: 'No notes in valid VWB MPC range (C3-G4, notes 48-67).' };
  }

  // ── 3. Build a percussion chunk in House Band format ──
  // Re-time notes to seconds based on target BPM
  const tempoRatio = fileBpm / bpm;
  const chunkNotes = validNotes.map(n => ({
    time:     n.timeSec * tempoRatio,  // seconds from loop start
    duration: 0.08,                    // percussion = short — 80ms note-off
    midi:     n.note,                  // exact note number, matched by DIANE_PERC_NOTE_MAP
    velocity: n.vel / 127,             // normalized 0-1
    label:    MPC_NOTE_LABELS[n.note] || ('Note ' + n.note)
  }));

  const duration = Math.max(...chunkNotes.map(n => n.time)) + 0.5;

  // ── 4. Build song ID and chunk data ──
  const songId = 'mpc-perc-' + Date.now();
  const title  = meta.title || 'VWB MPC Percussion Loop';
  const key    = meta.key   || 'C';
  const style  = meta.style || 'Medium Groove Gospel';
  const mood   = meta.mood  || 'Standard / Neutral';
  const feel   = meta.feel  || 'Straight';

  // House Band percussion chunk — feeds Diane's channel (ch 8, program 200)
  // This is a single-slot chunk: only the percussion channel
  const percChunk = {
    id:           songId + '-chunk',
    instrument:   'Congas',          // matches HB_CHUNK_INSTRUMENT_TO_SLOT in house-band-engine.js
    slot:         'percussion',
    channel:      8,
    program:      200,
    style,
    originalKey:  key,
    originalTempo: bpm,
    feel,
    notes:        chunkNotes,
    duration,
    source:       'vwb-mpc-import',
    importedAt:   new Date().toISOString(),
    noteCount:    chunkNotes.length,
    padSummary:   _buildPadSummary(chunkNotes)
  };

  // ── 5. Register in House Band library cache ──
  // Injects directly into the loaded library so it's immediately
  // available for hbFindChunk() without reloading from disk.
  if (typeof _hbLibrary !== 'undefined' && _hbLibrary !== null) {
    _hbLibrary['Congas'] = _hbLibrary['Congas'] || {};
    _hbLibrary['Congas'][style] = _hbLibrary['Congas'][style] || {};
    // Use title as chord label so it's findable by name
    _hbLibrary['Congas'][style][title] = [percChunk];
    console.log('[MpcImport] Chunk registered in HB library:', title);
  } else {
    warnings.push('House Band library not loaded — chunk will not be available for real-time playback until VWB restarts.');
  }

  // ── 6. Persist chunk via IPC ──
  if (window.vwb && typeof window.vwb.saveJson === 'function') {
    try {
      await window.vwb.saveJson('mpcPercChunk_' + songId, percChunk);
    } catch(e) {
      warnings.push('Chunk persistence failed: ' + e.message);
    }
  }

  // ── 7. Add to Song Library ──
  const songData = {
    id:     songId,
    title,
    engine: 'house-band',
    key,
    style,
    mood,
    feel,
    tempo:  bpm,
    source: 'user-import',
    tags:   ['percussion', 'mpc', 'loop'],
    // Store chunk inline so hbPlayPercChunk() can find it by song ID
    percChunk,
    // Chart is minimal — one segment covering the whole loop
    chart: {
      songTitle:      title,
      key,
      tempo:          bpm,
      beatsPerMeasure: 4,
      segments: [{
        section:      'Verse',
        chordSymbol:  'I',
        style,
        measureStart: 1,
        beatStart:    1,
        measureEnd:   Math.ceil(duration / (60/bpm) / 4) + 1,
        beatEnd:      1
      }]
    }
  };

  let addedToLibrary = false;
  if (typeof songLibraryAddSong === 'function') {
    addedToLibrary = await songLibraryAddSong(songData);
  } else {
    warnings.push('songLibraryAddSong() not available — song not added to Song Library tab.');
  }

  console.log('[MpcImport] Import complete:', {
    title, songId, noteCount: chunkNotes.length,
    bpm, duration: duration.toFixed(2) + 's',
    addedToLibrary, warnings
  });

  return {
    success: true,
    songId,
    noteCount: chunkNotes.length,
    duration,
    bpm,
    warnings,
    addedToLibrary
  };
}


// ── Direct Percussion Chunk Playback ──────────────────────────
// Plays a percussion chunk directly through Diane's channel
// without needing a full song chart. Used for preview and
// for the Loops & Pads page.

let _mpcPercPlaybackTimer = null;
let _mpcPercPlaybackActive = false;

async function mpcPlayPercChunk(chunk, opts = {}) {
  mpcStopPercPlayback();
  if (!chunk || !chunk.notes || chunk.notes.length === 0) return;

  const bpm        = opts.bpm      || chunk.originalTempo || 90;
  const loop       = opts.loop     !== false; // default true
  const volumePct  = opts.volume   || 100;

  // Ensure Diane's sampler is loaded
  if (typeof synthEnsureProgram === 'function') {
    await synthEnsureProgram(8, 200);
  }

  const duration = chunk.duration || (Math.max(...chunk.notes.map(n => n.time)) + 0.5);
  _mpcPercPlaybackActive = true;

  function scheduleLoop(startOffset) {
    if (!_mpcPercPlaybackActive) return;

    chunk.notes.forEach(note => {
      const delay = (note.time + startOffset) * 1000; // ms from now
      setTimeout(() => {
        if (!_mpcPercPlaybackActive) return;
        // Route directly to Diane's percussion sampler
        // bypassing channel 8 routing which has Tone.js conflicts
        if (typeof _dianePercNoteOn === 'function' &&
            typeof _dianePercBuffers !== 'undefined' &&
            Object.keys(_dianePercBuffers).length > 0) {
          _dianePercNoteOn(note.midi, Math.round(note.velocity * 127), volumePct);
        } else if (typeof synthNoteOn === 'function') {
          // Fallback — try channel 8 if direct route not available
          synthNoteOn(8, note.midi, Math.round(note.velocity * 127), 200, undefined);
        }
      }, delay);
    });

    if (loop) {
      _mpcPercPlaybackTimer = setTimeout(() => {
        scheduleLoop(0);
      }, (duration + startOffset) * 1000);
    }
  }

  scheduleLoop(0);

  if (typeof showNotification === 'function') {
    showNotification('🥁 Playing: ' + (chunk.id || 'Percussion Loop'));
  }
}

function mpcStopPercPlayback() {
  _mpcPercPlaybackActive = false;
  clearTimeout(_mpcPercPlaybackTimer);
  _mpcPercPlaybackTimer = null;
}


// ── Pad Usage Summary ──────────────────────────────────────────
function _buildPadSummary(notes) {
  const counts = {};
  notes.forEach(n => {
    const label = MPC_NOTE_LABELS[n.midi] || ('Note ' + n.midi);
    counts[label] = (counts[label] || 0) + 1;
  });
  return Object.entries(counts)
    .sort((a,b) => b[1]-a[1])
    .map(([label, count]) => label + ' ×' + count)
    .join(', ');
}


// ── File Picker UI Helper ──────────────────────────────────────
/**
 * Opens a file dialog, reads the selected .mid file, and triggers
 * the import flow with a metadata form. Call this from the UI layer.
 *
 * @param {Object} defaultMeta - pre-filled metadata { title, key, style, mood, feel, tempo }
 * @returns {Promise<Object>} import result
 */
async function mpcImportFromFilePicker(defaultMeta = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mid,.midi';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) { resolve({ success: false, error: 'No file selected' }); return; }

      const buffer = await file.arrayBuffer();
      const title  = defaultMeta.title || file.name.replace(/\.(mid|midi)$/i, '').replace(/_/g,' ');
      const meta   = { ...defaultMeta, title };
      const result = await mpcImportLoop(buffer, meta);
      resolve(result);
    };
    input.click();
  });
}


// ── Load Persisted Chunks on Startup ──────────────────────────
/**
 * On VWB startup, reloads all previously imported MPC percussion
 * chunks back into the House Band library cache. Call this from
 * the main init sequence after hbLoadLibrary().
 */
async function mpcRestorePercChunks() {
  if (!window.vwb || typeof window.vwb.listJsonKeys !== 'function') return;

  try {
    const keys = await window.vwb.listJsonKeys();
    const chunkKeys = (keys || []).filter(k => k.startsWith('mpcPercChunk_'));

    for (const key of chunkKeys) {
      try {
        const res = await window.vwb.loadJson(key);
        if (!res || !res.success || !res.data) continue;
        const chunk = res.data;

        // Re-inject into library cache
        if (typeof _hbLibrary !== 'undefined' && _hbLibrary !== null) {
          const style = chunk.style || 'Medium Groove Gospel';
          const title = chunk.id    || key;
          _hbLibrary['Congas'] = _hbLibrary['Congas'] || {};
          _hbLibrary['Congas'][style] = _hbLibrary['Congas'][style] || {};
          _hbLibrary['Congas'][style][title] = [chunk];
        }
        console.log('[MpcImport] Restored chunk:', key);
      } catch(e) {
        console.warn('[MpcImport] Failed to restore chunk:', key, e.message);
      }
    }
  } catch(e) {
    console.warn('[MpcImport] Restore failed:', e.message);
  }
}
