// ═══════════════════════════════════════════════════════════════
//  VWB — Internal MIDI Synthesizer  (Tone.js + IPC edition)
//  Loads sample files via Electron IPC bridge — no fetch()
//  required, works fully offline and inside Electron security.
// ═══════════════════════════════════════════════════════════════

const Tone = window.Tone;

// ── 12 core instruments ────────────────────────────────────────
const VWB_INSTRUMENTS = [
  {
    program: 0,
    name: 'Acoustic Grand Piano',
    sf: 'acoustic_grand_piano',
    notes: ['A0','A1','A2','A3','A4','A5','A6','A7',
            'C1','C2','C3','C4','C5','C6','C7','C8']
  },
  {
    program: 4,
    name: 'Electric Piano (Rhodes)',
    sf: 'electric_piano_1',
    notes: ['A1','A2','A3','A4','A5','A6',
            'C2','C3','C4','C5','C6','C7']
  },
  {
    program: 16,
    name: 'Drawbar Organ',
    sf: 'drawbar_organ',
    notes: ['C2','C3','C4','C5','C6'],
    defaultOctave: 1   // samples sit one octave low — shift up to match recording
  },
  {
    program: 24,
    name: 'Acoustic Guitar',
    sf: 'acoustic_guitar_nylon',
    notes: ['B2','E3','A3','D4','G4','B4','E5']
  },
  {
    program: 27,
    name: 'Electric Guitar',
    sf: 'electric_guitar_clean',
    notes: ['B2','E3','A3','D4','G4','B4','E5']
  },
  {
    program: 33,
    name: 'Electric Bass',
    sf: 'electric_bass_finger',
    notes: ['E1','A1','D2','G2','B2','E3'],
    defaultOctave: -1   // samples sit one octave high — default to -1 so it sounds correct
  },
  {
    program: 48,
    name: 'Strings',
    sf: 'string_ensemble_1',
    notes: ['A2','A3','A4','A5',
            'C2','C3','C4','C5','C6']
  },
  {
    program: 61,
    name: 'Brass Section',
    sf: 'brass_section',
    notes: ['D3','F3','D4','F4','D5','F5']
  },
  {
    program: 88,
    name: 'Smooth Pad',
    sf: 'pad_1_new_age',
    notes: ['C2','C3','C4','C5','C6']
  },
  {
    program: 89,
    name: 'Synth Pad',
    sf: 'pad_2_warm',
    notes: ['C2','C3','C4','C5','C6']
  },
  {
    program: 9,
    name: 'Glockenspiel / Bells',
    sf: 'glockenspiel',
    notes: ['G5','A5','B5','C6','D6','E6','F6','G6']
  },
  {
    program: 128,
    name: 'Drums',
    sf: 'percussion',
    isDrum: true,
    notes: [
      '35','36',
      '31','37','38','40',
      '41','42','43','44',
      '46','47','50',
      '49','51','53',
      '55'
    ]
  },
  {
    program: 200,
    name: 'Diane Moore Percussion',
    sf: 'hmpi_diane_perc',
    isDrum: true,
    isPercKit: true,   // uses note map, not chromatic pitch
  },
];

const VWB_PROG_MAP = {};
VWB_INSTRUMENTS.forEach(inst => { VWB_PROG_MAP[inst.program] = inst; });

// ── VWB Default Mix ───────────────────────────────────────────
// Applied to FX chains at build time. Set by applyDefaultMix()
// or pre-seeded here so channels sound right from first note.
// Ch 0=Keys, 1=Bass, 2=Organ, 3=Guitar, 4=Aux, 9=Drums
const VWB_CHANNEL_DEFAULTS = {
  0: { pan: -0.15, eq: { low: -1, loMid: -1, hiMid: -2, high: +1 }, reverb: 'hall', reverbSend: 17, delay: 26, comp: 17 },
  1: { pan:  0.00, eq: { low: +1, loMid: -3, hiMid: +1, high:  0 }, reverb: 'none', reverbSend:  0, delay:  8, comp: 57 },
  2: { pan: +0.15, eq: { low: -2, loMid: -1, hiMid: -2, high:  0 }, reverb: 'hall', reverbSend: 26, delay: 12, comp: 28 },
  3: { pan: +0.35, eq: { low: -3, loMid: +1, hiMid: -3, high: +1 }, reverb: 'hall', reverbSend: 32, delay:  0, comp: 36 },
  4: { pan: -0.20, eq: { low: -3, loMid: -3, hiMid: -1, high: +1 }, reverb: 'hall', reverbSend: 19, delay:  0, comp: 14 },
  9: { pan:  0.00, eq: { low: +2, loMid: -1, hiMid:  0, high: +2 }, reverb: 'hall', reverbSend:  0, delay:  0, comp: 37 },
};

// Pre-seed channel state from defaults so _buildNativeChFx picks them up
function _seedChannelDefaults() {
  Object.entries(VWB_CHANNEL_DEFAULTS).forEach(([ch, d]) => {
    const c = parseInt(ch);
    if (midiChPan[c]        === undefined) midiChPan[c]        = d.pan;
    if (midiChReverbSend[c] === undefined) midiChReverbSend[c] = d.reverbSend;
    if (midiChReverbType[c] === undefined) midiChReverbType[c] = d.reverb;
  });
}

// ── Core State ─────────────────────────────────────────────────
let _synthEnabled = false;
let _masterGain   = null;
let _blobCache    = {};
let _drumNoteMap  = {};

// ── Reverb Buses (Tone.js Convolver) ──────────────────────────
let _hallConvolver  = null;
let _plateConvolver = null;

// ── Per-channel sampler & FX chain ────────────────────────────
let _chSampler    = {};   // ch → Tone.Sampler
let _chProgram    = {};   // ch → program number
let _chVolume     = {};   // ch → 0-100
let _loadingCh    = {};   // ch → Promise

// Per-channel Tone.js FX nodes
let _nativePanner  = {};  // ch → StereoPannerNode
let _nativeDryGain = {};  // ch → GainNode (sampler → dry path)
let _nativeRevSend = {};  // ch → GainNode (sampler → reverb)
let _nativeAnalyser  = {}; // ch → AnalyserNode (for level meters)
let _drumAnalyser    = null; // AnalyserNode for drum bus
let _drumFXBus       = null; // Shared drum FX bus { eq, comp, delay, reverbSend }
let _nativeEQ        = {}; // ch → { low, loMid, hiMid, high } BiquadFilterNodes
let _nativeComp      = {}; // ch → DynamicsCompressorNode
let _nativeDelay     = {}; // ch → { delay, gain, panner } — stereo width delay

// Meter animation
let _meterAnimId    = null;
let _meterPeakHold  = {}; // ch → { level, timer }

// ── Per-channel FX settings (persisted in session) ─────────────
let midiChPan        = {};  // ch → -1..1,  default 0
let midiChReverbSend = {};  // ch → 0..100, default 0
let midiChReverbType = {};  // ch → 'hall' | 'plate' | 'none'

// ── Drum state ─────────────────────────────────────────────────
let _drumPlayers  = {};
let _drumsLoading = null;
let _warnedMissingDrumNote = {};  // dedupe repeated console warnings per note

