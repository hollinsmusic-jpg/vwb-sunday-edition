// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Band Registry
//  js/band-registry.js
//
//  The single source of truth for the VWB House Band and
//  Artist Series system. Manages:
//    • The seven instrument slots
//    • The default House Band members for each slot
//    • Installed Artist Packs and which slot they occupy
//    • Saving and loading band configuration
//
//  No UI lives here. No audio lives here.
//  This module is pure data — other modules read from it.
//
//  Depends on: state.js (showNotification via session.js)
// ═══════════════════════════════════════════════════════════════


// ── Instrument Slots ───────────────────────────────────────────

const BAND_SLOTS = ['drums', 'percussion', 'bass', 'keys', 'organ', 'guitar', 'aux'];

const BAND_SLOT_LABELS = {
  drums:      '🥁 Drums',
  percussion: '🪘 Percussion',
  bass:       '🎸 Bass',
  keys:       '🎹 Keys',
  organ:      '🎹 Organ',
  guitar:     '🎸 Guitar',
  aux:        '🎛 Auxiliary Keys'
};

const BAND_SLOT_DESCRIPTIONS = {
  drums:      'Rhythmic foundation — kick, snare, hi-hat, cymbals',
  percussion: 'Texture and groove — congas, bongos, tambourine, shakers',
  bass:       'Low-end groove — electric or acoustic bass lines',
  keys:       'Harmony and melody — piano, Rhodes, gospel voicings',
  organ:      'Hammond B3 runs, chord hits, and holy atmosphere',
  guitar:     'Rhythm and lead — acoustic or electric gospel guitar',
  aux:        'Atmosphere and texture — strings, pads, synth layers'
};


// ── House Band Members ─────────────────────────────────────────
//  The VWB House Band. Seven musicians representing the full
//  sound of a contemporary gospel worship band.
//  Content recorded by Kenneth Hollins, HMPI.

const HOUSE_BAND = {
  drums: {
    id:          'hb-drums-jason',
    name:        'Jason Washington',
    slot:        'drums',
    type:        'house',
    style:       'Contemporary Gospel',
    ethnicity:   'African American',
    bio:         'Jason Washington is the kind of drummer every worship leader wants behind them. Solid, powerful, and deeply sensitive to the moment — he knows when to drive the congregation and when to pull back and let the Spirit lead. His pocket is tight, his fills are tasteful, and his hi-hat work alone will make your band sound twice as professional.',
    avatar:      null,
    contentPath: null
  },

  percussion: {
    id:          'hb-perc-diane',
    name:        'Diane Moore',
    slot:        'percussion',
    type:        'house',
    style:       'Gospel / Praise & Worship',
    ethnicity:   'African American',
    bio:         'Diane Moore brings warmth, color, and feel to everything she touches. Her conga and tambourine work is rooted in the African American worship tradition, and her shaker patterns add a layer of groove that lifts the entire band. Diane is the heartbeat behind the heartbeat.',
    avatar:      null,
    contentPath: null
  },

  bass: {
    id:          'hb-bass-terry',
    name:        'Terry Washington',
    slot:        'bass',
    type:        'house',
    style:       'Gospel / Quartet',
    ethnicity:   'African American',
    bio:         'Terry Washington locks in with a powerful baseline and never lets go. His bass lines are melodic, authoritative, and deeply rooted in the gospel tradition. Whether he is holding down a slow devotional or riding a praise break, Terry makes the whole band feel like one organism moving together.',
    avatar:      null,
    contentPath: null
  },

  keys: {
    id:          'hb-keys-julian',
    name:        'Julian Cross',
    slot:        'keys',
    type:        'house',
    style:       'Contemporary Gospel / Traditional',
    ethnicity:   'African American',
    bio:         'Julian Cross is a complete gospel pianist. His left hand walks and his right hand sings. He plays with the vocabulary of the church — the turnarounds, the vamps, the chord extensions that make gospel piano instantly recognizable. Julian knows every style from old school Pentecostal to modern worship, and he brings all of it to the table.',
    avatar:      null,
    contentPath: null
  },

  organ: {
    id:          'hb-organ-paul',
    name:        'Paul Simmons',
    slot:        'organ',
    type:        'house',
    style:       'Traditional Gospel / Pentecostal',
    ethnicity:   'African American',
    bio:         'Paul Simmons has been playing Hammond organ in the church since he was twelve years old. His runs are clean, his chord hits land exactly where they need to, and his sense of timing under a preacher is instinctive. When Paul plays, you feel it in your chest. He is the sound of the Black church organ tradition — deep, soulful, and anointed.',
    avatar:      null,
    contentPath: null
  },

  guitar: {
    id:          'hb-guitar-sanchez',
    name:        'Sanchez Rivera',
    slot:        'guitar',
    type:        'house',
    style:       'Gospel / Praise & Worship',
    ethnicity:   'Hispanic',
    bio:         'Sanchez Rivera grew up playing guitar in his family church and never stopped. His rhythm playing is crisp and locked in, and his lead lines have a singing quality that cuts right through the mix. Sanchez brings a warm Latin sensibility to the gospel sound — a voice that is distinctly his own and perfectly at home in any worship setting.',
    avatar:      null,
    contentPath: null
  },

  aux: {
    id:          'hb-aux-larry',
    name:        'Larry Evans',
    slot:        'aux',
    type:        'house',
    style:       'Contemporary Worship / Gospel',
    ethnicity:   'White',
    bio:         'Larry Evans is the painter of the band. While everyone else holds the groove and carries the melody, Larry is building the atmosphere — lush string pads swelling under the message, synth textures adding depth during high praise, soft orchestral layers holding the room during altar call. Larry plays what you feel more than what you hear, and a room with Larry playing feels twice as large.',
    avatar:      null,
    contentPath: null
  }
};


