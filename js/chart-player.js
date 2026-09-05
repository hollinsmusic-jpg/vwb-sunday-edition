// ═══════════════════════════════════════════════════════════════
//  VWB — Chart Player Engine   (js/chart-player.js)
//
//  Reads a .vwbs song chart file and drives the House Band
//  to perform it live. Handles:
//    - Chord parsing & transposition (all 19 qualities + slash chords)
//    - Section jumping (on next downbeat)
//    - Section looping (loop on/off)
//    - Live tempo & key control
//    - Graceful handling of missing chunks
//
//  Depends on: house-band-engine.js, midi-player.js, band-ui.js
// ═══════════════════════════════════════════════════════════════

// ── Chord Parser ───────────────────────────────────────────────
//  Parses chord symbols like "Ebmin7", "Ab7/C", "Dbmaj/Ab"
//  Returns { root, quality, bassNote } where bassNote may be null

const CP_ROOTS = ['Db','Eb','Gb','Ab','Bb','C#','F#','C','D','E','F','G','A','B'];

const CP_ROOT_TO_SEMITONE = {
  'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,
  'Gb':6,'F#':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11
};

const CP_QUALITY_MAP = {
  // Major — sorted longest first for greedy matching
  'maj7#5':  'maj7#5',
  'maj7':    'maj7',
  'maj':     'maj',
  '':        'maj',           // bare root = major triad
  // Minor (Kenneth uses "min" prefix)
  'min7b5':  'min7b5',
  'min11':   'min11',
  'min9':    'min9',
  'min7':    'min7',
  'min6':    'min6',
  'min':     'min',
  // Dominant
  '13b5':    'dom13b5',
  '13':      'dom13',
  '7#5#9':   'dom7#5#9',
  '7b5b9':   'dom7b5b9',
  '7b9':     'dom7b9',
  '7':       'dom7',
  // Suspended
  'sus13':   'sus13',
  'sus7':    'sus7',
  'sus4':    'sus4',
  // Diminished
  'dim7':    'dim7',
};

// Quality suffixes sorted longest-first so greedy match works
const CP_QUALITY_KEYS = Object.keys(CP_QUALITY_MAP).sort((a,b) => b.length - a.length);

