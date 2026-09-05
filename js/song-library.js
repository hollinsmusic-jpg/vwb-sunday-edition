// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Song Library
//  js/song-library.js
//
//  The master song library for VWB. Single front desk for all
//  songs regardless of engine type. Handles:
//    • Pre-loaded songs that ship with VWB (congregational hymns,
//      gospel standards, etc.)
//    • User-purchased songs added via .vwbp bundles
//    • User-added songs imported manually
//    • Filtering by key, style, mood, feel, tempo, engine type
//    • Routing each song to the correct VWB engine on launch
//
//  Engine types:
//    'house-band'  → House Band chunk engine (cpLoadChart + cpPlay, in chart-player.js)
//    'flex'        → Flex Engine full arrangement (.vwba, verbatim playback)
//    'audio'       → Audio stems engine (song setup + playback)
//    'rubato'      → Rubato Mode MIDI file (voice-triggered)
//    'organ'       → Armor Bearer organ module
//
//  Preset fields (optional, set via songLibrarySavePreset()):
//    mixerPreset   → house-band/flex: saved reverb/EQ/comp/volume per channel
//    sections      → flex: saved section jump markers
//    stemVolumes   → audio: saved per-stem volume levels
//    vwbaPath      → flex: stored path to the song's .vwba arrangement file
//
//  No audio lives here. No UI lives here.
//  This module is pure data + routing logic.
//
//  Depends on: band-registry.js, house-band-engine.js (for 'house-band' songs)
// ═══════════════════════════════════════════════════════════════


// ── Constants ──────────────────────────────────────────────────

const SL_ENGINE_TYPES = ['house-band', 'audio', 'rubato', 'organ', 'flex'];

const SL_STYLES = [
  'Congregational / Hymn',
  'Worship Ballad',
  'Medium Groove Gospel',
  'High Energy Gospel / Praise',
  'Shout Music',
  'Gospel Waltz',
  'Six-Eight Gospel',
  'Quartet Style Gospel',
  'Shuffle / Swing Gospel',
  'Vamp Groove',
  'Preacher / Talking Music Groove',
];

const SL_MOODS = [
  'Solemn / Reverent',
  'Peaceful / Calm',
  'Warm / Tender',
  'Standard / Neutral',
  'Energetic / Lively',
  'Exciting / Celebratory',
  'Intense / Driving',
];

const SL_FEELS = ['Straight', 'Swing'];

const SL_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// Tempo ranges for display + filtering
const SL_TEMPO_RANGES = [
  { label: 'Slow (< 60)',        min: 0,   max: 59  },
  { label: 'Ballad (60–79)',     min: 60,  max: 79  },
  { label: 'Medium (80–109)',    min: 80,  max: 109 },
  { label: 'Up Tempo (110–139)',  min: 110, max: 139 },
  { label: 'Fast (140+)',        min: 140, max: 9999 },
];

// Song source — how it got into the library
const SL_SOURCES = ['preloaded', 'bundle', 'user-import'];


// ── Pre-Loaded Song Catalog ────────────────────────────────────
//  These songs ship with VWB on installation. They use the
//  'house-band' engine — the House Band performs them using
//  the chunk library in the standard Congregational / Hymn style.
//
//  Chart data (segments) follows VWB House Band Training Data
//  Standard v1.1. Key and tempo represent sensible defaults;
//  the worship leader can transpose at playback time.
//
//  NOTE: Chord segments marked with chordSymbol in standard
//  Roman-numeral notation (as chord-theory.js expects). These
//  are shells — full chord charts will be filled in during
//  the demo song recording sessions.

// ── Pre-Loaded Song Catalog ────────────────────────────────────
//  Empty by design. Songs are added when the user imports a
//  .vwbp bundle or manually imports stems via Song Setup.
//  The library grows as the user adds content — nothing ships
//  pre-populated to avoid broken Launch buttons.