// ── Drum Mix Table ─────────────────────────────────────────────
const DRUM_MIX = {
  // ── Kick Drums ──────────────────────  center, controlled
  35: { db:  -5, pan:  0.0 },   // Kick 2 (soft kick layer)
  36: { db:  -5, pan:  0.0 },   // Kick 1 (primary kick)
  // ── Snare Drums ─────────────────────  dead center, prominent
  31: { db:  +6, pan:  0.0 },   // Snare soft / ghost
  37: { db:  +6, pan:  0.0 },   // Snare cross-stick
  38: { db:  +6, pan:  0.0 },   // Snare medium
  40: { db:  +6, pan:  0.0 },   // Snare hard
  // ── Hi-Hats ─────────────────────────  midway left of center
  42: { db:   0, pan: -0.5 },   // Closed hi-hat
  44: { db:  +1, pan: -0.5 },   // Pedal hi-hat
  46: { db:  +1, pan: -0.5 },   // Open hi-hat
  // ── Toms ────────────────────────────  sweep left to right
  50: { db:  +2, pan: -0.8  },  // High tom → left
  48: { db:  +2, pan: -0.8  },  // High tom alt → left
  47: { db:  +2, pan: -0.25 },  // Mid tom → slightly left of center
  45: { db:  +2, pan: -0.25 },  // Mid tom alt
  43: { db:  +2, pan:  0.85 },  // Floor tom → far right
  41: { db:  +2, pan:  0.85 },  // Low floor tom → far right
  // ── Cymbals ─────────────────────────
  49: { db:  +1, pan: -0.6  },  // Crash → slightly left
  55: { db:  +1, pan: -0.6  },  // Splash/crash 2
  57: { db:  +1, pan: -0.6  },  // Crash 3
  51: { db:  +1, pan:  0.5  },  // Ride → midway right
  53: { db:  +1, pan:  0.5  },  // Ride bell
  59: { db:  +1, pan:  0.5  },  // Ride 2
};

const DRUM_VEL_MAP = {
  36: [{ maxVel: 70, sampleNote: 35 }, { maxVel: 127, sampleNote: 36 }],
  35: [{ maxVel: 127, sampleNote: 35 }],
  // Note 60 alias: Kenneth's Studio One kick track exports at note 60
  // (two octaves above GM standard note 36) instead of the expected
  // kick note — likely a non-GM drum instrument/pad mapping in his
  // Studio One template. Treat it as kick until the template is fixed.
  60: [{ maxVel: 70, sampleNote: 35 }, { maxVel: 127, sampleNote: 36 }],
  38: [{ maxVel: 42, sampleNote: 31 }, { maxVel: 85, sampleNote: 38 }, { maxVel: 127, sampleNote: 40 }],
  40: [{ maxVel: 42, sampleNote: 31 }, { maxVel: 85, sampleNote: 38 }, { maxVel: 127, sampleNote: 40 }],
  37: [{ maxVel: 127, sampleNote: 37 }],
  31: [{ maxVel: 127, sampleNote: 31 }],
  42: [{ maxVel: 127, sampleNote: 42 }],
  44: [{ maxVel: 127, sampleNote: 44 }],
  46: [{ maxVel: 127, sampleNote: 46 }],
  41: [{ maxVel: 127, sampleNote: 41 }],
  47: [{ maxVel: 127, sampleNote: 47 }],
  50: [{ maxVel: 127, sampleNote: 50 }],
  43: [{ maxVel: 127, sampleNote: 41 }],
  45: [{ maxVel: 127, sampleNote: 47 }],
  48: [{ maxVel: 127, sampleNote: 50 }],
  49: [{ maxVel: 127, sampleNote: 49 }],
  51: [{ maxVel: 127, sampleNote: 51 }],
  53: [{ maxVel: 127, sampleNote: 53 }],
  55: [{ maxVel: 127, sampleNote: 55 }],
  57: [{ maxVel: 127, sampleNote: 49 }],
  59: [{ maxVel: 127, sampleNote: 51 }],
};

function _resolveDrumSample(midiNote, velocity) {
  const layers = DRUM_VEL_MAP[midiNote];
  if (!layers) return null;
  for (const layer of layers) {
    if (velocity <= layer.maxVel) return String(layer.sampleNote);
  }
  return String(layers[layers.length - 1].sampleNote);
}

// ── Blob URL cache ─────────────────────────────────────────────
async function _sampleBlobUrl(sfName, note) {
  const key = sfName + '/' + note;
  if (_blobCache[key]) return _blobCache[key];
  try {
    const buffer = await window.vwb.readSampleFile(sfName, note);
    if (!buffer) return null;
    const blob = new Blob([buffer], { type: 'audio/mpeg' });
    const url  = URL.createObjectURL(blob);
    _blobCache[key] = url;
    return url;
  } catch (e) {
    console.warn('[VWB Synth] Could not read sample:', sfName, note, e);
    return null;
  }
}

// ── Native Web Audio helpers ────────────────────────────────────

// Get the AudioContext that Tone.js is actually using
function _ctx() {
  return Tone.context.rawContext || Tone.context._context || Tone.getContext().rawContext;
}

