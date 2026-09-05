// ═══════════════════════════════════════════════════════════════
//  VWB Sunday Edition — MIDI File Player
//  MIDI file parsing, playlist management, and playback.
//  Depends on: state.js
// ═══════════════════════════════════════════════════════════════

let midiAccess      = null;
let midiOutPort     = null;
let midiPlaying     = false;
let midiLoopEnabled = false;
let midiStartTime   = 0;
let midiTimers      = [];
let midiActiveNotes = [];
let midiLoopTimer   = null;
let midiTranspose   = 0;       // semitones, -12 to +12
let midiTempoPct    = 100;     // tempo percentage, 50-200
let midiPanelOpen   = false;
let midiPauseAt     = 0;      // seconds, position when paused
let midiAnimFrame   = null;   // animation frame for progress bar
let midiChVolumes   = {};     // channel volumes, keyed by channel 0-15, value 0-127
let midiChNames     = {};     // auto-detected channel names from GM program numbers
let midiChPrograms  = {};     // selected program per channel, -1 = not set
// Note: midiChReverbType / midiChReverbSend are NOT declared here —
// they're already declared elsewhere (likely midi-synth.js) and
// shared as globals. Redeclaring them with `let` crashes the whole
// script on load (duplicate top-level identifier). The setter
// functions below assign into them directly, same as the rest of
// this file already reads from them.
let channelPrograms = {};     // programs read from MIDI file pc events — module-level so all functions can access

// ── VWB Default Mix — Kenneth Hollins, HMPI ───────────────────
const VWB_DEFAULT_MIX = {
  0: { vol: 68, pan: -0.15, eq: { low: -1, loMid: -1, hiMid: -2, high: +1 }, reverb: 'hall', reverbSend: 17, delay: 26, comp: 17 },  // Julian — Keys
  1: { vol: 62, pan:  0.00, eq: { low: +1, loMid: -3, hiMid: +1, high:  0 }, reverb: 'none', reverbSend:  0, delay:  8, comp: 57 },  // Terry  — Bass
  2: { vol: 35, pan: +0.15, eq: { low: -2, loMid: -1, hiMid: -2, high:  0 }, reverb: 'hall', reverbSend: 26, delay: 12, comp: 28 },  // Paul   — Organ
  3: { vol: 40, pan: +0.35, eq: { low: -3, loMid: +1, hiMid: -3, high: +1 }, reverb: 'hall', reverbSend: 32, delay:  0, comp: 36 },  // Sanchez— Guitar
  4: { vol: 46, pan: -0.20, eq: { low: -3, loMid: -3, hiMid: -1, high: +1 }, reverb: 'hall', reverbSend: 19, delay:  0, comp: 14 },  // Larry  — Aux
  9: { vol: 77, pan:  0.00, eq: { low: +2, loMid: -1, hiMid:  0, high: +2 }, reverb: 'hall', reverbSend:  0, delay:  0, comp: 37 },  // Jason  — Drums
};

// Convert fader % (0-100) to dB display value for traditional mixer feel
function _pctToDb(pct) {
  if (pct === 0) return '-∞';
  if (pct >= 100) return '0';
  const db = Math.round(20 * Math.log10(pct / 100));
  return (db >= 0 ? '+' : '') + db;
}

// Apply the default mix to all channels on startup
function applyDefaultMix() {
  Object.entries(VWB_DEFAULT_MIX).forEach(([ch, settings]) => {
    const chInt = parseInt(ch);

    // Volume
    midiChVolumes[chInt] = settings.vol;
    if (typeof synthSetVolume === 'function') synthSetVolume(chInt, settings.vol);

    // Pan — setMidiChPan lives in midi-synth.js
    if (typeof setMidiChPan === 'function') setMidiChPan(chInt, settings.pan);

    // EQ — synthSetEQ takes (ch, bandsObject)
    if (typeof synthSetEQ === 'function') {
      synthSetEQ(chInt, {
        low:   settings.eq.low,
        loMid: settings.eq.loMid,
        hiMid: settings.eq.hiMid,
        high:  settings.eq.high,
      });
    }

    // Reverb type and send — both in midi-synth.js
    if (typeof setMidiChReverbType === 'function') setMidiChReverbType(chInt, settings.reverb);
    if (typeof setMidiChReverbSend === 'function') setMidiChReverbSend(chInt, settings.reverbSend);

    // Depth delay
    if (typeof synthSetDelay === 'function') synthSetDelay(chInt, settings.delay);

    // Compressor — setMidiChCompressor lives in midi-player.js
    if (typeof setMidiChCompressor === 'function') setMidiChCompressor(chInt, settings.comp);

    // Update UI sliders to reflect new values
    const slider = document.querySelector(`input.vwb-fader[oninput*="setMidiChannelVolume(${chInt}"]`);
    if (slider) slider.value = settings.vol;
    const volEl = document.getElementById('midiChVol_' + chInt);
    if (volEl) volEl.textContent = settings.vol + '%';
    const dbEl = document.getElementById('midiChDb_' + chInt);
    if (dbEl) dbEl.textContent = _pctToDb(settings.vol) + ' dB';
  });
  console.log('[VWB] Default mix applied —', Object.keys(VWB_DEFAULT_MIX).length, 'channels');
}

// Playlist — up to 8 files
// Each entry: { events, duration, noteCount, trackCount, fileName, storedPath,
//               sections, transpose, tempoPct, chVolumes, chPrograms, chOctave }
let midiPlaylist  = [];
let midiActiveIdx = -1;

// Legacy compat vars pointed at active file
let midiStoredPath = '';
let midiFileName   = '';
let midiEvents     = [];
let midiDuration   = 0;


// ── Helpers ────────────────────────────────────────────────────

function getMidiActive() {
  return midiActiveIdx >= 0 && midiActiveIdx < midiPlaylist.length
    ? midiPlaylist[midiActiveIdx]
    : null;
}

// ── MIDI File Parser ───────────────────────────────────────────


// ===================================================================
//  VWB MIDI Track Auto-Splitter
//  Detects merged MIDI files and re-channels each track to the
//  correct House Band slot using note-range analysis.
// ===================================================================
const HB_SPLIT_SLOTS = [
  { slot:'drums',      ch:9, prog:128, label:'Drums - Jason',      noteMin:35, noteMax:59  },
  { slot:'percussion', ch:8, prog:200, label:'Percussion - Diane', noteMin:48, noteMax:67  },
  { slot:'bass',       ch:1, prog:33,  label:'Bass - Terry',        noteMin:28, noteMax:55  },
  { slot:'keys',       ch:0, prog:0,   label:'Keys - Julian',       noteMin:36, noteMax:84  },
  { slot:'organ',      ch:2, prog:16,  label:'Organ - Paul',        noteMin:36, noteMax:84  },
  { slot:'guitar',     ch:3, prog:24,  label:'Guitar - Sanchez',    noteMin:40, noteMax:76  },
  { slot:'aux',        ch:4, prog:48,  label:'Aux - Larry',         noteMin:36, noteMax:96  },
];

function _scoreTrackForSlot(noteEvents, slotDef) {
  if (!noteEvents || noteEvents.length === 0) return 9999;
  const notes = noteEvents.map(function(e){return e.note;});
  const centroid = notes.reduce(function(a,b){return a+b;},0) / notes.length;
  const slotCenter = (slotDef.noteMin + slotDef.noteMax) / 2;
  const outOfRange = notes.filter(function(n){return n < slotDef.noteMin || n > slotDef.noteMax;}).length;
  return Math.abs(centroid - slotCenter) + (outOfRange / notes.length) * 30;
}

function _autoSplitMidiTracks(events) {
  var trackNotes = {}, trackAllEvs = {};
  events.forEach(function(ev) {
    var t = ev.trk !== undefined ? ev.trk : 0;
    if (!trackAllEvs[t]) trackAllEvs[t] = [];
    trackAllEvs[t].push(ev);
    if (ev.type === 'on' && ev.vel > 0) {
      if (!trackNotes[t]) trackNotes[t] = [];
      trackNotes[t].push(ev);
    }
  });

  var tracks = Object.keys(trackNotes).map(Number).sort(function(a,b){return a-b;});
  if (tracks.length === 0) return { events: events, channelPrograms: {}, slotAssignments: {} };

  // Score every track against every slot, assign greedily best-first
  var scores = [];
  tracks.forEach(function(t) {
    HB_SPLIT_SLOTS.forEach(function(slotDef) {
      scores.push({ trk:t, slot:slotDef.slot, score:_scoreTrackForSlot(trackNotes[t], slotDef) });
    });
  });
  scores.sort(function(a,b){return a.score - b.score;});

  var usedTrks = {}, usedSlots = {}, trkToSlot = {};
  scores.forEach(function(s) {
    if (usedTrks[s.trk] || usedSlots[s.slot]) return;
    trkToSlot[s.trk] = HB_SPLIT_SLOTS.find(function(d){return d.slot===s.slot;});
    usedTrks[s.trk] = true;
    usedSlots[s.slot] = true;
  });
  // Assign remaining unmatched tracks to leftover slots
  var remSlots = HB_SPLIT_SLOTS.filter(function(d){return !usedSlots[d.slot];});
  var ri = 0;
  tracks.forEach(function(t) {
    if (!trkToSlot[t] && ri < remSlots.length) trkToSlot[t] = remSlots[ri++];
  });

  // Re-channel all events
  var newEvents = events.map(function(ev) {
    var t = ev.trk !== undefined ? ev.trk : 0;
    var sd = trkToSlot[t];
    if (!sd) return ev;
    var ne = Object.assign({}, ev);
    ne.ch = sd.ch;
    return ne;
  });

  var channelPrograms = {}, slotAssignments = {};
  Object.keys(trkToSlot).forEach(function(trk) {
    var sd = trkToSlot[trk];
    channelPrograms[sd.ch] = sd.prog;
    slotAssignments[sd.ch] = {
      slot: sd.slot, label: sd.label,
      trk: parseInt(trk),
      noteCount: (trackNotes[trk]||[]).length
    };
  });

  console.log('[VWB AutoSplit] Assignments:');
  Object.keys(slotAssignments).forEach(function(ch) {
    var a = slotAssignments[ch];
    console.log('  Trk'+a.trk+' -> Ch'+(parseInt(ch)+1)+' '+a.label+' ('+a.noteCount+' notes)');
  });

  // Confidence check: this whole split is a pitch-range GUESS (the file
  // has no real per-track MIDI channels to go on). Overlapping instrument
  // ranges (e.g. drums vs percussion) make some guesses unreliable, and
  // a bad guess sounds like "wrong instrument triggering" chaos with no
  // obvious cause. Surface that risk instead of hiding it.
  var matchedScores = scores.filter(function(s) { return trkToSlot[s.trk] && trkToSlot[s.trk].slot === s.slot; });
  var avgScore = matchedScores.length
    ? matchedScores.reduce(function(sum, s){ return sum + s.score; }, 0) / matchedScores.length
    : 0;
  var lowConfidence = avgScore > 15; // empirically: well-separated instruments score under ~10

  console.log('[VWB AutoSplit] Confidence score (lower = better): ' + avgScore.toFixed(1) +
    (lowConfidence ? '  ⚠ LOW CONFIDENCE — some tracks may be misrouted' : '  ✓ looks solid'));

  return { events: newEvents, channelPrograms: channelPrograms, slotAssignments: slotAssignments, lowConfidence: lowConfidence, avgScore: avgScore };
}

function parseMidiFile(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  let pos = 0;

  function readUint16() { const v = (data[pos]<<8)|data[pos+1]; pos+=2; return v; }
  function readUint32() { const v = (data[pos]<<24)|(data[pos+1]<<16)|(data[pos+2]<<8)|data[pos+3]; pos+=4; return v; }
  function readVarLen() {
    let val = 0;
    while (true) {
      const b = data[pos++];
      val = (val << 7) | (b & 0x7F);
      if (!(b & 0x80)) break;
    }
    return val;
  }

  const hdrId = String.fromCharCode(data[0],data[1],data[2],data[3]);
  if (hdrId !== 'MThd') throw new Error('Not a valid MIDI file');
  pos = 4;
  const hdrLen     = readUint32();
  const format     = readUint16();
  const numTracks  = readUint16();
  const timeDivision = readUint16();
  pos = 8 + hdrLen;

  let allEvents = [];

  for (let t = 0; t < numTracks; t++) {
    pos += 4; // track ID
    const trkLen = readUint32();
    const trkEnd = pos + trkLen;
    let absTick = 0, runningStatus = 0;

    while (pos < trkEnd) {
      const delta = readVarLen();
      absTick += delta;
      let statusByte = data[pos];
      if (statusByte & 0x80) {
        pos++;
        if (statusByte < 0xF0) runningStatus = statusByte;
      } else {
        statusByte = runningStatus;
      }

      const type = statusByte & 0xF0;
      const ch   = statusByte & 0x0F;

      if (type === 0x90 || type === 0x80) {
        const note = data[pos++], vel = data[pos++];
        allEvents.push({ tick: absTick, type: (type===0x90 && vel>0)?'on':'off', note, vel, ch, trk: t });
      } else if (type === 0xA0) { pos += 2; }
      else if (type === 0xB0) {
        // Control Change — capture CC7 (volume) and CC10 (pan) and CC123 (all notes off)
        const cc = data[pos++], ccVal = data[pos++];
        allEvents.push({ tick: absTick, type: 'cc', cc, val: ccVal, ch, trk: t });
      }
      else if (type === 0xC0) {
        // Program Change — capture so we can send correct instrument per channel
        const program = data[pos++];
        allEvents.push({ tick: absTick, type: 'pc', program, ch, trk: t });
      }
      else if (type === 0xD0) { pos += 1; }
      else if (type === 0xE0) { pos += 2; }
      else if (statusByte === 0xFF) {
        const metaType = data[pos++], metaLen = readVarLen();
        if (metaType === 0x51 && metaLen === 3) {
          const uspqn = (data[pos]<<16)|(data[pos+1]<<8)|data[pos+2];
          allEvents.push({ tick: absTick, type:'tempo', uspqn });
        }
        if (metaType === 0x59 && metaLen === 2) {
          // Key signature: byte 0 = sharps(+) or flats(-), byte 1 = 0=major 1=minor
          const sharps = data[pos] > 127 ? data[pos] - 256 : data[pos]; // signed byte
          const minor  = data[pos + 1] === 1;
          allEvents.push({ tick: absTick, type: 'keysig', sharps, minor });
        }
        pos += metaLen;
      } else if (statusByte === 0xF0 || statusByte === 0xF7) {
        const sysLen = readVarLen(); pos += sysLen;
      } else { pos++; }
    }
    pos = trkEnd;
  }

  allEvents.sort((a, b) => a.tick - b.tick);

  let currentTempo = 500000, currentTick = 0, currentTime = 0;
  const ticksPerBeat = timeDivision;
  const timedEvents = [];

  for (const ev of allEvents) {
    const deltaTicks = ev.tick - currentTick;
    const deltaTime  = (deltaTicks / ticksPerBeat) * (currentTempo / 1000000);
    currentTime += deltaTime;
    currentTick  = ev.tick;
    if (ev.type === 'tempo') {
      currentTempo = ev.uspqn;
    } else {
      timedEvents.push({ time: currentTime, type: ev.type, note: ev.note, vel: ev.vel, ch: ev.ch, program: ev.program, cc: ev.cc, val: ev.val, trk: ev.trk !== undefined ? ev.trk : 0 });
    }
  }

  // ── Calculate note durations ────────────────────────────────
  // Pair each note-on with its matching note-off to get exact hold time.
  // This lets the synth use triggerAttackRelease for natural-sounding playback.
  const pendingNotes = {}; // key: "ch_note" → index in timedEvents
  for (let i = 0; i < timedEvents.length; i++) {
    const ev = timedEvents[i];
    const key = ev.ch + '_' + ev.note;
    if (ev.type === 'on' && ev.vel > 0) {
      pendingNotes[key] = i;
    } else if (ev.type === 'off' || (ev.type === 'on' && ev.vel === 0)) {
      if (pendingNotes[key] !== undefined) {
        const onIdx = pendingNotes[key];
        timedEvents[onIdx].duration = ev.time - timedEvents[onIdx].time;
        delete pendingNotes[key];
      }
    }
  }
  // Any notes still pending (no note-off found) get a default duration
  Object.values(pendingNotes).forEach(idx => {
    if (!timedEvents[idx].duration) timedEvents[idx].duration = 0.5;
  });

  // Extract first tempo event for BPM detection
  const firstTempoEv = allEvents.find(e => e.type === 'tempo');
  const detectedBpm  = firstTempoEv ? Math.round(60000000 / firstTempoEv.uspqn) : null;

  // Extract key signature
  const firstKeySig  = allEvents.find(e => e.type === 'keysig');
  const detectedKey  = firstKeySig ? { sharps: firstKeySig.sharps, minor: firstKeySig.minor } : null;

  // Detect merged file (Type 0 or all notes on one channel across multiple tracks)
  const _activeChs  = new Set(timedEvents.filter(e=>e.type==='on').map(e=>e.ch));
  const _activeTrks = new Set(timedEvents.filter(e=>e.type==='on').map(e=>e.trk));
  // Merged = Type 0, OR multi-track file where all notes landed on one channel
  const isMerged = (format === 0) || (_activeChs.size <= 1 && numTracks > 1);

  // ── DIAGNOSTIC LOG — remove after testing ──────────────────
  console.log('[VWB MIDI Parse]',
    'format='+format,
    'tracks='+numTracks,
    'activeChs=['+[..._activeChs].sort((a,b)=>a-b).join(',')+']',
    'activeTrks=['+[..._activeTrks].sort((a,b)=>a-b).join(',')+']',
    'isMerged='+isMerged,
    'totalNoteOns='+timedEvents.filter(e=>e.type==='on').length
  );
  // ── END DIAGNOSTIC ─────────────────────────────────────────

  return {
    events:      timedEvents,
    duration:    currentTime,
    noteCount:   timedEvents.filter(e => e.type === 'on').length,
    trackCount:  numTracks,
    detectedBpm,
    detectedKey,
    ticksPerBeat: timeDivision,
    isMerged,
    format
  };
}