const SL_PRELOADED_SONGS = [];



// ── Library State ──────────────────────────────────────────────

let _slCatalog       = [];   // All songs (preloaded + user-added)
let _slUserSongs     = {};   // User-added songs keyed by id
let _slLibraryReady  = false;

// Turns a song title into a safe ID fragment — letters/numbers/hyphens
// only. Titles routinely contain apostrophes ("I'm a Soldier") which,
// left in an ID, break every onclick="...('${song.id}')" attribute
// built from it in index.html (the quote ends the JS string early).
// ALWAYS build song IDs through this, never title.replace(/\s+/g,'-')
// alone.
function _slSlugify(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'song';
}


// ── Initialization ─────────────────────────────────────────────

async function songLibraryInit() {
  if (_slLibraryReady) return;

  // Start with the preloaded catalog
  _slCatalog = [...SL_PRELOADED_SONGS];

  // Load any user-saved songs from persistent storage
  await _slLoadUserSongs();

  _slLibraryReady = true;
  console.log('[SongLibrary] Ready —', _slCatalog.length, 'songs loaded (' +
    Object.keys(_slUserSongs).length + ' user-added). Import a .vwbp bundle or stems to add songs.');
}


// ── Public API — Reading ───────────────────────────────────────

/**
 * Returns all songs matching ALL active filters (AND logic).
 * Pass an empty filters object {} to get everything.
 *
 * @param {Object} filters
 *   {
 *     search:    string   — title/artist substring match
 *     style:     string   — exact style label
 *     feel:      string   — 'Straight' | 'Swing'
 *     mood:      string   — exact mood label
 *     key:       string   — e.g. 'Bb', 'Ab'
 *     tempoRange: string  — label from SL_TEMPO_RANGES
 *     engine:    string   — 'house-band' | 'audio' | 'rubato' | 'organ'
 *     source:    string   — 'preloaded' | 'bundle' | 'user-import'
 *     tags:      string[] — song must include ALL listed tags
 *   }
 * @returns {Array} sorted array of matching song objects
 */
function songLibraryQuery(filters = {}) {
  let results = [..._slCatalog];

  // Text search (title + artist)
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase();
    results = results.filter(s =>
      s.title.toLowerCase().includes(q) ||
      (s.artist && s.artist.toLowerCase().includes(q)) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(q)))
    );
  }

  // Style filter
  if (filters.style) {
    results = results.filter(s => s.style === filters.style);
  }

  // Feel filter
  if (filters.feel) {
    results = results.filter(s => s.feel === filters.feel);
  }

  // Mood filter
  if (filters.mood) {
    results = results.filter(s => s.mood === filters.mood);
  }

  // Key filter
  if (filters.key) {
    results = results.filter(s => s.key === filters.key);
  }

  // Tempo range filter
  if (filters.tempoRange) {
    const range = SL_TEMPO_RANGES.find(r => r.label === filters.tempoRange);
    if (range) {
      results = results.filter(s => s.tempo >= range.min && s.tempo <= range.max);
    }
  }

  // Engine type filter
  if (filters.engine) {
    results = results.filter(s => s.engine === filters.engine);
  }

  // Source filter
  if (filters.source) {
    results = results.filter(s => s.source === filters.source);
  }

  // Tags filter (song must include ALL requested tags)
  if (filters.tags && filters.tags.length > 0) {
    results = results.filter(s =>
      filters.tags.every(tag => s.tags && s.tags.includes(tag))
    );
  }

  // Sort: preloaded first, then alphabetical by title
  results.sort((a, b) => {
    if (a.source === 'preloaded' && b.source !== 'preloaded') return -1;
    if (a.source !== 'preloaded' && b.source === 'preloaded') return 1;
    return a.title.localeCompare(b.title);
  });

  return results;
}

function songLibraryGetAll() {
  return songLibraryQuery({});
}

