// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — The Organist
//  The Organist — Hammond Organ Module
//  Features: Keyboard triggers, Smart Random sequences,
//            Auto Key Detection via pitch analysis
//  Depends on: state.js, audio-engine.js
// ═══════════════════════════════════════════════════════════════

// ── Core State ────────────────────────────────────────────────
let abRootFolder   = '';
let abCurrentKey   = 'C';
let abCurrentLevel = 'Level2';
let abSamples      = {};
let abLoaded       = false;
let abPlaying      = false;
let abCurrentSrc   = null;
let abCurrentBuf   = null;
let abGain         = null;
let abVolume       = 80;

// ── Organ Reverb FX ───────────────────────────────────────────
let abReverbType   = 'none';   // 'none' | 'hall' | 'plate'
let abReverbAmount = 30;       // 0-100 wet send level
let abReverbSend   = null;     // GainNode: organ → reverb bus
let abHallConv     = null;     // ConvolverNode: hall reverb
let abPlateConv    = null;     // ConvolverNode: plate reverb
let abReverbOut    = null;     // GainNode: reverb bus → mGain
let abFxOpen       = false;    // whether FX panel is expanded (setup)
let abFxOpenPerf   = false;    // whether FX panel is expanded (perform)
let abSampleIdx    = {};
let abLevel3Gain   = null;   // separate gain node for Level 3 +2dB boost
let abAutoLooping  = false;  // true when Level 3 or TalkingMusic auto-loop is active

// ── Random / Smart Sequence State ─────────────────────────────
let abRandomMode        = false;
let abCurrentSeq        = [];    // current chord sequence being played
let abCurrentSeqPos     = 0;     // position within current sequence
let abSeqHistory        = [];    // last few sequences to avoid repeats

// ── Auto-Play Sequential (Diatonic) State ─────────────────────
// When auto-play is ON and random is OFF, chords step through
// the diatonic scale in order: 1 → 2 → 3 → 4 → ♭5 → 5 → 6 → 7 → repeat
const AB_DIATONIC_ORDER = ['1Chord','2Chord','3Chord','4Chord','Flat5Chord','5Chord','6Chord','7Chord'];
let abDiatonicPos = 0;  // current position in AB_DIATONIC_ORDER

// ── Key Detection State ───────────────────────────────────────
let abListening         = false;
let abListenStream      = null;
let abListenAnalyser    = null;
let abListenSource      = null;
let abListenTimer       = null;
let abListenFlashTimer  = null;
let abListenCountdown   = 0;   // seconds remaining in listen window
let abKeyLocked         = false;
let abDetectedKey       = '';

const AB_KEYS = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

// ── Auto-Play (Voice Activity Detection) State ────────────────
let abAutoPlay         = false;   // master on/off
let abVadStream        = null;    // mic stream for VAD
let abVadSource        = null;    // MediaStreamAudioSourceNode
let abVadAnalyser      = null;    // AnalyserNode for RMS measurement
let abVadInterval      = null;    // polling interval
let abVadSpeaking      = false;   // true = preacher is currently speaking
let abVadCooldown      = false;   // true = just triggered, waiting before next trigger
let abVadSensitivity   = 15;      // RMS threshold (0-100 scale); lower = more sensitive
let abVadDelay         = 400;     // ms to wait after silence before triggering
let abVadSilenceTimer  = null;    // timeout that fires the trigger after silence
let abVadMicDeviceId   = '';      // '' = default mic; populated from device selector
let abVadMicLabel      = 'Default Mic';
let abVadCooldownMs    = 1200;    // ms to lock out re-trigger after a sample fires

// ── Organist Profile ──────────────────────────────────────────
let abOrganistName  = '';   // name from organist_name.txt
let abOrganistPhoto = '';   // base64 data URL from organist_photo.jpg
const AB_LEVELS = [
  { id: 'Level1',       label: 'Level 1',       sub: 'Runs & Startup',   color: '#40E0D0', key: '1' },
  { id: 'Level2',       label: 'Level 2',       sub: 'Chord Hits',       color: '#FF8844', key: '2' },
  { id: 'Level3',       label: 'Level 3',       sub: 'The Drive',        color: '#FF4466', key: '3' },
  { id: 'TalkingMusic', label: 'Talking Music',  sub: 'Prayer & Talking', color: '#AA66FF', key: '4' },
];

// ── Smart Gospel Sequences for Level 2 ────────────────────────
// Each sequence is chord names matching Level2 file suffixes
const AB_SEQUENCES = [
  ['1Chord', '4Chord'],
  ['2Chord', '5Chord', '1Chord'],
  ['3Chord', '6Chord', '2Chord', '5Chord', '1Chord'],
  ['Flat5Chord', '5Chord'],
  ['7Chord', '4Chord', '1Chord'],
  ['5Chord', '1Chord'],
  ['5Chord', '3Chord', '4Chord'],
  ['3Chord', '4Chord', 'Flat5Chord', '5Chord'],
];

// Chromatic pitch classes for key detection
const NOTE_NAMES = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

// ── Init ──────────────────────────────────────────────────────
function initArmorBearer() {
  if (!abGain) {
    abGain = AC.createGain();
    abGain.gain.value = abVolume / 100;
    abGain.connect(mGain);
  }
  if (!abLevel3Gain) {
    // +2dB boost for Level 3 samples (linear gain ≈ 10^(2/20) ≈ 1.259)
    abLevel3Gain = AC.createGain();
    abLevel3Gain.gain.value = 1.259;
    abLevel3Gain.connect(abGain);
  }
  if (!abReverbOut) {
    // Reverb output gain → mGain (parallel with dry abGain)
    abReverbOut = AC.createGain();
    abReverbOut.gain.value = 0.75;
    abReverbOut.connect(mGain);

    // Reverb send (wet level control)
    abReverbSend = AC.createGain();
    abReverbSend.gain.value = abReverbAmount / 100;

    // Hall convolver — long spacious room (3.5s)
    abHallConv  = AC.createConvolver();
    abHallConv.buffer  = _abMakeImpulse(3.5, 2.0);

    // Plate convolver — tight bright plate (1.6s)
    abPlateConv = AC.createConvolver();
    abPlateConv.buffer = _abMakeImpulse(1.6, 3.5);

    // Wire: abGain → abReverbSend → [active convolver] → abReverbOut
    abGain.connect(abReverbSend);
    _abConnectReverb();
  }
}

// Build a synthetic impulse response buffer
function _abMakeImpulse(durationSec, decay) {
  const len = Math.floor(AC.sampleRate * durationSec);
  const buf = AC.createBuffer(2, len, AC.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// Connect reverb send to the currently selected convolver
function _abConnectReverb() {
  if (!abReverbSend) return;
  try { abReverbSend.disconnect(); } catch(e) {}
  if (abReverbType === 'hall'  && abHallConv)  {
    abReverbSend.connect(abHallConv);
    abHallConv.connect(abReverbOut);
  } else if (abReverbType === 'plate' && abPlateConv) {
    abReverbSend.connect(abPlateConv);
    abPlateConv.connect(abReverbOut);
  }
  // 'none' → send disconnected, no reverb
}

// Reverb setters called from UI
function abSetReverbType(type) {
  abReverbType = type;
  _abConnectReverb();
  renderArmorBearerSetup();
  renderArmorBearerPerform();
}

function abSetReverbAmount(pct) {
  abReverbAmount = parseInt(pct);
  if (abReverbSend) abReverbSend.gain.value = abReverbAmount / 100;
  const els = ['abRevAmtSetup', 'abRevAmtPerf'];
  els.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = pct + '%'; });
}

