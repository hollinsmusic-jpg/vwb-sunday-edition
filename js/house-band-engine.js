// ═══════════════════════════════════════════════════════════════
//  VWB — House Band Engine
//  js/house-band-engine.js
//
//  Defines the channel map, program map, and playback engine
//  for the VWB House Band. This is the missing glue between
//  the MIDI player, the synth, and the band UI.
//
//  Depends on: midi-player.js, midi-synth.js, band-ui.js,
//              band-registry.js, state.js
// ═══════════════════════════════════════════════════════════════

// ── Channel Map ────────────────────────────────────────────────
//  Maps each House Band slot to a VWB internal MIDI channel.
//  These are zero-based (0-15). Channel 9 = GM drums.
//  Studio One channel numbers = VWB channel + 1  (except drums = 10).
//
//  STUDIO ONE SETUP:
//    Track 1  Jason  (Drums)      → Studio One Channel 10
//    Track 2  Diane  (Percussion) → Studio One Channel 9
//    Track 3  Terry  (Bass)       → Studio One Channel 2
//    Track 4  Julian (Keys)       → Studio One Channel 1
//    Track 5  Paul   (Organ)      → Studio One Channel 3
//    Track 6  Sanchez(Guitar)     → Studio One Channel 4
//    Track 7  Larry  (Aux)        → Studio One Channel 5

const HB_SLOT_TO_CHANNEL = {
  drums:      9,   // Jason Washington  — GM drum channel (Studio One Ch 10)
  percussion: 8,   // Diane Moore       — custom perc kit (Studio One Ch 9)
  bass:       1,   // Terry Washington  — electric bass   (Studio One Ch 2)
  keys:       0,   // Julian Cross      — piano/keys      (Studio One Ch 1)
  organ:      2,   // Paul Simmons      — drawbar organ   (Studio One Ch 3)
  guitar:     3,   // Sanchez Rivera    — acoustic guitar (Studio One Ch 4)
  aux:        4,   // Larry Evans       — strings/pads    (Studio One Ch 5)
};

// ── Program Map ────────────────────────────────────────────────
//  Maps each slot to the correct GM program number (or VWB custom).
//  These match exactly what midi-synth.js expects.

const HB_SLOT_TO_PROGRAM = {
  drums:      128,  // Jason  — GM Drums (special program)
  percussion: 200,  // Diane  — VWB Custom Percussion Kit
  bass:       33,   // Terry  — Electric Bass (finger)
  keys:       0,    // Julian — Acoustic Grand Piano
  organ:      16,   // Paul   — Drawbar Organ
  guitar:     24,   // Sanchez— Acoustic Guitar (nylon)
  aux:        48,   // Larry  — Strings
};

// ── Octave Offsets ─────────────────────────────────────────────
//  Applied at playback time to correct for samples recorded
//  in a different octave than the MIDI data expects.

const HB_OCTAVE_OFFSETS = {
  drums:      0,
  percussion: 0,   // Diane's note map handles all pitch resolution
  bass:       -1,  // Terry's samples sit one octave high
  keys:       0,
  organ:      1,   // Paul's organ samples sit one octave low
  guitar:     0,
  aux:        0,
};

// ── Musician Roster ────────────────────────────────────────────
//  The seven House Band musicians. bandGetActive() returns the
//  active musician object for a given slot (default or artist pack).

const HB_MUSICIANS = {
  drums:      { id: 'hb-drums-jason',    name: 'Jason Washington', instrument: 'Drums',       photo: 'band-assets/jason-washington.png' },
  percussion: { id: 'hb-perc-diane',     name: 'Diane Moore',      instrument: 'Percussion',  photo: 'band-assets/diane-moore.png'      },
  bass:       { id: 'hb-bass-terry',     name: 'Terry Washington', instrument: 'Bass Guitar', photo: 'band-assets/terry-washington.png'  },
  keys:       { id: 'hb-keys-julian',    name: 'Julian Cross',     instrument: 'Keys',        photo: 'band-assets/julian-cross.png'      },
  organ:      { id: 'hb-organ-paul',     name: 'Paul Simmons',     instrument: 'Organ',       photo: 'band-assets/paul-simmons.png'      },
  guitar:     { id: 'hb-guitar-sanchez', name: 'Sanchez Rivera',   instrument: 'Guitar',      photo: 'band-assets/sanchez-rivera.png'    },
  aux:        { id: 'hb-aux-larry',      name: 'Larry Evans',      instrument: 'Aux Keys',    photo: 'band-assets/larry-evans.png'       },
};