// Build a synthetic impulse-response buffer for convolution reverb
function _makeImpulse(ctx, durationSec, decay) {
  const len = Math.floor(ctx.sampleRate * durationSec);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function _initNativeBuses() {
  // Hall reverb — 3.5s decay, spacious
  _hallConvolver  = new Tone.Convolver();
  _plateConvolver = new Tone.Convolver();

  // Generate impulse responses after context is ready
  const ctx = _ctx();
  _hallConvolver.buffer  = _makeImpulse(ctx, 3.5, 2.0);
  _plateConvolver.buffer = _makeImpulse(ctx, 1.6, 3.5);

  // Both feed into Tone's master output
  _hallConvolver.toDestination();
  _plateConvolver.toDestination();
}

// ── Per-channel Tone.js FX chain ──────────────────────────────
// sampler → Tone.Panner → Tone.Destination  (dry path)
//         → Tone.Volume (send) → _hallConvolver or _plateConvolver (wet)
//
// Using Tone.js nodes throughout — this is the only reliable way
// to stay in Tone's audio graph in v14.

function _buildNativeChFx(ch) {
  // Tear down old Tone nodes
  if (_nativePanner[ch])  { try { _nativePanner[ch].dispose();  } catch(e) {} }
  if (_nativeRevSend[ch]) { try { _nativeRevSend[ch].dispose(); } catch(e) {} }
  if (_nativeDryGain[ch]) { try { _nativeDryGain[ch].dispose(); } catch(e) {} }

  const pan     = (midiChPan[ch]        !== undefined) ? midiChPan[ch]        : 0;
  const sendPct = (midiChReverbSend[ch] !== undefined) ? midiChReverbSend[ch] : 0;

  // ── FX Chain: sampler → EQ → Compressor → Panner → Destination ──
  const ctx = _ctx();

  // Analyser for metering
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.75;
  analyser.connect(ctx.destination);

  // 4-band EQ
  const eqLow   = ctx.createBiquadFilter(); eqLow.type   = 'lowshelf';  eqLow.frequency.value   = 80;
  const eqLoMid = ctx.createBiquadFilter(); eqLoMid.type = 'peaking';   eqLoMid.frequency.value = 500;  eqLoMid.Q.value = 1;
  const eqHiMid = ctx.createBiquadFilter(); eqHiMid.type = 'peaking';   eqHiMid.frequency.value = 3000; eqHiMid.Q.value = 1;
  const eqHigh  = ctx.createBiquadFilter(); eqHigh.type  = 'highshelf'; eqHigh.frequency.value  = 10000;
  eqLow.connect(eqLoMid); eqLoMid.connect(eqHiMid); eqHiMid.connect(eqHigh);
  _nativeEQ[ch] = { low: eqLow, loMid: eqLoMid, hiMid: eqHiMid, high: eqHigh };

  // Apply default EQ immediately if defined for this channel
  const _chDef = VWB_CHANNEL_DEFAULTS[ch];
  if (_chDef && _chDef.eq) {
    eqLow.gain.value   = _chDef.eq.low   || 0;
    eqLoMid.gain.value = _chDef.eq.loMid || 0;
    eqHiMid.gain.value = _chDef.eq.hiMid || 0;
    eqHigh.gain.value  = _chDef.eq.high  || 0;
  }

  // Compressor
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 6; comp.ratio.value = 1; comp.threshold.value = 0;
  comp.attack.value = 0.003; comp.release.value = 0.25;
  eqHigh.connect(comp);
  _nativeComp[ch] = comp;

  // Apply default compressor immediately if defined
  if (_chDef && _chDef.comp > 0) {
    const amt = _chDef.comp;
    comp.threshold.value = -6  - (amt / 100) * 24;
    comp.ratio.value     =  2  + (amt / 100) * 4;
    comp.attack.value    = 0.003 + (1 - amt/100) * 0.02;
    comp.release.value   = 0.1 + (amt / 100) * 0.3;
  }

  // Panner → Destination
  const panner = new Tone.Panner(pan).toDestination();
  try { comp.connect(panner.input || panner._panner || ctx.destination); } catch(e) { comp.connect(ctx.destination); }

  // Tap panner output for metering
  try {
    const panOut = panner.output || panner._panner || null;
    if (panOut && panOut.connect) panOut.connect(analyser);
  } catch(e) { console.warn('[VWB Synth] Meter tap ch' + ch + ':', e.message); }

  // Stereo width delay — opposite-side echo for depth and dimension
  // Chain: comp → delayGain → delay → delayPanner (opposite side) → destination
  const delayNode  = ctx.createDelay(0.5);
  delayNode.delayTime.value = 0.06; // 60ms — subtle enough to add depth, not echo
  const delayGain  = ctx.createGain();
  delayGain.gain.value = 0; // off by default
  const delayPan   = ctx.createStereoPanner();
  delayPan.pan.value = -pan; // opposite pan of the dry signal
  comp.connect(delayGain);
  delayGain.connect(delayNode);
  delayNode.connect(delayPan);
  delayPan.connect(ctx.destination);
  _nativeDelay[ch] = { delay: delayNode, gain: delayGain, panner: delayPan };

  // Wet path: reverb send
  const revSend = new Tone.Volume(sendPct <= 0 ? -80 : 20 * Math.log10(sendPct / 100));
  const type = midiChReverbType[ch] || 'none';
  if (type === 'hall'  && _hallConvolver)  revSend.connect(_hallConvolver);
  if (type === 'plate' && _plateConvolver) revSend.connect(_plateConvolver);

  _nativePanner[ch]   = panner;
  _nativeRevSend[ch]  = revSend;
  _nativeDryGain[ch]  = eqLow; // sampler connects here → flows through full chain
  _nativeAnalyser[ch] = analyser;

  return eqLow; // sampler.connect(eqLow) → EQ → comp → panner → destination
}

// ── Load instrument for a specific channel ─────────────────────
async function _loadChannelSampler(ch, program) {
  if (program === 128) return _loadDrumSampler();
  if (program === 200) return _loadDianePercSampler();  // Diane Moore Percussion Kit

  const inst = VWB_PROG_MAP[program];
  if (!inst) { console.warn('[VWB Synth] Unknown program:', program); return null; }

  if (_chSampler[ch] && _chProgram[ch] === program) return _chSampler[ch];
  if (_loadingCh[ch]) return _loadingCh[ch];

  if (_chSampler[ch]) {
    try { _chSampler[ch].disconnect(); } catch(e) {}
    _chSampler[ch] = null;
  }

  _setSynthStatus('Loading ' + inst.name + '...', 'loading');

  _loadingCh[ch] = (async () => {
    const urls = {};
    await Promise.all(inst.notes.map(async note => {
      const url = await _sampleBlobUrl(inst.sf, note);
      if (url) urls[note] = url;
    }));

    if (Object.keys(urls).length === 0) {
      _setSynthStatus('Failed to load ' + inst.name, 'error');
      delete _loadingCh[ch];
      return null;
    }

    // Build Tone.js FX chain for this channel
    const panner   = _buildNativeChFx(ch);
    const revSend  = _nativeRevSend[ch];

    return new Promise(resolve => {
      const sampler = new Tone.Sampler({
        urls,
        onload: () => {
          _chSampler[ch] = sampler;
          _chProgram[ch] = program;
          delete _loadingCh[ch];
          _setSynthStatus(inst.name + ' ready', 'ready');
          console.log('[VWB Synth] Ch' + (ch+1) + ' → native FX chain');
          resolve(sampler);
        },
        onerror: () => {
          delete _loadingCh[ch];
          _setSynthStatus('Failed to load ' + inst.name, 'error');
          resolve(null);
        }
      });

      // Connect sampler into Tone.js FX chain (stays in Tone graph)
      sampler.connect(panner);
      if (revSend) sampler.connect(revSend);
    });
  })();

  return _loadingCh[ch];
}

// ── Drum loader ────────────────────────────────────────────────
function _initDrumFXBus() {
  if (_drumFXBus) return; // already built
  const ctx = _ctx();
  if (!ctx) return;

  // Analyser for metering
  _drumAnalyser = ctx.createAnalyser();
  _drumAnalyser.fftSize = 256;
  _drumAnalyser.smoothingTimeConstant = 0.7;
  _drumAnalyser.connect(ctx.destination);

  // 4-band EQ
  const eqLow   = ctx.createBiquadFilter(); eqLow.type   = 'lowshelf';  eqLow.frequency.value   = 80;
  const eqLoMid = ctx.createBiquadFilter(); eqLoMid.type = 'peaking';   eqLoMid.frequency.value = 500;  eqLoMid.Q.value = 1;
  const eqHiMid = ctx.createBiquadFilter(); eqHiMid.type = 'peaking';   eqHiMid.frequency.value = 3000; eqHiMid.Q.value = 1;
  const eqHigh  = ctx.createBiquadFilter(); eqHigh.type  = 'highshelf'; eqHigh.frequency.value  = 10000;
  eqLow.connect(eqLoMid); eqLoMid.connect(eqHiMid); eqHiMid.connect(eqHigh);

  // Compressor
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 6; comp.ratio.value = 1; comp.threshold.value = 0;
  comp.attack.value = 0.003; comp.release.value = 0.25;
  eqHigh.connect(comp);

  // Panner → Analyser → Destination
  const drumPanner = ctx.createStereoPanner();
  drumPanner.pan.value = 0;
  comp.connect(drumPanner);
  drumPanner.connect(_drumAnalyser);

  // Reverb send — native GainNode (not Tone.Volume)
  const revSend = ctx.createGain();
  revSend.gain.value = 0;
  comp.connect(revSend);

  // Delay for depth
  const delayNode = ctx.createDelay(0.5);
  delayNode.delayTime.value = 0.06;
  const delayGain = ctx.createGain();
  delayGain.gain.value = 0;
  comp.connect(delayGain);
  delayGain.connect(delayNode);
  delayNode.connect(ctx.destination);

  _drumFXBus = {
    input:     eqLow,
    eq:        { low: eqLow, loMid: eqLoMid, hiMid: eqHiMid, high: eqHigh },
    comp,
    panner:    drumPanner,
    revSend,
    delay:     delayNode,
    delayGain,
  };

  // Register in channel 9 slots so all existing FX setters work automatically
  _nativeEQ[9]    = _drumFXBus.eq;
  _nativeComp[9]  = comp;
  _nativeDelay[9] = { delay: delayNode, gain: delayGain, panner: drumPanner };

  console.log('[VWB Synth] Drum FX bus ready');
}

async function _loadDrumSampler() {
  if (Object.keys(_drumPlayers).length > 0) return true;
  if (_drumsLoading) return _drumsLoading;

  _setSynthStatus('Loading Drums...', 'loading');

  _drumsLoading = (async () => {
    const inst = VWB_PROG_MAP[128];

    // Build shared drum FX bus if not already done
    _initDrumFXBus();

    const _failedDrumNotes = [];

    await Promise.all(inst.notes.map(midiNoteStr => new Promise(async resolve => {
      const url = await _sampleBlobUrl(inst.sf, midiNoteStr);
      if (!url) {
        _failedDrumNotes.push(midiNoteStr);
        console.warn('[VWB Synth] Drum sample FAILED to load — no file returned for note', midiNoteStr, '(sf="' + inst.sf + '"). This note will be silent.');
        resolve();
        return;
      }
      const mix = DRUM_MIX[parseInt(midiNoteStr)] || { db: 0, pan: 0 };

      // Each drum sound routes into the shared FX bus input (native EQ node)
      const drumGain = new Tone.Volume(mix.db);
      // Tone.Volume output → native EQ node: use Tone's internal node reference
      try {
        const toneOut = drumGain.output || drumGain._gainNode || null;
        if (toneOut) toneOut.connect(_drumFXBus.input);
        else drumGain.connect(Tone.Destination); // fallback
      } catch(e) { console.warn('[VWB] Drum FX connect:', e.message); }

      const p = new Tone.Player({
        url,
        onload: () => {
          _drumPlayers[midiNoteStr] = p;
          resolve();
        },
        onerror: (e) => {
          _failedDrumNotes.push(midiNoteStr);
          console.warn('[VWB Synth] Drum sample FAILED to decode/load for note', midiNoteStr, '(sf="' + inst.sf + '"):', e && e.message ? e.message : e, '— this note will be silent.');
          resolve();
        }
      }).connect(drumGain);
    })));

    if (_failedDrumNotes.length > 0) {
      console.warn('[VWB Synth] ' + _failedDrumNotes.length + ' drum note(s) failed to load and will be silent:', _failedDrumNotes.join(', '));
    }

    if (Object.keys(_drumPlayers).length === 0) {
      _setSynthStatus('Drums not available', 'error');
      _drumsLoading = null;
      return null;
    }
    _setSynthStatus('Drums ready (' + Object.keys(_drumPlayers).length + ' sounds)', 'ready');
    console.log('[VWB Synth] Drums loaded:', Object.keys(_drumPlayers).length);
    return true;
  })();

  return _drumsLoading;
}

// ═══════════════════════════════════════════════════════════════
//  VWB — Diane Moore Percussion Kit
//  A dedicated percussion sampler for channel 8.
//  Uses the same Tone.Player architecture as Jason's drums,
//  but with a custom note map instead of GM drum numbers.
//  All 6 samples live in app/hmpi_diane_perc/.
// ═══════════════════════════════════════════════════════════════

// ── Diane Percussion Note Map ─────────────────────────────────
// Note → { file, label, reverbSend }
// Matches the MIDI note assignments documented in the recording guide.
// Tolerance: notes within ±1 semitone will snap to nearest mapped note.

// ── VWB MPC Note Map — Full 20-pad layout ────────────────────
// Bank A (C3=60 to B3=71) — 12 core percussion samples
// Bank B (C4=72 to G4=79) — 8 additional samples
// Starts at Middle C (C3 in Studio One = MIDI 60).
// Sample files live in app/hmpi_diane_perc/ (WAV format).
const DIANE_PERC_NOTE_MAP = {
  // ── Bank A — starts at Middle C (MIDI 60) ──
  60: { file: 'kick_1',         label: 'Kick 1',         reverbSend: 0.02 },
  61: { file: 'kick_2',         label: 'Kick 2',         reverbSend: 0.02 },
  62: { file: 'snare',          label: 'Snare',          reverbSend: 0.08 },
  63: { file: 'clap',           label: 'Clap',           reverbSend: 0.12 },
  64: { file: 'hi-hat',         label: 'Hi-Hat',         reverbSend: 0.04 },
  65: { file: 'snap',           label: 'Snap',           reverbSend: 0.06 },
  66: { file: 'shaker',         label: 'Shaker',         reverbSend: 0.08 },
  67: { file: 'tamborine',      label: 'Tambourine',     reverbSend: 0.20 },
  68: { file: 'conga',          label: 'Conga',          reverbSend: 0.10 },
  69: { file: 'conga_slap',     label: 'Conga Slap',     reverbSend: 0.08 },
  70: { file: 'triangle',       label: 'Triangle',       reverbSend: 0.25 },
  71: { file: 'wood_block',     label: 'Wood Block',     reverbSend: 0.05 },
  // ── Bank B ──
  72: { file: 'windchimes',     label: 'Wind Chimes',    reverbSend: 0.45 },
  73: { file: 'bongo_high',     label: 'Bongo High',     reverbSend: 0.10 },
  74: { file: 'bongo_low',      label: 'Bongo Low',      reverbSend: 0.10 },
  75: { file: 'cow_bell',       label: 'Cow Bell',       reverbSend: 0.05 },
  76: { file: 'high_tam',       label: 'High Tam',       reverbSend: 0.15 },
  77: { file: 'timpani',        label: 'Timpani',        reverbSend: 0.30 },
  78: { file: 'triangle_closed',label: 'Triangle Closed',reverbSend: 0.15 },
  79: { file: 'triangle_open',  label: 'Triangle Open',  reverbSend: 0.35 },
};

// Per-instrument mix settings (dB gain, stereo pan)
const DIANE_PERC_MIX = {
  // Bank A
  kick_1:          { db:  0.0, pan:  0.0 },
  kick_2:          { db:  0.0, pan:  0.1 },
  snare:           { db:  0.0, pan:  0.0 },
  clap:            { db: -1.0, pan:  0.2 },
  'hi-hat':        { db: -1.5, pan:  0.4 },
  snap:            { db: -1.0, pan: -0.2 },
  shaker:          { db: -2.0, pan: -0.4 },
  tamborine:       { db: -1.0, pan:  0.5 },
  conga:           { db:  0.0, pan:  0.3 },
  conga_slap:      { db: -0.5, pan:  0.3 },
  triangle:        { db: -2.0, pan:  0.6 },
  wood_block:      { db: -1.0, pan:  0.0 },
  // Bank B
  windchimes:      { db: -3.0, pan:  0.0 },
  bongo_high:      { db:  0.0, pan:  0.4 },
  bongo_low:       { db:  0.0, pan: -0.4 },
  cow_bell:        { db: -1.0, pan:  0.0 },
  high_tam:        { db: -1.5, pan:  0.3 },
  timpani:         { db:  1.0, pan:  0.0 },
  triangle_closed: { db: -2.0, pan:  0.5 },
  triangle_open:   { db: -2.0, pan:  0.5 },
};

// ── Diane Perc State ──────────────────────────────────────────
let _dianePercPlayers  = {};   // file → Tone.Player
let _dianePercLoading  = null; // Promise while loading
let _dianePercFXBus    = null; // Shared FX bus (same architecture as drums)
let _dianePercAnalyser = null;

// ── Note resolution with ±1 semitone tolerance ────────────────
function _dianePercResolveNote(midiNote) {
  if (DIANE_PERC_NOTE_MAP[midiNote]) return midiNote;
  // Snap to nearest mapped note within ±1 semitone
  const mapped = Object.keys(DIANE_PERC_NOTE_MAP).map(Number);
  let closest = null, closestDist = Infinity;
  for (const m of mapped) {
    const dist = Math.abs(midiNote - m);
    if (dist < closestDist && dist <= 1) { closest = m; closestDist = dist; }
  }
  return closest; // null if no match within ±1 — silent
}

// ── Diane Perc FX Bus ─────────────────────────────────────────
// Same architecture as _initDrumFXBus() — shared EQ, compressor,
// analyser, and reverb send for all percussion sounds.
// Channel 8 registers here instead of channel 9.

function _initDianePercFXBus() {
  if (_dianePercFXBus) return;
  const ctx = _ctx();
  if (!ctx) return;

  // Analyser for metering (channel 8 meter in mixer)
  _dianePercAnalyser = ctx.createAnalyser();
  _dianePercAnalyser.fftSize = 256;
  _dianePercAnalyser.smoothingTimeConstant = 0.7;
  _dianePercAnalyser.connect(ctx.destination);

  // 4-band EQ
  const eqLow   = ctx.createBiquadFilter(); eqLow.type   = 'lowshelf';  eqLow.frequency.value   = 80;
  const eqLoMid = ctx.createBiquadFilter(); eqLoMid.type = 'peaking';   eqLoMid.frequency.value = 500;  eqLoMid.Q.value = 1;
  const eqHiMid = ctx.createBiquadFilter(); eqHiMid.type = 'peaking';   eqHiMid.frequency.value = 3000; eqHiMid.Q.value = 1;
  const eqHigh  = ctx.createBiquadFilter(); eqHigh.type  = 'highshelf'; eqHigh.frequency.value  = 10000;
  eqLow.connect(eqLoMid); eqLoMid.connect(eqHiMid); eqHiMid.connect(eqHigh);

  // Compressor — gentle, preserves percussion transients
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 8; comp.ratio.value = 2; comp.threshold.value = -12;
  comp.attack.value = 0.001; comp.release.value = 0.15;
  eqHigh.connect(comp);

  // Panner → Analyser → Destination
  const percPanner = ctx.createStereoPanner();
  percPanner.pan.value = 0;
  comp.connect(percPanner);
  percPanner.connect(_dianePercAnalyser);

  // Reverb send — native GainNode
  const revSend = ctx.createGain();
  revSend.gain.value = 0;
  comp.connect(revSend);

  // Delay for subtle depth
  const delayNode = ctx.createDelay(0.5);
  delayNode.delayTime.value = 0.05;
  const delayGain = ctx.createGain();
  delayGain.gain.value = 0;
  comp.connect(delayGain);
  delayGain.connect(delayNode);
  delayNode.connect(ctx.destination);

  _dianePercFXBus = {
    input:     eqLow,
    eq:        { low: eqLow, loMid: eqLoMid, hiMid: eqHiMid, high: eqHigh },
    comp,
    panner:    percPanner,
    revSend,
    delay:     delayNode,
    delayGain,
  };

  // Register on channel 8 so all existing FX setters (EQ, comp, reverb, delay)
  // work automatically for Diane's channel in the mixer
  _nativeEQ[8]       = _dianePercFXBus.eq;
  _nativeComp[8]     = comp;
  _nativeDelay[8]    = { delay: delayNode, gain: delayGain, panner: percPanner };
  _nativeAnalyser[8] = _dianePercAnalyser;

  console.log('[VWB Synth] Diane Perc FX bus ready');
}

// ── Diane Perc Loader ─────────────────────────────────────────
async function _loadDianePercSampler() {
  if (Object.keys(_dianePercPlayers).length > 0) return true;
  if (_dianePercLoading) return _dianePercLoading;

  _setSynthStatus('Loading Diane Percussion...', 'loading');

  _dianePercLoading = (async () => {
    _initDianePercFXBus();

    const files = Object.values(DIANE_PERC_NOTE_MAP)
      .map(e => e.file)
      .filter((f, i, arr) => arr.indexOf(f) === i); // unique file names

    await Promise.all(files.map(fileName => new Promise(async resolve => {
      const url = await _sampleBlobUrl('hmpi_diane_perc', fileName);
      if (!url) {
        console.warn('[DianePerc] Sample not found:', fileName);
        resolve();
        return;
      }
      const mix = DIANE_PERC_MIX[fileName] || { db: 0, pan: 0 };

      // Per-instrument gain + pan node, routed into shared FX bus
      const gainNode   = new Tone.Volume(mix.db);
      const panNode    = new Tone.Panner(mix.pan);

      // Connect: player → gainNode → panNode → _dianePercFXBus.input
      try {
        const gainOut = gainNode.output || gainNode._gainNode || null;
        const panOut  = panNode.output  || panNode._panner   || null;
        if (gainOut && panOut) {
          gainOut.connect(panNode.input || panNode._panner || gainOut);
          if (panOut.connect) panOut.connect(_dianePercFXBus.input);
        } else {
          gainNode.connect(Tone.Destination); // safe fallback
        }
      } catch(e) { console.warn('[DianePerc] FX connect:', e.message); }

      const player = new Tone.Player({
        url,
        onload: () => {
          _dianePercPlayers[fileName] = player;
          console.log('[DianePerc] Loaded:', fileName);
          resolve();
        },
        onerror: () => {
          console.warn('[DianePerc] Failed:', fileName);
          resolve();
        }
      }).connect(gainNode);
    })));

    if (Object.keys(_dianePercPlayers).length === 0) {
      _setSynthStatus('Diane Percussion not available — check hmpi_diane_perc folder', 'error');
      _dianePercLoading = null;
      return null;
    }

    _setSynthStatus(
      'Diane Percussion ready (' + Object.keys(_dianePercPlayers).length + ' sounds)', 'ready'
    );
    console.log('[VWB Synth] Diane Perc loaded:',
      Object.keys(_dianePercPlayers).length + '/' + files.length + ' samples');
    return true;
  })();

  return _dianePercLoading;
}

// ── Diane Perc Note On ────────────────────────────────────────
function _dianePercNoteOn(midiNote, vel, chVol) {
  const resolvedNote = _dianePercResolveNote(midiNote);
  if (resolvedNote === null) return;

  const entry = DIANE_PERC_NOTE_MAP[resolvedNote];
  if (!entry) return;

  const player = _dianePercPlayers[entry.file];
  if (!player) return;

  const volPct  = (chVol !== undefined ? chVol : 100) / 100;
  const velGain = Math.pow(vel / 127, 0.85); // gentle velocity curve
  const velDb   = 20 * Math.log10(Math.max(0.001, velGain * volPct));
  player.volume.value = velDb;

  // Route wind chimes and tambourine through reverb bus automatically
  if (_dianePercFXBus && entry.reverbSend > 0) {
    const revType = midiChReverbType[8] || 'hall'; // default to hall for percussion
    _dianePercFXBus.revSend.gain.value = entry.reverbSend;
    if (revType === 'hall'  && _hallConvolver)  {
      try { _dianePercFXBus.revSend.disconnect(); } catch(e) {}
      _dianePercFXBus.revSend.connect(_hallConvolver);
    } else if (revType === 'plate' && _plateConvolver) {
      try { _dianePercFXBus.revSend.disconnect(); } catch(e) {}
      _dianePercFXBus.revSend.connect(_plateConvolver);
    }
  }

  try {
    if (player.loaded) player.start(Tone.now());
  } catch(e) {}
}


// ── Delay Setter ───────────────────────────────────────────────
// amt: 0-100. Maps to gain 0-0.4 (subtle to noticeable depth)
function synthSetDelay(ch, amt) {
  const d = _nativeDelay[ch];
  if (!d) return;
  d.gain.gain.value = amt <= 0 ? 0 : (amt / 100) * 0.4;
  // Adjust delay time: low mix = short (wider), high mix = longer (more echo feel)
  d.delay.delayTime.value = 0.04 + (amt / 100) * 0.08; // 40ms-120ms
  // Keep delay on opposite side of current pan
  const curPan = midiChPan[ch] || 0;
  d.panner.pan.value = curPan === 0 ? 0.7 : -curPan; // if centered, push delay right
}

// ── EQ Setter ──────────────────────────────────────────────────
function synthSetEQ(ch, bands) {
  const eq = _nativeEQ[ch];
  if (!eq) return;
  if (bands.low   !== undefined) eq.low.gain.value   = bands.low;
  if (bands.loMid !== undefined) eq.loMid.gain.value = bands.loMid;
  if (bands.hiMid !== undefined) eq.hiMid.gain.value = bands.hiMid;
  if (bands.high  !== undefined) eq.high.gain.value  = bands.high;
}

// ── Compressor Setter ──────────────────────────────────────────
// amt: 0-100. Maps to threshold: 0=off(-6dB threshold), 100=heavy(-30dB)
// Musical curve: low amounts add punch, high amounts clamp peaks.
function synthSetCompressor(ch, amt) {
  const comp = _nativeComp[ch];
  if (!comp) return;
  if (amt <= 0) {
    comp.threshold.value = 0; // effectively off
    comp.ratio.value     = 1;
    return;
  }
  // Map 0-100 to threshold -6dB to -30dB and ratio 2:1 to 6:1
  comp.threshold.value = -6  - (amt / 100) * 24;  // -6 to -30
  comp.ratio.value     =  2  + (amt / 100) * 4;   // 2:1 to 6:1
  comp.attack.value    = 0.003 + (1 - amt/100) * 0.02; // fast for punchy, slower for gentle
  comp.release.value   = 0.1 + (amt / 100) * 0.3;
}

// ── Level Meter API ────────────────────────────────────────────
// Returns 0-1 RMS level for a channel. Called by the mixer UI.
function synthGetChannelLevel(ch) {
  const chInt = parseInt(ch);
  // Channel 9 = Jason drums, Channel 8 = Diane percussion
  const analyser = chInt === 9 ? _drumAnalyser
                 : chInt === 8 ? _dianePercAnalyser
                 : _nativeAnalyser[ch];
  if (!analyser) return 0;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// Start/stop the meter animation loop
function synthStartMeters() {
  if (_meterAnimId) return;
  function tick() {
    _meterAnimId = requestAnimationFrame(tick);
    // Update each visible meter bar
    document.querySelectorAll('.vwb-meter-bar').forEach(bar => {
      const ch  = parseInt(bar.dataset.ch);
      const rms = synthGetChannelLevel(ch);
      // Convert RMS to display height (0-100%)
      // Apply log scale so it feels natural — quiet signals visible, loud fills meter
      const db  = rms > 0.0001 ? 20 * Math.log10(rms) : -80;
      const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));

      bar.style.height = pct + '%';

      // Color zones: green → yellow → orange → red
      if (pct > 90)      bar.style.background = 'linear-gradient(to top, #4ecdc4, #ffeb3b, #ff5722)';
      else if (pct > 70) bar.style.background = 'linear-gradient(to top, #4ecdc4, #ffeb3b)';
      else               bar.style.background = 'linear-gradient(to top, #2a9d8f, #4ecdc4)';

      // Peak hold dot
      const peakEl = bar.parentElement && bar.parentElement.querySelector('.vwb-meter-peak');
      if (peakEl) {
        const held = _meterPeakHold[ch] || { level: 0 };
        if (pct > held.level) {
          held.level = pct;
          clearTimeout(held.timer);
          held.timer = setTimeout(() => {
            held.level = 0;
            if (peakEl) peakEl.style.bottom = '0%';
          }, 1800);
          _meterPeakHold[ch] = held;
        }
        peakEl.style.bottom = Math.min(98, held.level) + '%';
      }
    });
  }
  tick();
}