// ── Folder Loading ────────────────────────────────────────────
async function abSelectRootFolder() {
  initArmorBearer();
  const result = await window.vwb.pickFolder({ title: 'Select VWB Organ Samples Folder' });
  if (!result || result.canceled) return;
  abRootFolder = result.path;
  showNotification('⏳ Loading Hammond samples…');
  await abScanFolder();
  renderArmorBearerSetup();
  renderArmorBearerPerform();
  showNotification('🎹 The Organist loaded — ' + abRootFolder.split('/').pop());
}

async function abScanFolder() {
  abSamples = {};
  abLoaded  = false;
  if (!abRootFolder) return;
  try {
    const scanResult = await window.vwb.scanArmorBearerFolder(abRootFolder);
    if (!scanResult || !scanResult.success) {
      showNotification('❌ Could not read Hammond samples folder'); return;
    }
    abSamples       = scanResult.samples;
    abOrganistName  = scanResult.organistName  || '';
    abOrganistPhoto = scanResult.organistPhoto || '';
    if (typeof window._refreshOrganistIdentity === 'function') window._refreshOrganistIdentity();
    abLoaded        = Object.keys(abSamples).length > 0;
  } catch(e) {
    showNotification('❌ The Organist scan error: ' + e.message);
  }
}

// ── Auto-load bundled organ samples on startup ─────────────────
//  Checks for the bundled organ-samples/ folder inside the app
//  directory. If found, loads it automatically so users never
//  need to manually browse for the samples folder.
async function abAutoLoadBundled() {
  if (abLoaded) return; // already loaded
  try {
    if (!window.vwb || typeof window.vwb.getOrganSamplesPath !== 'function') return;
    const result = await window.vwb.getOrganSamplesPath();
    if (!result || !result.success) {
      console.log('[ArmorBearer] No bundled organ-samples folder found — user must select manually');
      return;
    }
    abRootFolder = result.path;
    initArmorBearer();
    await abScanFolder();
    if (abLoaded) {
      console.log('[ArmorBearer] Bundled organ samples loaded automatically from:', abRootFolder);
      if (typeof renderArmorBearerSetup  === 'function') renderArmorBearerSetup();
      if (typeof renderArmorBearerPerform === 'function') renderArmorBearerPerform();
    }
  } catch(e) {
    console.warn('[ArmorBearer] Auto-load error:', e.message);
  }
}

// ── Core Playback ─────────────────────────────────────────────
async function abTrigger(key, level) {
  if (!key)   key   = abCurrentKey;
  if (!level) level = abCurrentLevel;

  const keyData = abSamples[key];
  if (!keyData) { showNotification('⚠ No samples for key ' + key); return; }

  let filePath;
  let useLevel = level; // actual level we pull a file from (may differ in random mix)

  if (abRandomMode && (level === 'Level2' || level === 'Level1')) {
    // ── Smart Random Mix: ~65% L2 gospel sequences, ~25% L2 wildcard, ~10% L1 sprinkle ──
    const roll = Math.random();
    if (roll < 0.10) {
      // Sprinkle Level 1
      const l1Files = keyData['Level1'];
      if (l1Files && l1Files.length) {
        useLevel = 'Level1';
        filePath = l1Files[Math.floor(Math.random() * l1Files.length)];
      } else {
        // Fall back to Level 2 if no L1 samples
        useLevel = 'Level2';
        const l2Files = keyData['Level2'] || [];
        filePath = _abSmartSequenceNext(key, l2Files);
      }
    } else {
      // Primary Level 2 (sequences + wildcards handled inside _abSmartSequenceNext)
      useLevel = 'Level2';
      const l2Files = keyData['Level2'];
      if (!l2Files || !l2Files.length) { showNotification('⚠ No Level 2 samples for key ' + key); return; }
      filePath = _abSmartSequenceNext(key, l2Files);
    }
  } else {
    const files = keyData[level];
    if (!files || !files.length) { showNotification('⚠ No ' + level + ' samples for key ' + key); return; }
    // Round-robin
    const rrKey = key + '_' + level;
    if (abSampleIdx[rrKey] === undefined) abSampleIdx[rrKey] = 0;
    filePath = files[abSampleIdx[rrKey] % files.length];
    abSampleIdx[rrKey]++;
  }

  // Auto-loop levels
  const isAutoLoop = (level === 'Level3' || level === 'TalkingMusic');

  try {
    const rb = await window.vwb.readFileBuffer(filePath);
    if (!rb || !rb.success) { showNotification('❌ Could not load: ' + filePath.split('/').pop()); return; }
    const audioBuffer = await AC.decodeAudioData(rb.buffer.slice(0));
    abPlayBuffer(audioBuffer, level, isAutoLoop);
    abCurrentKey   = key;
    abCurrentLevel = level;
    renderArmorBearerPerform();
  } catch(e) {
    showNotification('❌ The Organist error: ' + e.message);
  }
}

function abPlayBuffer(buf, level, autoLoop) {
  abStop();
  initArmorBearer();
  abAutoLooping = !!autoLoop;

  const src = AC.createBufferSource();
  src.buffer = buf;

  // Route Level 3 through the +2dB boost gain node
  if (level === 'Level3') {
    src.connect(abLevel3Gain);
  } else {
    src.connect(abGain);
  }

  src.onended = () => {
    if (abCurrentSrc === src) {
      if (abAutoLooping && abPlaying) {
        // Auto-loop: restart the same buffer immediately
        abPlayBuffer(buf, level, true);
      } else {
        abPlaying = false; abCurrentSrc = null; abAutoLooping = false;
        renderArmorBearerPerform();
      }
    }
  };
  src.start(0);
  abCurrentSrc = src; abCurrentBuf = buf; abPlaying = true;
}

function abStop() {
  abAutoLooping = false;
  if (abCurrentSrc) {
    try { abCurrentSrc.stop(); } catch(e) {}
    try { abCurrentSrc.disconnect(); } catch(e) {}
    abCurrentSrc = null;
  }
  abPlaying = false;
}

// ── Smart Sequence Engine ─────────────────────────────────────
function _abSmartSequenceNext(key, files) {
  // If no active sequence or sequence complete, pick a new one
  if (!abCurrentSeq.length || abCurrentSeqPos >= abCurrentSeq.length) {
    abCurrentSeq    = _abPickNextSequence();
    abCurrentSeqPos = 0;
  }

  const chordName = abCurrentSeq[abCurrentSeqPos];
  abCurrentSeqPos++;

  // Find the file matching this chord name
  const match = files.find(f => {
    const base = f.split('/').pop().split('\\').pop();
    return base.toLowerCase().includes(chordName.toLowerCase());
  });

  if (match) return match;

  // Fallback — random file if chord not found
  return files[Math.floor(Math.random() * files.length)];
}