// ── General MIDI Instrument Names ─────────────────────────────
const GM_NAMES = [
  'Acoustic Grand Piano','Bright Acoustic Piano','Electric Grand Piano','Honky-tonk Piano',
  'Electric Piano 1','Electric Piano 2','Harpsichord','Clavinet',
  'Celesta','Glockenspiel','Music Box','Vibraphone','Marimba','Xylophone','Tubular Bells','Dulcimer',
  'Drawbar Organ','Percussive Organ','Rock Organ','Church Organ','Reed Organ','Accordion','Harmonica','Tango Accordion',
  'Acoustic Guitar (nylon)','Acoustic Guitar (steel)','Electric Guitar (jazz)','Electric Guitar (clean)',
  'Electric Guitar (muted)','Overdriven Guitar','Distortion Guitar','Guitar Harmonics',
  'Acoustic Bass','Electric Bass (finger)','Electric Bass (pick)','Fretless Bass',
  'Slap Bass 1','Slap Bass 2','Synth Bass 1','Synth Bass 2',
  'Violin','Viola','Cello','Contrabass','Tremolo Strings','Pizzicato Strings','Orchestral Harp','Timpani',
  'String Ensemble 1','String Ensemble 2','Synth Strings 1','Synth Strings 2',
  'Choir Aahs','Voice Oohs','Synth Voice','Orchestra Hit',
  'Trumpet','Trombone','Tuba','Muted Trumpet','French Horn','Brass Section','Synth Brass 1','Synth Brass 2',
  'Soprano Sax','Alto Sax','Tenor Sax','Baritone Sax',
  'Oboe','English Horn','Bassoon','Clarinet',
  'Piccolo','Flute','Recorder','Pan Flute','Blown Bottle','Shakuhachi','Whistle','Ocarina',
  'Lead 1 (square)','Lead 2 (sawtooth)','Lead 3 (calliope)','Lead 4 (chiff)',
  'Lead 5 (charang)','Lead 6 (voice)','Lead 7 (fifths)','Lead 8 (bass+lead)',
  'Pad 1 (new age)','Pad 2 (warm)','Pad 3 (polysynth)','Pad 4 (choir)',
  'Pad 5 (bowed)','Pad 6 (metallic)','Pad 7 (halo)','Pad 8 (sweep)',
  'FX 1 (rain)','FX 2 (soundtrack)','FX 3 (crystal)','FX 4 (atmosphere)',
  'FX 5 (brightness)','FX 6 (goblins)','FX 7 (echoes)','FX 8 (sci-fi)',
  'Sitar','Banjo','Shamisen','Koto','Kalimba','Bag pipe','Fiddle','Shanai',
  'Tinkle Bell','Agogo','Steel Drums','Woodblock','Taiko Drum','Melodic Tom','Synth Drum','Reverse Cymbal',
  'Guitar Fret Noise','Breath Noise','Seashore','Bird Tweet','Telephone Ring','Helicopter','Applause','Gunshot'
];

function getGMName(program) {
  return GM_NAMES[program] || ('Program ' + (program + 1));
}

// Detect which channels are active in a MIDI event list and their instrument names
function detectActiveChannels(events) {
  const channels = {};
  events.forEach(ev => {
    if (ev.type === 'on' && !(ev.ch in channels)) {
      channels[ev.ch] = { ch: ev.ch, name: ev.ch === 9 ? 'Drums' : 'Channel ' + (ev.ch + 1), program: -1 };
    }
    if (ev.type === 'pc' && channels[ev.ch]) {
      channels[ev.ch].program = ev.program;
      channels[ev.ch].name = ev.ch === 9 ? 'Drums' : getGMName(ev.program);
    }
  });
  // Set GM names for channels with program changes found before note events
  events.forEach(ev => {
    if (ev.type === 'pc' && !(ev.ch in channels)) {
      channels[ev.ch] = { ch: ev.ch, name: ev.ch === 9 ? 'Drums' : getGMName(ev.program), program: ev.program };
    }
  });
  return Object.values(channels).sort((a, b) => a.ch - b.ch);
}

// ── Web MIDI API ───────────────────────────────────────────────
let _midiInitAttempted = false;  // only try once — prevents console flood

async function initMidi() {
  if (_midiInitAttempted) return;
  _midiInitAttempted = true;
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    midiAccess.onstatechange = () => refreshMidiPorts();
    refreshMidiPorts();
    setMidiStatus('MIDI access granted. Select an output port.', 'connected');
  } catch(e) {
    console.warn('Web MIDI not available:', e.message || e);
    setMidiStatus('MIDI not available in this browser. Use Chrome for MIDI support.', 'error');
  }
}

function refreshAllMidiPortSelectors() { refreshMidiPorts(); }

function refreshMidiPorts() {
  const sel = document.getElementById('midiPortSelect');
  if (!sel || !midiAccess) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">-- Select MIDI Output --</option>';
  midiAccess.outputs.forEach(port => {
    const opt = document.createElement('option');
    opt.value   = port.id;
    opt.textContent = port.name || ('MIDI Output ' + port.id);
    sel.appendChild(opt);
  });
  if (currentVal) sel.value = currentVal;
  if (midiAccess.outputs.size === 0) {
    setMidiStatus('No MIDI output devices found. Connect a USB-MIDI interface and click Refresh.', '');
  }
}

function selectMidiPort(portId) {
  if (!midiAccess) return;
  if (!portId) { midiOutPort = null; setMidiStatus('No output selected', ''); return; }
  midiOutPort = midiAccess.outputs.get(portId);
  if (midiOutPort) {
    setMidiStatus('Connected: ' + (midiOutPort.name || portId), 'connected');
  } else {
    setMidiStatus('Port not found', 'error');
  }
}

function setMidiStatus(msg, cls) {
  const el = document.getElementById('midiStatus');
  if (el) { el.textContent = msg; el.className = 'midi-status' + (cls ? ' ' + cls : ''); }
}

// ── Panel Toggle ───────────────────────────────────────────────

function toggleMidiPanel() {
  midiPanelOpen = !midiPanelOpen;
  const body  = document.getElementById('midiPanelBody');
  const arrow = document.getElementById('midiToggleArrow');
  const hint  = document.getElementById('midiPanelHint');
  if (body)  body.style.display  = midiPanelOpen ? 'block' : 'none';
  if (arrow) arrow.style.transform = midiPanelOpen ? 'rotate(90deg)' : '';
  if (hint)  hint.textContent = midiPanelOpen ? 'Click to collapse' : 'Click to expand';
}

let rubatoPanelOpen = false;
function toggleRubatoCard() {
  rubatoPanelOpen = !rubatoPanelOpen;
  const body  = document.getElementById('rubatoCardBody');
  const arrow = document.getElementById('rubatoToggleArrow');
  const hint  = document.getElementById('rubatoCardHint');
  if (body)  body.style.display    = rubatoPanelOpen ? 'block' : 'none';
  if (arrow) arrow.style.transform = rubatoPanelOpen ? 'rotate(90deg)' : '';
  if (hint)  hint.textContent      = rubatoPanelOpen ? 'Click to collapse' : 'Click to expand';
  if (rubatoPanelOpen) {
    if (typeof rbInitAudio === 'function') rbInitAudio();
    if (typeof renderRubatoCard === 'function') renderRubatoCard();
  }
}

// ── Reset transpose and tempo to original file values ─────────
function resetMidiTransposeAndTempo() {
  midiTranspose = 0;
  midiTempoPct  = 100;
  _updateKeyDisplay();
  _updateTempoDisplay();
  const active = getMidiActive();
  if (active) { active.transpose = 0; active.tempoPct = 100; }
  if (typeof syncMidiTempoToSongInfo === 'function') syncMidiTempoToSongInfo(midiBpm || 120);
  if (midiPlaying) _midiLiveRestart();
}

function adjustMidiTranspose(delta) {
  midiTranspose = Math.max(-12, Math.min(12, midiTranspose + delta));
  _updateKeyDisplay();
  const active = getMidiActive();
  if (active) active.transpose = midiTranspose;
  if (midiPlaying) _midiLiveRestart();
}

function adjustMidiTempo(bpmDelta) {
  const baseBpm    = midiBpm || 120;
  const currentBpm = _getCurrentBpm();
  const newBpm     = Math.max(30, Math.min(300, currentBpm + bpmDelta));
  midiTempoPct     = (newBpm / baseBpm) * 100;
  _updateTempoDisplay();
  const active = getMidiActive();
  if (active) active.tempoPct = midiTempoPct;
  if (typeof syncMidiTempoToSongInfo === 'function') syncMidiTempoToSongInfo(Math.round(newBpm));
  if (midiPlaying) _midiLiveRestart();
}

function setMidiTempoFromInput(val) {
  const baseBpm = midiBpm || 120;
  const newBpm  = Math.max(30, Math.min(300, parseInt(val) || baseBpm));
  midiTempoPct  = (newBpm / baseBpm) * 100;
  _updateTempoDisplay();
  const active = getMidiActive();
  if (active) active.tempoPct = midiTempoPct;
  if (typeof syncMidiTempoToSongInfo === 'function') syncMidiTempoToSongInfo(Math.round(newBpm));
  if (midiPlaying) _midiLiveRestart();
}

// Restart playback from current position — used for real-time key/tempo changes
function _midiLiveRestart() {
  const pos = getMidiCurrentTime();
  midiTimers.forEach(t => clearTimeout(t));
  midiTimers = [];
  if (typeof allNotesOff === 'function') allNotesOff();
  midiPlaying = false;
  midiPauseAt = pos;
  startMidiPlay(pos);
}

// ── Playlist Management ────────────────────────────────────────

function renderMidiPlaylist() {
  const pl    = document.getElementById('midiPlaylist');
  const addBtn = document.getElementById('midiAddBtn');
  if (!pl) return;
  pl.innerHTML = '';
  if (!midiPlaylist.length) {
    pl.innerHTML = '<p style="font-size:.8rem;color:var(--text-dim);font-style:italic;padding:.25rem 0;">No MIDI files loaded. Click + Add MIDI File below.</p>';
  }
  midiPlaylist.forEach((item, i) => {
    const isActive = i === midiActiveIdx;
    pl.innerHTML +=
      '<div style="display:flex;align-items:center;gap:.5rem;padding:.4rem .6rem;border-radius:7px;border:1px solid ' +
      (isActive ? 'var(--orange)' : 'var(--border)') +
      ';background:' + (isActive ? 'rgba(255,136,68,.08)' : 'var(--bg-tertiary)') +
      ';cursor:pointer;" onclick="selectMidiFile(' + i + ')">' +
      '<span style="font-size:.75rem;font-family:\'Space Mono\',monospace;color:var(--text-dim);min-width:16px;">' + (i+1) + '</span>' +
      '<span style="font-size:.82rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' +
      (isActive ? 'var(--orange)' : 'var(--text-primary)') + ';" title="' + item.fileName + '">' + item.fileName + '</span>' +
      '<span style="font-size:.68rem;color:var(--text-dim);font-family:\'Space Mono\',monospace;">' + fmt(item.duration) + '</span>' +
      '<button style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.85rem;padding:0 .2rem;opacity:.6;" onclick="event.stopPropagation();removeMidiFile(' + i + ')">×</button>' +
      '</div>';
  });
  if (addBtn) addBtn.style.display = midiPlaylist.length >= 8 ? 'none' : '';

  const active   = getMidiActive();
  const nameEl   = document.getElementById('midiActiveName');
  const detailEl = document.getElementById('midiActiveDetail');
  if (nameEl)   nameEl.textContent   = active ? active.fileName : 'No file selected';
  if (detailEl) detailEl.textContent = active
    ? (active.noteCount + ' notes · ' + active.trackCount + ' tracks · ' + fmt(active.duration))
    : '';
}