function synthStopMeters() {
  if (_meterAnimId) { cancelAnimationFrame(_meterAnimId); _meterAnimId = null; }
}

// ── Init ───────────────────────────────────────────────────────
function initSynth() {
  if (typeof Tone === 'undefined' || !Tone) {
    console.warn('[VWB Synth] Tone.js not loaded');
    document.querySelectorAll('.synth-mode-wrap').forEach(el => {
      el.innerHTML = '<div style="font-size:.75rem;color:#ff4466;padding:.5rem;border:1px solid #ff4466;border-radius:6px;">⚠ Sound engine failed to load. Tone.js missing.</div>';
    });
    return;
  }
  if (!window.vwb || !window.vwb.readSampleFile) {
    console.warn('[VWB Synth] readSampleFile not available in preload');
    return;
  }

  // Seed channel state from defaults before any FX chains build
  _seedChannelDefaults();

  // Initialize native Web Audio buses (reverb, master out)
  _initNativeBuses();
  _initDrumFXBus();      // build drum FX bus eagerly so reverb/EQ work before drums load
  _initDianePercFXBus(); // build Diane perc FX bus eagerly (channel 8)

  // Boost MIDI synth master output volume.
  try {
    Tone.Destination.volume.value = 10;
  } catch(e) {
    console.warn('[VWB Synth] Could not set master volume:', e);
  }

  _synthEnabled = true;
  console.log('[VWB Synth] Ready — native Web Audio FX routing active');
  renderSynthModeUI();
}