// ── Band Registry (slot assignments) ──────────────────────────
//  Authoritative source: band-registry.js (loads before this file).
//  bandGetActive(), bandAssign(), bandResetSlot(), bandResetAll(),
//  bandGetInstalledPacks() are all defined there.
//  Do NOT redefine them here — band-registry.js owns these.

// ── Chunk Library ──────────────────────────────────────────────
//  In-memory index of all loaded MIDI chunks from the
//  house_band_library_full/ folder. Keyed by chunk ID.

let _hbChunkLibrary  = {};   // { chunkId → chunkData }
let _hbLibraryLoaded = false;
let _hbLibraryLoading = false;

async function hbLoadChunkLibrary() {
  if (_hbLibraryLoaded || _hbLibraryLoading) return _hbChunkLibrary;
  _hbLibraryLoading = true;

  try {
    const result = await window.vwb.loadHouseBandLibrary();
    // IPC returns a flat array of chunk objects directly
    const chunks = Array.isArray(result) ? result
                 : (result && Array.isArray(result.chunks)) ? result.chunks
                 : null;
    if (chunks) {
      chunks.forEach(chunk => {
        if (chunk && chunk.id) _hbChunkLibrary[chunk.id] = chunk;
      });
      _hbLibraryLoaded = true;
      console.log('[HouseBand] Chunk library loaded:', Object.keys(_hbChunkLibrary).length, 'chunks');
    } else {
      console.warn('[HouseBand] loadHouseBandLibrary returned unexpected format:', typeof result);
    }
  } catch(e) {
    console.warn('[HouseBand] Could not load chunk library:', e.message);
  }

  _hbLibraryLoading = false;
  return _hbChunkLibrary;
}

function hbGetChunk(chunkId) {
  return _hbChunkLibrary[chunkId] || null;
}

function hbGetChunksForStyle(style, slot) {
  return Object.values(_hbChunkLibrary).filter(c =>
    (!style || c.style === style) &&
    (!slot  || c.slot  === slot)
  );
}

// ── Progression Chunk Matching (added Aug 23 2026) ─────────────
//  NEW, ADDITIVE, NOT YET WIRED INTO PLAYBACK.
//  Nothing above this section was changed. Nothing currently
//  calls hbFindBestChunk() — it is dormant until Kenneth records
//  real progression chunks AND a future step wires it into the
//  chart-player.js / House Band playback loop.
//
//  PURPOSE:
//  Longest-match-first lookup. Given the upcoming chord sequence
//  from the chart, find the longest recorded progression chunk
//  (in the right style/feel/slot) that matches the start of that
//  sequence. If no progression chunk matches, fall back to the
//  existing single-chord chunk lookup — so behavior is IDENTICAL
//  to today's system until progression chunks actually exist.
//
//  NEW OPTIONAL CHUNK FIELD: `sequence`
//  A progression chunk adds one new field on top of the existing
//  seven-label schema: `sequence`, an array describing each chord
//  in the progression in order. Each entry is a string combining
//  scale degree + quality, e.g.:
//    "3m", "6m", "2m", "5dom7", "1maj"   →  a iii-vi-ii-V-I in a
//                                            minor-ii-V gospel run
//  Existing single-chord chunks do NOT have this field and are
//  completely unaffected — hbFindBestChunk() only inspects chunks
//  that HAVE `sequence` when looking for a progression match, and
//  falls back to the untouched hbGetChunk()-style lookup otherwise.

// Compares two chord-sequence entries (both are "degree+quality"
// strings, e.g. "5dom7") for an exact match.
function hbChordsMatch(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}

// Returns true if `chunk` is a progression chunk (has a usable
// `sequence` array) rather than a single-chord chunk.
function hbIsProgressionChunk(chunk) {
  return !!chunk && Array.isArray(chunk.sequence) && chunk.sequence.length > 1;
}

