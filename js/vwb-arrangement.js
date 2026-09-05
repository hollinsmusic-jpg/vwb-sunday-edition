// ═══════════════════════════════════════════════════════════════
//  VWB Arrangement Loader  (.vwba)
//
//  Adds a second way to get a performance out of VWB, alongside the
//  chord-chart + chunk-library Flex Engine:
//
//    Chart Mode        — .vwbs chord chart, House Band improvises
//                         from the chunk library (unchanged)
//    Arrangement Mode   — .vwba full multi-track MIDI performance,
//                         played back verbatim through the same
//                         House Band instrument sounds (this file)
//
//  This module does NOT modify chart-player.js, house-band-engine.js,
//  or the chunk system in any way. It only produces a playlist
//  "entry" in the exact shape addMidiFileFromBuffer() already builds
//  in midi-player.js, so the existing playback engine, mixer, and
//  section-jump code handle arrangements with zero changes.
//
//  Load order requirement: this file must load AFTER midi-player.js
//  (it calls parseMidiFile, midiPlaylist, selectMidiFile, etc. as
//  globals) and AFTER band-registry.js if present.
// ═══════════════════════════════════════════════════════════════

const VWBA_FORMAT = 'vwb-arrangement';
const VWBA_SUPPORTED_VERSIONS = [1];

// ── Fixed track order ──────────────────────────────────────────
// Track position (not the channel byte in the .mid, not note-range
// guessing) is the ONLY thing that decides which House Band sound
// a track triggers. This is what makes the format tamper-proof
// against "wrong instrument" problems: if the file doesn't have
// exactly these 7 tracks in this order, it's rejected before a
// single note plays.
//
// Order and channel/program numbers match the House Band Training
// Data Standard v1.1 (Section 6.3) and HB_SPLIT_SLOTS in
// midi-player.js, so no other code needs to change.
const VWBA_TRACK_ORDER = [
  { instrument: 'piano',      slot: 'keys',       ch: 0, prog: 0,   label: 'Keys - Julian Cross' },
  { instrument: 'organ',      slot: 'organ',      ch: 2, prog: 16,  label: 'Organ - Paul Simmons' },
  { instrument: 'auxStrings', slot: 'aux',        ch: 4, prog: 48,  label: 'Aux - Larry Evans' },
  { instrument: 'guitar',     slot: 'guitar',     ch: 3, prog: 24,  label: 'Guitar - Sanchez Rivera' },
  { instrument: 'bass',       slot: 'bass',       ch: 1, prog: 33,  label: 'Bass - Terry Washington' },
  { instrument: 'percussion', slot: 'percussion', ch: 8, prog: 200, label: 'Percussion - Diane Moore' },
  { instrument: 'drums',      slot: 'drums',      ch: 9, prog: 128, label: 'Drums - Jason Washington' },
];

// ── Helpers ─────────────────────────────────────────────────────

function _vwbaBase64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function _vwbaParseTimeSig(ts) {
  if (!ts) return 4;
  if (typeof ts === 'number') return ts;
  const n = parseInt(String(ts).split('/')[0], 10);
  return isNaN(n) ? 4 : n;
}

// ── Validation ──────────────────────────────────────────────────
// This is the gatekeeper. A renamed .mid, a file from a future
// format version, or a file with the wrong number/order of tracks
// all get rejected here with a clear reason — before any note is
// ever routed to a sound.
function validateVwbaFile(vwba) {
  if (!vwba || typeof vwba !== 'object') {
    return { ok: false, error: 'File is not valid VWB Arrangement data.' };
  }
  if (vwba.format !== VWBA_FORMAT) {
    return { ok: false, error: 'This is not a VWB Arrangement file. VWB will not load a plain .mid here — convert it first with the vwba-converter tool so the track structure can be verified.' };
  }
  if (!VWBA_SUPPORTED_VERSIONS.includes(vwba.formatVersion)) {
    return { ok: false, error: 'This arrangement was built for a VWB Arrangement format version VWB doesn\'t recognize (v' + vwba.formatVersion + ').' };
  }
  if (!vwba.midiData || typeof vwba.midiData !== 'string') {
    return { ok: false, error: 'Arrangement file is missing its MIDI data.' };
  }
  if (!Array.isArray(vwba.trackMap) || vwba.trackMap.length !== 7) {
    return { ok: false, error: 'Arrangement must define exactly 7 tracks (Piano, Organ, Aux Strings, Guitar, Bass, Percussion, Drums). Found ' + (Array.isArray(vwba.trackMap) ? vwba.trackMap.length : 0) + '.' };
  }
  const expected = VWBA_TRACK_ORDER.map(t => t.instrument);
  const got = vwba.trackMap.map(t => t && t.instrument);
  for (let i = 0; i < expected.length; i++) {
    if (got[i] !== expected[i]) {
      return { ok: false, error: 'Track ' + (i + 1) + ' should be "' + expected[i] + '" but the file has "' + (got[i] || 'missing') + '". Track order is fixed and cannot be changed.' };
    }
  }
  return { ok: true };
}