// ── Public instrument loader ───────────────────────────────────
// Called from midi-player.js. ch is required for correct FX routing.
async function loadInstrument(program, ch) {
  if (program === 128) return _loadDrumSampler();
  if (ch !== undefined) return _loadChannelSampler(ch, program);
  // Fallback: load without FX chain (preload before channel is known)
  const inst = VWB_PROG_MAP[program];
  if (!inst) return null;
  if (VWB_PROG_MAP[program]) {
    const urls = {};
    await Promise.all(inst.notes.map(async note => {
      const url = await _sampleBlobUrl(inst.sf, note);
      if (url) urls[note] = url;
    }));
    return urls; // just warm the blob cache
  }
}

async function preloadChannelInstruments(events) {
  // Build channel → program map from events
  const chProgMap = {};
  let hasDrums = false;
  events.forEach(ev => {
    if (ev.type === 'pc') chProgMap[ev.ch] = ev.program;
    if (ev.type === 'on' && ev.ch === 9) hasDrums = true;
  });
  // Also include already-set programs
  Object.entries(_chProgram).forEach(([ch, prog]) => {
    if (!(ch in chProgMap)) chProgMap[ch] = prog;
  });

  const loads = Object.entries(chProgMap)
    .filter(([, prog]) => VWB_PROG_MAP[prog])
    .map(([ch, prog]) => _loadChannelSampler(parseInt(ch), prog));

  if (hasDrums) loads.push(_loadDrumSampler());

  // Check if any channel is using Diane Perc (program 200)
  const hasPercKit = Object.values(chProgMap).includes(200) ||
    Object.values(_chProgram).includes(200);
  if (hasPercKit) loads.push(_loadDianePercSampler());

  if (loads.length === 0) loads.push(_loadChannelSampler(0, 0));

  _setSynthStatus('Loading ' + loads.length + ' instrument(s)...', 'loading');
  await Promise.all(loads);
  _setSynthStatus('Ready — ' + loads.length + ' instrument(s) loaded', 'ready');
}

