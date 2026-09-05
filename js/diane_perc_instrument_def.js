// ═══════════════════════════════════════════════════════════════
//  VWB — Diane Moore Percussion Kit
//  Instrument definition for midi-synth.js
//
//  This block defines Diane's full percussion kit as a single
//  VWB instrument (program 200 — custom HMPI percussion).
//  All six instruments are mapped to specific MIDI notes on
//  channel 8 (the percussion slot in HB_SLOT_TO_CHANNEL).
//
//  INSTALLATION:
//  1. Copy the hmpi_diane_perc/ sample folder into your VWB
//     app/ directory alongside hmpi_drums/, hmpi_organ/, etc.
//  2. Add the VWB_PROG_MAP entry below into the VWB_PROG_MAP
//     object in midi-synth.js.
//  3. Add the DIANE_PERC_NOTE_MAP below into midi-synth.js
//     and wire it into synthNoteOn() for channel 8.
//  4. In house-band-engine.js, update HB_SLOT_TO_PROGRAM:
//       percussion: 200,  // Diane Moore Percussion Kit
//
//  MIDI NOTE MAP (channel 8):
//  ┌──────────────────────────────────────────────────────────┐
//  │  MIDI Note │ Name   │ Instrument     │ File             │
//  ├────────────┼────────┼────────────────┼──────────────────┤
//  │     60     │  C4    │ Conga High     │ conga_hi.wav     │
//  │     62     │  D4    │ Conga Low      │ conga_lo.wav     │
//  │     64     │  E4    │ Tambourine     │ tambourine.wav   │
//  │     65     │  F4    │ Egg Shaker     │ shaker.wav       │
//  │     67     │  G4    │ Wood Block     │ woodblock.wav    │
//  │     69     │  A4    │ Wind Chimes    │ windchimes.wav   │
//  └──────────────────────────────────────────────────────────┘
//
//  Kenneth's Studio One recording note:
//  When recording Diane's MIDI track, use these exact note
//  numbers. In Studio One, middle C = C3 (MIDI note 60),
//  so the mapping in your DAW view will be:
//    C3  = Conga High
//    D3  = Conga Low
//    E3  = Tambourine
//    F3  = Egg Shaker
//    G3  = Wood Block
//    A3  = Wind Chimes
// ═══════════════════════════════════════════════════════════════


// ── 1. Add this entry to VWB_PROG_MAP in midi-synth.js ────────
//
//  200: {
//    name:         'Diane Moore Percussion',
//    folder:       'hmpi_diane_perc',
//    isDrum:       true,
//    isPercKit:    true,   // new flag — uses note map instead of chromatic
//    defaultOctave: 0,
//    noteMap:       DIANE_PERC_NOTE_MAP,  // defined below
//  },


// ── 2. Add this note map to midi-synth.js ─────────────────────
//  Place near the top of the file with other constants.

const DIANE_PERC_NOTE_MAP = {
  60: { file: 'conga_hi',   label: 'Conga High'   },
  62: { file: 'conga_lo',   label: 'Conga Low'    },
  64: { file: 'tambourine', label: 'Tambourine'   },
  65: { file: 'shaker',     label: 'Egg Shaker'   },
  67: { file: 'woodblock',  label: 'Wood Block'   },
  69: { file: 'windchimes', label: 'Wind Chimes'  },
};

// Tolerance: notes within ±1 semitone of a mapped note
// will snap to the nearest mapped note. This makes Diane's
// MIDI recordings more forgiving if a note lands slightly off.
const DIANE_PERC_TOLERANCE = 1;

function dianePercResolveNote(midiNote) {
  if (DIANE_PERC_NOTE_MAP[midiNote]) return midiNote;
  // Check ±1 tolerance
  for (const mapped of Object.keys(DIANE_PERC_NOTE_MAP).map(Number)) {
    if (Math.abs(midiNote - mapped) <= DIANE_PERC_TOLERANCE) return mapped;
  }
  return null; // no match — silent
}


// ── 3. Loading logic for midi-synth.js ────────────────────────
//  This replaces the chromatic note loading for percussion kits.
//  In synthNoteOn(), when channel === 8 and program === 200,
//  call dianePercNoteOn() instead of the standard sampler path.

// Diane's per-note AudioBuffers — loaded once on first use
const _dianePercBuffers = {};
let   _dianePercLoaded  = false;
let   _dianePercLoading = false;

async function dianePercLoad(audioContext) {
  if (_dianePercLoaded || _dianePercLoading) return;
  _dianePercLoading = true;

  const folder = 'hmpi_diane_perc';
  const notes  = Object.values(DIANE_PERC_NOTE_MAP);

  await Promise.all(notes.map(async ({ file }) => {
    try {
      // Use VWB's existing IPC sample reader (same as drum samples)
      const bytes = await window.vwb.readSampleFile(folder, file);
      if (!bytes) { console.warn('[DianePerc] Sample not found:', file); return; }
      const buffer = await audioContext.decodeAudioData(bytes.buffer.slice(0));
      _dianePercBuffers[file] = buffer;
      console.log('[DianePerc] Loaded:', file, `(${(buffer.duration * 1000).toFixed(0)}ms)`);
    } catch(e) {
      console.warn('[DianePerc] Failed to load:', file, e.message);
    }
  }));

  _dianePercLoaded  = true;
  _dianePercLoading = false;
  console.log('[DianePerc] Kit ready —',
    Object.keys(_dianePercBuffers).length + '/' + notes.length + ' samples loaded');
}

function dianePercNoteOn(audioContext, masterGain, midiNote, velocity, reverbBus) {
  const resolvedNote = dianePercResolveNote(midiNote);
  if (resolvedNote === null) return;

  const entry = DIANE_PERC_NOTE_MAP[resolvedNote];
  if (!entry) return;

  const buffer = _dianePercBuffers[entry.file];
  if (!buffer) {
    console.warn('[DianePerc] Buffer not loaded for:', entry.file);
    return;
  }

  const source = audioContext.createBufferSource();
  source.buffer = buffer;

  // Velocity gain (0-127 → 0-1, with a gentle curve)
  const gainNode = audioContext.createGain();
  const velGain  = Math.pow(velocity / 127, 0.85); // slight curve for more natural feel
  gainNode.gain.value = velGain;

  source.connect(gainNode);
  gainNode.connect(masterGain);

  // Send wind chimes and tambourine through reverb bus if available
  const usesReverb = entry.file === 'windchimes' || entry.file === 'tambourine';
  if (usesReverb && reverbBus) {
    const reverbSend = audioContext.createGain();
    reverbSend.gain.value = entry.file === 'windchimes' ? 0.45 : 0.25;
    source.connect(reverbSend);
    reverbSend.connect(reverbBus);
  }

  source.start();
}


// ── 4. house-band-engine.js update ────────────────────────────
//
//  In HB_SLOT_TO_PROGRAM, change:
//    percussion: 128,   // was routed through drum sampler
//  to:
//    percussion: 200,   // Diane Moore Percussion Kit
//
//  In HB_OCTAVE_OFFSETS, percussion stays at 0 — the note
//  map handles all note resolution, no octave shifting needed.


// ── 5. VWB_INSTRUMENTS entry for the mixer display ────────────
//
//  Add this to VWB_INSTRUMENTS in midi-synth.js so the mixer
//  shows the correct name when channel 8 is active:
//
//  200: { name: 'Diane Moore Percussion', isDrum: true, isPercKit: true },