function selectMidiFile(idx) {
  if (midiPlaying) stopMidiPlay();
  midiPauseAt   = 0;
  midiCurSec    = -1;
  midiQueuedSec = -1;
  midiSecLoopOn = false;
  midiActiveIdx = idx;

  const active = getMidiActive();
  if (active) {
    midiEvents   = active.events;
    midiDuration = active.duration;
    midiFileName = active.fileName;
    midiStoredPath = active.storedPath;

    // Restore per-file BPM and time signature
    midiBpm     = active.bpm     || active.detectedBpm || 120;
    midiTimeSig = active.timeSig || 4;

    // Restore per-file transpose / tempo
    midiTranspose = active.transpose !== undefined ? active.transpose : 0;
    midiTempoPct  = active.tempoPct  !== undefined ? active.tempoPct  : 100;
    _updateKeyDisplay();
    _updateTempoDisplay();

    // Restore per-file channel settings
    midiChVolumes  = Object.assign({}, active.chVolumes  || {});
    midiChPrograms = Object.assign({}, active.chPrograms || {});
    midiChOctave   = Object.assign({}, active.chOctave   || {});
    midiChHBSlot   = Object.assign({}, active.chHBSlot   || {});
    midiChMute     = {};
    midiChSolo     = {};

    // Restore per-channel FX settings
    if (typeof midiChPan        !== 'undefined') midiChPan        = Object.assign({}, active.chPan        || {});
    if (typeof midiChReverbSend !== 'undefined') midiChReverbSend = Object.assign({}, active.chReverbSend || {});
    if (typeof midiChReverbType !== 'undefined') midiChReverbType = Object.assign({}, active.chReverbType || {});
    // Restore EQ + compressor — previously these were session-only and
    // never restored on file switch, unlike volume/programs/pan/reverb
    // above. Fixed as part of the Song Library preset feature so a
    // song's full mixer setup (including EQ/comp) travels with it.
    _midiChEQLow    = Object.assign({}, active.chEQLow    || {});
    _midiChEQLowMid = Object.assign({}, active.chEQLoMid  || {});
    _midiChEQHiMid  = Object.assign({}, active.chEQHiMid  || {});
    _midiChEQHigh   = Object.assign({}, active.chEQHigh   || {});
    _midiChCompAmt  = Object.assign({}, active.chComp     || {});
    Object.keys(_midiChEQLow).forEach(ch => _applyEQ(ch));
    Object.keys(_midiChEQLowMid).forEach(ch => _applyEQ(ch));
    Object.keys(_midiChEQHiMid).forEach(ch => _applyEQ(ch));
    Object.keys(_midiChEQHigh).forEach(ch => _applyEQ(ch));
    Object.entries(_midiChCompAmt).forEach(([ch, amt]) => {
      if (typeof synthSetCompressor === 'function') synthSetCompressor(parseInt(ch), amt);
    });

    // Auto-detect channels; fill in names
    const detected = detectActiveChannels(active.events);
    midiChNames = {};
    detected.forEach(ch => {
      midiChNames[ch.ch] = ch.name;
      if (!(ch.ch in midiChPrograms)) midiChPrograms[ch.ch] = ch.program;
      if (!(ch.ch in midiChVolumes))  midiChVolumes[ch.ch]  = 100;
    });

    // Auto-route channels to House Band slots based on channel number
    _hbAutoRouteChannels();

    // Restore sections — midiSections is legacy/unused by the live jump
    // system; song.secs is the shared array actually used by queueSection()
    // and the Song Sections editor (renderSections/addSec), for both
    // Audio and Flex engines. Same one-way restore-on-select pattern as
    // chVolumes/chPrograms above — no live save-back yet, consistent
    // with how those already behave.
    midiSections = active.sections ? active.sections.map(s => Object.assign({}, s)) : [];
    song.secs = (active.sections && Array.isArray(active.sections))
      ? active.sections.map(s => Object.assign({}, s))
      : [];
    if (typeof renderSections === 'function') renderSections();
  }

  renderMidiPlaylist();
  renderMidiMixer();
  renderMidiSectionEditor();
  updatePerfMidiSecUI();
  updatePerfMidiUI();
  if (typeof _cpUpdateFlexMixerVisibility === 'function') _cpUpdateFlexMixerVisibility();
  _syncMidiPerfHeader();

  // Sync BPM/timeSig into Song Info when MIDI engine is active
  if (typeof syncMidiBpmFromActive === 'function') syncMidiBpmFromActive();

  // Reinitialize beat indicator dots for MIDI time signature
  if (typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi') {
    const bi = document.getElementById('beatInd');
    if (bi) {
      bi.innerHTML = '';
      const beats = typeof midiTimeSig !== 'undefined' ? midiTimeSig : 4;
      for (let i = 0; i < beats; i++) bi.innerHTML += '<div class="b-dot"></div>';
    }
  }
}

function removeMidiFile(idx) {
  if (midiPlaying && midiActiveIdx === idx) stopMidiPlay();
  midiPlaylist.splice(idx, 1);
  if (midiActiveIdx >= midiPlaylist.length) midiActiveIdx = midiPlaylist.length - 1;
  const active = getMidiActive();
  if (active) {
    midiEvents = active.events; midiDuration = active.duration;
    midiFileName = active.fileName; midiStoredPath = active.storedPath;
  } else {
    midiEvents = []; midiDuration = 0; midiFileName = ''; midiStoredPath = '';
  }
  renderMidiPlaylist();
  updatePerfMidiUI();
}

async function addMidiFileFromBuffer(ab, fileName, storedPath, savedEntry) {
  try {
    const result = parseMidiFile(ab);

    // Auto-split merged MIDI files so each track routes to the correct
    // House Band slot. User can override any strip after load.
    let events = result.events;
    let autoChPrograms = {};
    let autoHBSlot = {};
    const hasSavedPrograms = savedEntry && savedEntry.chPrograms &&
                             Object.keys(savedEntry.chPrograms).length > 0;
    if (result.isMerged && !hasSavedPrograms) {
      const split = _autoSplitMidiTracks(result.events);
      events = split.events;
      autoChPrograms = split.channelPrograms;
      Object.keys(split.slotAssignments).forEach(function(ch) {
        autoHBSlot[parseInt(ch)] = split.slotAssignments[ch].slot;
      });
      const tc = Object.keys(split.slotAssignments).length;
      if (typeof showNotification === 'function') {
        if (split.lowConfidence) {
          showNotification('⚠️ ' + tc + ' tracks auto-routed by GUESSING (no real MIDI channels found) — routing may be wrong. Check each instrument, or re-export with named/channeled tracks and convert to .vwba for reliable playback.');
        } else {
          showNotification('Auto-routed ' + tc + ' tracks to House Band - tap any name to reassign');
        }
      }
      console.log('[VWB] Auto-split done: format=' + result.format + ' tracks=' + result.trackCount);
    }

    // For merged/split files, recalculate duration from actual event times
    // because Type 1 MIDI tempo track parsing can produce wrong durations
    let computedDuration = result.duration;
    if (result.isMerged && events.length > 0) {
      const maxTime = events.reduce(function(m, e) { return e.time > m ? e.time : m; }, 0);
      if (maxTime > 0 && maxTime < result.duration) computedDuration = maxTime + 4;
      console.log('[VWB] Duration fix: result.duration='+result.duration.toFixed(1)+'s computed='+computedDuration.toFixed(1)+'s');
    }

    const entry = {
      events:      events,
      duration:    computedDuration,
      noteCount:   result.noteCount,
      trackCount:  result.trackCount,
      isMerged:    result.isMerged || false,
      fileName,
      storedPath:  storedPath || '',
      detectedBpm: result.detectedBpm,
      detectedKey: result.detectedKey,
      sections:    (savedEntry && savedEntry.sections)   || [],
      transpose:   (savedEntry && savedEntry.transpose  != null) ? savedEntry.transpose  : 0,
      tempoPct:    (savedEntry && savedEntry.tempoPct   != null) ? savedEntry.tempoPct   : 100,
      bpm:         (savedEntry && savedEntry.bpm)        || result.detectedBpm || 120,
      timeSig:     (savedEntry && savedEntry.timeSig)    || 4,
      chVolumes:   (savedEntry && savedEntry.chVolumes)  || {},
      chPrograms:  hasSavedPrograms ? savedEntry.chPrograms : autoChPrograms,
      chOctave:    (savedEntry && savedEntry.chOctave)   || {},
      chHBSlot:    (savedEntry && savedEntry.chHBSlot)   || autoHBSlot,
    };
    midiPlaylist.push(entry);
    _midiInstrumentsReady = false;
    if (midiActiveIdx < 0) selectMidiFile(0);
    if (!midiAccess) await initMidi();
    renderMidiPlaylist();
    updatePerfMidiUI();
  } catch(e) {
    console.error('MIDI parse error:', e);
    alert('Could not load MIDI file: ' + fileName + '\n' + e.message);
  }
}

// Legacy alias
async function loadMidiFromBuffer(ab, fileName, storedPath) {
  await addMidiFileFromBuffer(ab, fileName, storedPath);
}

async function pickAndAddMidiFile() {
  if (midiPlaylist.length >= 8) { alert('Maximum 8 MIDI files reached.'); return; }
  const result = await window.vwb.pickMidiFile();
  if (result.canceled) return;
  const songTitle = document.getElementById('songTitle').value || 'untitled';
  const stored = await window.vwb.storeStem({
    songTitle, stemKey: 'midi_' + Date.now(), sourcePath: result.path, fileName: result.name
  });
  const storedPath = stored.success ? stored.storedPath : result.path;
  const rb = await window.vwb.readFileBuffer(result.path);
  if (!rb.success) { alert('Could not read MIDI file.'); return; }
  await addMidiFileFromBuffer(rb.buffer, result.name, storedPath);
}

// Legacy aliases
async function pickAndLoadMidi() { await pickAndAddMidiFile(); }
function removeMidi() { if (midiActiveIdx >= 0) removeMidiFile(midiActiveIdx); }

// ── Playback ───────────────────────────────────────────────────

let _midiInstrumentsReady = false; // true after first preload — skips await on section jumps

function toggleMidiPlay() { midiPlaying ? pauseMidiPlay() : startMidiPlay(); }

// ── Jump to position without stopping/restarting the engine ───
// Used by section jumps. Skips async preload entirely and
// rebuilds the timer schedule synchronously — no audible gap.
function _jumpToPosition(targetPos) {
  if (!midiEvents.length) return;

  // Use soft note-off — avoids the hard dropout that allNotesOff causes
  _softNotesOff();
  midiTimers.forEach(t => clearTimeout(t));
  midiTimers = [];

  midiPauseAt   = targetPos;
  midiStartTime = performance.now() - (targetPos * 1000);
  // Keep midiPlaying = true — no stop/start gap

  const tempoScale = midiTempoPct / 100;
  const transpose  = midiTranspose;

  midiEvents.forEach(ev => {
    const evTimeScaled = ev.time / tempoScale;
    if (evTimeScaled < targetPos) return;
    const delayMs = (evTimeScaled - targetPos) * 1000;

    const timer = setTimeout(() => {
      if (!midiPlaying) return;
      try {
      const useSynth = typeof isSynthEnabled === 'function' && isSynthEnabled();

      if (ev.type === 'on') {
        const _muted  = typeof getMidiChMute === 'function' && getMidiChMute(ev.ch);
        const _anyS   = typeof anySolo === 'function' && anySolo();
        const _soloed = typeof getMidiChSolo === 'function' && getMidiChSolo(ev.ch);
        if (_muted || (_anyS && !_soloed)) return;
        const _oct  = (typeof getMidiChOctave === 'function' ? getMidiChOctave(ev.ch) : 0) * 12;
        const note  = ev.ch === 9 ? ev.note : Math.max(0, Math.min(127, ev.note + transpose + _oct));
        const vel    = ev.vel;  // volume handled by live gain node — don't bake into velocity
        if (vel <= 0) return;  // true zero velocity = note-off, skip
        if (useSynth) {
          const prog = midiChPrograms[ev.ch] >= 0 ? midiChPrograms[ev.ch]
                     : (channelPrograms[ev.ch] !== undefined ? channelPrograms[ev.ch]
                     : (ev.ch === 9 ? 128 : ev.ch === 8 ? 200 : 0));
          const dur  = ev.duration ? ev.duration / tempoScale : undefined;
          synthNoteOn(ev.ch, note, vel, prog, dur);
        } else if (midiOutPort) {
          midiOutPort.send([0x90 | ev.ch, note, vel]);
        }
        midiActiveNotes.push({ ch: ev.ch, note });

      } else if (ev.type === 'off') {
        const _oct  = (typeof getMidiChOctave === 'function' ? getMidiChOctave(ev.ch) : 0) * 12;
        const note  = ev.ch === 9 ? ev.note : Math.max(0, Math.min(127, ev.note + transpose + _oct));
        if (useSynth) synthNoteOff(ev.ch, note);
        else if (midiOutPort) midiOutPort.send([0x80 | ev.ch, note, 0]);
        midiActiveNotes = midiActiveNotes.filter(n => !(n.ch === ev.ch && n.note === note));

      } else if (ev.type === 'pc') {
        if (typeof isSynthEnabled === 'function' && isSynthEnabled()) {
          // Internal synth — apply program change live during playback
          if (typeof synthSetProgram === 'function') synthSetProgram(ev.ch, ev.program);
        } else if (midiOutPort) {
          midiOutPort.send([0xC0 | ev.ch, ev.program]);
        }
      } else if (ev.type === 'cc') {
        const useSynth2 = typeof isSynthEnabled === 'function' && isSynthEnabled();
        if (!useSynth2 && midiOutPort) {
          midiOutPort.send([0xB0 | ev.ch, ev.cc, ev.val]);
        } else if (useSynth2) {
          if (ev.cc === 64 && typeof synthSustainPedal === 'function') synthSustainPedal(ev.ch, ev.val);
          else if (ev.cc === 123 || ev.cc === 120) synthAllNotesOff();
          else if (ev.cc === 7) synthSetVolume(ev.ch, Math.round(ev.val / 127 * 100));
        }
      }
      } catch(err) {
        console.error('[VWB Scheduler] Error on event:', JSON.stringify({type:ev.type,ch:ev.ch,note:ev.note,prog:ev.program}), err.message);
      }
    }, Math.max(0, delayMs));
    midiTimers.push(timer);
  });

  // End-of-file timer
  const remaining = (midiDuration / tempoScale - targetPos) * 1000 + 50;
  const endTimer = setTimeout(() => {
    if (!midiPlaying) return;
    allNotesOff();
    midiPauseAt = 0;
    if (midiLoopEnabled) startMidiPlay(0);
    else {
      midiPlaying = false;
      updateMidiBtns(); updatePerfMidiUI(); updateMidiProgress();
    }
  }, Math.max(0, remaining));
  midiTimers.push(endTimer);
}