function songLibraryGetById(id) {
  return _slCatalog.find(s => s.id === id) || null;
}

function songLibraryGetByStyle(style) {
  return songLibraryQuery({ style });
}

function songLibraryCount() {
  return _slCatalog.length;
}

/**
 * Returns available filter options based on what's actually in the catalog.
 * Used to build filter UI — only shows options that have at least one song.
 */
function songLibraryGetFilterOptions() {
  const songs = _slCatalog;
  return {
    styles:      [...new Set(songs.map(s => s.style).filter(Boolean))].sort(),
    feels:       [...new Set(songs.map(s => s.feel).filter(Boolean))].sort(),
    moods:       [...new Set(songs.map(s => s.mood).filter(Boolean))].sort(),
    keys:        SL_KEYS.filter(k => songs.some(s => s.key === k)),
    tempoRanges: SL_TEMPO_RANGES.filter(r => songs.some(s => s.tempo >= r.min && s.tempo <= r.max)).map(r => r.label),
    engines:     [...new Set(songs.map(s => s.engine).filter(Boolean))].sort(),
  };
}


// ── Public API — Adding Songs ──────────────────────────────────

/**
 * Adds a song from a .vwbp bundle or manual import.
 * Automatically merges into the catalog and persists.
 */
async function songLibraryAddSong(songData) {
  if (!songData || !songData.id || !songData.title) {
    console.warn('[SongLibrary] Invalid song data — id and title required.');
    return false;
  }
  if (!SL_ENGINE_TYPES.includes(songData.engine)) {
    console.warn('[SongLibrary] Unknown engine type:', songData.engine);
    return false;
  }

  // Merge source tag
  if (!songData.source) songData.source = 'user-import';

  // Prevent duplicate IDs
  const existing = _slCatalog.findIndex(s => s.id === songData.id);
  if (existing >= 0) {
    // Update in place
    _slCatalog[existing] = songData;
    _slUserSongs[songData.id] = songData;
  } else {
    _slCatalog.push(songData);
    _slUserSongs[songData.id] = songData;
  }

  await _slSaveUserSongs();

  if (typeof showNotification === 'function') {
    showNotification('📚 "' + songData.title + '" added to Song Library');
  }
  return true;
}

/**
 * Removes a user-added or bundle song from the library.
 * Preloaded songs cannot be removed.
 */
async function songLibraryRemoveSong(id) {
  const song = songLibraryGetById(id);
  if (!song) return false;
  // All songs can be removed — no preloaded protection needed
  _slCatalog = _slCatalog.filter(s => s.id !== id);
  delete _slUserSongs[id];
  await _slSaveUserSongs();
  if (typeof showNotification === 'function') {
    showNotification('🗑 "' + song.title + '" removed from Song Library');
  }
  return true;
}


// ── Preset Capture ──────────────────────────────────────────────

/**
 * Captures the CURRENTLY LOADED song's sections + mixer setup
 * (reverb, EQ, compression, volume — or per-stem volume for Audio
 * Engine songs) and saves it into that song's Song Library entry.
 *
 * Once saved, every future launch of this song via songLibraryLaunch()
 * applies this preset automatically — no manual setup needed.
 *
 * Call this after dialing in the mix and marking sections for a
 * song that's actively loaded in its engine.
 *
 * @param {string} songId
 */