function _abPickNextSequence() {
  // Occasionally (20% chance) throw in a single random chord between sequences
  if (Math.random() < 0.2) {
    const randomChords = ['1Chord','4Chord','5Chord','2Chord','6Chord'];
    return [randomChords[Math.floor(Math.random() * randomChords.length)]];
  }

  // Pick a sequence not recently used
  let available = AB_SEQUENCES.filter((_, i) => !abSeqHistory.includes(i));
  if (!available.length) { abSeqHistory = []; available = AB_SEQUENCES; }

  const idx = Math.floor(Math.random() * available.length);
  const seq = available[idx];
  const seqIdx = AB_SEQUENCES.indexOf(seq);
  abSeqHistory.push(seqIdx);
  if (abSeqHistory.length > 4) abSeqHistory.shift();

  return [...seq]; // return a copy
}

function abToggleRandom() {
  abRandomMode    = !abRandomMode;
  abCurrentSeq    = [];
  abCurrentSeqPos = 0;
  abSeqHistory    = [];
  renderArmorBearerPerform();
  showNotification(abRandomMode ? '🎲 Smart Random ON' : '🎲 Smart Random OFF');
}

// ── Auto-Play VAD Engine ──────────────────────────────────────
// Listens to mic in real time. When the preacher pauses (silence),
// VWB fires a Level 2 chord hit (occasional Level 1 sprinkle).

async function abStartAutoPlay() {
  if (abAutoPlay) { abStopAutoPlay(); return; }
  if (!abLoaded)  { showNotification('⚠ Load Hammond samples first'); return; }

  try {
    const constraints = {
      audio: abVadMicDeviceId
        ? { deviceId: { exact: abVadMicDeviceId } }
        : true,
      video: false
    };
    abVadStream   = await navigator.mediaDevices.getUserMedia(constraints);
    abVadSource   = AC.createMediaStreamSource(abVadStream);
    abVadAnalyser = AC.createAnalyser();
    abVadAnalyser.fftSize = 1024;
    abVadSource.connect(abVadAnalyser);

    abAutoPlay   = true;
    abVadSpeaking = false;
    abVadCooldown = false;
    abDiatonicPos = 0;   // always start from 1 chord in sequential mode
    renderArmorBearerPerform();
    showNotification('🎙 Auto-Play ON — listening for preacher');

    const bufLen  = abVadAnalyser.frequencyBinCount;
    const timeData = new Uint8Array(bufLen);

    abVadInterval = setInterval(() => {
      if (!abAutoPlay) return;
      abVadAnalyser.getByteTimeDomainData(timeData);

      // Calculate RMS volume (0–100 scale)
      let sumSq = 0;
      for (let i = 0; i < bufLen; i++) {
        const s = (timeData[i] - 128) / 128;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / bufLen) * 100;

      const threshold = abVadSensitivity;

      if (rms > threshold) {
        // ── Preacher is speaking ──
        abVadSpeaking = true;
        // Cancel any pending silence trigger
        if (abVadSilenceTimer) {
          clearTimeout(abVadSilenceTimer);
          abVadSilenceTimer = null;
        }
      } else {
        // ── Silence detected ──
        if (abVadSpeaking && !abVadCooldown && !abVadSilenceTimer) {
          // Preacher just stopped — start the delay timer
          abVadSilenceTimer = setTimeout(() => {
            abVadSilenceTimer = null;
            abVadSpeaking     = false;
            if (!abAutoPlay || abVadCooldown) return;
            // Fire a sample on the breath pause
            _abAutoPlayTrigger();
          }, abVadDelay);
        }
      }
    }, 50); // poll every 50ms

  } catch(e) {
    showNotification('❌ Mic access denied — allow microphone access for Auto-Play');
    abAutoPlay = false;
    renderArmorBearerPerform();
  }
}

function abStopAutoPlay() {
  abAutoPlay = false;
  if (abVadInterval)    { clearInterval(abVadInterval);    abVadInterval    = null; }
  if (abVadSilenceTimer){ clearTimeout(abVadSilenceTimer); abVadSilenceTimer = null; }
  if (abVadSource)      { try { abVadSource.disconnect(); } catch(e) {} abVadSource = null; }
  if (abVadStream)      { abVadStream.getTracks().forEach(t => t.stop()); abVadStream = null; }
  abVadAnalyser = null;
  abVadSpeaking = false;
  abVadCooldown = false;
  renderArmorBearerPerform();
  showNotification('🎙 Auto-Play OFF');
}

function _abAutoPlayTrigger() {
  const keyData = abSamples[abCurrentKey];
  if (!keyData) return;

  let filePath;
  let level = 'Level2';

  if (abRandomMode) {
    // ── Random mode: smart gospel patterns + occasional Level 1 sprinkle ──
    const useLevel = (Math.random() < 0.10) ? 'Level1' : 'Level2';
    let files = keyData[useLevel];
    level = useLevel;
    if (!files || !files.length) { files = keyData['Level2']; level = 'Level2'; }
    if (!files || !files.length) return;
    if (level === 'Level2') {
      filePath = _abSmartSequenceNext(abCurrentKey, files);
    } else {
      filePath = files[Math.floor(Math.random() * files.length)];
    }
  } else {
    // ── Sequential diatonic mode: 1 → 2 → 3 → 4 → ♭5 → 5 → 6 → 7 → repeat ──
    const l2Files = keyData['Level2'];
    if (!l2Files || !l2Files.length) return;

    const chordName = AB_DIATONIC_ORDER[abDiatonicPos % AB_DIATONIC_ORDER.length];
    abDiatonicPos = (abDiatonicPos + 1) % AB_DIATONIC_ORDER.length;

    // Find file matching this chord name
    const match = l2Files.find(f => {
      const base = f.split('/').pop().split('\\').pop();
      return base.toLowerCase().includes(chordName.toLowerCase());
    });
    filePath = match || l2Files[Math.floor(Math.random() * l2Files.length)];
    level = 'Level2';
  }

  // Set cooldown so we don't re-trigger immediately
  abVadCooldown = true;
  setTimeout(() => { abVadCooldown = false; }, abVadCooldownMs);

  // Load and play
  window.vwb.readFileBuffer(filePath).then(rb => {
    if (!rb || !rb.success) return;
    AC.decodeAudioData(rb.buffer.slice(0)).then(audioBuffer => {
      abPlayBuffer(audioBuffer, level, false);
      renderArmorBearerPerform();
    }).catch(() => {});
  }).catch(() => {});
}

function abSetVadSensitivity(v) {
  abVadSensitivity = parseInt(v);
}

function abSetVadDelay(v) {
  abVadDelay = parseInt(v);
}

async function abPopulateMicDevices() {
  try {
    // Must request permission first before enumerateDevices returns labels
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioIns = devices.filter(d => d.kind === 'audioinput');
    const sel = document.getElementById('abMicSelect');
    if (!sel) return;
    sel.innerHTML = audioIns.map(d =>
      `<option value="${d.deviceId}" ${d.deviceId === abVadMicDeviceId ? 'selected' : ''}>
        ${d.label || 'Microphone ' + (audioIns.indexOf(d) + 1)}
       </option>`
    ).join('');
  } catch(e) {
    showNotification('⚠ Could not list audio devices');
  }
}