async function startMidiPlay(fromPosition) {
  console.log('[VWB Play] startMidiPlay called. midiEvents:', midiEvents.length,
    'isSynth:', typeof isSynthEnabled==='function' ? isSynthEnabled() : 'fn missing',
    'midiOutPort:', !!midiOutPort,
    'AC.state:', typeof AC !== 'undefined' ? AC.state : 'missing');

  if (!midiEvents.length) {
    console.log('[VWB Play] BLOCKED: no midiEvents');
    alert('No MIDI file loaded. Select a file from the playlist first.');
    return;
  }
  if (!(typeof isSynthEnabled === 'function' && isSynthEnabled()) && !midiOutPort) {
    console.log('[VWB Play] BLOCKED: no synth and no MIDI out port');
    alert('No MIDI output selected. Choose a MIDI output port first, or switch to Built-in Sounds mode.');
    return;
  }

  // Resume AudioContext if suspended
  if (typeof AC !== 'undefined' && AC.state === 'suspended') {
    console.log('[VWB Play] Resuming suspended AudioContext...');
    try { await AC.resume(); } catch(e) { console.warn('[VWB] AudioContext resume failed:', e); }
  }

  console.log('[VWB Play] Passed all checks — starting playback');
  console.log('[VWB Play] midiChPrograms:', JSON.stringify(midiChPrograms));
  console.log('[VWB Play] _chProgram snapshot will be built from these');

  // Clear any existing timers
  midiTimers.forEach(t => clearTimeout(t));
  midiTimers = [];

  const startPos   = (fromPosition !== undefined) ? fromPosition : midiPauseAt;
  midiPlaying      = true;
  midiPauseAt      = startPos;
  midiStartTime    = performance.now() - (startPos * 1000);

  const tempoScale = midiTempoPct / 100;
  const transpose  = midiTranspose;

  // Build channel program map — user selections override file program changes
  channelPrograms = {};  // reset module-level map — populated from pc events below
  midiEvents.forEach(ev => {
    if (ev.type === 'pc' && !(ev.ch in channelPrograms)) {
      channelPrograms[ev.ch] = ev.program;
    }
  });
  Object.entries(midiChPrograms).forEach(([ch, prog]) => {
    if (prog >= 0) channelPrograms[parseInt(ch)] = prog;
  });

  // Internal synth mode — preload instruments
  if (typeof isSynthEnabled === 'function' && isSynthEnabled()) {
    // Sync channel programs and volumes to synth
    Object.entries(channelPrograms).forEach(([ch, prog]) => {
      synthSetProgram(parseInt(ch), prog);
      // Apply instrument's defaultOctave if user hasn't manually set octave for this channel
      if (typeof VWB_PROG_MAP !== 'undefined' && VWB_PROG_MAP[prog] && VWB_PROG_MAP[prog].defaultOctave !== undefined) {
        const chInt = parseInt(ch);
        if (midiChOctave[chInt] === undefined || midiChOctave[chInt] === 0) {
          midiChOctave[chInt] = VWB_PROG_MAP[prog].defaultOctave;
        }
      }
    });
    Object.entries(midiChVolumes).forEach(([ch, vol]) => synthSetVolume(parseInt(ch), vol));
    console.log('[VWB Play] channelPrograms:', JSON.stringify(channelPrograms));
    // Always preload — ensures samplers are ready even after auto-split re-channeling
    await preloadChannelInstruments(midiEvents);
    _midiInstrumentsReady = true;
    // Apply default mix now that all FX chains are built
    if (typeof applyDefaultMix === 'function') applyDefaultMix();
  } else {
    // External MIDI — send program changes to connected device
    Object.entries(channelPrograms).forEach(([ch, prog]) => {
      try { midiOutPort.send([0xC0 | parseInt(ch), prog]); } catch(e) {}
    });
  }

  // Schedule only events from startPos onwards
  midiEvents.forEach(ev => {
    const evTimeScaled = ev.time / tempoScale;
    if (evTimeScaled < startPos) return; // skip already-passed events
    const delayMs = (evTimeScaled - startPos) * 1000;

    const timer = setTimeout(() => {
      if (!midiPlaying) return;
      try {
      const useSynth = typeof isSynthEnabled === 'function' && isSynthEnabled();
      if (ev.type === 'on') {
        // Check mute / solo before playing
        const _muted  = typeof getMidiChMute === 'function' && getMidiChMute(ev.ch);
        const _anyS   = typeof anySolo === 'function' && anySolo();
        const _soloed = typeof getMidiChSolo === 'function' && getMidiChSolo(ev.ch);
        if (_muted || (_anyS && !_soloed)) return;

        // Apply transpose + per-channel octave shift
        const _octShift = (typeof getMidiChOctave === 'function' ? getMidiChOctave(ev.ch) : 0) * 12;
        const note = ev.ch === 9
          ? ev.note
          : Math.max(0, Math.min(127, ev.note + transpose + _octShift));
        const vel    = ev.vel;  // volume handled by live gain node — don't bake into velocity
        if (vel <= 0) return;  // true zero velocity = note-off, skip

        if (useSynth) {
          // Route through internal sound engine — pass duration for natural playback
          const prog = midiChPrograms[ev.ch] >= 0 ? midiChPrograms[ev.ch]
                     : (channelPrograms[ev.ch] !== undefined ? channelPrograms[ev.ch]
                     : (ev.ch === 9 ? 128 : ev.ch === 8 ? 200 : 0));
          // Scale duration by tempo factor
          const dur = ev.duration ? ev.duration / tempoScale : undefined;
          synthNoteOn(ev.ch, note, vel, prog, dur);
        } else if (midiOutPort) {
          midiOutPort.send([0x90 | ev.ch, note, vel]);
        }
        midiActiveNotes.push({ ch: ev.ch, note });

      } else if (ev.type === 'off') {
        const _octShiftOff = (typeof getMidiChOctave === 'function' ? getMidiChOctave(ev.ch) : 0) * 12;
        const note = ev.ch === 9
          ? ev.note
          : Math.max(0, Math.min(127, ev.note + transpose + _octShiftOff));
        if (useSynth) {
          synthNoteOff(ev.ch, note);
        } else if (midiOutPort) {
          midiOutPort.send([0x80 | ev.ch, note, 0]);
        }
        midiActiveNotes = midiActiveNotes.filter(n => !(n.ch === ev.ch && n.note === note));

      } else if (ev.type === 'pc') {
        if (useSynth) {
          // Internal synth — apply program change live during playback
          if (typeof synthSetProgram === 'function') synthSetProgram(ev.ch, ev.program);
        } else if (midiOutPort) {
          midiOutPort.send([0xC0 | ev.ch, ev.program]);
        }
      } else if (ev.type === 'cc') {
        if (!useSynth && midiOutPort) {
          midiOutPort.send([0xB0 | ev.ch, ev.cc, ev.val]);
        } else if (useSynth) {
          // Handle critical CC messages for the internal synth
          if (ev.cc === 64) {
            // CC64 — Sustain pedal — handled properly in synth with note tracking
            if (typeof synthSustainPedal === 'function') {
              synthSustainPedal(ev.ch, ev.val);
            } else if (ev.val < 64) {
              synthNoteOff(ev.ch, -1);
            }
          } else if (ev.cc === 123 || ev.cc === 120) {
            // CC123 = All Notes Off, CC120 = All Sound Off
            synthAllNotesOff();
          } else if (ev.cc === 7) {
            // CC7 = Channel Volume
            synthSetVolume(ev.ch, Math.round(ev.val / 127 * 100));
          }
        }
      }
      } catch(err) {
        console.error('[VWB Scheduler2] Error on event:', JSON.stringify({type:ev.type,ch:ev.ch,note:ev.note}), err.message);
      }
    }, delayMs);
    midiTimers.push(timer);
  });

  const remaining = (midiDuration / tempoScale - startPos) * 1000 + 50;
  console.log('[VWB Play] midiDuration='+midiDuration.toFixed(2)+'s remaining='+remaining.toFixed(0)+'ms tempoScale='+tempoScale+' startPos='+startPos);
  const endTimer = setTimeout(() => {
    if (!midiPlaying) return;
    allNotesOff();
    midiPauseAt = 0;
    if (midiLoopEnabled) {
      startMidiPlay(0);
    } else {
      midiPlaying = false;
      updateMidiBtns();
      updatePerfMidiUI();
      updateMidiProgress();
    }
  }, remaining);
  midiTimers.push(endTimer);

  updateMidiBtns();
  updatePerfMidiUI();
  startMidiProgressLoop();
  // Start level meter animation
  if (typeof synthStartMeters === 'function') synthStartMeters();
}

function pauseMidiPlay() {
  if (!midiPlaying) return;
  midiPauseAt = getMidiCurrentTime();
  midiTimers.forEach(t => clearTimeout(t));
  midiTimers = [];
  allNotesOff();
  midiPlaying = false;
  if (typeof _cancelLoopSchedule === 'function') _cancelLoopSchedule();
  if (midiAnimFrame) { cancelAnimationFrame(midiAnimFrame); midiAnimFrame = null; }
  if (typeof synthStopMeters === 'function') synthStopMeters();
  updateMidiBtns();
  updatePerfMidiUI();
  updateMidiProgress();
}

function getMidiCurrentTime() {
  if (!midiPlaying) return midiPauseAt;
  return (performance.now() - midiStartTime) / 1000;
}

function startMidiProgressLoop() {
  if (midiAnimFrame) cancelAnimationFrame(midiAnimFrame);
  function tick() {
    if (!midiPlaying) return;
    updateMidiProgress();
    if (typeof _updateMidiSectionTracking === 'function') _updateMidiSectionTracking();
    // Drive Song Setup bar counter, beat dots, and timer when MIDI engine is active
    if (typeof updDisplays === 'function' &&
        typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi') {
      updDisplays(0); // parameter is ignored in MIDI branch — it reads getMidiCurrentTime() directly
    }
    midiAnimFrame = requestAnimationFrame(tick);
  }
  midiAnimFrame = requestAnimationFrame(tick);
}

function toggleMidiDisplayMode() {
  midiShowBars = !midiShowBars;
  // Update toggle button labels
  document.querySelectorAll('.midi-disp-toggle').forEach(btn => {
    btn.textContent  = midiShowBars ? '🎵 Bars' : '⏱ Time';
    btn.title        = midiShowBars ? 'Showing bars — click for time' : 'Showing time — click for bars';
    btn.style.color  = midiShowBars ? 'var(--orange)' : 'var(--text-dim)';
    btn.style.borderColor = midiShowBars ? 'var(--orange)' : 'var(--border)';
  });
  updateMidiProgress();
}

function updateMidiProgress() {
  const t        = getMidiCurrentTime();
  const dur      = midiDuration / (midiTempoPct / 100);
  const pct      = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
  const tUnscaled = t * (midiTempoPct / 100);

  // Progress bar fill
  document.querySelectorAll('.midi-progress-fill').forEach(el => {
    el.style.width = pct + '%';
  });

  // Build display strings
  const timeStr = fmt(Math.min(t, dur)) + ' / ' + fmt(dur);
  const curBar  = midiSections && typeof midiTime2Bar === 'function'
    ? midiTime2Bar(tUnscaled) : null;
  const totalBarsVal = typeof midiTotalBars === 'function' ? midiTotalBars() : null;
  const barStr  = curBar !== null ? 'Bar ' + curBar + (totalBarsVal ? ' / ' + totalBarsVal : '') : timeStr;
  const dispStr = midiShowBars && curBar !== null ? barStr : timeStr;

  // Primary display (setup tab)
  const midiTimeEl = document.getElementById('midiTimeDisplay');
  if (midiTimeEl) midiTimeEl.textContent = dispStr;

  // Perform bar — show bar on left, time on right
  const perfTimeEl = document.getElementById('perfMidiTime');
  if (perfTimeEl) {
    if (midiShowBars && curBar !== null) {
      perfTimeEl.innerHTML =
        '<span style="color:var(--orange);font-weight:700;margin-right:.5rem;">' + barStr + '</span>' +
        '<span style="color:var(--text-dim);font-size:.62rem;">' + timeStr + '</span>';
    } else {
      perfTimeEl.textContent = timeStr;
    }
  }

  // ── When MIDI engine is active, drive the unified bar display and beat dots ──
  if (typeof vwbActiveEngine !== 'undefined' && vwbActiveEngine === 'midi') {
    // Bar number display
    const uniBar = document.getElementById('uniBarDisplay');
    if (uniBar && curBar !== null) uniBar.textContent = curBar;

    // Unified time display
    const uniTime = document.getElementById('uniTimeDisplay');
    if (uniTime) uniTime.textContent = fmt(Math.min(t, dur)) + ' / ' + fmt(dur);

    // Beat indicator dots — pulse on each beat using MIDI BPM
    if (typeof midiBpm !== 'undefined' && midiBpm > 0) {
      const beatsPerBar = typeof midiTimeSig !== 'undefined' ? midiTimeSig : 4;
      const secPerBeat  = 60 / midiBpm;
      const beatInBar   = Math.floor((tUnscaled % (secPerBeat * beatsPerBar)) / secPerBeat);
      document.querySelectorAll('#beatInd .b-dot').forEach((dot, i) => {
        dot.classList.remove('act', 'db');
        dot.style.display = i < beatsPerBar ? '' : 'none';
        if (i === beatInBar) dot.classList.add(i === 0 ? 'db' : 'act');
      });
    }

    // Timeline sections highlight
    if (typeof uniOnMidiTick === 'function') uniOnMidiTick();
  }

  // Update the section timeline strip in the MIDI progress area
  _updateMidiTimelineStrip(pct);

  // Keep mini transport scrub bar in sync during MIDI playback
  if (typeof updMtScrubBar === 'function') updMtScrubBar();
}

// Draw section strips above the MIDI progress bar (setup + perform)
function _updateMidiTimelineStrip(pct) {
  ['midiTimelineStrip', 'midiTimelineStripPerf'].forEach(id => {
    const strip = document.getElementById(id);
    if (!strip) return;
    if (!midiSections || !midiSections.length || !midiDuration) {
      strip.innerHTML = '';
      return;
    }
    const dur = midiDuration;
    // Only rebuild DOM if section count changed
    if (strip.children.length !== midiSections.length) {
      strip.innerHTML = midiSections.map((sec, i) => {
        const st  = midiBar2Time(sec.sb);
        const et  = midiBar2Time(sec.eb + 1);
        const wp  = Math.min(((et - st) / dur) * 100, 100);
        const lft = Math.min((st / dur) * 100, 100);
        const lbl = sec.label || sec.type;
        return `<div class="midi-tl-sec" data-idx="${i}"
          style="left:${lft.toFixed(2)}%;width:${wp.toFixed(2)}%"
          onclick="event.stopPropagation();jumpMidiSection(${i})" title="${lbl} (Bar ${sec.sb}–${sec.eb})">${lbl}</div>`;
      }).join('');
    }
    // Highlight active section
    Array.from(strip.children).forEach((el, i) => {
      el.classList.toggle('on', i === midiCurSec);
    });
  });
}

function seekMidi(pct) {
  const dur = midiDuration / (midiTempoPct / 100);
  const pos = (pct / 100) * dur;
  const wasPlaying = midiPlaying;
  if (wasPlaying) {
    midiTimers.forEach(t => clearTimeout(t));
    midiTimers = [];
    allNotesOff();
    midiPlaying = false;
  }
  midiPauseAt = pos;
  if (wasPlaying) {
    startMidiPlay(pos);
  } else {
    updateMidiProgress();
  }
}

function stopMidiPlay() {
  midiTimers.forEach(t => clearTimeout(t));
  midiTimers = [];
  if (midiLoopTimer) { clearTimeout(midiLoopTimer); midiLoopTimer = null; }
  if (midiAnimFrame) { cancelAnimationFrame(midiAnimFrame); midiAnimFrame = null; }
  allNotesOff();
  midiPlaying = false;
  midiPauseAt = 0;
  updateMidiBtns();
  updatePerfMidiUI();
  updateMidiProgress();
}

// ── Silent jump — for section jumps ───────────────────────────
// Does NOT send note-off to the sampler. Hanging notes decay
// naturally so there is no volume dip at the transition point.
// Only clears the active note tracking list so the new section
// starts with a clean slate. Sustain pedal is reset so notes
// in the new section are not accidentally held.
function _softNotesOff() {
  const useSynth = typeof isSynthEnabled === 'function' && isSynthEnabled();
  if (useSynth) {
    // Just clear sustain state — don't trigger release on sampler
    if (typeof synthSustainPedal === 'function') {
      for (let ch = 0; ch < 16; ch++) synthSustainPedal(ch, 0);
    }
  } else if (midiOutPort) {
    // External MIDI must send explicit note-offs (hardware requirement)
    midiActiveNotes.forEach(n => {
      try { midiOutPort.send([0x80 | (n.ch || 0), n.note || n, 0]); } catch(e) {}
    });
  }
  // Clear tracking — new section starts fresh
  midiActiveNotes = [];
}

function allNotesOff() {
  // Stop internal synth notes
  if (typeof synthAllNotesOff === 'function') synthAllNotesOff();

  // Stop external MIDI notes
  if (midiOutPort) {
    midiActiveNotes.forEach(n => {
      try { midiOutPort.send([0x80 | (n.ch || 0), n.note || n, 0]); } catch(e) {}
    });
    for (let ch = 0; ch < 16; ch++) {
      try { midiOutPort.send([0xB0 | ch, 123, 0]); } catch(e) {}
    }
  }
  midiActiveNotes = [];
}

// (toggleMidiChFx moved to mixer block)

// ── Channel Volume ─────────────────────────────────────────────

function setMidiChannelVolume(ch, pct) {
  midiChVolumes[ch] = parseInt(pct);
  const active = getMidiActive();
  if (active) active.chVolumes = Object.assign({}, midiChVolumes);
  // Update live gain node in real time — works while playing
  if (typeof synthSetVolume === 'function') synthSetVolume(ch, parseInt(pct));
  // Send CC7 (volume) to the MIDI output in real time
  if (midiOutPort) {
    const val = Math.round(parseInt(pct) * 127 / 100);
    try { midiOutPort.send([0xB0 | ch, 7, val]); } catch(e) {}
  }
  // Update volume and dB display
  const el = document.getElementById('midiChVol_' + ch);
  if (el) el.textContent = pct + '%';
  const dbEl = document.getElementById('midiChDb_' + ch);
  if (dbEl) dbEl.textContent = _pctToDb(parseInt(pct)) + ' dB';
}