async function songLibrarySavePreset(songId) {
  const libSong = songLibraryGetById(songId);
  if (!libSong) {
    console.warn('[SongLibrary] Cannot save preset — song not found:', songId);
    return false;
  }

  const preset = {};

  if (libSong.engine === 'house-band' || libSong.engine === 'flex') {
    // Both chunk-based House Band chart playback and Flex arrangements
    // share the same channel-based synth mixer, so one preset shape
    // (chVolumes/chPrograms/chOctave/chPan/chReverb*/chEQ*/chComp)
    // works for both.
    const active = (typeof getMidiActive === 'function') ? getMidiActive() : null;
    const src = active || (typeof midiChVolumes !== 'undefined' ? {
      chVolumes: midiChVolumes, chPrograms: (typeof midiChPrograms !== 'undefined' ? midiChPrograms : {}),
      chOctave: (typeof midiChOctave !== 'undefined' ? midiChOctave : {}),
      chPan: (typeof midiChPan !== 'undefined' ? midiChPan : {}),
      chReverbSend: (typeof midiChReverbSend !== 'undefined' ? midiChReverbSend : {}),
      chReverbType: (typeof midiChReverbType !== 'undefined' ? midiChReverbType : {}),
    } : null);
    if (src) {
      preset.mixerPreset = {
        chVolumes:    Object.assign({}, src.chVolumes    || {}),
        chPrograms:   Object.assign({}, src.chPrograms   || {}),
        chOctave:     Object.assign({}, src.chOctave     || {}),
        chPan:        Object.assign({}, src.chPan        || {}),
        chReverbSend: Object.assign({}, src.chReverbSend || {}),
        chReverbType: Object.assign({}, src.chReverbType || {}),
        chEQLow:      Object.assign({}, src.chEQLow      || {}),
        chEQLoMid:    Object.assign({}, src.chEQLoMid    || {}),
        chEQHiMid:    Object.assign({}, src.chEQHiMid    || {}),
        chEQHigh:     Object.assign({}, src.chEQHigh     || {}),
        chComp:       Object.assign({}, src.chComp       || {}),
      };
    }
    // Section jump markers — only meaningful for Flex arrangements;
    // House Band chart sections live inside the chart data itself.
    if (libSong.engine === 'flex' && typeof song !== 'undefined' && Array.isArray(song.secs) && song.secs.length) {
      preset.sections = song.secs.map(s => Object.assign({}, s));
    }
  } else if (libSong.engine === 'audio') {
    // Audio Engine — per-stem volumes (piano/bass/guitar/rhythm)
    if (typeof S !== 'undefined' && typeof SK !== 'undefined') {
      preset.stemVolumes = {};
      SK.forEach(k => { preset.stemVolumes[k] = S[k].vol; });
    }
  }

  if (!preset.mixerPreset && !preset.stemVolumes && !preset.sections) {
    if (typeof showNotification === 'function') {
      showNotification('⚠ Nothing to save yet — load and set up "' + libSong.title + '" first.');
    }
    return false;
  }

  Object.assign(libSong, preset);
  await songLibraryAddSong(libSong);
  if (typeof showNotification === 'function') {
    showNotification('💾 Preset saved for "' + libSong.title + '" — will load automatically next time');
  }
  return true;
}


// ── Engine Routing ─────────────────────────────────────────────

/**
 * The main launch function. Given a song ID and optional key override,
 * routes to the correct engine and starts playback.
 *
 * @param {string} songId
 * @param {Object} [opts]
 *   { keyOverride: 'Ab' }  — play in a different key than the default
 */