function abSetMicDevice(deviceId, label) {
  abVadMicDeviceId = deviceId;
  abVadMicLabel    = label || 'Microphone';
  // Restart Auto-Play with new device if it was running
  if (abAutoPlay) {
    abStopAutoPlay();
    setTimeout(() => abStartAutoPlay(), 300);
  }
}

// ── Keyboard Trigger Handler ──────────────────────────────────
// Called from ui.js keyboard handler when Perform view is active
function abHandleKey(key) {
  if (!abLoaded) return false;

  // Number keys 1-4 select level
  if (key === '1') { abSetLevel('Level1');       return true; }
  if (key === '2') { abSetLevel('Level2');       return true; }
  if (key === '3') { abSetLevel('Level3');       return true; }
  if (key === '4') { abSetLevel('TalkingMusic'); return true; }

  // Backtick ` triggers the current level
  if (key === '`') { abTrigger(abCurrentKey, abCurrentLevel); return true; }

  return false;
}

// ── Auto Key Detection ────────────────────────────────────────
async function abStartKeyDetection() {
  if (abListening) { abStopKeyDetection(); return; }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    abListenStream   = stream;
    abListening      = true;
    abKeyLocked      = false;
    abDetectedKey    = '';

    // Build analyser from mic
    const micSource  = AC.createMediaStreamSource(stream);
    const analyser   = AC.createAnalyser();
    analyser.fftSize = 4096;
    micSource.connect(analyser);
    abListenAnalyser = analyser;
    abListenSource   = micSource;

    // Start flashing indicator
    _abStartListenFlash();

    // Collect pitch data for 7 seconds then determine key
    // Longer window lets the preacher establish tonal center before locking
    const LISTEN_TOTAL_MS  = 7000;
    const INTERVAL_MS      = 50;
    const TOTAL_SAMPLES    = LISTEN_TOTAL_MS / INTERVAL_MS; // 140 samples

    const pitchCounts = new Array(12).fill(0);
    const bufLen      = analyser.frequencyBinCount;
    const freqData    = new Float32Array(bufLen);
    const sampleRate  = AC.sampleRate;
    let   samples     = 0;
    abListenCountdown = Math.ceil(LISTEN_TOTAL_MS / 1000);
    _abUpdateDetectBtn();

    abListenTimer = setInterval(() => {
      analyser.getFloatFrequencyData(freqData);
      // Find dominant frequency bin
      let maxVal = -Infinity, maxBin = 0;
      for (let i = 1; i < bufLen / 2; i++) {
        if (freqData[i] > maxVal) { maxVal = freqData[i]; maxBin = i; }
      }
      if (maxVal > -60) { // Only count if signal is strong enough
        const freq = maxBin * sampleRate / analyser.fftSize;
        if (freq > 60 && freq < 2000) {
          const noteIdx = _abFreqToNoteClass(freq);
          if (noteIdx >= 0) pitchCounts[noteIdx]++;
        }
      }
      samples++;

      // Update countdown every second
      const secondsLeft = Math.ceil((TOTAL_SAMPLES - samples) * INTERVAL_MS / 1000);
      if (secondsLeft !== abListenCountdown) {
        abListenCountdown = secondsLeft;
        _abUpdateDetectBtn();
        renderArmorBearerPerform();
      }

      if (samples >= TOTAL_SAMPLES) {
        clearInterval(abListenTimer);
        _abLockKey(pitchCounts);
      }
    }, INTERVAL_MS);

  } catch(e) {
    showNotification('❌ Microphone access denied. Please allow mic access to use key detection.');
    abListening = false;
    _abUpdateDetectBtn();
  }
}

function abStopKeyDetection() {
  clearInterval(abListenTimer);
  clearInterval(abListenFlashTimer);
  if (abListenStream) { abListenStream.getTracks().forEach(t => t.stop()); abListenStream = null; }
  if (abListenSource) { try { abListenSource.disconnect(); } catch(e) {} abListenSource = null; }
  abListenAnalyser = null;
  abListening      = false;
  _abUpdateDetectBtn();
}

function _abFreqToNoteClass(freq) {
  // Convert frequency to pitch class (0=C, 1=Db, etc.)
  if (freq <= 0) return -1;
  const midi     = 69 + 12 * Math.log2(freq / 440);
  const noteClass = Math.round(midi) % 12;
  return ((noteClass % 12) + 12) % 12;
}

function _abLockKey(pitchCounts) {
  abStopKeyDetection();

  // Find the pitch class with the most hits
  let maxCount = 0, maxIdx = 0;
  pitchCounts.forEach((c, i) => { if (c > maxCount) { maxCount = c; maxIdx = i; } });

  if (maxCount < 3) {
    showNotification('⚠ Could not detect key — try playing more clearly');
    abKeyLocked = false;
    _abUpdateDetectBtn();
    return;
  }

  abDetectedKey = NOTE_NAMES[maxIdx];
  abKeyLocked   = true;
  abCurrentKey  = abDetectedKey;

  _abUpdateDetectBtn();
  renderArmorBearerSetup();
  renderArmorBearerPerform();
  showNotification('🔒 Key locked — ' + abDetectedKey);
}

function _abStartListenFlash() {
  let flash = true;
  _abUpdateDetectBtn();
  abListenFlashTimer = setInterval(() => {
    flash = !flash;
    ['abDetectBtn', 'abDetectBtnPerf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.style.background  = flash ? 'rgba(255,68,102,.3)' : 'rgba(255,68,102,.08)';
        btn.style.borderColor = flash ? '#FF4466' : 'rgba(255,68,102,.4)';
      }
    });
  }, 400);
}

function _abUpdateDetectBtn() {
  clearInterval(abListenFlashTimer);

  // Update the Listen button in Setup (abDetectBtn) and Perform (abDetectBtnPerf)
  const listenText   = abListening ? `👂 ${abListenCountdown}s…` : '🎙 Listen for Key';
  const listenColor  = abListening ? '#FF4466' : '#8B5E3C';
  const listenBg     = abListening ? 'rgba(255,68,102,.2)' : 'rgba(139,94,60,.08)';
  const listenBorder = abListening ? '#FF4466' : 'rgba(139,94,60,.4)';

  ['abDetectBtn', 'abDetectBtnPerf'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent       = listenText;
    btn.style.color       = listenColor;
    btn.style.background  = listenBg;
    btn.style.borderColor = listenBorder;
  });

  // Re-render perform panel so the lock button appears/disappears correctly
  // (only if we're not in the middle of a render already)
  if (!abListening) renderArmorBearerPerform();
}