function setMidiChannelInstrument(ch, program) {
  if (program < 0) return;
  midiChPrograms[ch] = program;
  midiChNames[ch]    = getGMName(program);
  const active = getMidiActive();
  if (active) active.chPrograms = Object.assign({}, midiChPrograms);
  // Send program change to the connected MIDI device immediately
  if (midiOutPort) {
    try { midiOutPort.send([0xC0 | ch, program]); } catch(e) {}
  }
  // Re-render mixer to update selected state
  renderMidiMixer();
}

// ── Render / UI ────────────────────────────────────────────────

function updateMidiBtns() {
  const setupBtn = document.getElementById('midiPlayBtn');
  const perfBtn  = document.getElementById('perfMidiBtn');
  if (setupBtn) { setupBtn.classList.toggle('on', midiPlaying); setupBtn.innerHTML = midiPlaying ? '⏸' : '▶'; }
  if (perfBtn)  { perfBtn.classList.toggle('on', midiPlaying);  perfBtn.innerHTML  = midiPlaying ? '⏸' : '▶'; }
}

function updatePerfMidiUI() {
  const bar = document.getElementById('perfMidiBar');
  if (!bar) return;
  const active = getMidiActive();
  if (active) {
    bar.style.display = 'flex';
    bar.classList.toggle('active', midiPlaying);
    document.getElementById('perfMidiName').textContent = active.fileName;
    const status = document.getElementById('perfMidiStatus');
    status.textContent = midiPlaying ? (midiLoopEnabled ? 'Playing (Loop)' : 'Playing') : (midiPauseAt > 0 ? 'Paused' : 'Stopped');
    status.classList.toggle('playing', midiPlaying);
  } else {
    bar.style.display = 'none';
  }
  updateMidiProgress();
}

// ── Key Name Helpers ───────────────────────────────────────────
const _MAJOR_KEYS = ['C','G','D','A','E','B','F#','C#','G#','D#','A#','F'];
const _MINOR_KEYS = ['A','E','B','F#','C#','G#','D#','A#','F','C','G','D'];

function _sharpsToKeyName(sharps, minor) {
  const idx = ((sharps % 12) + 12) % 12;
  return minor ? _MINOR_KEYS[idx] + 'm' : _MAJOR_KEYS[idx];
}

function _getTransposedKeyName() {
  const active = getMidiActive();
  if (!active || !active.detectedKey) return null;
  const { sharps, minor } = active.detectedKey;
  return _sharpsToKeyName(sharps + midiTranspose, minor);
}

function _getCurrentBpm() {
  return Math.round(midiBpm * midiTempoPct / 100);
}

function _updateTempoDisplay() {
  const bpm = _getCurrentBpm();
  const el  = document.getElementById('midiTempoPct');
  if (el) el.value = bpm;
}

function _updateKeyDisplay() {
  const semitones = midiTranspose;
  const semiLabel = semitones === 0 ? '0' : (semitones > 0 ? '+' : '') + semitones;
  // Update all transpose displays (class-based for setup + perform views)
  document.querySelectorAll('.midi-transpose-val').forEach(el => {
    el.textContent = semiLabel;
  });
  // Legacy single-element fallback
  const el = document.getElementById('midiTransposeVal');
  if (el) el.textContent = semiLabel;
}

// ── Perform page header sync — title / tempo / time signature ──
// Mirrors what _cpUpdatePerfHeader() (in ui.js) does for chord
// charts, but for Flex files (.mid / .vwba). Previously the header
// only ever updated tempo, and only when a tempo control was
// manually touched — a freshly loaded file showed stale info until
// then. Now runs on every file select.
function _syncMidiPerfHeader() {
  const active = getMidiActive();
  if (!active) return;
  const titleEl = document.getElementById('pTitle');
  const tempoEl = document.getElementById('pTempo');
  const tsEl    = document.getElementById('pTS');
  if (titleEl) titleEl.textContent = active.fileName || 'Untitled';
  if (tempoEl) tempoEl.textContent = Math.round(_getCurrentBpm()) + ' BPM';
  if (tsEl) {
    // Prefer the original "N/D" string (e.g. "6/8") if the file carried
    // one — the numeric midiTimeSig only tracks beats-per-bar and would
    // misrepresent anything that isn't an X/4 signature.
    const displayTs = (active.arrangementMeta && active.arrangementMeta.timeSig)
      ? active.arrangementMeta.timeSig
      : (midiTimeSig || 4) + '/4';
    tsEl.textContent = displayTs;
  }
}

// ═══════════════════════════════════════════════════════════════
//  VWB — Channel Mixer Extensions
//  Octave shift, Mute, Solo per channel
// ═══════════════════════════════════════════════════════════════

// ── Per-channel state ──────────────────────────────────────────
let midiChOctave = {};   // channel → octave offset (-2 to +2)
let midiChMute   = {};   // channel → bool
let midiChSolo   = {};   // channel → bool

// ── House Band slot overrides ─────────────────────────────────
// Tracks manual slot reassignments the user makes in the mixer.
// Default routing comes from HB_SLOT_TO_CHANNEL in house-band-engine.js.
// When the user reassigns a channel, we store it here so the synth
// knows which sampler to use regardless of the channel number.
// { chInt: 'drums'|'percussion'|'bass'|'keys'|'organ'|'guitar'|'aux' }
let midiChHBSlot = {};

// Auto-routes all active channels to their default House Band slot
// based on HB_SLOT_TO_CHANNEL. Called after a MIDI file loads.
// User overrides in midiChHBSlot take precedence.
function _hbAutoRouteChannels() {
  if (typeof HB_SLOT_TO_CHANNEL === 'undefined') return;
  Object.keys(midiChNames).forEach(ch => {
    const chInt = parseInt(ch);
    if (chInt in midiChHBSlot) return; // user has already overridden this channel
    const slot = Object.keys(HB_SLOT_TO_CHANNEL).find(s => HB_SLOT_TO_CHANNEL[s] === chInt);
    if (slot) {
      midiChHBSlot[chInt] = slot;
      // Also set the correct program so the synth loads the right sampler
      if (typeof HB_SLOT_TO_PROGRAM !== 'undefined' && !(chInt in midiChPrograms)) {
        midiChPrograms[chInt] = HB_SLOT_TO_PROGRAM[slot];
      }
    }
  });
}

// Returns the effective HB slot for a channel (override → default → null)
function getChHBSlot(chInt) {
  if (midiChHBSlot[chInt]) return midiChHBSlot[chInt];
  if (typeof HB_SLOT_TO_CHANNEL === 'undefined') return null;
  return Object.keys(HB_SLOT_TO_CHANNEL).find(s => HB_SLOT_TO_CHANNEL[s] === chInt) || null;
}

// Reassigns a channel to a new HB slot — updates program, mixer strip,
// and synth so playback immediately uses the right samples.
function reassignChToHBSlot(chInt, slot) {
  midiChHBSlot[chInt] = slot;
  if (typeof HB_SLOT_TO_PROGRAM !== 'undefined') {
    midiChPrograms[chInt] = HB_SLOT_TO_PROGRAM[slot];
    if (typeof synthSetProgram === 'function') synthSetProgram(chInt, HB_SLOT_TO_PROGRAM[slot]);
  }
  const active = getMidiActive();
  if (active) {
    active.chPrograms = Object.assign({}, midiChPrograms);
    active.chHBSlot   = Object.assign({}, midiChHBSlot);
  }
  renderMidiMixer();
  if (typeof showNotification === 'function') {
    const slotLabels = { drums:'Drums', percussion:'Percussion', bass:'Bass',
      keys:'Keys', organ:'Organ', guitar:'Guitar', aux:'Aux' };
    showNotification('🎵 Ch' + (chInt+1) + ' → ' + (slotLabels[slot] || slot));
  }
}

// Which of our 12 instruments are available (program numbers)
const VWB_AVAILABLE_PROGRAMS = new Set([0, 4, 9, 16, 24, 27, 33, 48, 61, 88, 89, 128]);

// ── Octave helpers ─────────────────────────────────────────────

function getMidiChOctave(ch)      { return midiChOctave[ch] !== undefined ? midiChOctave[ch] : 0; }
function getMidiChMute(ch)        { return !!midiChMute[ch]; }
function getMidiChSolo(ch)        { return !!midiChSolo[ch]; }
function anySolo()                { return Object.values(midiChSolo).some(Boolean); }

function setMidiChOctave(ch, delta) {
  const cur = getMidiChOctave(ch);
  midiChOctave[ch] = Math.max(-2, Math.min(2, cur + delta));
  const active = getMidiActive();
  if (active) active.chOctave = Object.assign({}, midiChOctave);
  const el = document.getElementById('midiChOct_' + ch);
  if (el) el.textContent = _octaveLabel(midiChOctave[ch]);
}

function _octaveLabel(oct) {
  if (oct === 0)  return '0';
  if (oct > 0)    return '+' + oct;
  return '' + oct;
}

function toggleMidiChMute(ch) {
  midiChMute[ch] = !getMidiChMute(ch);
  _updateMixerRowState(ch);
  // Rebuild note schedule so already-running callbacks see the new mute state
  if (midiPlaying) _jumpToPosition(getMidiCurrentTime());
}

function toggleMidiChSolo(ch) {
  midiChSolo[ch] = !getMidiChSolo(ch);
  // Update all channel rows so visual state is correct
  Object.keys(midiChNames).forEach(c => _updateMixerRowState(parseInt(c)));
  // Rebuild note schedule — callbacks captured old solo state in their closures
  if (midiPlaying) _jumpToPosition(getMidiCurrentTime());
}

function _updateMixerRowState(ch) {
  const muteBtn  = document.getElementById('midiMute_' + ch);
  const soloBtn  = document.getElementById('midiSolo_' + ch);
  const row      = document.getElementById('midiChRow_' + ch);
  const muted    = getMidiChMute(ch);
  const soloed   = getMidiChSolo(ch);
  const anyS     = anySolo();
  const silenced = muted || (anyS && !soloed);

  if (muteBtn) {
    muteBtn.style.background   = muted   ? '#e05252' : 'var(--bg-primary)';
    muteBtn.style.color        = muted   ? '#fff'    : 'var(--text-dim)';
    muteBtn.style.borderColor  = muted   ? '#e05252' : 'var(--border)';
  }
  if (soloBtn) {
    soloBtn.style.background   = soloed  ? '#f0a030' : 'var(--bg-primary)';
    soloBtn.style.color        = soloed  ? '#000'    : 'var(--text-dim)';
    soloBtn.style.borderColor  = soloed  ? '#f0a030' : 'var(--border)';
  }
  if (row) row.style.opacity = silenced ? '0.45' : '1';
}

// ── Channel Mixer — vertical DAW-style strip layout ────────────

let _selectedMidiCh = -1;
let _midiChCompAmt  = {}; // ch → 0-100 compression amount
let _midiChDelayAmt = {}; // ch → 0-100 delay mix amount
let _midiChEQLow    = {}; // ch → -12..+12 dB
let _midiChEQLowMid = {};
let _midiChEQHiMid  = {};
let _midiChEQHigh   = {};

function selectMidiChannel(ch) {
  _selectedMidiCh = ch;
  document.querySelectorAll('.vwb-ch-strip').forEach(el => el.classList.remove('selected'));
  const strip = document.getElementById('midiChRow_' + ch);
  if (strip) strip.classList.add('selected');
}

// ── Floating FX panel ──────────────────────────────────────────
let _openFxCh = -1;

function toggleMidiChFx(ch) {
  const existing = document.getElementById('vwb-fx-float');
  if (existing && _openFxCh === ch) {
    existing.remove();
    _openFxCh = -1;
    document.querySelectorAll('.vwb-fx-btn').forEach(b => { b.classList.remove('open'); b.innerHTML = 'FX ▸'; });
    return;
  }
  if (existing) existing.remove();
  document.querySelectorAll('.vwb-fx-btn').forEach(b => { b.classList.remove('open'); b.innerHTML = 'FX ▸'; });

  _openFxCh = ch;
  const btn = document.getElementById('midiChFxToggle_' + ch);
  if (btn) { btn.classList.add('open'); btn.innerHTML = 'FX ▾'; }

  _renderFxFloat(ch);
}