async function songLibraryLaunch(songId, opts = {}) {
  const song = songLibraryGetById(songId);
  if (!song) {
    console.warn('[SongLibrary] Song not found:', songId);
    return;
  }

  const effectiveKey = opts.keyOverride || song.key;
  console.log('[SongLibrary] Launching:', song.title, '| Engine:', song.engine, '| Key:', effectiveKey);

  switch (song.engine) {

    case 'house-band': {
      // ── VWB MPC Percussion Loop — direct chunk playback ──
      // Songs imported from the VWB MPC have a percChunk property
      // and use Diane's channel directly rather than a full chart.
      if (song.percChunk && typeof hbPlayPercChunk === 'function') {
        await hbPlayPercChunk(song.percChunk, {
          bpmOverride: opts.tempoOverride || song.tempo,
          keyOverride: effectiveKey !== song.key ? effectiveKey : undefined
        });
        if (typeof goView === 'function') goView('perform');
        if (typeof showNotification === 'function') {
          showNotification('🥁 Percussion: ' + song.title);
        }
        break;
      }

      // ── Standard House Band chart playback ──
      // Routes through chart-player.js's real API (cpLoadChart + cpPlay),
      // not hbPlayChart — that function never existed anywhere in the
      // codebase; house-band-engine.js only provides the channel/program
      // maps and chunk library, not chart playback itself.
      const chart = song.chart
        ? { ...song.chart, key: effectiveKey }
        : _slBuildSimpleChart(song, effectiveKey);

      if (typeof cpLoadChart !== 'function') {
        console.error('[SongLibrary] cpLoadChart() not found — chart-player.js must be loaded first.');
        if (typeof showNotification === 'function') {
          showNotification('⚠ Chart Player engine not ready.');
        }
        return;
      }
      const loaded = cpLoadChart(chart, song.title);
      if (!loaded) {
        if (typeof showNotification === 'function') {
          showNotification('⚠ Could not load "' + song.title + '" — invalid chart.');
        }
        return;
      }

      // Remember which Library song this chart came from, so the House
      // Band Chart Sections card on the Setup page can save edits back
      // to the right entry — see hbSaveSections() in index.html.
      window._cpLoadedLibrarySongId = song.id;

      // Apply this song's saved mixer preset (reverb/EQ/compression/volume),
      // if one was saved for it — see songLibrarySavePreset().
      if (song.mixerPreset && typeof midiApplyMixerSnapshot === 'function') {
        midiApplyMixerSnapshot(song.mixerPreset);
      }

      // Loaded and ready — matches the "click it, everything's set up,
      // just hit Play" behavior. cpLoadChart() does not auto-play.
      if (typeof goView === 'function') goView('perform');
      if (typeof showNotification === 'function') {
        showNotification('🎵 "' + song.title + '" loaded — ready to play');
      }
      break;
    }

    case 'flex': {
      // ── Flex Engine — full multi-track VWB Arrangement (.vwba) ──
      // Loaded from its stored path, then this song's saved sections +
      // mixer preset (if any) are applied so it's ready to play with
      // zero setup — see songLibrarySavePreset().
      if (!song.vwbaPath) {
        console.warn('[SongLibrary] Flex song has no vwbaPath:', song.title);
        if (typeof showNotification === 'function') showNotification('⚠ "' + song.title + '" has no arrangement file on record.');
        break;
      }
      if (typeof addVwbaArrangementFromText !== 'function' || !window.vwb || typeof window.vwb.readFileBuffer !== 'function') {
        console.error('[SongLibrary] Flex Engine not ready — vwb-arrangement.js must be loaded first.');
        break;
      }
      try {
        const rb = await window.vwb.readFileBuffer(song.vwbaPath);
        if (!rb.success) {
          if (typeof showNotification === 'function') showNotification('⚠ Could not read arrangement file for "' + song.title + '"');
          break;
        }
        const text = new TextDecoder('utf-8').decode(rb.buffer);
        const beforeLen = (typeof midiPlaylist !== 'undefined') ? midiPlaylist.length : 0;
        await addVwbaArrangementFromText(text, song.title, song.vwbaPath);

        // If a new entry landed in the playlist, fold this song's saved
        // sections into it, then (re)select it so the existing restore-
        // on-select logic in selectMidiFile() applies everything —
        // sections, volume, EQ, reverb, compression — in one pass.
        if (typeof midiPlaylist !== 'undefined' && midiPlaylist.length > beforeLen) {
          const idx = midiPlaylist.length - 1;
          if (Array.isArray(song.sections) && song.sections.length) {
            midiPlaylist[idx].sections = song.sections.map(s => Object.assign({}, s));
          }
          if (song.mixerPreset) {
            Object.assign(midiPlaylist[idx], {
              chVolumes:    song.mixerPreset.chVolumes,
              chPrograms:   song.mixerPreset.chPrograms,
              chOctave:     song.mixerPreset.chOctave,
              chPan:        song.mixerPreset.chPan,
              chReverbSend: song.mixerPreset.chReverbSend,
              chReverbType: song.mixerPreset.chReverbType,
              chEQLow:      song.mixerPreset.chEQLow,
              chEQLoMid:    song.mixerPreset.chEQLoMid,
              chEQHiMid:    song.mixerPreset.chEQHiMid,
              chEQHigh:     song.mixerPreset.chEQHigh,
              chComp:       song.mixerPreset.chComp,
            });
          }
          if (typeof selectMidiFile === 'function') selectMidiFile(idx);
        }
      } catch (e) {
        console.error('[SongLibrary] Flex load error:', e);
        if (typeof showNotification === 'function') showNotification('⚠ Could not load "' + song.title + '": ' + e.message);
        break;
      }

      if (typeof setVwbEngine === 'function') setVwbEngine('midi', false);
      if (typeof goView === 'function') goView('perform');
      if (typeof showNotification === 'function') {
        showNotification('🎸 "' + song.title + '" loaded — ready to play');
      }
      break;
    }

    case 'audio': {
      // Audio stems engine — load the song's stem paths into Song Setup
      if (song.stems && typeof loadStemsFromSongData === 'function') {
        await loadStemsFromSongData(song);
      }

      // Apply this song's saved per-stem volume preset, if one was saved
      // — see songLibrarySavePreset(). Sections for audio-engine songs
      // are not yet applied here (loadStemsFromSongData's own handling
      // of song.secs needs to be confirmed before wiring that up).
      if (song.stemVolumes && typeof S !== 'undefined' && typeof SK !== 'undefined' && typeof setVol === 'function') {
        SK.forEach(k => {
          if (song.stemVolumes[k] !== undefined) setVol(k, song.stemVolumes[k]);
        });
      }

      if (typeof goView === 'function') goView('setup');
      if (typeof showNotification === 'function') {
        showNotification('🎵 "' + song.title + '" loaded into Song Setup');
      }
      break;
    }

    case 'rubato': {
      // Load into Rubato Mode
      if (song.midiPath && typeof rubatoLoadFile === 'function') {
        await rubatoLoadFile(song.midiPath);
      }
      if (typeof goView === 'function') goView('perform');
      if (typeof showNotification === 'function') {
        showNotification('🎹 "' + song.title + '" loaded into Rubato Mode');
      }
      break;
    }

    case 'organ': {
      // Load organ sample pack / navigate to organ settings
      if (typeof goView === 'function') goView('settings');
      if (typeof showNotification === 'function') {
        showNotification('🎹 "' + song.title + '" — configure in Organ Settings');
      }
      break;
    }

    default:
      console.warn('[SongLibrary] Unknown engine:', song.engine);
  }
}