// ── Registry State ─────────────────────────────────────────────

let bandAssignments = {
  drums:      'hb-drums-jason',
  percussion: 'hb-perc-diane',
  bass:       'hb-bass-terry',
  keys:       'hb-keys-julian',
  organ:      'hb-organ-paul',
  guitar:     'hb-guitar-sanchez',
  aux:        'hb-aux-larry'
};

// Installed Artist Packs
// { [packId]: { id, name, artist, slot, style, bio, avatar, contentPath, installDate } }
let installedPacks = {};

let bandRegistryReady = false;


// ── Public API — Reading ───────────────────────────────────────

function bandGetActive(slot) {
  const assignedId = bandAssignments[slot];
  if (!assignedId) return null;

  const houseMember = Object.values(HOUSE_BAND).find(m => m.id === assignedId);
  if (houseMember) return houseMember;

  if (installedPacks[assignedId]) return installedPacks[assignedId];

  return HOUSE_BAND[slot] || null;
}

function bandGetAvailable(slot) {
  const available = [];
  if (HOUSE_BAND[slot]) available.push(HOUSE_BAND[slot]);
  Object.values(installedPacks).forEach(pack => {
    if (pack.slot === slot) available.push(pack);
  });
  return available;
}

function bandGetFullConfig() {
  const config = {};
  BAND_SLOTS.forEach(slot => { config[slot] = bandGetActive(slot); });
  return config;
}

function bandIsHouseMember(slot) {
  const assignedId = bandAssignments[slot];
  return Object.values(HOUSE_BAND).some(m => m.id === assignedId);
}

function bandGetInstalledPacks() {
  return Object.values(installedPacks);
}

function bandGetPacksForSlot(slot) {
  return Object.values(installedPacks).filter(p => p.slot === slot);
}


// ── Public API — Writing ───────────────────────────────────────

function bandAssign(slot, musicianId) {
  if (!BAND_SLOTS.includes(slot)) {
    console.warn('[BandRegistry] Unknown slot:', slot);
    return false;
  }

  const isHouse = Object.values(HOUSE_BAND).some(m => m.id === musicianId);
  const isPack  = !!installedPacks[musicianId];

  if (!isHouse && !isPack) {
    console.warn('[BandRegistry] Unknown musician ID:', musicianId);
    return false;
  }

  bandAssignments[slot] = musicianId;
  bandSaveConfig();

  const musician = bandGetActive(slot);
  if (typeof showNotification === 'function') {
    showNotification('🎵 ' + (musician ? musician.name : musicianId) + ' assigned to ' + BAND_SLOT_LABELS[slot]);
  }

  bandNotifyChange(slot);
  return true;
}