function _renderFxFloat(ch) {
  const chInt   = parseInt(ch);
  const strip   = document.getElementById('midiChRow_' + chInt);
  const mixer   = document.getElementById('midiMixer');
  if (!strip || !mixer) return;

  const revType = midiChReverbType[chInt] || 'none';
  const revSend = midiChReverbSend[chInt] || 0;
  const compAmt = _midiChCompAmt[chInt]   || 0;
  const delAmt  = _midiChDelayAmt[chInt]  || 0;
  const eqLow   = _midiChEQLow[chInt]     || 0;
  const eqLoMid = _midiChEQLowMid[chInt]  || 0;
  const eqHiMid = _midiChEQHiMid[chInt]   || 0;
  const eqHigh  = _midiChEQHigh[chInt]    || 0;
  const name    = midiChNames[chInt] || ('Ch' + (chInt+1));

  const panel = document.createElement('div');
  panel.id = 'vwb-fx-float';
  // Wider panel so EQ labels don't overflow
  panel.style.cssText = `
    position:absolute;
    background:var(--bg-secondary,#1a1a2e);
    border:1px solid rgba(255,140,50,.35);
    border-radius:10px;
    padding:.8rem;
    width:310px;
    z-index:9999;
    box-shadow:0 8px 32px rgba(0,0,0,.6);
    box-sizing:border-box;
  `;

  // Build panel content using DOM methods to avoid escaping issues
  const sectionHead = (icon, label) =>
    `<div style='font-size:.65rem;font-weight:700;color:var(--text-dim);text-transform:uppercase;
      letter-spacing:.08em;margin-bottom:.4rem;border-bottom:1px solid rgba(255,255,255,.06);
      padding-bottom:.25rem;'>${icon} ${label}</div>`;


  const eqBands = [
    {label:'Low',    freq:'80Hz',  val:eqLow,   fn:'setMidiChEQLow',   sid:'eqLow'  },
    {label:'Lo-Mid', freq:'500Hz', val:eqLoMid, fn:'setMidiChEQLoMid', sid:'eqLoMid'},
    {label:'Hi-Mid', freq:'3kHz',  val:eqHiMid, fn:'setMidiChEQHiMid', sid:'eqHiMid'},
    {label:'High',   freq:'10kHz', val:eqHigh,  fn:'setMidiChEQHigh',  sid:'eqHigh' },
  ];

  function rvBtn(type, label, activeColor, activeBg) {
    const active = revType === type;
    const bc = active ? activeColor : 'var(--border)';
    const bg = active ? activeBg   : 'none';
    const cl = active ? activeColor : 'var(--text-dim)';
    return '<button data-revtype="' + type + '" onclick="event.stopPropagation();_setRevType(' + chInt + ',this.dataset.revtype)"' +
      ' style="flex:1;font-size:.62rem;font-weight:600;padding:.25rem .3rem;border-radius:5px;' +
      'cursor:pointer;transition:all .15s;' +
      'border:1px solid ' + bc + ';' +
      'background:' + bg + ';' +
      'color:' + cl + ';">' + label + '</button>';
  }

  panel.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.65rem;">'+
    '<div style="font-size:.72rem;font-weight:700;color:var(--orange);text-transform:uppercase;letter-spacing:.06em;">'+
    'FX \u2014 Ch'+(chInt+1)+' '+(name.length>14?name.substring(0,14)+'\u2026':name)+'</div>'+
    '<button onclick="event.stopPropagation();toggleMidiChFx('+chInt+')"'+
    ' style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:1rem;padding:0 .25rem;">\u2715</button></div>'+

    '<div style="margin-bottom:.7rem;">'+sectionHead('\u2699','EQ')+
    eqBands.map(b => {
      const vid = 'vwb-eq-'+b.sid+'-'+chInt;
      const lbl = (b.val>0?'+':'')+b.val+'dB';
      return '<div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem;">'+
        '<span style="min-width:40px;font-size:.62rem;color:var(--text-dim);">'+b.label+'</span>'+
        '<span style="font-size:.55rem;color:rgba(255,255,255,.25);min-width:34px;">'+b.freq+'</span>'+
        '<input type="range" min="-12" max="12" step="1" value="'+b.val+'"'+
        ' style="-webkit-appearance:none;flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.1);cursor:pointer;"'+
        ' oninput="'+b.fn+'('+chInt+',parseInt(this.value));document.getElementById(\''+vid+'\').textContent=(this.value>0?\'+\':\'\')+this.value+\'dB\';">'+
        '<span id="'+vid+'" style="font-size:.62rem;font-family:Space Mono,monospace;color:var(--orange);min-width:36px;text-align:right;">'+lbl+'</span>'+
        '</div>';
    }).join('')+'</div>'+

    '<div style="margin-bottom:.7rem;">'+sectionHead('\uD83C\uDF0A','Reverb')+
    '<div style="display:flex;gap:.35rem;margin-bottom:.4rem;">'+
    rvBtn('none','Off','var(--orange)','rgba(255,140,50,.15)')+
    rvBtn('hall','Hall','#7eb8d4','rgba(126,184,212,.2)')+
    rvBtn('plate','Plate','#d4a07e','rgba(212,160,126,.2)')+
    '</div>'+
    '<div style="display:flex;align-items:center;gap:.4rem;opacity:'+(revType==='none'?.35:1)+';pointer-events:'+(revType==='none'?'none':'auto')+';" id="vwb-rev-send-row-'+chInt+'">'+
    '<span style="font-size:.62rem;color:var(--text-dim);min-width:34px;">Send</span>'+
    '<input type="range" min="0" max="100" step="1" value="'+revSend+'" id="vwb-rev-send-'+chInt+'"'+
    ' style="-webkit-appearance:none;flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.1);cursor:pointer;"'+
    ' oninput="setMidiChReverbSend('+chInt+',this.value);document.getElementById(\'vwb-rev-val-'+chInt+'\').textContent=this.value+\'%\';">'+
    '<span id="vwb-rev-val-'+chInt+'" style="font-size:.62rem;font-family:Space Mono,monospace;color:var(--orange);min-width:36px;text-align:right;">'+revSend+'%</span>'+
    '</div></div>'+

    '<div style="margin-bottom:.7rem;">'+sectionHead('\u23F1','Depth Delay')+
    '<div style="font-size:.58rem;color:rgba(255,255,255,.3);margin-bottom:.4rem;">Adds opposite-side delay for width and dimension</div>'+
    '<div style="display:flex;align-items:center;gap:.4rem;">'+
    '<span style="font-size:.62rem;color:var(--text-dim);min-width:34px;">Mix</span>'+
    '<input type="range" min="0" max="100" step="1" value="'+delAmt+'"'+
    ' style="-webkit-appearance:none;flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.1);cursor:pointer;"'+
    ' oninput="setMidiChDelay('+chInt+',parseInt(this.value));document.getElementById(\'vwb-delay-val-'+chInt+'\').textContent=this.value+\'%\';">'+
    '<span id="vwb-delay-val-'+chInt+'" style="font-size:.62rem;font-family:Space Mono,monospace;color:var(--orange);min-width:36px;text-align:right;">'+delAmt+'%</span>'+
    '</div>'+
    '<div style="font-size:.58rem;color:rgba(255,255,255,.25);margin-top:.25rem;">0% = off · delay adds depth on opposite side</div>'+
    '</div>'+

    '<div>'+sectionHead('\uD83C\uDFDB','Compressor')+
    '<div style="display:flex;align-items:center;gap:.4rem;">'+
    '<span style="font-size:.62rem;color:var(--text-dim);min-width:40px;">Amount</span>'+
    '<input type="range" min="0" max="100" step="1" value="'+compAmt+'"'+
    ' style="-webkit-appearance:none;flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.1);cursor:pointer;"'+
    ' oninput="setMidiChCompressor('+chInt+',parseInt(this.value));document.getElementById(\'vwb-comp-val-'+chInt+'\').textContent=this.value+\'%\';">'+
    '<span id="vwb-comp-val-'+chInt+'" style="font-size:.62rem;font-family:Space Mono,monospace;color:var(--orange);min-width:36px;text-align:right;">'+compAmt+'%</span>'+
    '</div>'+
    '<div style="font-size:.58rem;color:rgba(255,255,255,.25);margin-top:.25rem;">0% = off · 50% = musical · 100% = punchy</div>'+
    '</div>';

  // Position floating panel above the strip
  mixer.style.position = 'relative';
  const stripRect  = strip.getBoundingClientRect();
  const mixerRect  = mixer.getBoundingClientRect();
  const leftOffset = stripRect.left - mixerRect.left + mixer.scrollLeft;

  panel.style.left = Math.max(0, leftOffset - 85) + 'px';
  panel.style.bottom = (mixerRect.bottom - stripRect.top + 8) + 'px';

  mixer.appendChild(panel);

  // Close if clicking outside
  setTimeout(() => {
    document.addEventListener('click', function _closeFx(e) {
      const fp = document.getElementById('vwb-fx-float');
      if (fp && !fp.contains(e.target) && !e.target.classList.contains('vwb-fx-btn')) {
        fp.remove();
        _openFxCh = -1;
        document.querySelectorAll('.vwb-fx-btn').forEach(b => { b.classList.remove('open'); b.innerHTML = 'FX ▸'; });
        document.removeEventListener('click', _closeFx);
      }
    });
  }, 50);
}

// ── Inline instrument picker ───────────────────────────────────
function openInstrumentPicker(ch) {
  document.querySelectorAll('.vwb-inst-picker').forEach(p => p.remove());

  const chInt = parseInt(ch);
  const strip = document.getElementById('midiChRow_' + chInt);
  if (!strip) return;
  if (chInt === 9) return;

  const currentSlot = getChHBSlot(chInt);
  const currentProg = midiChPrograms[chInt] !== undefined ? midiChPrograms[chInt] : -1;
  const hasHB = typeof HB_SLOT_TO_CHANNEL !== 'undefined' && typeof bandGetActive === 'function';

  const HB_SLOT_LABELS = {
    drums:'🥁 Drums', percussion:'🪘 Percussion', bass:'🎸 Bass',
    keys:'🎹 Keys', organ:'🎹 Organ', guitar:'🎸 Guitar', aux:'🎛 Aux'
  };
  const HB_SLOTS = ['keys','organ','bass','guitar','aux'];

  let hbSection = '';
  if (hasHB) {
    hbSection =
      '<div style="padding:.3rem .6rem;font-size:.58rem;font-weight:700;color:#4ecdc4;' +
      'text-transform:uppercase;letter-spacing:.06em;' +
      'background:rgba(78,205,196,.06);border-bottom:1px solid rgba(255,255,255,.05);">' +
      '🎵 House Band</div>';
    HB_SLOTS.forEach(function(slot) {
      var musician = bandGetActive(slot);
      var isCurrent = currentSlot === slot;
      var defaultCh = HB_SLOT_TO_CHANNEL[slot];
      var chLabel = defaultCh !== undefined
        ? ' <span style="color:rgba(255,255,255,.25);font-size:.58rem;">(Ch'+(defaultCh+1)+')</span>' : '';
      hbSection +=
        '<div class="vwb-hb-slot-item" data-slot="'+slot+'"' +
        ' style="padding:.38rem .6rem;font-size:.72rem;cursor:pointer;display:flex;' +
        'align-items:center;gap:.5rem;' +
        (isCurrent
          ? 'color:var(--orange);font-weight:700;background:rgba(255,140,50,.1);border-left:2px solid var(--orange);'
          : 'color:var(--text-primary);font-weight:600;border-left:2px solid transparent;') +
        '">' +
        HB_SLOT_LABELS[slot] +
        (musician ? ' — <span style="font-size:.66rem;opacity:.7;">'+musician.name+'</span>' : '') +
        chLabel + '</div>';
    });
  }

  var avail = [], others = [];
  GM_NAMES.forEach(function(name, i) {
    (VWB_AVAILABLE_PROGRAMS.has(i) ? avail : others).push({ idx: i, name: name });
  });
  function makeGMItem(opt, isAvail) {
    var sel   = opt.idx === currentProg && !currentSlot;
    var color = sel ? 'var(--orange)' : (isAvail ? 'var(--text-primary)' : 'var(--text-dim)');
    var fw    = sel ? '700' : (isAvail ? '600' : '400');
    var bg    = sel ? 'rgba(255,140,50,.1)' : 'none';
    var bl    = sel ? 'var(--orange)' : 'transparent';
    var star  = isAvail
      ? '<span style="font-size:.6rem;color:#4ecdc4;">★</span>'
      : '<span style="font-size:.6rem;color:transparent;">★</span>';
    return '<div class="vwb-inst-item" data-prog="'+opt.idx+'"' +
      ' style="padding:.35rem .6rem;font-size:.72rem;cursor:pointer;display:flex;align-items:center;gap:.4rem;' +
      'color:'+color+';font-weight:'+fw+';background:'+bg+';border-left:2px solid '+bl+';">' +
      star+(opt.idx+1)+'. '+opt.name+'</div>';
  }
  var gmSection =
    '<div style="padding:.3rem .6rem;font-size:.58rem;font-weight:700;color:#4ecdc4;' +
    'text-transform:uppercase;letter-spacing:.06em;' +
    'background:rgba(78,205,196,.06);border-bottom:1px solid rgba(255,255,255,.05);' +
    'border-top:1px solid rgba(255,255,255,.05);">★ Available Instruments</div>' +
    avail.map(function(o){return makeGMItem(o,true);}).join('') +
    '<div style="padding:.3rem .6rem;font-size:.58rem;font-weight:700;color:var(--text-dim);' +
    'text-transform:uppercase;letter-spacing:.06em;' +
    'background:rgba(255,255,255,.02);border-top:1px solid rgba(255,255,255,.05);' +
    'border-bottom:1px solid rgba(255,255,255,.05);">All Instruments</div>' +
    others.map(function(o){return makeGMItem(o,false);}).join('');

  var picker = document.createElement('div');
  picker.className = 'vwb-inst-picker';
  picker.style.cssText =
    'position:fixed;background:#1a1a2e;' +
    'border:1px solid rgba(255,140,50,.4);border-radius:8px;overflow:hidden;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.7);z-index:99999;width:240px;';
  var scrollDiv = document.createElement('div');
  scrollDiv.style.cssText = 'max-height:280px;overflow-y:auto;scrollbar-width:thin;';
  scrollDiv.innerHTML = hbSection + gmSection;
  picker.appendChild(scrollDiv);
  document.body.appendChild(picker);

  var rect = strip.getBoundingClientRect();
  var top = rect.top - 288;
  if (top < 10) top = rect.bottom + 8;
  var left = rect.left;
  if (left + 240 > window.innerWidth) left = window.innerWidth - 248;
  picker.style.top  = top + 'px';
  picker.style.left = left + 'px';

  scrollDiv.addEventListener('click', function(e) {
    var slotItem = e.target.closest('.vwb-hb-slot-item');
    if (slotItem) { reassignChToHBSlot(chInt, slotItem.dataset.slot); picker.remove(); return; }
    var gmItem = e.target.closest('.vwb-inst-item');
    if (gmItem) { delete midiChHBSlot[chInt]; setMidiChannelInstrument(chInt, parseInt(gmItem.dataset.prog)); picker.remove(); }
  });
  scrollDiv.addEventListener('mouseover', function(e) {
    var item = e.target.closest('.vwb-hb-slot-item, .vwb-inst-item');
    if (item) item.style.background = 'rgba(255,255,255,.07)';
  });
  scrollDiv.addEventListener('mouseout', function(e) {
    var item = e.target.closest('.vwb-hb-slot-item, .vwb-inst-item');
    if (item) {
      var isCS = item.dataset.slot && item.dataset.slot === currentSlot;
      var isCG = item.dataset.prog && parseInt(item.dataset.prog) === currentProg && !currentSlot;
      item.style.background = (isCS || isCG) ? 'rgba(255,140,50,.1)' : 'none';
    }
  });
  setTimeout(function() {
    document.addEventListener('click', function _cp(e) {
      var pk = document.querySelector('.vwb-inst-picker');
      if (pk && !pk.contains(e.target) && !e.target.classList.contains('vwb-ch-name')) {
        pk.remove(); document.removeEventListener('click', _cp);
      }
    });
  }, 150);
}

// ── Reverb setters ──────────────────────────────────────────────
// These were previously missing — the FX panel's reverb slider and
// type buttons called them, but they were never defined, so
// adjusting reverb silently did nothing. synthSetReverb is the same
// real synth-level call already used successfully elsewhere (chart
// mixer's hbSetReverb in ui.js).
function setMidiChReverbSend(ch, val) {
  midiChReverbSend[ch] = parseInt(val);
  if (typeof synthSetReverb === 'function') synthSetReverb(parseInt(ch), parseInt(val) / 100);
  const active = getMidiActive();
  if (active) active.chReverbSend = Object.assign({}, midiChReverbSend);
}
function setMidiChReverbType(ch, type) {
  midiChReverbType[ch] = type;
  if (typeof synthSetReverbType === 'function') synthSetReverbType(parseInt(ch), type);
  const active = getMidiActive();
  if (active) active.chReverbType = Object.assign({}, midiChReverbType);
}

// ── Reverb type setter (used by FX panel buttons) ─────────────
// ── MIDI bar/time conversion — mirrors state.js's bar2time/time2bar,
// but keyed to the active Flex file's own tempo/time signature
// (midiBpm/midiTimeSig) instead of the Audio Engine's song.tempo/song.ts.
// These were referenced from transport.js and audio-engine.js but never
// defined, which is why the Song Sections bar counter always fell back
// to "Bar 1" and section jumping never worked for Flex/.vwba files.
//
// Scaling convention (matches seekMidi() and startMidiPlay() elsewhere
// in this file): midiBar2Time() returns UNSCALED position (seconds at
// the file's original tempo, tempo-slider-independent). Wall-clock
// playback position (what getMidiCurrentTime()/midiPauseAt use) is
// unscaledPosition / (midiTempoPct/100).
function midiSecsPerBar() {
  return (60 / (midiBpm || 120)) * (midiTimeSig || 4);
}
function midiBar2Time(bar) {
  return (bar - 1) * midiSecsPerBar();
}
function midiTime2Bar(unscaledT) {
  const spb = midiSecsPerBar();
  return spb > 0 ? Math.floor(unscaledT / spb) + 1 : 1;
}

// Jumps to a specific bar number, on-beat, for the active Flex file.
// Uses the same soft note-off pattern already documented above
// (_softNotesOff) so there's no volume dip at the jump point.
function jumpMidiSectionByBar(bar) {
  const tempoScale  = (midiTempoPct || 100) / 100;
  const unscaledPos = midiBar2Time(bar);
  const pos         = unscaledPos / tempoScale; // convert to wall-clock seconds
  const wasPlaying  = midiPlaying;

  if (wasPlaying) {
    midiTimers.forEach(t => clearTimeout(t));
    midiTimers = [];
    if (typeof _softNotesOff === 'function') _softNotesOff();
  }

  midiPauseAt = pos;

  if (wasPlaying) {
    startMidiPlay(pos);
  } else {
    updateMidiProgress();
  }
}

function _setRevType(ch, type) {
  setMidiChReverbType(ch, type);
  // Refresh the FX panel to update button states
  if (_openFxCh === parseInt(ch)) {
    const existing = document.getElementById('vwb-fx-float');
    if (existing) existing.remove();
    _renderFxFloat(ch);
  }
}