/**
 * Builds a minimal looping chart for a song that doesn't have a
 * full chord-by-chord chart stored. Uses the song's key to create
 * a simple I–IV–V vamp the House Band can perform over.
 */
function _slBuildSimpleChart(song, key) {
  return {
    songTitle:       song.title,
    key:             key,
    tempo:           song.tempo || 76,
    beatsPerMeasure: song.timeSignature === '3/4' ? 3 : 4,
    segments: [
      { measureStart:1, beatStart:1, measureEnd:4, beatEnd:(song.timeSignature === '3/4' ? 3 : 4),
        chordSymbol: key, section: 'Vamp', style: song.style }
    ]
  };
}


// ── Bundle Integration ─────────────────────────────────────────

/**
 * Called by vwb-bundle.js when a .vwbp bundle is opened.
 * If the bundle's house-band/ folder contains song chart JSON files,
 * they are registered into the Song Library automatically.
 */
async function songLibraryIngestBundleCharts(charts) {
  if (!charts || !Array.isArray(charts)) return;
  let added = 0;
  for (const chart of charts) {
    if (!chart.songTitle || !chart.key) continue;
    const songData = {
      id:          'bundle-' + _slSlugify(chart.songTitle) + '-' + Date.now(),
      title:       chart.songTitle,
      style:       (chart.segments && chart.segments[0] && chart.segments[0].style) || 'Congregational / Hymn',
      feel:        chart.feel || 'Straight',
      mood:        chart.mood || 'Standard / Neutral',
      engine:      'house-band',
      key:         chart.key,
      tempo:       chart.tempo || 76,
      timeSignature: (chart.beatsPerMeasure === 3) ? '3/4' : '4/4',
      source:      'bundle',
      tags:        [],
      chart:       chart,
    };
    await songLibraryAddSong(songData);
    added++;
  }
  if (added > 0 && typeof showNotification === 'function') {
    showNotification('📦 ' + added + ' song' + (added > 1 ? 's' : '') + ' added to Song Library from bundle');
  }
}