function cpParseChord(symbol) {
  if (!symbol || !symbol.trim()) return null;
  const s = symbol.trim();

  // Regex: root = note letter + optional flat/sharp, then quality suffix, then optional /bass
  // Flats must be captured before the bare letter — use (Db|Eb|Gb|Ab|Bb|C#|F#|[A-G])
  const CHORD_RE = /^(Db|Eb|Gb|Ab|Bb|C#|F#|[A-G])(.*?)(?:\/([A-G]b?))?$/;
  const m = s.match(CHORD_RE);
  if (!m) return null;

  const root    = m[1];
  let   qualStr = (m[2] || '').trim();
  const bassRaw = m[3] || null;

  // Normalize quality shorthand
  let q = qualStr;
  if (q === 'M')    q = 'maj';
  if (q === 'M7')   q = 'maj7';
  if (q === 'dom7') q = '7';
  // "m" prefix without "in" or "aj" → minor
  if (/^m(?!aj|in)/.test(q)) q = 'min' + q.slice(1);

  // Greedy match against quality map (longest first)
  let quality = 'maj';
  for (const k of CP_QUALITY_KEYS) {
    if (q === k) { quality = CP_QUALITY_MAP[k]; break; }
  }

  // Parse bass note — also use regex to get flat names correctly
  let bassNote = null;
  if (bassRaw) {
    const bassMatch = bassRaw.match(/^(Db|Eb|Gb|Ab|Bb|C#|F#|[A-G])/);
    bassNote = bassMatch ? bassMatch[1] : null;
  }

  return { root, quality, bassNote };
}

// Transpose a root note by semitones
function cpTransposeRoot(root, semitones) {
  const base = CP_ROOT_TO_SEMITONE[root];
  if (base === undefined) return root;
  const newSemitone = ((base + semitones) % 12 + 12) % 12;
  // Prefer flat spellings (matches Kenneth's convention)
  const SEMITONE_TO_NOTE = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  return SEMITONE_TO_NOTE[newSemitone];
}

// Full chord transposition
function cpTransposeChord(parsed, semitones) {
  if (!parsed) return null;
  return {
    root:     cpTransposeRoot(parsed.root, semitones),
    quality:  parsed.quality,
    bassNote: parsed.bassNote ? cpTransposeRoot(parsed.bassNote, semitones) : null
  };
}

// Semitone distance from C for a key name
function cpKeyToSemitone(key) {
  return CP_ROOT_TO_SEMITONE[key] || 0;
}

// ── Chart Player State ─────────────────────────────────────────
let _cp = {
  chart:           null,    // loaded .vwbs object
  fileName:        '',
  activeSectionIdx: 0,      // which section is currently playing
  activeMeasureIdx: 0,      // which measure within the section
  activeBeatIdx:   0,       // which beat within the measure
  looping:         false,   // is current section set to loop?
  pendingJump:     null,    // section index to jump to on next downbeat
  playing:         false,
  tempo:           70,      // current BPM (may differ from chart BPM)
  keyOffset:       0,       // semitones up/down from original chart key
  originalKey:     'C',
  originalTempo:   70,
  beatTimer:       null,    // setInterval handle
  scheduledBeat:   null,    // next beat time for downbeat-accurate jumps
  drumMeasureIdx:  0,       // which measure of the recorded drum performance is next (see _cpGetDrumMeasureSlice)
};

// ── Public API ─────────────────────────────────────────────────

function cpLoadChart(chartObj, fileName) {
  if (!chartObj || chartObj.format !== 'vwb-song-chart') {
    cpNotify('Invalid chart file — not a VWB Song Chart.');
    return false;
  }
  if (!chartObj.sections || !chartObj.sections.length) {
    cpNotify('Chart has no sections.');
    return false;
  }

  cpStop();

  _cp.chart           = chartObj;
  _cp.fileName        = fileName || 'Chart';
  _cp.activeSectionIdx = 0;
  _cp.activeMeasureIdx = 0;
  _cp.activeBeatIdx   = 0;
  _cp.looping         = false;
  _cp.pendingJump     = null;
  _cp._skipBeats      = 0;
  _cp.keyOffset       = 0;
  _cp.drumMeasureIdx  = 0;
  _cp.originalKey     = chartObj.song?.key     || 'C';
  _cp.originalTempo   = chartObj.song?.bpm     || 70;
  _cp.tempo           = _cp.originalTempo;
  _cp.timeSig         = chartObj.song?.timeSig || chartObj.song?.timeSignature || '4/4';

  console.log('[ChartPlayer] Loaded:', chartObj.song?.title,
    '| Key:', _cp.originalKey,
    '| BPM:', _cp.tempo,
    '| Sections:', chartObj.sections.length);

  cpRenderUI();
  // Reveal the chart player panel in the Perform view
  if (typeof window._cpSyncPerformPanel === 'function') window._cpSyncPerformPanel();
  // Refresh the House Band Chart Sections card on the Setup page, if present
  if (typeof window.hbRefreshSectionsCard === 'function') window.hbRefreshSectionsCard();
  return true;
}

async function cpPlay() {
  if (!_cp.chart || _cp.playing) return;
  _cp.playing = true;

  // Load chunk library — the IPC returns a flat array, so index it directly
  try {
    const rawChunks = await window.vwb.loadHouseBandLibrary();
    if (Array.isArray(rawChunks)) {
      rawChunks.forEach(chunk => {
        if (chunk && chunk.id) _hbChunkLibrary[chunk.id] = chunk;
      });
      console.log('[ChartPlayer] Indexed', Object.keys(_hbChunkLibrary).length, 'chunks');
    }
  } catch(e) {
    console.warn('[ChartPlayer] Could not load chunk library:', e.message);
  }

  hbApplyChannelPrograms();

  // Apply current mixer fader positions to the synth — same as midi-player.js line 925
  // Without this, synthNoteOn fires at full volume regardless of fader position
  if (typeof synthSetVolume === 'function' && typeof midiChVolumes !== 'undefined') {
    Object.entries(midiChVolumes).forEach(([ch, vol]) => {
      synthSetVolume(parseInt(ch), vol);
    });
  }

  _cpScheduleNextBeat();
  if (typeof synthStartMeters === 'function') synthStartMeters();
  cpRenderUI();
  cpNotify('🎵 House Band performing: ' + (_cp.chart.song?.title || _cp.fileName));
}

function cpStop() {
  _cp.playing = false;
  _cp.looping = false;
  _cp.pendingJump = null;
  if (_cp.beatTimer) { clearTimeout(_cp.beatTimer); _cp.beatTimer = null; }
  _cpCancelPendingNotes();
  if (typeof allNotesOff     === 'function') allNotesOff();
  if (typeof synthStopMeters === 'function') synthStopMeters();
  cpRenderUI();
}

// Clear the current chart and return to the load screen
function cpClearChart() {
  cpStop();
  _cp.chart            = null;
  _cp.fileName         = '';
  _cp.activeSectionIdx = 0;
  _cp.activeMeasureIdx = 0;
  _cp.activeBeatIdx    = 0;
  _cp.keyOffset        = 0;
  _cp.originalKey      = 'C';
  _cp.tempo            = 70;
  var pTitle = document.getElementById('pTitle'); if (pTitle) pTitle.textContent = 'Untitled';
  var pTempo = document.getElementById('pTempo'); if (pTempo) pTempo.textContent = '72 BPM';
  var pTS    = document.getElementById('pTS');    if (pTS)    pTS.textContent    = '4/4';
  var pStems = document.getElementById('pStems'); if (pStems) pStems.textContent = '0 tracks';
  var pRoute = document.getElementById('pRoute'); if (pRoute) pRoute.textContent = 'Stereo';
  if (typeof window._cpSyncPerformPanel === 'function') window._cpSyncPerformPanel();
}

function cpTogglePlay() {
  if (_cp.playing) cpStop();
  else cpPlay();
}

// Jump to a section by index — takes effect on next downbeat
function cpJumpToSection(idx) {
  if (!_cp.chart || idx < 0 || idx >= _cp.chart.sections.length) return;
  if (!_cp.playing) {
    _cp.activeSectionIdx = idx;
    _cp.activeMeasureIdx = 0;
    _cp.activeBeatIdx    = 0;
    _cp.looping          = false;
    _cp.drumMeasureIdx   = 0;
    cpRenderUI();
    return;
  }
  _cp.pendingJump = idx;
  _cp.looping     = false;   // cancel loop when jumping
  _cp.drumMeasureIdx = 0;    // restart the drum performance from measure 1 at the new section
  cpRenderUI();
  cpNotify('Jumping to ' + _cp.chart.sections[idx].label + ' on next downbeat…');
}

// Toggle loop for current section
function cpToggleLoop() {
  _cp.looping = !_cp.looping;
  cpRenderUI();
  cpNotify(_cp.looping
    ? '🔁 Looping: ' + (_cp.chart?.sections[_cp.activeSectionIdx]?.label || 'Section')
    : 'Loop off — continuing forward');
}

// Live tempo adjustment
function cpSetTempo(bpm) {
  _cp.tempo = Math.max(20, Math.min(300, parseInt(bpm) || 70));
  cpRenderUI();
}

// Live key adjustment (semitones from original)
function cpSetKeyOffset(semitones) {
  _cp.keyOffset = Math.max(-11, Math.min(11, parseInt(semitones) || 0));
  cpRenderUI();
}

// ── Variation Selection — Last-Used Avoidance ─────────────────
//  Tracks the last variation played per chord key so VWB never
//  plays the same variation twice in a row on the same chord.
//  _cpLastVariation: { 'C_dom7_congregational': 'v2', ... }

const _cpLastVariation = {};

// ── Flex Engine Mixer State ────────────────────────────────────
// Tracks mute, solo, and volume for each House Band channel.
// Keyed by MIDI channel number (0-based).
// These are read by _cpPlayChunkDirect before firing any note.

const _cpChMutes  = {};  // { ch: true/false }
const _cpChSolos  = {};  // { ch: true/false }

function getMidiChMute(ch) { return !!_cpChMutes[ch]; }
function getMidiChSolo(ch) { return !!_cpChSolos[ch]; }
function anySolo()         { return Object.values(_cpChSolos).some(Boolean); }

// NOTE: hbToggleMute/hbToggleSolo/hbSetVolume are intentionally NOT defined
// here anymore. ui.js defines the real versions (loaded after this file),
// which correctly delegate into toggleMidiChMute/toggleMidiChSolo below and
// apply the resulting gain changes. Duplicate same-name copies used to live
// here too; they were always silently overwritten by ui.js's versions at
// runtime, so removing them changes nothing observable — it just removes a
// trap where reordering <script> tags in index.html could have silently
// broken mute/solo/volume with no error.

// These are called by ui.js's hbToggleMute/hbToggleSolo wrappers.
// Wire them directly into our _cp state so the Flex Engine respects them
function toggleMidiChMute(ch) {
  _cpChMutes[ch] = !_cpChMutes[ch];
  _cpRefreshMixerButtons();
  if (typeof _hbApplyMixerGains === 'function') _hbApplyMixerGains();
}

function toggleMidiChSolo(ch) {
  _cpChSolos[ch] = !_cpChSolos[ch];
  _cpRefreshMixerButtons();
  if (typeof _hbApplyMixerGains === 'function') _hbApplyMixerGains();
}

function _cpRefreshMixerButtons() {
  // Button IDs match what ui.js _cpBuildHouseBandMixer generates:
  // midiMute_{ch} and midiSolo_{ch}
  if (typeof HB_SLOT_TO_CHANNEL === 'undefined') return;
  const anyS = anySolo();
  Object.entries(HB_SLOT_TO_CHANNEL).forEach(([slot, ch]) => {
    const muted    = !!_cpChMutes[ch];
    const soloed   = !!_cpChSolos[ch];
    const silenced = muted || (anyS && !soloed);

    const mBtn  = document.getElementById(`midiMute_${ch}`);
    const sBtn  = document.getElementById(`midiSolo_${ch}`);
    const row   = document.getElementById(`midiChRow_${ch}`);

    if (mBtn) {
      mBtn.classList.toggle('active', muted);
    }
    if (sBtn) {
      sBtn.classList.toggle('active', soloed);
    }
    if (row) {
      row.classList.toggle('silenced', silenced);
    }

    // Apply gain to synth so Tone.js actually respects the state
    const vol = (typeof midiChVolumes !== 'undefined' && midiChVolumes[ch] !== undefined) ? midiChVolumes[ch] : 100;
    if (typeof synthSetVolume === 'function') {
      synthSetVolume(ch, silenced ? 0 : vol);
    }
  });
}

// Tracks all pending setTimeout handles for note scheduling.
// Cleared before each new chord fires so old chunk notes stop immediately.
let _cpPendingNoteTimers = [];

function _cpCancelPendingNotes() {
  _cpPendingNoteTimers.forEach(t => clearTimeout(t));
  _cpPendingNoteTimers = [];
}

// Style bucket map — maps chart style tags to abbreviated chunk style tags
// Chunk files use short abbreviations: cong, trad, worship, etc.
// Shared by melodic-slot lookup (_cpFindChunkWithVariation) and the
// drums lookup (_cpFindDrumChunk) so both use one consistent convention.
const CP_STYLE_BUCKETS = {
  'congregational':       'cong',
  'uptempo-praise':       'cong',
  'uptempo-gospel':       'cong',
  'medium-groove-gospel': 'cong',
  'traditional':          'trad',
  'traditional-gospel':   'trad',
  'worship':              'worship',
  'worship-ballad':       'worship',
  'contemporary':         'contemp',
  'contemporary-gospel':  'contemp',
  'gospel-funk':          'funk',
  'funk':                 'funk',
  'gospel-blues':         'blues',
  'blues':                'blues',
  'quartet':              'quartet',
  'quartet-gospel':       'quartet',
  'latin':                'latin',
  'latin-gospel':         'latin',
  'praise-break':         'praise',
  'prophetic':            'prophetic',
  'christian-rock':       'rock',
  'ccm':                  'ccm',
};

function _cpStyleBucket(style) {
  return CP_STYLE_BUCKETS[style] || CP_STYLE_BUCKETS[(style || '').toLowerCase()] || style;
}

function _cpPickVariation(root, quality, style, variations) {
  const trackKey = `${root}_${quality}_${style}`;
  const last     = _cpLastVariation[trackKey];
  // Filter out the last-used variation
  const choices  = variations.filter(v => v !== last);
  const pool     = choices.length > 0 ? choices : variations;
  // Pick randomly from the remaining pool
  const picked   = pool[Math.floor(Math.random() * pool.length)];
  _cpLastVariation[trackKey] = picked;
  return picked;
}

// Find a chunk with variation support.
// If multiple variations exist (v1/v2/v3), picks intelligently.
function _cpFindChunkWithVariation(root, quality, style, slot) {
  const r = root.toLowerCase();
  const chunkStyle = _cpStyleBucket(style);

  // Slot-specific prefix map — each slot only looks for its own chunks.
  // Never fall back to keys chunks for organ/guitar/aux — that causes double-firing.
  let prefixes = [];
  if (slot === 'bass') {
    prefixes = [`tw-bass-${chunkStyle}-${quality}-${r}`];
  } else if (slot === 'keys') {
    prefixes = [`jc-keys-${chunkStyle}-${quality}-${r}`];
  } else {
    // organ, guitar, aux — only look for their own slot chunks, no keys fallback
    prefixes = [`jc-${slot}-${chunkStyle}-${quality}-${r}`];
  }

  for (const prefix of prefixes) {
    const variations = ['v1','v2','v3'].filter(v => _hbChunkLibrary[`${prefix}-${v}`]);
    if (variations.length > 0) {
      const picked = _cpPickVariation(root, quality, style, variations);
      console.log(`[ChartPlayer] ✓ Found chunk: ${prefix}-${picked} (style: ${style} → ${chunkStyle})`);
      return _hbChunkLibrary[`${prefix}-${picked}`];
    }
  }

  // Log miss so we can see what was not found
  console.log(`[ChartPlayer] ✗ No chunk for: root=${root} quality=${quality} style=${style}→${chunkStyle} slot=${slot} | tried: ${prefixes.join(', ')}`);

  // Fall back to standard chunk lookup
  return null;
}

// Find a drums chunk. Drums don't vary by chord root/quality the way
// melodic instruments do — one recorded groove covers a whole style+feel
// (see jason-washington's jw-drums-{style}-{feel}-vN chunks). Feel matters
// (straight vs swing are genuinely different grooves) so it's tried first;
// falls back to a feel-agnostic chunk if only one was ever recorded for
// that style. Mirrors _cpFindChunkWithVariation's variation-picking so
// v1/v2/v3 groove variations rotate the same way melodic chunks do.
function _cpFindDrumChunk(style, feel) {
  const chunkStyle = _cpStyleBucket(style);
  const feelSlug   = (feel || '').toLowerCase();

  const prefixes = feelSlug
    ? [`jw-drums-${chunkStyle}-${feelSlug}`, `jw-drums-${chunkStyle}`]
    : [`jw-drums-${chunkStyle}`];

  for (const prefix of prefixes) {
    const variations = ['v1','v2','v3'].filter(v => _hbChunkLibrary[`${prefix}-${v}`]);
    if (variations.length > 0) {
      const picked = _cpPickVariation('drums', chunkStyle, feelSlug || 'any', variations);
      console.log(`[ChartPlayer] ✓ Found drum chunk: ${prefix}-${picked} (style: ${style} → ${chunkStyle}, feel: ${feelSlug || 'any'})`);
      return _hbChunkLibrary[`${prefix}-${picked}`];
    }
  }

  console.log(`[ChartPlayer] ✗ No drum chunk for: style=${style}→${chunkStyle} feel=${feelSlug || 'any'} | tried: ${prefixes.join(', ')}`);
  return null;
}

// ── Progression Read-Ahead Engine ─────────────────────────────
//  Reads ahead in the chart to detect multi-chord progressions
//  (2-5-1, 3-6-2-5-1, etc.) and fires a single progression chunk
//  instead of individual chord chunks, for more natural phrasing.

// All recognized 2-5-1 progressions keyed by the "2" chord (min7)
const CP_251_MAP = {
  'Dmin7':  { five: 'G7',  one: 'Cmaj7',  key: 'C'  },
  'Ebmin7': { five: 'Ab7', one: 'Dbmaj7', key: 'Db' },
  'Emin7':  { five: 'A7',  one: 'Dmaj7',  key: 'D'  },
  'Fmin7':  { five: 'Bb7', one: 'Ebmaj7', key: 'Eb' },
  'F#min7': { five: 'B7',  one: 'Emaj7',  key: 'E'  },
  'Gmin7':  { five: 'C7',  one: 'Fmaj7',  key: 'F'  },
  'Abmin7': { five: 'Db7', one: 'Gbmaj7', key: 'Gb' },
  'Amin7':  { five: 'D7',  one: 'Gmaj7',  key: 'G'  },
  'Bbmin7': { five: 'Eb7', one: 'Abmaj7', key: 'Ab' },
  'Bmin7':  { five: 'E7',  one: 'Amaj7',  key: 'A'  },
  'Cmin7':  { five: 'F7',  one: 'Bbmaj7', key: 'Bb' },
  'Dbmin7': { five: 'Gb7', one: 'Bmaj7',  key: 'B'  },
};

// Read the chord at a given number of beats ahead from current position.
// Returns the chord string or null if out of bounds.
function _cpPeekBeat(beatsAhead) {
  if (!_cp.chart) return null;
  let secIdx  = _cp.activeSectionIdx;
  let measIdx = _cp.activeMeasureIdx;
  let beatIdx = _cp.activeBeatIdx + beatsAhead;

  while (secIdx < _cp.chart.sections.length) {
    const sec = _cp.chart.sections[secIdx];
    if (!sec || !sec.measures) return null;
    while (measIdx < sec.measures.length) {
      const meas = sec.measures[measIdx];
      if (!meas || !meas.beats) return null;
      if (beatIdx < meas.beats.length) {
        return meas.beats[beatIdx]?.chord || null;
      }
      beatIdx -= meas.beats.length;
      measIdx++;
    }
    measIdx = 0;
    secIdx++;
  }
  return null;
}

// Normalize a chord symbol for comparison (strip spaces, flatten Gb/F# etc.)
function _cpNormalizeChord(sym) {
  if (!sym) return '';
  return sym.trim();
}

// Check if current position starts a 2-5-1 progression.
// The "2" chord is beats 0-1, "5" is beats 2-3, "1" is beats 4-7.
// Returns the progression key (e.g. 'C') or null.
function _cpDetect251(currentChord) {
  if (!currentChord) return null;
  const norm = _cpNormalizeChord(currentChord);
  const prog = CP_251_MAP[norm];
  if (!prog) return null;

  // Peek beats 2 and 4 (start of 5 chord and 1 chord)
  const beat2chord = _cpNormalizeChord(_cpPeekBeat(2));
  const beat4chord = _cpNormalizeChord(_cpPeekBeat(4));

  if (beat2chord === prog.five && beat4chord === prog.one) {
    return prog.key;
  }
  return null;
}

// Skip ahead a given number of beats in the chart without firing.
// Used after a progression chunk fires to skip the chords it covered.
function _cpSkipBeats(count) {
  for (let i = 0; i < count; i++) {
    const section = _cp.chart.sections[_cp.activeSectionIdx];
    if (!section) break;
    const measure = section.measures[_cp.activeMeasureIdx];
    if (!measure) break;
    _cp.activeBeatIdx++;
    if (_cp.activeBeatIdx >= (measure.beats?.length || 4)) {
      _cp.activeBeatIdx = 0;
      _cpAdvanceMeasure();
    }
  }
}

// ── Beat Scheduler ─────────────────────────────────────────────
//  Steps through the chart beat by beat. Each beat fires the
//  correct chord chunk via the House Band engine.

function _cpScheduleNextBeat() {
  if (!_cp.playing || !_cp.chart) return;

  const secsPerBeat = 60 / _cp.tempo;

  // Check for pending section jump — only execute at measure boundary
  if (_cp.pendingJump !== null && _cp.activeBeatIdx === 0) {
    _cp.activeSectionIdx = _cp.pendingJump;
    _cp.activeMeasureIdx = 0;
    _cp.activeBeatIdx    = 0;
    _cp.pendingJump      = null;
    _cp.looping          = false;
    cpRenderUI();
  }

  const section = _cp.chart.sections[_cp.activeSectionIdx];
  if (!section || !section.measures || !section.measures.length) {
    _cpAdvanceSection();
    return;
  }

  const measure = section.measures[_cp.activeMeasureIdx];
  if (!measure || !measure.beats || !measure.beats.length) {
    _cpAdvanceMeasure();
    return;
  }

  const beat = measure.beats[_cp.activeBeatIdx];
  const beatsInMeasure = measure.beats.length;

  // Flash the beat indicator dots in sync with chart tempo
  const bi = document.getElementById('beatInd');
  if (bi) {
    // Build dots if not already built for this time signature
    if (bi.querySelectorAll('.b-dot').length !== beatsInMeasure) {
      bi.innerHTML = '';
      for (let i = 0; i < beatsInMeasure; i++) bi.innerHTML += '<div class="b-dot"></div>';
    }
    bi.querySelectorAll('.b-dot').forEach(function(dot, i) {
      dot.classList.remove('act', 'db');
      if (i === _cp.activeBeatIdx) dot.classList.add(_cp.activeBeatIdx === 0 ? 'db' : 'act');
    });
  }

  // Fire the chord for this beat — check for progression first
  if (beat && beat.chord) {
    // Only detect progressions on beat 1 of a measure (activeBeatIdx === 0)
    const progKey = (_cp.activeBeatIdx === 0) ? _cpDetect251(beat.chord) : null;
    // Duration for chunk playback = full measure length, not just one beat.
    // Chunks are recorded as whole measures so they need the full measure duration
    // to play correctly regardless of tempo.
    const secsPerMeasure = secsPerBeat * beatsInMeasure;

    if (progKey) {
      // Found a 2-5-1 — check style compatibility then fire progression chunk
      const chunkId   = `jc-keys-251-${progKey.toLowerCase()}`;
      const progChunk = _hbChunkLibrary[chunkId];
      const songStyle = _cp.chart?.song?.style || '';
      const styleOk   = progChunk && (
        !progChunk.styles ||
        progChunk.styles.includes(songStyle) ||
        progChunk.styles.includes('all')
      );
      if (progChunk && styleOk) {
        console.log(`[ChartPlayer] 2-5-1 detected in ${progKey} (${songStyle}) — firing progression chunk`);
        const progDurSecs = secsPerBeat * 8;  // chunk spans 8 beats
        _cpPlayChunkDirect(progChunk, progDurSecs, null);
        // Skip the next 7 beats — the progression chunk covers them
        _cp._skipBeats = 7;
      } else {
        // Style mismatch or chunk not found — fall back to individual chord firing
        console.log(`[ChartPlayer] 2-5-1 in ${progKey} — no compatible chunk for style "${songStyle}", falling back`);
        _cpFireChord(beat.chord, true, secsPerMeasure);
      }
    } else {
      // Check if we're inside a progression skip window
      if (_cp._skipBeats && _cp._skipBeats > 0) {
        _cp._skipBeats--;
        // Don't fire — progression chunk is still playing
      } else {
        _cpFireChord(beat.chord, _cp.activeBeatIdx === 0, secsPerMeasure);
      }
    }
  }

  // Update UI to highlight current position
  cpRenderUI();

  // Advance position
  _cp.activeBeatIdx++;
  if (_cp.activeBeatIdx >= beatsInMeasure) {
    _cp.activeBeatIdx = 0;
    _cpAdvanceMeasure();
  }

  // Schedule next beat
  _cp.beatTimer = setTimeout(_cpScheduleNextBeat, secsPerBeat * 1000);
}

function _cpAdvanceMeasure() {
  const section = _cp.chart?.sections[_cp.activeSectionIdx];
  if (!section) return;
  _cp.activeMeasureIdx++;
  if (_cp.activeMeasureIdx >= section.measures.length) {
    _cp.activeMeasureIdx = 0;
    if (_cp.looping) {
      // Stay in this section — loop it
      console.log('[ChartPlayer] Looping section:', section.label);
    } else if (_cp.pendingJump !== null) {
      // Jump pending — will be handled at next beat
    } else {
      _cpAdvanceSection();
    }
  }
}

function _cpAdvanceSection() {
  if (!_cp.chart) return;
  _cp.activeSectionIdx++;
  _cp.activeMeasureIdx = 0;
  _cp.activeBeatIdx    = 0;
  if (_cp.activeSectionIdx >= _cp.chart.sections.length) {
    // Song complete — stop or loop from top
    _cp.activeSectionIdx = 0;
    cpStop();
    cpNotify('Song complete.');
    return;
  }
  cpRenderUI();
}

// ── Chord Firing ───────────────────────────────────────────────
//  Fires all House Band slots for each chord event.
//  Melodic slots: keys, bass, organ, guitar, aux (on every beat with a chord).
//  Drums: fired only on beat 1 of each measure (isDownbeat = true).
//  Missing chunks are skipped gracefully — never crashes.

// Drum chunks are recorded as one continuous performance (Kenneth plays
// straight through several measures, same as a real drummer would), not
// as isolated per-chord hits. Chunks are authored at the 60 BPM reference
// tempo (1 beat = 1 second — see the House Band chunk schema), so at 4/4
// each recorded measure is exactly 4 seconds of chunk-time.
// NOTE: this assumes 4/4. A 3/4 congregational hymn's drum chunk would
// need a different seconds-per-measure value — not handled yet.
const CP_DRUM_CHUNK_SECS_PER_MEASURE = 4;

// Slices one measure's worth of events out of a full drum performance
// chunk, wrapping around (measure 1 again) once the recording runs out —
// so a chart with more chords than the drummer recorded measures just
// loops the performance rather than going silent. Returns a fresh events
// array with time rebased to 0 for that measure; never mutates the chunk.
function _cpGetDrumMeasureSlice(chunk, measureIdx) {
  if (!chunk._totalMeasures) {
    const maxEnd = chunk.events.reduce((m, e) => Math.max(m, (e.time || 0) + (e.duration || 0)), 0);
    chunk._totalMeasures = Math.max(1, Math.ceil(maxEnd / CP_DRUM_CHUNK_SECS_PER_MEASURE));
  }
  const wrapped    = measureIdx % chunk._totalMeasures;
  const rangeStart = wrapped * CP_DRUM_CHUNK_SECS_PER_MEASURE;
  const rangeEnd    = rangeStart + CP_DRUM_CHUNK_SECS_PER_MEASURE;
  return chunk.events
    .filter(e => e.time >= rangeStart && e.time < rangeEnd)
    .map(e => ({ note: e.note, vel: e.vel, time: e.time - rangeStart, duration: e.duration }));
}

function _cpFireChord(chordSymbol, isDownbeat, secsPerMeasure) {
  // Cancel any notes still pending from the previous chord
  _cpCancelPendingNotes();
  // Cut off sustaining notes on melodic channels 20ms before new chord fires.
  // Firing at exactly t=0 causes a tiny overlap in the audio engine.
  // A 20ms pre-cut ensures old notes are fully silent before new ones start.
  // Skips drums (ch 9) and percussion (ch 8) so rhythmic hits are not chopped.
  const _cutNow = () => {
    if (typeof synthNoteOff === 'function') {
      [0, 1, 2, 3, 4].forEach(ch => {
        for (let note = 0; note < 128; note++) {
          synthNoteOff(ch, note);
        }
      });
    } else if (typeof allNotesOff === 'function') {
      allNotesOff();
    }
  };
  _cutNow();  // cut immediately
  // Also schedule a follow-up cut 20ms later to catch any notes that fire
  // from pending timers that were not yet in the list when cancel ran
  const _followUpCut = setTimeout(_cutNow, 20);
  _cpPendingNoteTimers.push(_followUpCut);

  const parsed = cpParseChord(chordSymbol);
  if (!parsed) return;

  const semitones  = _cp.keyOffset;
  const transposed = cpTransposeChord(parsed, semitones);
  if (!transposed) return;

  const secsPerBeat = 60 / _cp.tempo;
  // Use full measure duration so chunks play their complete recorded content
  const chunkDuration = secsPerMeasure || secsPerBeat;
  const style       = _cp.chart?.song?.style || 'foundation';

  console.log(`[ChartPlayer] Firing: "${chordSymbol}" → ${transposed.root} ${transposed.quality} (${style})`);

  // ── Melodic slots ──────────────────────────────────────────
  ['keys', 'bass', 'organ', 'guitar', 'aux'].forEach(slot => {
    // Try style-specific chunk first, then plain key_quality_slot fallback,
    // then root-only fallback (e.g. tw-bass-root-db) for instruments that
    // record one root chunk covering all chord qualities
    const rootKey = transposed.root.toLowerCase();

    // Check for variation chunks first (congregational dom7 v1/v2/v3 etc.)
    // If a variation chunk is found, use it exclusively — don't fall through
    // to the standard library to avoid double-firing two piano/bass parts.
    const varChunk = _cpFindChunkWithVariation(transposed.root, transposed.quality, style, slot);
    if (varChunk) {
      if (varChunk.events) _cpPlayChunkDirect(varChunk, chunkDuration, transposed.bassNote);
      else _cpPlayChunk(varChunk, chunkDuration, transposed.bassNote);
      return;
    }

    // No variation chunk — fall through to standard library lookup.
    // Foundation chunks are last resort only — never fire alongside a style chunk.
    const rootKey2 = transposed.root.toLowerCase();

    // 1. Style-tagged or plain chord chunk
    let chunk = _hbChunkLibrary[`${transposed.root}_${transposed.quality}_${slot}_${style}`]
             || _hbChunkLibrary[`${transposed.root}_${transposed.quality}_${slot}`];

    // 2. Only if no style chunk found, fall to Foundation or bass root
    if (!chunk) {
      if (slot === 'bass') {
        chunk = _hbChunkLibrary[`tw-bass-root-${rootKey2}`];
      } else {
        chunk = _hbChunkLibrary[`${transposed.root}_${transposed.quality}_${slot}_foundation`];
      }
    }

    if (!chunk) return;  // still nothing — skip silently

    if (chunk.format === 'midi-b64') {
      _cpPlayMidiBassChunk(chunk, chunkDuration, transposed.bassNote);
    } else if (chunk.events) {
      _cpPlayChunkDirect(chunk, chunkDuration, transposed.bassNote);
    } else {
      _cpPlayChunk(chunk, chunkDuration, transposed.bassNote);
    }
  });

  // ── Drums — downbeat only to avoid double-firing ───────────
  if (isDownbeat) {
    const feel     = _cp.chart?.song?.feel || '';
    const drumChunk = _cpFindDrumChunk(style, feel);
    if (drumChunk?.events) {
      const slice = _cpGetDrumMeasureSlice(drumChunk, _cp.drumMeasureIdx);
      _cpPlayDrumChunk({ events: slice }, secsPerBeat);
      _cp.drumMeasureIdx++;
    }
  }
}

// Drum chunk player — channel 9 (GM channel 10), short articulate hits
// Drum chunk player — channel 9 (GM channel 10), short articulate hits.
// Chunks are recorded at 60 BPM (1 recorded beat = 1 recorded second —
// see CP_DRUM_CHUNK_SECS_PER_MEASURE above), so scaling recorded time to
// the actual current tempo is just a multiply by secsPerBeat (the actual
// seconds-per-beat at the live tempo) — the 1-sec/beat recorded reference
// cancels out. Without this, drums always play at the recorded 60 BPM
// regardless of the song's real tempo, same bug that made melodic chunks
// need _cpPlayChunkDirect's timeScale.
function _cpPlayDrumChunk(chunk, secsPerBeat) {
  if (!chunk || !chunk.events) return;
  const timeScale = secsPerBeat;
  chunk.events.forEach(ev => {
    if (!ev.note) return;
    const note     = Math.max(0, Math.min(127, ev.note));
    const dur      = Math.min((ev.duration || 0.1) * timeScale, 0.15);
    const delayMs  = Math.max(0, (ev.time || 0) * timeScale * 1000);
    const fire = () => { if (typeof synthNoteOn === 'function') synthNoteOn(9, note, ev.vel || 100, 128, dur); };
    if (delayMs === 0) fire(); else setTimeout(fire, delayMs);
  });
}

// Find a chunk for a specific slot
function _cpFindChunkForSlot(transposed, slot) {
  const exact = `${transposed.root}_${transposed.quality}_${slot}`;
  if (_hbChunkLibrary[exact]) return exact;
  return null;
}

// Legacy single-slot lookup (keys only)
function _cpFindChunk(transposed) {
  return _cpFindChunkForSlot(transposed, 'keys');
}

function _cpPlayChunk(chunk, durationSecs, bassOverrideNote) {
  if (!chunk || !chunk.tracks) return;

  const now = (typeof AC !== 'undefined') ? AC.currentTime : 0;

  Object.entries(chunk.tracks).forEach(([slot, trackEvents]) => {
    const ch     = HB_SLOT_TO_CHANNEL[slot];
    const octOff = HB_OCTAVE_OFFSETS[slot] || 0;
    if (ch === undefined) return;

    trackEvents.forEach(ev => {
      if (ev.type !== 'on' || !ev.note) return;

      let note = ev.note + octOff * 12;

      // Bass override for slash chords: Terry plays the bass note
      if (slot === 'bass' && bassOverrideNote) {
        const bassRoot = CP_ROOT_TO_SEMITONE[bassOverrideNote];
        if (bassRoot !== undefined) {
          // Find nearest octave to original note
          const origOct = Math.floor(note / 12);
          note = origOct * 12 + bassRoot;
        }
      }

      note = Math.max(0, Math.min(127, note));

      // Trim duration to beat length
      const noteDur = Math.min(ev.duration || durationSecs, durationSecs * 0.95);
      const startAt = now + (ev.time || 0);

      if (typeof synthTriggerNote === 'function') {
        synthTriggerNote(ch, note, ev.vel || 80, startAt, noteDur);
      } else if (typeof synthNoteOn === 'function') {
        synthNoteOn(ch, note, ev.vel || 80);
        setTimeout(() => { if (typeof synthNoteOff === 'function') synthNoteOff(ch, note); },
          noteDur * 1000);
      }
    });
  });
}

// ── UI Renderer ────────────────────────────────────────────────

function cpRenderUI() {
  _cpRenderSongBar();
  _cpRenderControls();
  _cpRenderSectionButtons();
  _cpRenderMeasureGrid();
  if (typeof uniUpdateProgress === 'function') uniUpdateProgress();
  const chartPanel = document.getElementById('cpPerfChartPanel');
  if (chartPanel && typeof _cpRenderPerfChartPanel === 'function') {
    _cpRenderPerfChartPanel(chartPanel);
  }
  if (typeof _cpUpdatePerfHeader === 'function') _cpUpdatePerfHeader();
}

function _cpRenderSongBar() {
  const titleEl = document.getElementById('cpSongTitle');
  const metaEl  = document.getElementById('cpSongMeta');
  const song    = _cp.chart?.song;
  if (titleEl) titleEl.textContent = song?.title || _cp.fileName || 'No chart loaded';
  if (metaEl && song) {
    const currentKey = cpTransposeRoot(_cp.originalKey, _cp.keyOffset);
    metaEl.textContent = [
      'Key of ' + currentKey + (_cp.keyOffset !== 0 ? ' (orig: ' + _cp.originalKey + ')' : ''),
      _cp.tempo + ' BPM',
      song.style?.replace(/-/g,' ') || '',
      song.feel || ''
    ].filter(Boolean).join(' · ');
  }
}

function _cpRenderControls() {
  // Play/Stop button
  const playBtn   = document.getElementById('cpPlayBtn');
  const playLabel = document.getElementById('cpPlayLabel');
  const playIcon  = document.getElementById('cpPlayIcon');
  if (playBtn) {
    playBtn.classList.toggle('cp-playing', _cp.playing);
    if (playIcon)  playIcon.textContent  = _cp.playing ? '⏸' : '▶';
    if (playLabel) playLabel.textContent = _cp.playing ? 'Playing…' : 'Play';
  }

  // Loop button
  const loopBtn = document.getElementById('cpLoopBtn');
  if (loopBtn) {
    loopBtn.classList.toggle('cp-loop-active', _cp.looping);
    loopBtn.title = _cp.looping ? 'Loop ON — click to turn off' : 'Loop current section';
  }

  // Tempo display
  const tempoEl = document.getElementById('cpTempoVal');
  if (tempoEl) tempoEl.textContent = _cp.tempo + ' BPM';
  const tempoSlider = document.getElementById('cpTempoSlider');
  if (tempoSlider) tempoSlider.value = _cp.tempo;

  // Key display
  const currentKey = cpTransposeRoot(_cp.originalKey, _cp.keyOffset);
  const keyEl = document.getElementById('cpKeyVal');
  if (keyEl) keyEl.textContent = currentKey;
  const keySlider = document.getElementById('cpKeySlider');
  if (keySlider) keySlider.value = _cp.keyOffset;

  // ── Perform panel live updates (key + tempo) ──────────────────
  const perfKeyEl = document.getElementById('cpPerfKeyVal');
  if (perfKeyEl) perfKeyEl.textContent = currentKey;

  const perfTempoEl = document.getElementById('cpPerfTempoVal');
  if (perfTempoEl) {
    // input element — use .value; plain div would use .textContent
    if (perfTempoEl.tagName === 'INPUT') perfTempoEl.value = _cp.tempo;
    else perfTempoEl.textContent = _cp.tempo;
  }

  // Rebuild the full panel when key offset changes so "orig:" hint
  // appears / disappears correctly without a page reload
  if (typeof _cpRenderPerfChartPanel === 'function') {
    const panel = document.getElementById('cpPerfChartPanel');
    if (panel) _cpRenderPerfChartPanel(panel);
  }
}

function _cpRenderSectionButtons() {
  const wrap = document.getElementById('cpSectionBtns');
  if (!wrap || !_cp.chart) return;

  wrap.innerHTML = (_cp.chart.sections || []).map((sec, i) => {
    const isActive  = i === _cp.activeSectionIdx;
    const isPending = _cp.pendingJump === i;
    // Prefer the actual section name (Verse/Chorus/etc), then a custom
    // label if one was set, then generic numbering as a last resort —
    // matches the same priority used in ui.js's _cpRenderPerfChartPanel().
    const displayName = sec.label || sec.type || ('Section ' + (i + 1));
    let cls = 'cp-sec-btn';
    if (isActive)  cls += ' cp-sec-active';
    if (isPending) cls += ' cp-sec-pending';
    return `<button class="${cls}" onclick="cpJumpToSection(${i})" title="Jump to ${displayName}">
      ${displayName}
    </button>`;
  }).join('');
}

function _cpRenderMeasureGrid() {
  const wrap = document.getElementById('cpMeasureGrid');
  if (!wrap || !_cp.chart) return;

  const section = _cp.chart.sections[_cp.activeSectionIdx];
  if (!section) { wrap.innerHTML = ''; return; }

  wrap.innerHTML = section.measures.map((meas, mi) => {
    const isActiveMeas = mi === _cp.activeMeasureIdx;
    const beatsHtml = meas.beats.map((beat, bi) => {
      const isActiveBeat = isActiveMeas && bi === _cp.activeBeatIdx && _cp.playing;
      const hasChord = !!beat.chord;
      let cls = 'cp-beat';
      if (isActiveBeat) cls += ' cp-beat-active';
      if (!hasChord)    cls += ' cp-beat-empty';
      return `<div class="${cls}">${beat.chord || '·'}</div>`;
    }).join('');

    return `<div class="cp-measure ${isActiveMeas ? 'cp-measure-active' : ''}">
      <div class="cp-measure-num">M${mi + 1}</div>
      <div class="cp-beats">${beatsHtml}</div>
    </div>`;
  }).join('');
}

// ── Notify helper ──────────────────────────────────────────────
function cpNotify(msg) {
  if (typeof showNotification === 'function') showNotification(msg);
  else console.log('[ChartPlayer]', msg);
}

// ── IPC: Open .vwbs file ───────────────────────────────────────
async function cpPickChartFile() {
  try {
    const result = await window.vwb.openVwbs();
    if (!result || result.canceled) return;
    if (!result.success) { cpNotify('Could not open chart: ' + (result.error || 'unknown error')); return; }
    const chart = JSON.parse(result.text);
    const fileName = result.fileName || 'Chart';
    if (cpLoadChart(chart, fileName)) {
      cpNotify('✅ ' + (chart.song?.title || fileName) + ' loaded');
      const loader = document.getElementById('cpChartLoader');
      const panel  = document.getElementById('cpChartPanel');
      if (loader) loader.style.display = 'none';
      if (panel)  panel.style.display  = 'block';
    }
  } catch(e) {
    cpNotify('Chart load error: ' + e.message);
  }
}

console.log('[ChartPlayer] chart-player.js loaded');

// ── Direct chunk playback for flat-event library format ────────
//  Julian's chunks have: { id, key, quality, slot, events: [{note, vel, time, duration}] }
//  Uses synthNoteOn(ch, note, vel, program, duration) directly — Tone.js handles release.

function _cpPlayChunkDirect(chunk, durationSecs, bassOverrideNote) {
  if (!chunk) return;

  const events  = chunk.events || [];
  const slot    = chunk.slot || 'keys';
  const ch      = HB_SLOT_TO_CHANNEL[slot] !== undefined
                  ? HB_SLOT_TO_CHANNEL[slot]
                  : HB_SLOT_TO_CHANNEL['keys'];
  const program = HB_SLOT_TO_PROGRAM[slot] !== undefined
                  ? HB_SLOT_TO_PROGRAM[slot]
                  : HB_SLOT_TO_PROGRAM['keys'];
  const octOff  = HB_OCTAVE_OFFSETS[slot] || 0;

  // ── Tempo scaling ─────────────────────────────────────────────
  // Chunks are recorded at 60 BPM (4 seconds per measure).
  // Scale all note timestamps and durations to match current chart tempo.
  // recordedMeasureDuration = 4 beats * (60 sec / 60 BPM) = 4.0 seconds
  const RECORDED_MEASURE_SECS = 4.0;
  const timeScale = durationSecs / RECORDED_MEASURE_SECS;

  // ── Mixer state — respect mute, solo, and volume fader ────────
  const isMuted  = typeof getMidiChMute === 'function' && getMidiChMute(ch);
  const hasSolo  = typeof anySolo       === 'function' && anySolo();
  const isSoloed = typeof getMidiChSolo === 'function' && getMidiChSolo(ch);
  if (isMuted || (hasSolo && !isSoloed)) return;

  // Scale velocity by the channel's fader (0-127 range, default 100)
  const faderVol = (typeof midiChVolumes !== 'undefined' && midiChVolumes[ch] !== undefined)
                   ? midiChVolumes[ch] : 100;
  const volScale = Math.max(0, Math.min(1, faderVol / 100));

  if (typeof synthSetProgram === 'function') synthSetProgram(ch, program);

  events.forEach(ev => {
    if (!ev.note) return;

    let note = ev.note + (octOff * 12);

    // Slash chord: bass slot plays the bass override note
    if (slot === 'bass' && bassOverrideNote && typeof CP_ROOT_TO_SEMITONE !== 'undefined') {
      const bassRoot = CP_ROOT_TO_SEMITONE[bassOverrideNote];
      if (bassRoot !== undefined) {
        const origOct = Math.floor(note / 12);
        note = origOct * 12 + bassRoot;
      }
    }

    note = Math.max(0, Math.min(127, note));

    const vel     = Math.round((ev.vel || 80) * volScale);
    if (vel === 0) return;

    // Scale note timing to current chart tempo
    const scaledTime = (ev.time || 0) * timeScale;
    // Cap note duration so it ends before the next chord fires.
    // durationSecs is the time until the next chord change.
    // Notes must not sustain past that boundary or they bleed into the next chord.
    const scaledDur  = (ev.duration !== undefined ? ev.duration : RECORDED_MEASURE_SECS) * timeScale;
    const timeUntilNextChord = durationSecs - scaledTime;
    const noteDur = Math.min(scaledDur, timeUntilNextChord * 0.88);

    const delayMs = Math.max(0, scaledTime * 1000);

    if (delayMs === 0) {
      if (typeof synthNoteOn === 'function') synthNoteOn(ch, note, vel, program, noteDur);
    } else {
      // Register timer so it can be cancelled if a new chord fires before this note plays
      const t = setTimeout(() => {
        if (typeof synthNoteOn === 'function') synthNoteOn(ch, note, vel, program, noteDur);
      }, delayMs);
      _cpPendingNoteTimers.push(t);
    }
  });
}

// ── MIDI-b64 chunk playback ────────────────────────────────────
//  Handles chunks loaded as raw MIDI base64 (e.g. tw-bass-root-* files).
//  Decodes the base64, parses the MIDI, and fires notes directly
//  via synthTriggerNote respecting the beat duration and bass override.
function _cpPlayMidiBassChunk(chunk, durationSecs, bassOverrideNote) {
  if (!chunk || chunk.format !== 'midi-b64' || !chunk.data) return;

  try {
    // Decode base64 → Uint8Array
    const binary = atob(chunk.data);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Parse MIDI manually (Type 0, single track)
    const view   = new DataView(bytes.buffer);
    const tpb    = view.getUint16(12);          // ticks per beat from header
    let   pos    = 14;                          // skip 14-byte header

    // Skip track header (8 bytes: 'MTrk' + length)
    pos += 8;

    const now    = (typeof AC !== 'undefined') ? AC.currentTime : 0;
    // Scale ticks to current chart tempo — chunks recorded at 60 BPM (500000 microseconds per beat)
    // secsPerTick at recording tempo = 500000 / 1000000 / tpb
    // Scale by durationSecs / RECORDED_MEASURE_SECS to match current tempo
    const RECORDED_MEASURE_SECS_MIDI = 4.0;
    const secsPerTick = (RECORDED_MEASURE_SECS_MIDI / tpb) * (durationSecs / RECORDED_MEASURE_SECS_MIDI);
    const ch     = HB_SLOT_TO_CHANNEL['bass'];
    const octOff = HB_OCTAVE_OFFSETS['bass'] || 0;

    let tick = 0;
    while (pos < bytes.length - 1) {
      // Read variable-length delta time
      let delta = 0;
      let b;
      do { b = bytes[pos++]; delta = (delta << 7) | (b & 0x7F); } while (b & 0x80);
      tick += delta;

      const status = bytes[pos++];
      if (status === 0xFF) {
        // Meta event — read type and length then skip
        const metaType = bytes[pos++];
        let metaLen = 0;
        do { b = bytes[pos++]; metaLen = (metaLen << 7) | (b & 0x7F); } while (b & 0x80);
        pos += metaLen;
        continue;
      }

      const type    = (status & 0xF0);
      const midiCh  = (status & 0x0F);
      if (type === 0x90 || type === 0x80) {
        const noteNum = bytes[pos++];
        const vel     = bytes[pos++];
        const isOn    = (type === 0x90 && vel > 0);
        if (isOn) {
          let note = noteNum + octOff * 12;

          // Slash chord override: play the bass note instead
          if (bassOverrideNote && typeof CP_ROOT_TO_SEMITONE !== 'undefined') {
            const bassRoot = CP_ROOT_TO_SEMITONE[bassOverrideNote];
            if (bassRoot !== undefined) {
              const origOct = Math.floor(note / 12);
              note = origOct * 12 + bassRoot;
            }
          }

          note = Math.max(0, Math.min(127, note));
          const startAt  = now + tick * secsPerTick;
          const noteDur  = Math.min(durationSecs * 0.92, durationSecs);

          if (typeof synthTriggerNote === 'function') {
            synthTriggerNote(ch, note, vel, startAt, noteDur);
          }
        }
      } else if (type === 0xA0 || type === 0xB0 || type === 0xE0) {
        pos += 2; // two data bytes
      } else if (type === 0xC0 || type === 0xD0) {
        pos += 1; // one data byte
      }
    }
  } catch(e) {
    console.warn('[ChartPlayer] midi-b64 playback error:', e.message);
  }
}