// ── Playback ───────────────────────────────────────────────────
// ── Per-channel sustain pedal state ───────────────────────────
const _chSustainDown = {};   // ch → boolean
const _chSustainHeld = {};   // ch → Set of held note names

function synthNoteOn(ch, note, vel, program, duration) {
  if (!_synthEnabled) return;
  if (Tone.context.state === 'suspended') Tone.start();

  const prog = program !== undefined
    ? program
    : (_chProgram[ch] !== undefined ? _chProgram[ch] : (ch === 9 ? 128 : 0));

  // Drums (channel 9 / program 128)
  if (prog === 128) {
    if (Object.keys(_drumPlayers).length === 0) { _loadDrumSampler(); return; }
    const sampleNote = _resolveDrumSample(note, vel);
    if (!sampleNote) {
      if (!_warnedMissingDrumNote[note]) {
        _warnedMissingDrumNote[note] = true;
        console.warn('[VWB Synth] No DRUM_VEL_MAP entry for incoming MIDI note', note, '— this drum hit is silently dropped.');
      }
      return;
    }
    const player = _drumPlayers[sampleNote];
    if (!player) {
      if (!_warnedMissingDrumNote[sampleNote]) {
        _warnedMissingDrumNote[sampleNote] = true;
        console.warn('[VWB Synth] Drum sample for note', sampleNote, '(resolved from incoming note', note + ') never loaded — this drum hit is silent. Check the sample file for note', sampleNote, 'in your percussion sample folder.');
      }
      return;
    }
    const volPct = (_chVolume[ch] !== undefined ? _chVolume[ch] : 100) / 100;
    const velDb  = 20 * Math.log10(Math.max(0.001, (vel / 127) * volPct));
    player.volume.value = velDb;
    try { if (player.loaded) player.start(Tone.now()); } catch(e) {}
    return;
  }

  // Diane Moore Percussion Kit (channel 8 / program 200)
  if (prog === 200) {
    if (Object.keys(_dianePercPlayers).length === 0) {
      _loadDianePercSampler();
      return;
    }
    _dianePercNoteOn(note, vel, _chVolume[ch]);
    return;
  }

  // Pitched — use per-channel sampler
  const sampler = _chSampler[ch];
  if (!sampler || _chProgram[ch] !== prog) {
    _loadChannelSampler(ch, prog);
    return;
  }

  const volPct   = (_chVolume[ch] !== undefined ? _chVolume[ch] : 100) / 100;
  const velocity = (vel / 127) * volPct;
  try {
    const noteName = Tone.Frequency(note, 'midi').toNote();
    if (_chSustainHeld[ch]) _chSustainHeld[ch].delete(noteName);

    if (duration && duration > 0 && !_chSustainDown[ch]) {
      // Use exact recorded duration plus a velocity-scaled release tail.
      // Harder notes (higher velocity) need more tail time so they don't
      // cut off abruptly — soft notes need less.
      const releaseTail = 0.05 + (velocity * 0.25); // 50ms–300ms based on velocity
      const holdSecs = Math.max(0.05, duration + releaseTail);
      sampler.triggerAttackRelease(noteName, holdSecs, Tone.now(), velocity);
    } else {
      // Sustain pedal is down or no duration — use attack only
      // (release will be handled by note-off or pedal-up)
      sampler.triggerAttack(noteName, Tone.now(), velocity);
    }
  } catch (e) {
    console.warn('[VWB Synth] noteOn error:', e);
  }
}