// ── Reverb FX Panel HTML ──────────────────────────────────────
// Shared between Setup and Perform renders.
// openStateVar: JS variable name string to toggle open/closed
function _abReverbFxPanel(openVar, openVal) {
  const btnBase = `font-family:'Outfit',sans-serif;font-size:.65rem;font-weight:700;
    padding:.18rem .45rem;border-radius:5px;cursor:pointer;transition:all .15s;`;
  const hallActive  = abReverbType === 'hall';
  const plateActive = abReverbType === 'plate';

  return `
    <!-- FX Toggle Button -->
    <div style="margin-top:.4rem;">
      <button onclick="${openVar}=!${openVar};renderArmorBearerSetup();renderArmorBearerPerform();"
        style="${btnBase}border:1px solid ${openVal ? 'rgba(139,94,60,.5)' : 'var(--border)'};
               background:${openVal ? 'rgba(139,94,60,.1)' : 'none'};
               color:${openVal ? '#8B5E3C' : 'var(--text-dim)'};">
        FX ${openVal ? '▾' : '▸'}
      </button>
    </div>

    <!-- FX Panel (collapsible) -->
    ${openVal ? `
    <div style="margin-top:.35rem;padding:.4rem .55rem;border-radius:7px;
                border:1px solid rgba(139,94,60,.18);background:rgba(139,94,60,.04);
                display:flex;flex-direction:column;gap:.35rem;">

      <!-- Reverb type selector -->
      <div style="display:flex;align-items:center;gap:.4rem;">
        <span style="font-size:.65rem;color:var(--text-dim);min-width:40px;">Reverb</span>
        <button onclick="abSetReverbType(abReverbType==='hall'?'none':'hall')"
          style="${btnBase}border:1px solid ${hallActive ? '#7eb8d4' : 'var(--border)'};
                 background:${hallActive ? 'rgba(126,184,212,.25)' : 'none'};
                 color:${hallActive ? '#7eb8d4' : 'var(--text-dim)'};">
          Hall
        </button>
        <button onclick="abSetReverbType(abReverbType==='plate'?'none':'plate')"
          style="${btnBase}border:1px solid ${plateActive ? '#d4a07e' : 'var(--border)'};
                 background:${plateActive ? 'rgba(212,160,126,.25)' : 'none'};
                 color:${plateActive ? '#d4a07e' : 'var(--text-dim)'};">
          Plate
        </button>
        <span style="font-size:.6rem;color:var(--text-dim);margin-left:.2rem;">
          ${abReverbType === 'none' ? '— off' : ''}
        </span>
      </div>

      <!-- Amount slider (only shown when reverb is active) -->
      ${abReverbType !== 'none' ? `
      <div style="display:flex;align-items:center;gap:.5rem;">
        <span style="font-size:.65rem;color:var(--text-dim);min-width:40px;">Amount</span>
        <input type="range" min="0" max="100" value="${abReverbAmount}" step="1"
          style="-webkit-appearance:none;flex:1;height:3px;border-radius:2px;background:var(--bg-primary);"
          oninput="abSetReverbAmount(this.value)">
        <span id="${openVar === 'abFxOpen' ? 'abRevAmtSetup' : 'abRevAmtPerf'}"
          style="font-family:'Space Mono',monospace;font-size:.65rem;color:var(--text-dim);min-width:30px;text-align:right;">
          ${abReverbAmount}%
        </span>
      </div>` : ''}
    </div>` : ''}
  `;
}
function renderArmorBearerSetup() {
  const wrap = document.getElementById('abSetupWrap');
  if (!wrap) return;

  const keyButtons = AB_KEYS.map(k => `
    <button onclick="abSetKey('${k}')"
      style="font-family:'Outfit',sans-serif;font-size:.8rem;font-weight:600;
             padding:.3rem .6rem;border-radius:6px;cursor:pointer;transition:all .15s;
             border:1px solid ${k === abCurrentKey ? 'var(--accent)' : 'var(--border)'};
             background:${k === abCurrentKey ? 'rgba(64,224,208,.15)' : 'none'};
             color:${k === abCurrentKey ? 'var(--accent)' : 'var(--text-dim)'};">
      ${k}
    </button>`).join('');

  const levelRows = AB_LEVELS.map(lv => {
    const hasFiles = abSamples[abCurrentKey] &&
                     abSamples[abCurrentKey][lv.id] &&
                     abSamples[abCurrentKey][lv.id].length > 0;
    const count = hasFiles ? abSamples[abCurrentKey][lv.id].length : 0;
    return `
      <div style="display:flex;align-items:center;gap:.75rem;padding:.5rem .6rem;
                  border-radius:8px;background:var(--bg-tertiary);border:1px solid var(--border);
                  margin-bottom:.4rem;">
        <div style="width:10px;height:10px;border-radius:50%;background:${lv.color};
                    flex-shrink:0;${!hasFiles ? 'opacity:.3' : ''}"></div>
        <div style="flex:1;">
          <div style="font-size:.82rem;font-weight:600;
                      color:${hasFiles ? 'var(--text-primary)' : 'var(--text-dim)'};">
            ${lv.label} — ${lv.sub}
            <span style="font-size:.68rem;color:var(--text-dim);font-weight:400;margin-left:.4rem;">
              [key ${lv.key}]
            </span>
          </div>
          <div style="font-size:.7rem;color:var(--text-dim);">
            ${hasFiles ? count + ' sample' + (count !== 1 ? 's' : '') + ' loaded' : 'No samples in this category yet'}
          </div>
        </div>
      </div>`;
  }).join('');

  wrap.innerHTML = !abLoaded ? `
    <div style="text-align:center;padding:1.5rem 1rem;">
      <div style="font-size:2rem;margin-bottom:.75rem;">🎹</div>
      <div style="font-size:.9rem;font-weight:600;color:var(--text-primary);margin-bottom:.4rem;">No Hammond Samples Loaded</div>
      <div style="font-size:.8rem;color:var(--text-dim);margin-bottom:1rem;">
        Point VWB to your VWB Organ Samples folder to load your Hammond A-102 recordings.
      </div>
      <button class="btn btn-primary" onclick="abSelectRootFolder()"
        style="border-color:#8B5E3C;background:rgba(139,94,60,.15);color:#8B5E3C;">
        📂 Load Hammond Samples
      </button>
    </div>` : `
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.85rem;flex-wrap:wrap;">
      <span style="font-size:.72rem;color:var(--text-dim);font-weight:600;text-transform:uppercase;
                   letter-spacing:.06em;">Folder:</span>
      <span style="font-size:.75rem;color:var(--accent);font-family:'Space Mono',monospace;">
        ${abRootFolder.split('/').pop()}
      </span>
      <button class="btn btn-secondary btn-small" onclick="abSelectRootFolder()"
        style="margin-left:auto;">↻ Change</button>
    </div>

    <!-- Key Selection -->
    <div style="margin-bottom:.85rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;">
        <div style="font-size:.72rem;font-weight:600;color:var(--text-dim);
                    text-transform:uppercase;letter-spacing:.06em;">Key</div>
      </div>
      <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem;">
        <div style="display:flex;flex-wrap:wrap;gap:.3rem;flex:1;">${keyButtons}</div>
        ${_abProfileCardLarge()}
      </div>
      <!-- Detect Key button -->
      <button id="abDetectBtn" onclick="abStartKeyDetection()"
        style="font-family:'Outfit',sans-serif;font-size:.78rem;font-weight:600;
               padding:.3rem .9rem;border-radius:6px;cursor:pointer;transition:all .2s;
               border:1px solid rgba(139,94,60,.4);background:rgba(139,94,60,.08);
               color:#8B5E3C;margin-top:.35rem;">
        🎙 Listen for Key
      </button>
      ${abKeyLocked ? `
        <div style="font-size:.72rem;color:var(--accent);margin-top:.4rem;display:flex;align-items:center;gap:.4rem;">
          <span>🔒 Key locked to <strong>${abDetectedKey}</strong></span>
          <button onclick="abKeyLocked=false;abDetectedKey='';_abUpdateDetectBtn();renderArmorBearerSetup();"
            style="font-size:.65rem;padding:.1rem .35rem;border-radius:4px;
                   border:1px solid var(--border);background:none;color:var(--text-dim);cursor:pointer;">
            Clear
          </button>
        </div>` : ''}
    </div>

    <!-- Sample inventory -->
    <div>
      <div style="font-size:.72rem;font-weight:600;color:var(--text-dim);
                  letter-spacing:.06em;margin-bottom:.4rem;">
        <span style="text-transform:uppercase;">Samples in Key of </span>${abCurrentKey}
      </div>
      ${levelRows}
    </div>

    <!-- Volume -->
    <div style="display:flex;align-items:center;gap:.75rem;margin-top:.85rem;padding-top:.75rem;
                border-top:1px solid var(--border);">
      <span style="font-size:.75rem;color:var(--text-dim);">Output Volume</span>
      <input type="range" min="0" max="100" value="${abVolume}"
        style="-webkit-appearance:none;flex:1;height:4px;border-radius:2px;background:var(--bg-primary)"
        oninput="abSetVolume(this.value);document.getElementById('abVolPct').textContent=this.value+'%'">
      <span id="abVolPct"
        style="font-family:'Space Mono',monospace;font-size:.72rem;color:var(--text-dim);min-width:36px;">
        ${abVolume}%
      </span>
    </div>

    <!-- Reverb FX (collapsed by default) -->
    ${_abReverbFxPanel('abFxOpen', abFxOpen)}
    `;
}