// Finds every progression chunk in the library matching the given
// style / feel / slot, sorted longest-sequence-first. Pure read,
// no mutation, safe to call anytime.
function hbGetProgressionChunks(style, feel, slot) {
  return Object.values(_hbChunkLibrary)
    .filter(c =>
      hbIsProgressionChunk(c) &&
      (!style || c.style === style) &&
      (!feel  || c.feel  === feel)  &&
      (!slot  || c.slot  === slot)
    )
    .sort((a, b) => b.sequence.length - a.sequence.length);
}

// Core lookup: given the upcoming chord sequence (array of
// "degree+quality" strings, starting at the chart's current
// position), plus style/feel/slot, returns the best available
// chunk to play next:
//
//   { chunk, matchLength }
//
// matchLength tells the caller how many chart chords this chunk
// covers, so playback can advance the chart position correctly
// (1 for a single-chord chunk, N for an N-chord progression chunk).
// Returns null only if NOTHING matches at all — same as today's
// behavior when a required single chunk is simply missing.
function hbFindBestChunk(chordSequence, style, feel, slot) {
  if (!Array.isArray(chordSequence) || chordSequence.length === 0) return null;

  // 1. Try progression chunks, longest first.
  const candidates = hbGetProgressionChunks(style, feel, slot);
  for (const chunk of candidates) {
    const len = chunk.sequence.length;
    if (len > chordSequence.length) continue; // can't fit what's left in the chart
    let matches = true;
    for (let i = 0; i < len; i++) {
      if (!hbChordsMatch(chunk.sequence[i], chordSequence[i])) { matches = false; break; }
    }
    if (matches) return { chunk, matchLength: len };
  }

  // 2. Fall back to existing single-chord lookup behavior.
  //    (Mirrors hbGetChunksForStyle's style/slot filtering, plus
  //    feel and an exact match on the first upcoming chord via
  //    each chunk's own degree/quality fields, if present.)
  const singleChunks = Object.values(_hbChunkLibrary).filter(c =>
    !hbIsProgressionChunk(c) &&
    (!style || c.style === style) &&
    (!feel  || c.feel  === feel)  &&
    (!slot  || c.slot  === slot)
  );
  const firstChord = chordSequence[0];
  const single = singleChunks.find(c => {
    // Single chunks may describe their chord via a `chord` field
    // ("degree+quality", same format as `sequence` entries) or,
    // for older chunks recorded before this convention, may not
    // specify a chord at all (style/feel-only vamp chunks) — those
    // still match as a generic fallback.
    if (typeof c.chord === 'string') return hbChordsMatch(c.chord, firstChord);
    return true;
  }) || singleChunks[0] || null;

  if (!single) return null;
  return { chunk: single, matchLength: 1 };
}

// ── Channel Setup ──────────────────────────────────────────────
//  Applies the correct program to each channel so the synth
//  knows which instrument to use for each musician.
//  Call this after loading a MIDI file or starting the House Band.

function hbApplyChannelPrograms() {
  if (typeof synthSetProgram !== 'function') return;
  Object.entries(HB_SLOT_TO_CHANNEL).forEach(([slot, ch]) => {
    const prog = HB_SLOT_TO_PROGRAM[slot];
    synthSetProgram(ch, prog);
    if (typeof synthSetVolume === 'function') {
      synthSetVolume(ch, 100);
    }
  });
  console.log('[HouseBand] Channel programs applied.');
}

// ── MIDI File Load Hook ────────────────────────────────────────
//  Called automatically by midi-player.js after a MIDI file
//  is parsed and loaded. Applies House Band channel programs
//  so the correct instruments sound immediately on play.

function hbOnMidiFileLoaded() {
  hbApplyChannelPrograms();
}

// ── Engine Init ────────────────────────────────────────────────

function hbEngineInit() {
  // Load chunk library in background on startup
  if (window.vwb && typeof window.vwb.loadHouseBandLibrary === 'function') {
    hbLoadChunkLibrary().then(() => {
      console.log('[HouseBand] Engine ready —',
        Object.keys(_hbChunkLibrary).length, 'chunks in library');
    });
  } else {
    console.log('[HouseBand] Engine ready — no chunk library IPC (samples-only mode)');
  }

  // Apply initial channel programs so MIDI player is ready
  setTimeout(() => hbApplyChannelPrograms(), 500);
}

// Auto-init when script loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hbEngineInit);
} else {
  setTimeout(hbEngineInit, 100);
}

console.log('[HouseBand] house-band-engine.js loaded — channel map active');