function synthNoteOff(ch, note) {
  if (!_synthEnabled) return;
  const prog = _chProgram[ch] !== undefined ? _chProgram[ch] : (ch === 9 ? 128 : 0);
  if (prog === 128) return;
  const sampler = _chSampler[ch];
  if (!sampler) return;

  if (note === -1) {
    // Release all — used for sustain pedal up or all notes off
    _chSustainDown[ch] = false;
    if (_chSustainHeld[ch]) {
      _chSustainHeld[ch].forEach(n => {
        try { sampler.triggerRelease(n, Tone.now()); } catch(e) {}
      });
      _chSustainHeld[ch].clear();
    }
    try { sampler.releaseAll(); } catch(e) {}
    return;
  }

  try {
    const noteName = Tone.Frequency(note, 'midi').toNote();
    if (_chSustainDown[ch]) {
      // Pedal is down — hold the note, don't release yet
      if (!_chSustainHeld[ch]) _chSustainHeld[ch] = new Set();
      _chSustainHeld[ch].add(noteName);
    } else {
      sampler.triggerRelease(noteName, Tone.now());
    }
  } catch(e) {}
}

function synthSustainPedal(ch, val) {
  // val >= 64 = pedal down, val < 64 = pedal up
  if (val >= 64) {
    _chSustainDown[ch] = true;
    if (!_chSustainHeld[ch]) _chSustainHeld[ch] = new Set();
  } else {
    // Pedal up — release all held notes
    synthNoteOff(ch, -1);
  }
}

function synthAllNotesOff() {
  Object.keys(_chSampler).forEach(ch => {
    _chSustainDown[ch] = false;
    if (_chSustainHeld[ch]) _chSustainHeld[ch].clear();
  });
  Object.values(_chSampler).forEach(s => { try { s.releaseAll(); } catch(e) {} });
}

function synthSetProgram(ch, program) {
  if (_chProgram[ch] === program) return; // no change needed
  _chProgram[ch] = program;
  _loadChannelSampler(ch, program);
}

function synthSetVolume(ch, pct) { _chVolume[ch] = pct; }

// Master volume for the entire MIDI synth engine (0-100)
// Called by the master volume slider in the main UI
function synthSetMasterVol(v) {
  const pct = parseFloat(v) / 100;
  try {
    if (pct <= 0) {
      Tone.Destination.volume.value = -Infinity;
    } else {
      // Convert 0-100 linear to dB, offset by +10 to match init boost
      Tone.Destination.volume.value = 20 * Math.log10(pct) + 10;
    }
  } catch(e) {
    console.warn('[VWB Synth] synthSetMasterVol error:', e);
  }
}

// ── FX Setters ─────────────────────────────────────────────────