// ── Perform Panel Render ──────────────────────────────────────
function renderArmorBearerPerform() {
  const wrap = document.getElementById('abPerfWrap');
  if (!wrap) return;

  if (!abLoaded) {
    wrap.innerHTML = `
      <div style="font-size:.75rem;color:var(--text-dim);font-style:italic;padding:.4rem 0;">
        Load Hammond samples in Song Setup to use The Organist.
      </div>`;
    return;
  }

  const keyOpts = AB_KEYS.map(k =>
    `<option value="${k}" ${k === abCurrentKey ? 'selected' : ''}>${k}</option>`
  ).join('');

  // Sequence indicator for smart random
  let seqIndicator = '';
  if (abRandomMode && abCurrentLevel === 'Level2' && abCurrentSeq.length) {
    const steps = abCurrentSeq.map((chord, i) => {
      const name = chord.replace('Chord','').replace('Flat5','♭5');
      return `<span style="color:${i < abCurrentSeqPos ? 'var(--text-dim)' : (i === abCurrentSeqPos ? '#FF8844' : 'var(--text-secondary)')};
                            font-weight:${i === abCurrentSeqPos ? '700' : '400'};
                            text-decoration:${i < abCurrentSeqPos ? 'line-through' : 'none'};">
                ${name}
              </span>`;
    }).join(' → ');
    seqIndicator = `
      <div style="font-size:.7rem;color:var(--text-dim);margin-top:.4rem;padding:.3rem .5rem;
                  border-radius:5px;background:rgba(255,136,68,.08);border:1px solid rgba(255,136,68,.15);">
        Sequence: ${steps}
      </div>`;
  }

  const levelBtns = AB_LEVELS.map(lv => {
    const hasFiles = abSamples[abCurrentKey] &&
                     abSamples[abCurrentKey][lv.id] &&
                     abSamples[abCurrentKey][lv.id].length > 0;
    const isActive  = lv.id === abCurrentLevel;
    const isPlaying = abPlaying && isActive;
    return `
      <button onclick="abSetLevel('${lv.id}')"
        ${!hasFiles ? 'disabled title="No samples loaded for this level"' : ''}
        style="font-family:'Outfit',sans-serif;font-size:.78rem;font-weight:600;
               padding:.45rem .6rem;border-radius:8px;
               cursor:${hasFiles ? 'pointer' : 'not-allowed'};
               transition:all .15s;flex:1;text-align:center;position:relative;
               border:2px solid ${isPlaying ? lv.color : (isActive ? lv.color : 'var(--border)')};
               background:${isPlaying ? lv.color+'33' : (isActive ? lv.color+'18' : 'none')};
               color:${hasFiles ? (isActive ? lv.color : 'var(--text-secondary)') : 'var(--text-dim)'};
               opacity:${hasFiles ? '1' : '0.35'};
               box-shadow:${isPlaying ? '0 0 14px '+lv.color+'66' : 'none'};">
        <span style="position:absolute;top:.2rem;right:.3rem;font-size:.55rem;
                     opacity:.6;">[${lv.key}]</span>
        ${isPlaying ? '▶ ' : ''}${lv.label}
        <div style="font-size:.6rem;font-weight:400;color:inherit;opacity:.7;margin-top:.1rem;">
          ${lv.sub}
        </div>
      </button>`;
  }).join('');

  wrap.innerHTML = `
    <!-- Header row -->
    <div style="display:flex;align-items:center;justify-content:space-between;
                margin-bottom:.5rem;flex-wrap:wrap;gap:.4rem;">
      <div style="display:flex;align-items:center;gap:.5rem;">
        <span style="font-size:.72rem;font-weight:700;color:#8B5E3C;
                     text-transform:uppercase;letter-spacing:.08em;">🎹 The Organist</span>
      </div>
      <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;">
        <!-- Listen for Key button — always visible, starts/stops detection -->
        <button id="abDetectBtnPerf" onclick="abStartKeyDetection()"
          style="font-family:'Outfit',sans-serif;font-size:.68rem;font-weight:600;
                 padding:.2rem .55rem;border-radius:5px;cursor:pointer;transition:all .2s;
                 border:1px solid ${abListening ? '#FF4466' : 'rgba(139,94,60,.4)'};
                 background:${abListening ? 'rgba(255,68,102,.2)' : 'rgba(139,94,60,.08)'};
                 color:${abListening ? '#FF4466' : '#8B5E3C'};">
          ${abListening ? `👂 ${abListenCountdown}s…` : '🎙 Listen for Key'}
        </button>
        <!-- Key Locked indicator — only shown when a key is locked -->
        ${abKeyLocked ? `
          <button onclick="abKeyLocked=false;abDetectedKey='';_abUpdateDetectBtn();renderArmorBearerPerform();"
            title="Key locked — click to clear"
            style="font-family:'Outfit',sans-serif;font-size:.68rem;font-weight:700;
                   padding:.2rem .55rem;border-radius:5px;cursor:pointer;transition:all .2s;
                   border:1px solid var(--accent);background:rgba(64,224,208,.12);
                   color:var(--accent);">
            🔒 ${abDetectedKey}
          </button>` : ''}
        <!-- Key selector -->
        <span style="font-size:.68rem;color:var(--text-dim);">Key</span>
        <select onchange="abSetKey(this.value)"
          style="background:var(--bg-primary);border:1px solid var(--border);
                 color:var(--text-primary);padding:.15rem .35rem;border-radius:5px;
                 font-size:.75rem;font-weight:600;">
          ${keyOpts}
        </select>
        <!-- Random mode toggle -->
        <button onclick="abToggleRandom()"
          title="${abRandomMode ? 'Smart Random ON — click to turn off' : 'Click to enable Smart Random sequences'}"
          style="font-size:.68rem;padding:.2rem .5rem;border-radius:5px;cursor:pointer;
                 border:1px solid ${abRandomMode ? '#FF8844' : 'var(--border)'};
                 background:${abRandomMode ? 'rgba(255,136,68,.15)' : 'none'};
                 color:${abRandomMode ? '#FF8844' : 'var(--text-dim)'};
                 font-family:'Outfit',sans-serif;font-weight:600;transition:all .2s;">
          ${abRandomMode ? 'Random ON' : 'Random'}
        </button>
        ${abPlaying ? `
          <button onclick="abStop();renderArmorBearerPerform();"
            style="font-size:.68rem;padding:.2rem .45rem;border-radius:5px;cursor:pointer;
                   border:1px solid var(--border);background:none;color:var(--text-dim);">■</button>` : ''}
      </div>
    </div>

    <!-- Profile + Level buttons -->
    <div style="display:flex;flex-direction:column;align-items:center;">
      ${_abProfileCardSmall()}
      <div style="display:flex;gap:.35rem;flex-wrap:wrap;width:100%;">${levelBtns}</div>
    </div>

    <!-- Volume slider -->
    <div style="display:flex;align-items:center;gap:.6rem;margin-top:.5rem;
                padding:.35rem .5rem;border-radius:7px;background:rgba(139,94,60,.05);
                border:1px solid rgba(170,68,255,.12);">
      <span style="font-size:.65rem;color:var(--text-dim);white-space:nowrap;">🔊 Vol</span>
      <input type="range" min="0" max="100" value="${abVolume}"
        style="-webkit-appearance:none;flex:1;height:4px;border-radius:2px;background:var(--bg-primary);"
        oninput="abSetVolume(this.value);document.getElementById('abPerfVolPct').textContent=this.value+'%'">
      <span id="abPerfVolPct"
        style="font-family:'Space Mono',monospace;font-size:.68rem;color:var(--text-dim);min-width:32px;">
        ${abVolume}%
      </span>
    </div>

    <!-- Reverb FX (collapsed by default) -->
    ${_abReverbFxPanel('abFxOpenPerf', abFxOpenPerf)}

    <!-- Auto-Play Panel -->
    <div style="margin-top:.5rem;border-radius:8px;border:1px solid ${abAutoPlay ? 'rgba(255,136,68,.4)' : 'rgba(255,255,255,.08)'};
                background:${abAutoPlay ? 'rgba(255,136,68,.06)' : 'var(--bg-tertiary)'};overflow:hidden;">

      <!-- Auto-Play header / toggle row -->
      <div style="display:flex;align-items:center;gap:.5rem;padding:.4rem .55rem;">
        <button onclick="abStartAutoPlay()"
          style="font-family:'Outfit',sans-serif;font-size:.72rem;font-weight:700;
                 padding:.25rem .6rem;border-radius:6px;cursor:pointer;transition:all .2s;
                 border:1px solid ${abAutoPlay ? '#FF8844' : 'var(--border)'};
                 background:${abAutoPlay ? 'rgba(255,136,68,.2)' : 'none'};
                 color:${abAutoPlay ? '#FF8844' : 'var(--text-dim)'};">
          ${abAutoPlay ? '🎙 Auto-Play ON' : '🎙 Auto-Play'}
        </button>
        ${abAutoPlay ? `
          <span style="font-size:.62rem;color:#FF8844;animation:abFlash 1.2s infinite;">
            ● listening
          </span>
          ${abVadSpeaking ? `<span style="font-size:.62rem;color:#40E0D0;">🗣 preacher</span>` :
                             `<span style="font-size:.62rem;color:var(--text-dim);">— silence</span>`}
        ` : `<span style="font-size:.62rem;color:var(--text-dim);">Plays chord hits on preacher's breath pauses</span>`}
      </div>

      ${abAutoPlay ? `
      <!-- Sensitivity + Delay controls (shown when active) -->
      <div style="padding:.35rem .55rem .45rem;border-top:1px solid rgba(255,136,68,.15);
                  display:flex;flex-direction:column;gap:.3rem;">

        <!-- Sensitivity -->
        <div style="display:flex;align-items:center;gap:.5rem;">
          <span style="font-size:.62rem;color:var(--text-dim);min-width:72px;">Sensitivity</span>
          <input type="range" min="2" max="40" value="${abVadSensitivity}"
            style="-webkit-appearance:none;flex:1;height:3px;border-radius:2px;background:var(--bg-primary);"
            oninput="abSetVadSensitivity(this.value);document.getElementById('abVadSensVal').textContent=this.value">
          <span id="abVadSensVal"
            style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--text-dim);min-width:20px;">
            ${abVadSensitivity}
          </span>
          <span style="font-size:.58rem;color:var(--text-dim);">(low=louder room)</span>
        </div>

        <!-- Response Delay -->
        <div style="display:flex;align-items:center;gap:.5rem;">
          <span style="font-size:.62rem;color:var(--text-dim);min-width:72px;">Response</span>
          <input type="range" min="100" max="1200" step="50" value="${abVadDelay}"
            style="-webkit-appearance:none;flex:1;height:3px;border-radius:2px;background:var(--bg-primary);"
            oninput="abSetVadDelay(this.value);document.getElementById('abVadDelayVal').textContent=this.value+'ms'">
          <span id="abVadDelayVal"
            style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--text-dim);min-width:42px;">
            ${abVadDelay}ms
          </span>
        </div>

        <!-- Mic selector -->
        <div style="display:flex;align-items:center;gap:.5rem;margin-top:.1rem;">
          <span style="font-size:.62rem;color:var(--text-dim);min-width:72px;">Mic Input</span>
          <select id="abMicSelect"
            onchange="abSetMicDevice(this.value, this.options[this.selectedIndex].text)"
            style="flex:1;background:var(--bg-primary);border:1px solid var(--border);
                   color:var(--text-primary);padding:.15rem .3rem;border-radius:4px;font-size:.65rem;">
            <option value="">Default Mic</option>
          </select>
          <button onclick="abPopulateMicDevices()"
            style="font-size:.6rem;padding:.15rem .35rem;border-radius:4px;cursor:pointer;
                   border:1px solid var(--border);background:none;color:var(--text-dim);">
            ↻
          </button>
        </div>
      </div>` : ''}
    </div>

    <!-- Trigger hint -->
    <div style="font-size:.65rem;color:var(--text-dim);margin-top:.4rem;text-align:center;">
      Press <kbd style="background:var(--bg-tertiary);border:1px solid var(--border);
                         border-radius:3px;padding:.05rem .3rem;font-size:.65rem;">1-4</kbd>
      to select level &nbsp;·&nbsp;
      <kbd style="background:var(--bg-tertiary);border:1px solid var(--border);
                   border-radius:3px;padding:.05rem .3rem;font-size:.65rem;">\`</kbd>
      to trigger
    </div>

    ${seqIndicator}

    <!-- Fade Out button — always visible in organ perform panel -->
    <div style="display:flex;align-items:center;gap:.5rem;margin-top:.6rem;
                padding:.4rem .5rem;border-radius:8px;
                border:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.15);">
      <button onclick="vwbFadeWithIndicator ? vwbFadeWithIndicator(this) : (typeof uniFadeOut === 'function' && uniFadeOut())"
        id="abFadeBtn"
        style="font-family:'Outfit',sans-serif;font-size:.78rem;font-weight:600;
               padding:.35rem .9rem;border-radius:7px;cursor:pointer;transition:all .3s;
               border:1px solid rgba(139,94,60,.4);background:rgba(139,94,60,.08);
               color:#8B5E3C;flex:1;">
        ↓ Fade Out
      </button>
      <button onclick="typeof abStop === 'function' && abStop(); typeof renderArmorBearerPerform === 'function' && renderArmorBearerPerform();"
        style="font-family:'Outfit',sans-serif;font-size:.78rem;font-weight:600;
               padding:.35rem .9rem;border-radius:7px;cursor:pointer;transition:all .2s;
               border:1px solid rgba(255,255,255,.15);background:none;color:var(--text-dim);">
        ■ Stop
      </button>
    </div>`;
}

// ── Organist Profile Card ─────────────────────────────────────

function _abProfileCardLarge() {
  // Large version for Setup page — photo only (name display coming soon)
  const photo = abOrganistPhoto
    ? `<img src="${abOrganistPhoto}" style="width:72px;height:72px;border-radius:50%;
           object-fit:cover;border:2px solid #8B5E3C;display:block;">`
    : `<svg width="72" height="72" viewBox="0 0 72 72" style="border-radius:50%;
           border:2px solid rgba(139,94,60,.4);background:rgba(139,94,60,.1);">
         <circle cx="36" cy="27" r="14" fill="rgba(139,94,60,.4)"/>
         <ellipse cx="36" cy="62" rx="22" ry="18" fill="rgba(139,94,60,.4)"/>
       </svg>`;
  return `
    <div style="display:flex;flex-direction:column;align-items:center;
                padding:.6rem .75rem;border-radius:10px;border:1px solid rgba(139,94,60,.2);
                background:rgba(139,94,60,.05);min-width:90px;">
      ${photo}
    </div>`;
}