function bandResetSlot(slot) {
  if (!HOUSE_BAND[slot]) return false;
  bandAssignments[slot] = HOUSE_BAND[slot].id;
  bandSaveConfig();
  bandNotifyChange(slot);
  if (typeof showNotification === 'function') {
    showNotification('↩ ' + BAND_SLOT_LABELS[slot] + ' reset to house band');
  }
  return true;
}

function bandResetAll() {
  BAND_SLOTS.forEach(slot => {
    if (HOUSE_BAND[slot]) bandAssignments[slot] = HOUSE_BAND[slot].id;
  });
  bandSaveConfig();
  BAND_SLOTS.forEach(slot => bandNotifyChange(slot));
  if (typeof showNotification === 'function') {
    showNotification('↩ Band reset to full house band');
  }
}

function bandInstallPack(packData) {
  if (!packData || !packData.id || !packData.slot) {
    console.warn('[BandRegistry] Invalid pack data:', packData);
    return false;
  }
  if (!BAND_SLOTS.includes(packData.slot)) {
    console.warn('[BandRegistry] Invalid slot in pack data:', packData.slot);
    return false;
  }

  installedPacks[packData.id] = {
    ...packData,
    type:        'artist',
    installDate: new Date().toISOString()
  };

  bandSaveConfig();

  if (typeof showNotification === 'function') {
    showNotification('📦 ' + packData.name + ' installed');
  }

  if (typeof bandUiRefresh === 'function') bandUiRefresh();
  return true;
}

function bandRemovePack(packId) {
  const pack = installedPacks[packId];
  if (!pack) return false;

  BAND_SLOTS.forEach(slot => {
    if (bandAssignments[slot] === packId) bandResetSlot(slot);
  });

  delete installedPacks[packId];
  bandSaveConfig();

  if (typeof showNotification === 'function') {
    showNotification('🗑 Pack removed');
  }
  return true;
}


// ── Persistence ────────────────────────────────────────────────

async function bandSaveConfig() {
  if (!window.vwb) return;
  try {
    await window.vwb.saveJson('bandConfig', {
      version:     1,
      assignments: bandAssignments,
      packs:       installedPacks,
      savedAt:     new Date().toISOString()
    });
  } catch (e) {
    console.warn('[BandRegistry] Save failed:', e);
  }
}

async function bandLoadConfig() {
  if (!window.vwb) return;
  try {
    const res = await window.vwb.loadJson('bandConfig');
    if (res && res.success && res.data) {
      const d = res.data;
      if (d.assignments) {
        BAND_SLOTS.forEach(slot => {
          if (d.assignments[slot]) bandAssignments[slot] = d.assignments[slot];
        });
      }
      if (d.packs) installedPacks = d.packs;
    }
  } catch (e) {
    console.warn('[BandRegistry] Load failed (first run is normal):', e);
  }
}


// ── Change Notifications ───────────────────────────────────────

const _bandChangeListeners = [];

function bandOnChange(callback) {
  _bandChangeListeners.push(callback);
}

function bandNotifyChange(slot) {
  const musician = bandGetActive(slot);
  _bandChangeListeners.forEach(cb => {
    try { cb(slot, musician); } catch (e) {}
  });
}


// ── Initialization ─────────────────────────────────────────────

async function bandRegistryInit() {
  if (bandRegistryReady) return;
  await bandLoadConfig();
  bandRegistryReady = true;
  console.log('[BandRegistry] Ready —', BAND_SLOTS.map(s => {
    const m = bandGetActive(s);
    return s + ': ' + (m ? m.name : 'unassigned');
  }).join(', '));
}


// ── Compatibility Alias ────────────────────────────────────────
//  bandRegisterPack() was previously defined in house-band-engine.js.
//  It now delegates to bandInstallPack() which lives here.
function bandRegisterPack(pack) {
  return bandInstallPack(pack);
}

// ── Debug Helper ───────────────────────────────────────────────

function bandDebug() {
  console.group('[BandRegistry] Current State');
  BAND_SLOTS.forEach(slot => {
    const m = bandGetActive(slot);
    console.log(' ', BAND_SLOT_LABELS[slot], '→', m ? m.name + ' (' + m.type + ')' : 'NONE');
  });
  console.log('Installed Packs:', Object.keys(installedPacks).length);
  Object.values(installedPacks).forEach(p => {
    console.log('  [' + p.slot + ']', p.name, '—', p.artist);
  });
  console.groupEnd();
}