// ── Delay setter ───────────────────────────────────────────────
function setMidiChDelay(ch, amt) {
  _midiChDelayAmt[ch] = amt;
  if (typeof synthSetDelay === 'function') synthSetDelay(parseInt(ch), amt);
}

// ── EQ setters ─────────────────────────────────────────────────
function setMidiChEQLow(ch, db)    { _midiChEQLow[ch]    = db; _applyEQ(ch); _saveEQToActive(); }
function setMidiChEQLoMid(ch, db)  { _midiChEQLowMid[ch] = db; _applyEQ(ch); _saveEQToActive(); }
function setMidiChEQHiMid(ch, db)  { _midiChEQHiMid[ch]  = db; _applyEQ(ch); _saveEQToActive(); }
function setMidiChEQHigh(ch, db)   { _midiChEQHigh[ch]   = db; _applyEQ(ch); _saveEQToActive(); }

// Persists the current EQ state into the active playlist entry, same
// pattern as setMidiChannelVolume/setMidiChReverbSend above.
function _saveEQToActive() {
  const active = getMidiActive();
  if (!active) return;
  active.chEQLow   = Object.assign({}, _midiChEQLow);
  active.chEQLoMid = Object.assign({}, _midiChEQLowMid);
  active.chEQHiMid = Object.assign({}, _midiChEQHiMid);
  active.chEQHigh  = Object.assign({}, _midiChEQHigh);
}

function _applyEQ(ch) {
  if (typeof synthSetEQ === 'function') {
    synthSetEQ(parseInt(ch), {
      low:   _midiChEQLow[ch]    || 0,
      loMid: _midiChEQLowMid[ch] || 0,
      hiMid: _midiChEQHiMid[ch]  || 0,
      high:  _midiChEQHigh[ch]   || 0,
    });
  }
}

// ── Compressor setter ──────────────────────────────────────────
function setMidiChCompressor(ch, amt) {
  _midiChCompAmt[ch] = amt;
  if (typeof synthSetCompressor === 'function') synthSetCompressor(parseInt(ch), amt);
  const active = getMidiActive();
  if (active) active.chComp = Object.assign({}, _midiChCompAmt);
}

// ── Song Library mixer preset apply ────────────────────────────
// Applies a saved preset object (same field shape as a playlist
// entry: chVolumes, chPrograms, chOctave, chPan, chReverbSend,
// chReverbType, chEQLow/LoMid/HiMid/High, chComp) straight through
// the real per-channel setters, so both the synth AND the active
// entry's own state end up correct. Used by songLibraryLaunch() to
// auto-apply a song's saved mixer setup on load — works for both
// Flex/.vwba playback and House Band chart playback, since both
// share this same channel-based synth mixer.
function midiApplyMixerSnapshot(preset) {
  if (!preset) return;
  Object.entries(preset.chVolumes    || {}).forEach(([ch, v]) => setMidiChannelVolume(parseInt(ch), v));
  Object.entries(preset.chPrograms   || {}).forEach(([ch, p]) => setMidiChannelInstrument(parseInt(ch), p));
  Object.entries(preset.chOctave     || {}).forEach(([ch, o]) => {
    const cur = (typeof midiChOctave !== 'undefined' && midiChOctave[ch]) || 0;
    if (typeof setMidiChOctave === 'function') setMidiChOctave(parseInt(ch), o - cur);
  });
  if (typeof setMidiChPan === 'function') {
    Object.entries(preset.chPan || {}).forEach(([ch, p]) => setMidiChPan(parseInt(ch), p));
  }
  Object.entries(preset.chReverbSend || {}).forEach(([ch, v])  => setMidiChReverbSend(parseInt(ch), v));
  Object.entries(preset.chReverbType || {}).forEach(([ch, t])  => setMidiChReverbType(parseInt(ch), t));
  Object.entries(preset.chEQLow      || {}).forEach(([ch, db]) => setMidiChEQLow(parseInt(ch), db));
  Object.entries(preset.chEQLoMid    || {}).forEach(([ch, db]) => setMidiChEQLoMid(parseInt(ch), db));
  Object.entries(preset.chEQHiMid    || {}).forEach(([ch, db]) => setMidiChEQHiMid(parseInt(ch), db));
  Object.entries(preset.chEQHigh     || {}).forEach(([ch, db]) => setMidiChEQHigh(parseInt(ch), db));
  Object.entries(preset.chComp       || {}).forEach(([ch, amt]) => setMidiChCompressor(parseInt(ch), amt));
  if (typeof renderMidiMixer === 'function') renderMidiMixer();
}

// ── Keyboard control ───────────────────────────────────────────
function _initMixerKeyboard() {
  if (document.getElementById('vwb-mixer-kb-listener')) return;
  const marker = document.createElement('span');
  marker.id = 'vwb-mixer-kb-listener';
  marker.style.display = 'none';
  document.body.appendChild(marker);

  document.addEventListener('keydown', (e) => {
    if (_selectedMidiCh < 0) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' && document.activeElement.type !== 'range') return;
    if (tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = midiChVolumes[_selectedMidiCh] !== undefined ? midiChVolumes[_selectedMidiCh] : 100;
      const nv  = Math.min(100, cur + (e.shiftKey ? 5 : 1));
      setMidiChannelVolume(_selectedMidiCh, nv);
      const fader = document.querySelector(`#midiChRow_${_selectedMidiCh} .vwb-fader`);
      if (fader) fader.value = nv;
      const volEl = document.getElementById('midiChVol_' + _selectedMidiCh);
      if (volEl) volEl.textContent = nv + '%';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = midiChVolumes[_selectedMidiCh] !== undefined ? midiChVolumes[_selectedMidiCh] : 100;
      const nv  = Math.max(0, cur - (e.shiftKey ? 5 : 1));
      setMidiChannelVolume(_selectedMidiCh, nv);
      const fader = document.querySelector(`#midiChRow_${_selectedMidiCh} .vwb-fader`);
      if (fader) fader.value = nv;
      const volEl = document.getElementById('midiChVol_' + _selectedMidiCh);
      if (volEl) volEl.textContent = nv + '%';
    } else if (e.key === 'Escape') {
      _selectedMidiCh = -1;
      document.querySelectorAll('.vwb-ch-strip').forEach(el => el.classList.remove('selected'));
    }
  });
}

// ── House Band musician identity on mixer strips ──────────────
//
//  When the House Band engine is active, each MIDI channel
//  corresponds to a specific musician via HB_SLOT_TO_CHANNEL.
//  This function returns the HTML for the bottom of each mixer
//  strip — showing portrait, musician name, and instrument role
//  instead of the generic "Electric Bass · Ch2" label.
//
//  Falls back to the generic label gracefully when:
//    - house-band-engine.js hasn't loaded
//    - The channel isn't a House Band channel
//    - No photo exists yet (uses emoji fallback)

function _hbGetMusicianStrip(chInt, drums, shortName, instIdx) {
  // Only try musician identity if the HB channel map is loaded
  if (typeof HB_SLOT_TO_CHANNEL === 'undefined' || typeof bandGetActive === 'undefined') {
    return _hbGenericStrip(chInt, drums, shortName, instIdx);
  }

  // Find which slot maps to this channel
  const slot = Object.keys(HB_SLOT_TO_CHANNEL).find(s => HB_SLOT_TO_CHANNEL[s] === chInt);
  if (!slot) return _hbGenericStrip(chInt, drums, shortName, instIdx);

  const musician = bandGetActive(slot);
  if (!musician) return _hbGenericStrip(chInt, drums, shortName, instIdx);

  // Get avatar path from band-ui.js BAND_AVATAR_PATHS if available
  const avatarPaths = (typeof BAND_AVATAR_PATHS !== 'undefined') ? BAND_AVATAR_PATHS : {};
  const avatarSrc   = avatarPaths[musician.id] || '';

  const slotLabels = {
    drums: 'Drums', percussion: 'Percussion', bass: 'Bass',
    keys: 'Keys', organ: 'Organ', guitar: 'Guitar', aux: 'Aux'
  };
  const slotEmojis = {
    drums: '🥁', percussion: '🪘', bass: '🎸',
    keys: '🎹', organ: '🎹', guitar: '🎸', aux: '🎛'
  };
  const slotLabel = slotLabels[slot] || slot;
  const slotEmoji = slotEmojis[slot] || '🎵';

  // First name only for tight mixer strip
  const firstName = musician.name.split(' ')[0];

  const portraitHtml = avatarSrc
    ? `<img class="vwb-musician-portrait" src="${avatarSrc}" alt="${musician.name}"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
       <div class="vwb-musician-portrait-fb" style="display:none;">${slotEmoji}</div>`
    : `<div class="vwb-musician-portrait-fb">${slotEmoji}</div>`;

  return `
    <div class="vwb-musician-id" title="Click to reassign ${musician.name}"
      onclick="event.stopPropagation();openInstrumentPicker(${chInt})"
      style="cursor:pointer;">
      <div class="vwb-musician-portrait-wrap">
        ${portraitHtml}
      </div>
      <div class="vwb-musician-name">${firstName}</div>
      <div class="vwb-musician-slot" style="color:rgba(64,224,208,.7);">${slotLabel} ▲</div>
    </div>`;
}

function _hbGenericStrip(chInt, drums, shortName, instIdx) {
  return `
    <div class="vwb-ch-name${drums ? ' drums' : ''}"
      onclick="event.stopPropagation();${drums ? '' : 'openInstrumentPicker(' + chInt + ')'}"
      title="${drums ? 'Drums (channel 10)' : 'Click to select instrument'}">
      ${shortName}
    </div>
    <div style="font-size:.5rem;color:rgba(255,255,255,.2);text-align:center;margin-top:-2px;">
      ${drums ? '' : '▲ tap to change'}
    </div>
    <div class="vwb-ch-num">Inst ${instIdx+1} · Ch${chInt+1}</div>`;
}