// ── Deterministic channel remap ────────────────────────────────
// Ignores whatever MIDI channel byte the DAW happened to export on
// each track. The track's POSITION in the file is the only source
// of truth for which House Band sound it triggers.
function _vwbaRemapEvents(rawEvents) {
  return rawEvents.map(function (ev) {
    const trkIdx = ev.trk !== undefined ? ev.trk : 0;
    const slotDef = VWBA_TRACK_ORDER[trkIdx];
    if (!slotDef) return ev; // stray track beyond the 7 — left alone, never routed
    const ne = Object.assign({}, ev);
    ne.ch = slotDef.ch;
    return ne;
  });
}

// ── Core parse ──────────────────────────────────────────────────
// Produces the same "entry" shape addMidiFileFromBuffer() builds in
// midi-player.js, so it drops into midiPlaylist and every existing
// piece of playback/mixer/section-jump code just works.
function parseVwbaArrangement(vwba) {
  const check = validateVwbaFile(vwba);
  if (!check.ok) throw new Error(check.error);

  const ab = _vwbaBase64ToArrayBuffer(vwba.midiData);
  const result = parseMidiFile(ab); // existing parser, unmodified — from midi-player.js

  if (result.trackCount !== 7) {
    throw new Error('Embedded MIDI has ' + result.trackCount + ' tracks — VWB Arrangements require exactly 7 (Piano, Organ, Aux Strings, Guitar, Bass, Percussion, Drums), recorded in that order. Re-export from Studio One using the standard House Band track order and re-run the converter.');
  }

  const events = _vwbaRemapEvents(result.events);

  const channelPrograms = {};
  const chHBSlot = {};
  VWBA_TRACK_ORDER.forEach(function (t) {
    channelPrograms[t.ch] = t.prog;
    chHBSlot[t.ch] = t.slot;
  });

  const meta = vwba.meta || {};
  const maxTime = events.reduce(function (m, e) { return e.time > m ? e.time : m; }, 0);

  return {
    events: events,
    duration: maxTime > 0 ? maxTime + 2 : result.duration,
    noteCount: result.noteCount,
    trackCount: result.trackCount,
    isMerged: false,
    isArrangement: true,      // informational flag only — playback code doesn't need to branch on this
    detectedBpm: meta.tempo || result.detectedBpm,
    detectedKey: meta.key || result.detectedKey,
    // Bar-based, matching song.secs' shape ({type,label,sb,eb}) — this
    // is what VWB's actual section editor and jump system (queueSection,
    // renderSections, jumpMidiSectionByBar) expect. Converting to
    // seconds happens live, per-engine, at jump time — not here.
    sections: Array.isArray(vwba.sections) ? vwba.sections.map(function (s) {
      return {
        type: s.type || 'Verse',
        label: s.label || '',
        sb: s.startBar,
        eb: s.endBar != null ? s.endBar : s.startBar
      };
    }) : [],
    transpose: 0,
    tempoPct: 100,
    bpm: meta.tempo || result.detectedBpm || 120,
    timeSig: _vwbaParseTimeSig(meta.timeSig),
    chVolumes: {},
    chPrograms: channelPrograms,
    chOctave: {},
    chHBSlot: chHBSlot,
    arrangementMeta: {
      title: meta.title || '',
      style: meta.style || '',
      feel: meta.feel || '',
      key: meta.key || '',
      notes: meta.notes || '',
      timeSig: meta.timeSig || '' // original string (e.g. "6/8"), for display — the numeric `timeSig` above is beats-per-bar only, used for bar math
    }
  };
}

// ── Entry point for the UI ─────────────────────────────────────
// Call this when a .vwba file is picked. Mirrors what
// addMidiFileFromBuffer() does for regular MIDI files.
async function addVwbaArrangementFromText(jsonText, fileName, storedPath) {
  let vwba;
  try {
    vwba = JSON.parse(jsonText);
  } catch (e) {
    alert('Could not read arrangement file: ' + fileName + '\nFile is not valid VWB Arrangement JSON.');
    return;
  }

  let entry;
  try {
    entry = parseVwbaArrangement(vwba);
  } catch (e) {
    console.error('[VWB Arrangement] load error:', e);
    alert('Could not load arrangement: ' + fileName + '\n' + e.message);
    return;
  }

  entry.fileName = entry.arrangementMeta.title || fileName;
  entry.storedPath = storedPath || '';

  if (midiPlaylist.length >= 8) { alert('Maximum 8 files reached.'); return; }
  midiPlaylist.push(entry);
  _midiInstrumentsReady = false;
  if (midiActiveIdx < 0) selectMidiFile(midiPlaylist.length - 1);
  if (typeof midiAccess !== 'undefined' && !midiAccess && typeof initMidi === 'function') await initMidi();
  if (typeof renderMidiPlaylist === 'function') renderMidiPlaylist();
  if (typeof updatePerfMidiUI === 'function') updatePerfMidiUI();

  if (typeof showNotification === 'function') {
    showNotification('Arrangement loaded: ' + entry.fileName + ' — all 7 tracks routed to House Band sounds');
  } else {
    console.log('[VWB Arrangement] Loaded:', entry.fileName, '(' + entry.noteCount + ' notes, ' + entry.trackCount + ' tracks)');
  }
}