function setMidiChPan(ch, val) {
  const panVal = Math.max(-1, Math.min(1, val / 100));
  midiChPan[ch] = panVal;
  // _nativePanner[ch] is a Tone.Panner — set via .pan.value
  if (_nativePanner[ch]) _nativePanner[ch].pan.value = panVal;
  _persistFx();
  const el = document.getElementById('midiChPanVal_' + ch);
  if (el) el.textContent = val == 0 ? 'C' : (val < 0 ? 'L' + Math.abs(val) : 'R' + val);
}

function _connectToConvolver(gainNode, convolver) {
  if (!gainNode || !convolver) return;
  try {
    const ctx = _ctx();
    // Get the underlying native AudioNode from Tone.js wrapper
    const native = convolver._nativeAudioNode
      || (convolver.input && convolver.input._nativeAudioNode)
      || convolver.input
      || null;
    if (native && native.constructor && native.constructor.name === 'ConvolverNode') {
      gainNode.connect(native);
    } else {
      // Tone.js connect method accepts native nodes
      convolver.connect && convolver.connect(ctx.destination); // ensure convolver outputs
      gainNode.connect(ctx.destination); // fallback — at least play dry
    }
  } catch(e) {
    console.warn('[VWB Synth] Reverb connect:', e.message);
  }
}

function setMidiChReverbType(ch, type) {
  midiChReverbType[ch] = type;
  const chInt = parseInt(ch);

  if (chInt === 9 && _drumFXBus) {
    try { _drumFXBus.revSend.disconnect(); } catch(e) {}
    if (type === 'hall'  && _hallConvolver)  _connectToConvolver(_drumFXBus.revSend, _hallConvolver);
    if (type === 'plate' && _plateConvolver) _connectToConvolver(_drumFXBus.revSend, _plateConvolver);
    if (type !== 'none') _drumFXBus.revSend.gain.value = (midiChReverbSend[9] || 0) / 100;
    _persistFx();
    return;
  }

  if (_nativeRevSend[ch]) {
    try { _nativeRevSend[ch].disconnect(); } catch(e) {}
    if (type === 'hall'  && _hallConvolver)  _connectToConvolver(_nativeRevSend[ch], _hallConvolver);
    if (type === 'plate' && _plateConvolver) _connectToConvolver(_nativeRevSend[ch], _plateConvolver);
  }
  _persistFx();
  _updateFxUI(ch);
}

function setMidiChReverbSend(ch, pct) {
  midiChReverbSend[ch] = parseInt(pct);
  const chInt = parseInt(ch);

  if (chInt === 9 && _drumFXBus) {
    // Drums — native GainNode
    _drumFXBus.revSend.gain.value = pct <= 0 ? 0 : parseInt(pct) / 100;
    _persistFx();
    return;
  }

  if (_nativeRevSend[ch]) {
    _nativeRevSend[ch].volume.value = pct <= 0 ? -80 : 20 * Math.log10(parseInt(pct) / 100);
  }
  _persistFx();
  const el = document.getElementById('midiChRevSendVal_' + ch);
  if (el) el.textContent = pct + '%';
}

function _persistFx() {
  if (typeof getMidiActive !== 'function') return;
  const active = getMidiActive();
  if (!active) return;
  active.chPan        = Object.assign({}, midiChPan);
  active.chReverbSend = Object.assign({}, midiChReverbSend);
  active.chReverbType = Object.assign({}, midiChReverbType);
}

function _updateFxUI(ch) {
  const type = midiChReverbType[ch] || 'none';
  ['hall','plate'].forEach(t => {
    const btn = document.getElementById('midiChRev_' + t + '_' + ch);
    if (!btn) return;
    const active = (type === t);
    btn.style.background   = active ? (t === 'hall' ? 'rgba(126,184,212,.3)' : 'rgba(212,160,126,.3)') : 'none';
    btn.style.borderColor  = active ? (t === 'hall' ? '#7eb8d4' : '#d4a07e') : 'var(--border)';
    btn.style.color        = active ? (t === 'hall' ? '#7eb8d4' : '#d4a07e') : 'var(--text-dim)';
  });
  // Show/hide send slider
  const sendRow = document.getElementById('midiChRevSendRow_' + ch);
  if (sendRow) sendRow.style.display = (type === 'none') ? 'none' : 'flex';
}

// ── Mode ───────────────────────────────────────────────────────
function setSynthMode(enabled) {
  _synthEnabled = enabled;
  if (enabled && Tone.context.state === 'suspended') Tone.start();
  renderSynthModeUI();
  updateSynthToggleBtns();
}
function toggleSynthMode() { setSynthMode(!_synthEnabled); }
function isSynthEnabled()  { return _synthEnabled; }

// ── Status ─────────────────────────────────────────────────────
function _setSynthStatus(msg, cls) {
  document.querySelectorAll('.synth-status').forEach(el => {
    el.textContent = msg;
    el.className   = 'synth-status' + (cls ? ' synth-status-' + cls : '');
  });
}

// ── UI ─────────────────────────────────────────────────────────
function updateSynthToggleBtns() {
  document.querySelectorAll('.synth-mode-btn').forEach(btn => {
    const active = (btn.dataset.mode === 'internal') === _synthEnabled;
    btn.classList.toggle('active', active);
    btn.style.background  = active ? 'var(--accent)' : 'none';
    btn.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
    btn.style.color       = active ? '#000' : 'var(--text-dim)';
  });
}

function renderSynthModeUI() {
  document.querySelectorAll('.synth-mode-wrap').forEach(wrap => {
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;">
        <span style="font-size:.75rem;color:var(--text-dim);font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Sound Source</span>
      </div>
      <div style="display:flex;gap:.4rem;margin-bottom:.5rem;">
        <button class="synth-mode-btn" data-mode="internal"
          onclick="setSynthMode(true)"
          style="flex:1;padding:.35rem .5rem;border-radius:6px;
                 border:1px solid ${_synthEnabled ? 'var(--accent)' : 'var(--border)'};
                 background:${_synthEnabled ? 'var(--accent)' : 'none'};
                 color:${_synthEnabled ? '#000' : 'var(--text-dim)'};
                 font-size:.75rem;font-weight:600;cursor:pointer;transition:all .2s;">
          🔊 Built-in Sounds
        </button>
        <button class="synth-mode-btn" data-mode="external"
          onclick="setSynthMode(false)"
          style="flex:1;padding:.35rem .5rem;border-radius:6px;
                 border:1px solid ${!_synthEnabled ? 'var(--accent)' : 'var(--border)'};
                 background:${!_synthEnabled ? 'var(--accent)' : 'none'};
                 color:${!_synthEnabled ? '#000' : 'var(--text-dim)'};
                 font-size:.75rem;font-weight:600;cursor:pointer;transition:all .2s;">
          🎹 External MIDI
        </button>
      </div>
      <div class="synth-status synth-status-${_synthEnabled ? 'ready' : 'idle'}"
        style="font-size:.7rem;color:var(--text-dim);font-style:italic;">
        ${_synthEnabled
          ? 'Built-in sounds active — instruments load from local files'
          : 'External MIDI active — connect a keyboard or module'}
      </div>
    `;
  });
}

setTimeout(() => {
  initSynth();
  if (typeof setSynthMode === 'function' && !isSynthEnabled()) {
    setSynthMode(true);
  }
}, 300);