function _abProfileCardSmall() {
  // Small version for Perform page panel — photo only (name display coming soon)
  const photo = abOrganistPhoto
    ? `<img src="${abOrganistPhoto}" style="width:44px;height:44px;border-radius:50%;
           object-fit:cover;border:2px solid #8B5E3C;display:block;">`
    : `<svg width="44" height="44" viewBox="0 0 44 44" style="border-radius:50%;
           border:2px solid rgba(139,94,60,.4);background:rgba(139,94,60,.1);">
         <circle cx="22" cy="16" r="9" fill="rgba(139,94,60,.4)"/>
         <ellipse cx="22" cy="38" rx="14" ry="11" fill="rgba(139,94,60,.4)"/>
       </svg>`;
  return `
    <div style="display:flex;flex-direction:column;align-items:center;margin-bottom:.5rem;">
      ${photo}
    </div>`;
}

// ── Helpers ───────────────────────────────────────────────────
function abSetKey(key) {
  abCurrentKey  = key;
  abDetectedKey = key;
  abKeyLocked   = true;
  _abUpdateDetectBtn();
  renderArmorBearerSetup();
  renderArmorBearerPerform();
}

function abSetLevel(level) {
  abCurrentLevel  = level;
  abCurrentSeq    = [];
  abCurrentSeqPos = 0;

  // Random always resets to off when switching levels
  if (abRandomMode) {
    abRandomMode = false;
    showNotification('🎲 Random OFF — switched level');
  }

  // Auto-Play turns off when switching to Level 3 or Talking Music —
  // those levels are manually triggered, not preacher-responsive
  if (abAutoPlay && (level === 'Level3' || level === 'TalkingMusic')) {
    abStopAutoPlay();
    showNotification('🎙 Auto-Play OFF — ' + (level === 'Level3' ? 'Level 3' : 'Talking Music') + ' selected');
  }

  renderArmorBearerPerform();

  // Level 3 and Talking Music trigger immediately on click —
  // no need to press Space Bar; stop any current sample first
  if (level === 'Level3' || level === 'TalkingMusic') {
    if (abPlaying) abStop();
    abTrigger(abCurrentKey, level);
  }
}