function renderMidiMixer() {
  const wrap = document.getElementById('midiMixer');
  if (!wrap) return;
  const active   = getMidiActive();
  const hasChart = typeof _cp !== 'undefined' && _cp !== null && _cp.chart !== null;
  if (!active && !hasChart) { wrap.innerHTML = ''; return; }

  // If chart is loaded but midiChNames is empty, rebuild from HB_SLOT_TO_CHANNEL.
  // This handles the case where the user loads a .vwbs on Song Setup then navigates
  // to Perform — the first renderMidiMixer call ran before the DOM was ready.
  if (hasChart && Object.keys(midiChNames).length === 0 &&
      typeof HB_SLOT_TO_CHANNEL !== 'undefined' &&
      typeof HB_SLOT_TO_PROGRAM  !== 'undefined') {
    const SLOT_LABELS = {
      keys: '🎹 Julian (Keys)', bass: '🎸 Terry (Bass)',
      organ: '🎹 Paul (Organ)', guitar: '🎸 Sanchez (Guitar)',
      aux: '🎹 Larry (Aux)', drums: '🥁 Jason (Drums)',
    };
    Object.entries(HB_SLOT_TO_CHANNEL).forEach(([slot, ch]) => {
      if (slot === 'percussion') return;
      midiChNames[ch]    = SLOT_LABELS[slot] || slot;
      midiChPrograms[ch] = HB_SLOT_TO_PROGRAM[slot];
    });
  }

  if (!active && Object.keys(midiChNames).length === 0) { wrap.innerHTML = ''; return; }

  const isDrums = (ch) => parseInt(ch) === 9;

  const channels = Object.entries(midiChNames)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

  // Inject styles once
  if (!document.getElementById('vwb-mixer-style')) {
    const style = document.createElement('style');
    style.id = 'vwb-mixer-style';
    style.textContent = `
      .vwb-ch-strip {
        display:flex;flex-direction:column;align-items:center;
        background:var(--bg-tertiary);border:1px solid var(--border);
        border-radius:10px;padding:.5rem .45rem .5rem;
        width:90px;min-width:90px;gap:.28rem;
        transition:opacity .2s,border-color .15s,box-shadow .15s;
        position:relative;cursor:pointer;user-select:none;
      }
      .vwb-ch-strip.silenced { opacity:.4; }
      .vwb-ch-strip:hover { border-color:rgba(255,255,255,.22); }
      .vwb-ch-strip.selected {
        border-color:var(--orange);
        box-shadow:0 0 0 2px rgba(255,140,50,.2), 0 0 14px rgba(255,140,50,.12);
      }

      /* Pan bar */
      .vwb-pan-wrap {
        width:100%;height:16px;position:relative;
        background:rgba(255,255,255,.05);border-radius:3px;
        cursor:ew-resize;overflow:visible;
        border:1px solid rgba(255,255,255,.06);
      }
      .vwb-pan-center {
        position:absolute;left:50%;top:2px;bottom:2px;
        width:1px;background:rgba(255,255,255,.15);transform:translateX(-50%);
      }
      .vwb-pan-fill {
        position:absolute;top:3px;bottom:3px;
        background:rgba(78,205,196,.5);border-radius:2px;
        pointer-events:none;
      }
      .vwb-pan-thumb {
        position:absolute;top:50%;
        width:3px;height:12px;border-radius:2px;
        background:#4ecdc4;transform:translate(-50%,-50%);
        pointer-events:none;
        box-shadow:0 0 4px rgba(78,205,196,.6);
      }
      .vwb-pan-label {
        position:absolute;right:3px;top:50%;transform:translateY(-50%);
        font-size:.5rem;font-family:'Space Mono',monospace;
        color:rgba(78,205,196,.7);pointer-events:none;
      }

      /* M / S buttons */
      .vwb-ms-row { display:flex;gap:.3rem; }
      .vwb-btn-m, .vwb-btn-s {
        font-size:.62rem;font-weight:700;
        width:24px;height:18px;border-radius:3px;
        border:1px solid var(--border);
        background:var(--bg-primary);color:var(--text-dim);
        cursor:pointer;display:flex;align-items:center;justify-content:center;
        transition:all .12s;
      }
      .vwb-btn-m.active { background:#e05252;color:#fff;border-color:#e05252; }
      .vwb-btn-s.active { background:#f0a030;color:#000;border-color:#f0a030; }

      /* Fader + meter */
      .vwb-fader-wrap {
        display:flex;align-items:center;justify-content:center;
        height:130px;width:52px;position:relative;overflow:visible;
        gap:0;
      }
      /* dB scale beside fader */
      .vwb-fader-scale {
        display:flex;flex-direction:column;justify-content:space-between;
        height:110px;width:18px;padding:0;
        position:absolute;left:2px;top:50%;transform:translateY(-50%);
        pointer-events:none;
      }
      .vwb-fader-scale span {
        font-size:.44rem;color:rgba(255,255,255,.35);
        font-family:'Space Mono',monospace;text-align:right;
        line-height:1;
      }
      .vwb-fader-scale span.unity { color:rgba(78,205,196,.7); font-weight:700; }
      /* Fader track — thin center line */
      .vwb-fader-track {
        position:absolute;left:50%;top:50%;
        transform:translate(-50%,-50%);
        width:3px;height:110px;
        background:rgba(255,255,255,.1);border-radius:2px;
        pointer-events:none;
      }
      .vwb-fader {
        -webkit-appearance:none;appearance:none;
        width:110px;height:3px;
        background:transparent;cursor:pointer;
        transform:rotate(-90deg);
        position:absolute;left:50%;top:50%;
        margin-left:-55px;margin-top:-1.5px;
      }
      .vwb-fader::-webkit-slider-thumb {
        -webkit-appearance:none;
        width:28px;height:10px;border-radius:2px;
        background:linear-gradient(180deg,#c8c8c8 0%,#888 50%,#aaa 100%);
        border:1px solid rgba(0,0,0,.5);cursor:grab;
        box-shadow:0 1px 4px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.25);
        position:relative;
      }
      /* Center line on thumb like real faders */
      .vwb-fader::-webkit-slider-thumb:active { cursor:grabbing; }
      .vwb-fader::-webkit-slider-runnable-track {
        height:3px;border-radius:2px;background:transparent;
      }\n      .vwb-fader:focus { outline:none; }
      }
      .vwb-fader:focus { outline:none; }
      .vwb-unity-line {
        position:absolute;left:50%;transform:translateX(-50%);
        width:20px;height:1px;background:rgba(78,205,196,.5);
        top:calc(50% - 5px);pointer-events:none;z-index:2;
      }

      /* Level meter */
      .vwb-meter-wrap {
        width:6px;height:100px;background:rgba(255,255,255,.07);
        border-radius:3px;position:relative;overflow:hidden;flex-shrink:0;
      }
      .vwb-meter-bar {
        position:absolute;bottom:0;left:0;width:100%;height:0%;
        border-radius:3px;background:linear-gradient(to top,#2a9d8f,#4ecdc4);
        transition:height 0.04s linear;
      }
      .vwb-meter-peak {
        position:absolute;left:0;width:100%;height:2px;
        background:#ffeb3b;border-radius:1px;bottom:0%;
      }

      /* Vol % */
      .vwb-vol-pct {
        font-size:.62rem;font-family:'Space Mono',monospace;
        color:var(--text-dim);min-width:36px;text-align:center;
      }

      /* Oct row */
      .vwb-oct-row { display:flex;align-items:center;gap:.2rem; }
      .vwb-oct-btn {
        font-size:.58rem;width:16px;height:16px;border-radius:3px;
        border:1px solid var(--border);background:var(--bg-primary);color:var(--text-dim);
        cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;
      }
      .vwb-oct-val {
        font-size:.62rem;font-family:'Space Mono',monospace;
        color:var(--text-primary);min-width:18px;text-align:center;
      }

      /* FX pill */
      .vwb-fx-btn {
        font-size:.58rem;font-weight:600;padding:.18rem .5rem;
        border-radius:4px;border:1px solid var(--border);
        background:var(--bg-primary);color:var(--text-dim);
        cursor:pointer;letter-spacing:.03em;width:100%;transition:all .12s;
      }
      .vwb-fx-btn.open { border-color:var(--orange);color:var(--orange);background:rgba(255,140,50,.08); }

      /* Channel name — clickable */
      .vwb-ch-name {
        font-size:.6rem;color:var(--text-primary);font-weight:600;
        text-align:center;width:100%;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;line-height:1.2;
        cursor:pointer;border-radius:3px;padding:.1rem .2rem;
        transition:background .12s;
      }
      .vwb-ch-name:hover { background:rgba(255,255,255,.08); }
      .vwb-ch-name.drums { cursor:default; }
      .vwb-ch-num {
        font-size:.55rem;color:var(--text-dim);font-family:'Space Mono',monospace;
      }

      /* Instrument picker */
      .vwb-inst-picker { font-family:'Outfit',sans-serif; }
      .vwb-inst-picker::-webkit-scrollbar { width:4px; }
      .vwb-inst-picker::-webkit-scrollbar-track { background:transparent; }
      .vwb-inst-picker::-webkit-scrollbar-thumb { background:var(--border);border-radius:2px; }

      /* Musician identity strip */
      .vwb-musician-id {
        display:flex;flex-direction:column;align-items:center;
        gap:.2rem;width:100%;
      }
      .vwb-musician-portrait-wrap {
        width:44px;height:44px;border-radius:50%;
        overflow:hidden;border:2px solid rgba(64,224,208,.3);
        background:var(--bg-secondary);
        display:flex;align-items:center;justify-content:center;
        flex-shrink:0;
      }
      .vwb-musician-portrait {
        width:100%;height:100%;object-fit:cover;display:block;
      }
      .vwb-musician-portrait-fb {
        font-size:1.2rem;
        display:flex;align-items:center;justify-content:center;
        width:100%;height:100%;
      }
      .vwb-musician-name {
        font-size:.62rem;font-weight:700;
        color:var(--text-primary);
        text-align:center;width:100%;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        line-height:1.2;
      }
      .vwb-musician-slot {
        font-size:.52rem;
        font-family:'Space Mono',monospace;
        color:var(--accent);
        text-transform:uppercase;letter-spacing:.06em;
        text-align:center;
      }

      /* Mixer strips — wrap instead of scroll, so the whole mixer is
         visible at once now that the wrap spans full width. Also
         fixes the FX popup getting clipped: overflow-x:auto used to
         force overflow-y to clip too, cutting off the floating panel. */
      .vwb-mixer-scroll {
        display:flex;flex-wrap:wrap;gap:.5rem;padding-bottom:.5rem;
      }
    `;
    document.head.appendChild(style);
  }

  // Build strips
  const stripsHTML = channels.map(([ch, name], instIdx) => {
    const vol    = midiChVolumes[ch] !== undefined ? midiChVolumes[ch] : 100;
    const chInt  = parseInt(ch);
    const drums  = isDrums(ch);
    const oct    = getMidiChOctave(chInt);
    const muted  = getMidiChMute(chInt);
    const soloed = getMidiChSolo(chInt);
    const anyS   = anySolo();
    const silenced = muted || (anyS && !soloed);
    const panRaw = midiChPan[chInt] || 0;
    const panPct = Math.round(panRaw * 100);
    // Pan bar: center at 50%, fill from center to thumb
    const thumbPct  = (panRaw + 1) / 2 * 100; // 0..100
    const fillLeft  = panRaw < 0 ? thumbPct   : 50;
    const fillWidth = Math.abs(panRaw) * 50;
    const panLabel  = panRaw === 0 ? '' : (panRaw < 0 ? 'L' + Math.abs(panPct) : 'R' + panPct);
    const shortName = drums ? '🥁 Drums' : (name.length > 10 ? name.substring(0,10)+'…' : name);

    return `
    <div class="vwb-ch-strip${silenced ? ' silenced' : ''}" id="midiChRow_${chInt}"
      onclick="selectMidiChannel(${chInt})">

      <!-- Pan bar — drag left/right -->
      <div class="vwb-pan-wrap" id="vwb-pan-${chInt}"
        title="Pan: ${panLabel || 'Center'}"
        onmousedown="startPanDrag(event,${chInt})">
        <div class="vwb-pan-center"></div>
        <div class="vwb-pan-fill" id="vwb-pan-fill-${chInt}"
          style="left:${fillLeft}%;width:${fillWidth}%;"></div>
        <div class="vwb-pan-thumb" id="vwb-pan-thumb-${chInt}"
          style="left:${thumbPct}%;"></div>
        <div class="vwb-pan-label" id="vwb-pan-lbl-${chInt}">${panLabel}</div>
      </div>

      <!-- M / S -->
      <div class="vwb-ms-row">
        <button class="vwb-btn-m${muted ? ' active' : ''}" id="midiMute_${chInt}"
          onclick="event.stopPropagation();toggleMidiChMute(${chInt})">M</button>
        <button class="vwb-btn-s${soloed ? ' active' : ''}" id="midiSolo_${chInt}"
          onclick="event.stopPropagation();toggleMidiChSolo(${chInt})">S</button>
      </div>

      <!-- Fader + meter -->
      <div style="display:flex;gap:5px;align-items:center;height:110px;">
        <div class="vwb-fader-wrap">
          <div class="vwb-fader-scale">
            <span>+6</span>
            <span class="unity">0</span>
            <span>-6</span>
            <span>-12</span>
            <span>-24</span>
            <span>-48</span>
          </div>
          <div class="vwb-fader-track"></div>
          <div class="vwb-unity-line"></div>
          <input type="range" class="vwb-fader"
            min="0" max="100" value="${vol}" step="1"
            onclick="event.stopPropagation()"
            oninput="setMidiChannelVolume(${chInt},this.value);
                     document.getElementById('midiChVol_${chInt}').textContent=this.value+'%';
                     document.getElementById('midiChDb_${chInt}').textContent=_pctToDb(parseInt(this.value))+' dB';">
        </div>
        <div class="vwb-meter-wrap">
          <div class="vwb-meter-bar" data-ch="${chInt}"></div>
          <div class="vwb-meter-peak"></div>
        </div>
      </div>

      <!-- Vol % and dB -->
      <div class="vwb-vol-pct" id="midiChVol_${chInt}">${vol}%</div>
      <div class="vwb-vol-db" id="midiChDb_${chInt}" style="font-size:.62rem;color:var(--text-dim);text-align:center;margin-top:-2px;">${_pctToDb(vol)} dB</div>

      <!-- Oct -->
      <div class="vwb-oct-row">
        <span class="vwb-oct-btn" onclick="event.stopPropagation();setMidiChOctave(${chInt},-1)">▼</span>
        <span class="vwb-oct-val" id="midiChOct_${chInt}">${_octaveLabel(oct)}</span>
        <span class="vwb-oct-btn" onclick="event.stopPropagation();setMidiChOctave(${chInt},1)">▲</span>
      </div>

      <!-- FX button -->
      <button class="vwb-fx-btn" id="midiChFxToggle_${chInt}"
        onclick="event.stopPropagation();toggleMidiChFx(${chInt})">FX ▸</button>

      <!-- Musician identity — name, portrait, instrument role -->
      ${_hbGetMusicianStrip(chInt, drums, shortName, instIdx)}
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div style="font-size:.75rem;font-weight:600;color:var(--orange);
                text-transform:uppercase;letter-spacing:.08em;margin-bottom:.65rem;">
      🎚 Channel Mixer
      <span style="font-size:.6rem;color:var(--text-dim);font-weight:400;margin-left:.75rem;">
        Click name to change instrument · Click FX for effects · ↑↓ adjust selected volume
      </span>
    </div>
    <div class="vwb-mixer-scroll" id="vwbMixerScroll">${stripsHTML}</div>
  `;

  // Restore selection
  if (_selectedMidiCh >= 0) {
    const strip = document.getElementById('midiChRow_' + _selectedMidiCh);
    if (strip) strip.classList.add('selected');
  }

  _initMixerKeyboard();
}

// ── Pan drag handler ───────────────────────────────────────────
function startPanDrag(e, ch) {
  e.stopPropagation();
  e.preventDefault();
  const wrap    = document.getElementById('vwb-pan-' + ch);
  if (!wrap) return;
  const rect    = wrap.getBoundingClientRect();
  const startX  = e.clientX;
  const startPan = midiChPan[ch] || 0;

  function onMove(e2) {
    const dx     = e2.clientX - startX;
    const range  = rect.width;
    const delta  = dx / range * 2; // -1..1 range
    const newPan = Math.max(-1, Math.min(1, startPan + delta));
    _updatePanBar(ch, newPan);
    setMidiChPan(ch, Math.round(newPan * 100));
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _updatePanBar(ch, panRaw) {
  const thumb    = document.getElementById('vwb-pan-thumb-' + ch);
  const fill     = document.getElementById('vwb-pan-fill-'  + ch);
  const lbl      = document.getElementById('vwb-pan-lbl-'   + ch);
  const thumbPct = (panRaw + 1) / 2 * 100;
  const fillLeft = panRaw < 0 ? thumbPct : 50;
  const fillW    = Math.abs(panRaw) * 50;
  const panPct   = Math.round(panRaw * 100);
  const panLabel = panRaw === 0 ? '' : (panRaw < 0 ? 'L'+Math.abs(panPct) : 'R'+panPct);
  if (thumb) thumb.style.left = thumbPct + '%';
  if (fill)  { fill.style.left = fillLeft + '%'; fill.style.width = fillW + '%'; }
  if (lbl)   lbl.textContent = panLabel;
}

// Section system, BPM helpers, and session serialization live in midi-sections.js

// ═══════════════════════════════════════════════════════════════
//  Level Meter Animation — synthStartMeters / synthStopMeters
// ═══════════════════════════════════════════════════════════════

let _meterRaf       = null;
let _meterAnalyser  = null;
let _midiPlayerMeterPeakHold  = {};

function synthStartMeters() {
  if (_meterRaf) return;
  try {
    const ctx = (typeof Tone !== 'undefined') ? Tone.getContext().rawContext : null;
    if (!ctx) { _meterRafFallback(); return; }
    if (!_meterAnalyser) {
      _meterAnalyser = ctx.createAnalyser();
      _meterAnalyser.fftSize = 256;
      _meterAnalyser.smoothingTimeConstant = 0.75;
      const toneDestNode = Tone.getDestination().output;
      if (toneDestNode && toneDestNode.connect) {
        toneDestNode.connect(_meterAnalyser);
      }
    }
  } catch (e) {
    console.warn('[Meters] Could not attach analyser:', e.message);
    _meterRafFallback();
    return;
  }
  _midiPlayerMeterPeakHold = {};
  _meterTick();
}

function synthStopMeters() {
  if (_meterRaf) { cancelAnimationFrame(_meterRaf); _meterRaf = null; }
  document.querySelectorAll('.vwb-meter-bar').forEach(bar => {
    bar.style.height = '0%';
    bar.style.background = 'linear-gradient(to top,#2a9d8f,#4ecdc4)';
  });
  document.querySelectorAll('.vwb-meter-peak').forEach(pk => { pk.style.bottom = '0%'; });
  _midiPlayerMeterPeakHold = {};
}

function _meterTick() {
  const cpActive   = typeof _cp !== 'undefined' && _cp !== null && _cp.playing;
  const midiActive = typeof midiPlaying !== 'undefined' && midiPlaying;
  if (!cpActive && !midiActive) { synthStopMeters(); return; }

  let masterLevel = 0;
  if (_meterAnalyser) {
    const buf = new Uint8Array(_meterAnalyser.frequencyBinCount);
    _meterAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const s = (buf[i] - 128) / 128; sum += s * s; }
    masterLevel = Math.sqrt(sum / buf.length);
  }

  const bars = document.querySelectorAll('.vwb-meter-bar[data-ch]');
  const now  = performance.now();
  bars.forEach(bar => {
    const ch     = parseInt(bar.dataset.ch);
    const wrap   = bar.closest('.vwb-meter-wrap');
    const peakEl = wrap ? wrap.querySelector('.vwb-meter-peak') : null;
    const vol     = (typeof midiChVolumes !== 'undefined' && midiChVolumes[ch] !== undefined) ? midiChVolumes[ch] / 100 : 1.0;
    const muted   = (typeof getMidiChMute === 'function') ? getMidiChMute(ch) : false;
    const anyS    = (typeof anySolo === 'function') ? anySolo() : false;
    const soloed  = (typeof getMidiChSolo === 'function') ? getMidiChSolo(ch) : false;
    const silenced = muted || (anyS && !soloed);
    const level   = silenced ? 0 : Math.min(1, masterLevel * vol * 2.5);
    const pct     = Math.round(level * 100);
    let color;
    if (pct > 85)      color = 'linear-gradient(to top,#e63946,#ff6b6b)';
    else if (pct > 65) color = 'linear-gradient(to top,#f4a261,#ffd166)';
    else               color = 'linear-gradient(to top,#2a9d8f,#4ecdc4)';
    bar.style.height     = pct + '%';
    bar.style.background = color;
    if (!_midiPlayerMeterPeakHold[ch]) _midiPlayerMeterPeakHold[ch] = { level: 0, holdUntil: 0 };
    const peak = _midiPlayerMeterPeakHold[ch];
    if (pct > peak.level) { peak.level = pct; peak.holdUntil = now + 1500; }
    else if (now > peak.holdUntil) { peak.level = Math.max(0, peak.level - 2); }
    if (peakEl) peakEl.style.bottom = peak.level + '%';
  });
  _meterRaf = requestAnimationFrame(_meterTick);
}

function _meterRafFallback() {
  setTimeout(() => {
    const cpActive   = typeof _cp !== 'undefined' && _cp !== null && _cp.playing;
    const midiActive = typeof midiPlaying !== 'undefined' && midiPlaying;
    if (cpActive || midiActive) synthStartMeters();
  }, 500);
}