// ── Persistence ────────────────────────────────────────────────

async function _slSaveUserSongs() {
  if (!window.vwb) return;
  try {
    await window.vwb.saveJson('songLibraryUserSongs', {
      version: 1,
      songs:   _slUserSongs,
      savedAt: new Date().toISOString()
    });
  } catch (e) {
    console.warn('[SongLibrary] Save failed:', e);
  }
}

async function _slLoadUserSongs() {
  if (!window.vwb) return;
  try {
    const res = await window.vwb.loadJson('songLibraryUserSongs');
    if (res && res.success && res.data && res.data.songs) {
      _slUserSongs = res.data.songs;

      // Self-heal any song saved with an unsafe ID (e.g. a title with
      // an apostrophe, like "I'm a Soldier", produced a raw apostrophe
      // in the ID before this fix — which breaks onclick="...('${id}')"
      // attributes in index.html). Regenerate those IDs once, in place.
      const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
      let healedAny = false;
      const healedSongs = {};
      Object.values(_slUserSongs).forEach(song => {
        if (!SAFE_ID_RE.test(song.id)) {
          const prefix = (song.id.split('-')[0]) || 'user';
          song.id = prefix + '-' + _slSlugify(song.title) + '-' + Date.now() + Math.floor(Math.random() * 1000);
          healedAny = true;
        }
        healedSongs[song.id] = song;
      });
      _slUserSongs = healedSongs;
      if (healedAny) {
        await _slSaveUserSongs();
        console.log('[SongLibrary] Repaired song IDs containing unsafe characters.');
      }

      // Merge user songs into catalog (avoiding overwriting preloaded)
      Object.values(_slUserSongs).forEach(song => {
        if (!SL_PRELOADED_SONGS.find(p => p.id === song.id)) {
          _slCatalog.push(song);
        }
      });
    }
  } catch (e) {
    console.warn('[SongLibrary] Load failed (first run is normal):', e);
  }
}


// ── Helpers ────────────────────────────────────────────────────

function songLibraryTempoLabel(tempo) {
  const range = SL_TEMPO_RANGES.find(r => tempo >= r.min && tempo <= r.max);
  return range ? range.label : tempo + ' BPM';
}

function songLibraryEngineLabel(engine) {
  const labels = {
    'house-band': '🎵 House Band',
    'audio':      '🔊 Audio Stems',
    'flex':       '🎸 Flex Engine',
    'rubato':     '🎙 Rubato Mode',
    'organ':      '🎹 Organ',
    'piano':      '🎹 Piano',
  };
  return labels[engine] || engine;
}

function songLibraryEngineColor(engine) {
  const colors = {
    'house-band': '#40E0D0',
    'audio':      '#44dd88',
    'flex':       '#ff8844',
    'rubato':     '#aa66ff',
    'organ':      '#f0c040',
  };
  return colors[engine] || '#8899aa';
}