function abSetVolume(v) {
  abVolume = parseInt(v);
  if (abGain) abGain.gain.value = abVolume / 100;
}

// ── Transport Row Visibility ──────────────────────────────────
// Call abHideTransport(true) when entering Perform page on organ engine.
// Call abHideTransport(false) when leaving organ engine or leaving Perform page.
function abHideTransport(hide) {
  const transportRow = document.getElementById('mtTransportRow');
  const scrubWrap    = document.getElementById('mtScrubBarWrap');
  if (transportRow) transportRow.style.display = hide ? 'none' : '';
  if (scrubWrap)    scrubWrap.style.display    = hide ? 'none' : '';
}

// ── Engine Cleanup — called when switching away from Organ engine ──
function abOnEngineDeactivate() {
  abStopAutoPlay();
  abStopKeyDetection();
  abHideTransport(false);  // always restore transport when leaving organ
}
function getArmorBearerState() {
  return {
    rootFolder:      abRootFolder,
    currentKey:      abCurrentKey,
    currentLevel:    abCurrentLevel,
    volume:          abVolume,
    randomMode:      abRandomMode,
    organistName:    abOrganistName,
    organistPhoto:   abOrganistPhoto,
    vadSensitivity:  abVadSensitivity,
    vadDelay:        abVadDelay,
    vadMicDeviceId:  abVadMicDeviceId,
    vadMicLabel:     abVadMicLabel,
    reverbType:      abReverbType,
    reverbAmount:    abReverbAmount
  };
}

async function restoreArmorBearerState(state) {
  if (!state) return;
  abCurrentKey      = state.currentKey      || 'C';
  abCurrentLevel    = state.currentLevel    || 'Level2';
  abVolume          = state.volume          || 80;
  abRandomMode      = state.randomMode      || false;
  abOrganistName    = state.organistName    || '';
  abOrganistPhoto   = state.organistPhoto   || '';
  if (typeof window._refreshOrganistIdentity === 'function') window._refreshOrganistIdentity();
  abVadSensitivity  = state.vadSensitivity  || 15;
  abVadDelay        = state.vadDelay        || 400;
  abVadMicDeviceId  = state.vadMicDeviceId  || '';
  abVadMicLabel     = state.vadMicLabel     || 'Default Mic';
  abReverbType      = state.reverbType      || 'none';
  abReverbAmount    = state.reverbAmount    !== undefined ? state.reverbAmount : 30;
  if (state.rootFolder) {
    abRootFolder = state.rootFolder;
    await abScanFolder();
  }
  initArmorBearer();
  if (abGain) abGain.gain.value = abVolume / 100;
  // Restore reverb routing after init
  if (abReverbSend) abReverbSend.gain.value = abReverbAmount / 100;
  _abConnectReverb();
  renderArmorBearerSetup();
  renderArmorBearerPerform();
}

// ── Auto-load bundled samples on page ready ────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(abAutoLoadBundled, 1500); // after abLoadState runs
  });
} else {
  setTimeout(abAutoLoadBundled, 1500);
}
