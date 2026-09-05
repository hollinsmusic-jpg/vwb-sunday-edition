// ═══════════════════════════════════════════════════════════════
//  VWB — Rubato Mode
//  Voice-triggered MIDI phrase playback for live worship.
//  Listens to singer via Web Speech API, matches trigger words
//  to MIDI chunks, plays them in C (transposable to any key).
// ═══════════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────────
let rbPhrases        = [];     // [{words, trigger, midiFile, midiData}, ...]
let rbCurrentIdx     = -1;     // index of currently playing phrase
let rbCurrentPhraseStartTime = 0;  // Date.now() when the current phrase started
let rbFirstNewSoundTime = 0;       // Date.now() when something OTHER than the current phrase's own trigger was first heard — this is what the lyric-order fallback now waits from, not phrase-start time
let rbLyricsText     = '';     // raw lyrics text content
let rbChunkFolder    = '';     // path to MIDI chunk folder
let rbChunkFiles     = {};     // { triggerWord: filePath }
let rbTranspose      = 0;      // semitones from C (-11 to +11)
let rbOctave         = 0;      // octave shift (-2 to +2)
let rbConfidence     = 0.35;   // speech recognition confidence threshold
let rbListening      = false;  // is speech recognition active?
let rbManualMode     = false;  // manual trigger mode — user clicks phrases directly
let rbLeadInPlayed   = false;  // whether the instrumental intro has already been played this session
let rbKeyDetecting   = false;  // is key detection active? (separate from word listening)
let rbPlaying        = false;  // is a chunk currently playing?
let rbRecognizer     = null;   // SpeechRecognition instance
let rbMidiOut        = null;   // WebMIDI output (reuses main midi port)
let rbActiveNotes    = [];     // notes currently sounding (for instant cut)
let rbFxOpen         = false;  // FX panel open state
let rbSongMapOpen    = false;  // Song Map open state
let rbReverbType     = 'none';
let rbReverbAmount   = 30;
let rbReverbSend     = null;
let rbHallConv       = null;
let rbPlateConv      = null;
let rbReverbOut      = null;
let rbGain           = null;

// ── VWB Pack state (loaded from .vwb / .vwbr file) ────────────
let rbVwbPack        = null;   // full parsed pack JSON
let rbVwbPackVerses  = [];     // multi-verse data (v2.0+)
let rbActiveVerse    = 0;      // currently active verse index
let rbBranchMap      = {};     // { sectionId: [{sectionId, label, trigger}] } — smart branching
let rbSections       = [];     // all sections from .vwbr v2.0
let rbCurrentSection = null;   // currently active section id
let rbLastWordMap    = {};     // { phraseIdx: lastWord } — for interlude/branch detection
let rbSongTitle      = '';     // song title from pack
let rbArtistName     = '';     // pianist name from pack
let rbArtistRole     = '';     // role from pack
let rbArtistPhoto    = null;   // base64 photo from pack
let rbPackLoaded     = false;  // true when a .vwb pack is loaded

// Key names for transposition display
const RB_KEY_NAMES = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

// ── VWB Pack Loader ────────────────────────────────────────────
// Loads a .vwb file produced by VWB Studio and populates Rubato
// Mode with song title, artist info, phrases, and MIDI data.

async function rbLoadVwbPack() {
  try {
    // Use same pickAnyFile pattern as rbLoadLyricsFile
    const result = await window.vwb.pickAnyFile({ title: 'Load VWB Song Pack' });
    if (!result || result.canceled || !result.filePaths || !result.filePaths.length) return;

    const filePath = result.filePaths[0];
    console.log('[Rubato] Loading .vwb pack from:', filePath);

    // Use same readFileBuffer pattern as rbLoadLyricsFile
    const rb = await window.vwb.readFileBuffer(filePath);
    if (!rb || !rb.success) {
      showNotification('❌ Could not read song pack file');
      return;
    }

    const text = new TextDecoder('utf-8').decode(new Uint8Array(rb.buffer));
    let pack;
    try {
      pack = JSON.parse(text);
    } catch(parseErr) {
      showNotification('❌ Song pack file is not valid JSON');
      console.error('[Rubato] JSON parse error:', parseErr);
      return;
    }

    if (pack.format !== 'vwb-rubato-pack') {
      showNotification('⚠ Not a valid VWB song pack file');
      return;
    }

    // ── Multi-verse support (v2.0 .vwbr format) ───────────────
    // If the pack has a verses array, use the first verse as default.
    // The performer can switch verses via the UI.
    if (pack.verses && pack.verses.length > 0 && !pack._verseOverrideApplied) {
      rbVwbPackVerses = pack.verses;
      rbActiveVerse   = 0;
      // Merge verse 1 phrase data into top-level phrases array
      pack.verses[0].phrases.forEach((vp, i) => {
        if (pack.phrases[i]) {
          pack.phrases[i].trigger   = vp.trigger   || pack.phrases[i].trigger;
          pack.phrases[i].firstWord = vp.firstWord || pack.phrases[i].firstWord;
          pack.phrases[i].lastWord  = vp.lastWord  || pack.phrases[i].lastWord;
          pack.phrases[i].line      = vp.line      || vp.lyrics || pack.phrases[i].line;
          pack.phrases[i].syllables = vp.syllables || [];
        }
      });
    }

    // Store pack data
    rbVwbPack     = pack;
    rbPackLoaded  = true;
    rbSongTitle   = pack.song?.title   || '';
    rbArtistName  = pack.artist?.name  || '';
    rbArtistRole  = pack.artist?.role  || 'Pianist';
    rbArtistPhoto = pack.artist?.photo || null;

    // Set key from pack — user can override manually anytime
    const packKey = pack.song?.key || 'C';
    const keyIdx  = RB_KEY_NAMES.indexOf(packKey);
    if (keyIdx >= 0) rbTranspose = keyIdx;

    // Build phrases from .vwbr pack (v2.0 sections format or legacy flat phrases)
    rbPhrases    = [];
    rbChunkFiles = {};
    rbSections   = [];
    rbBranchMap  = pack.branchMap || {};
    rbLastWordMap = {};

    if (pack.sections && pack.sections.length > 0) {
      // ── v2.0 format: sections array ──────────────────────────
      rbSections = pack.sections;
      let phraseIdx = 0;
      pack.sections.forEach(sec => {
        if (!sec.phrases || !sec.phrases.length) return;
        sec.phrases.forEach(p => {
          if (!p.trigger) return;
          // startTime may be null if phrase not yet linked to timeline — still load it
          rbPhrases.push({
            line:        p.line      || p.trigger,
            trigger:     p.trigger,
            firstWord:   p.trigger,
            lastWord:    p.lastWord  || '',
            section:     sec.label   || '',
            sectionId:   sec.id,
            sectionType: sec.type    || 'section',
            startTime:   p.startTime,
            endTime:     p.endTime,
            duration:    p.duration,
            midiData:    null
          });
          if (p.lastWord) rbLastWordMap[phraseIdx] = p.lastWord;
          rbChunkFiles[p.trigger] = '__vwb_pack__';
          phraseIdx++;
        });
      });
    } else if (pack.phrases && pack.phrases.length) {
      // ── Legacy format: flat phrases array ────────────────────
      pack.phrases.forEach((p) => {
        if (!p.trigger) return;
        if (p.trigger === 'verse' || p.trigger === 'chorus') return;
        // startTime may be null if not yet linked to timeline
        rbPhrases.push({
          line:      p.line      || p.trigger,
          trigger:   p.trigger,
          firstWord: p.trigger,
          lastWord:  p.lastWord  || '',
          section:   p.section   || '',
          startTime: p.startTime,
          endTime:   p.endTime,
          duration:  p.duration,
          midiData:  null
        });
        rbChunkFiles[p.trigger] = '__vwb_pack__';
      });
    }

    // Build word-anchored melodic map for key detection
    if (pack.melodicStructure && pack.melodicStructure.length) {
      _rbBuildMelodicMapFromPack(pack);
    } else {
      rbMelodicMap = {};
    }

    // Reset position
    rbCurrentIdx = -1;
    rbPitchLocked = false;

    renderRubatoCard();
    showNotification('✅ ' + rbSongTitle + ' — ' + rbPhrases.length + ' phrases loaded');
    console.log('[Rubato] VWB Pack loaded:', rbSongTitle, '—', rbPhrases.length, 'phrases');

    // Prompt user to load the matching MIDI file
    if (rbPhrases.some(p => p.startTime != null)) {
      showNotification('🎵 Pack loaded — now load the matching MIDI file to hear piano');
    }

  } catch(e) {
    console.error('[Rubato] Error loading .vwb pack:', e);
    showNotification('❌ Could not load song pack: ' + e.message);
  }
}

// ── Word-Anchored Melodic Map ──────────────────────────────────
// Built from .vwb pack's melodicStructure: { syllable, degree }
// Keys are lowercase syllable words. Values are numeric scale degrees.
// Example: { "great": 3, "is": 3, "thy": 3, "faith": 4, ... }
let rbMelodicMap = {};   // word → scale degree (numeric)

// Build the word-to-degree lookup map from pack melodicStructure
function _rbBuildMelodicMapFromPack(pack) {
  rbMelodicMap = {};
  const structure = pack.melodicStructure || [];
  structure.forEach(entry => {
    if (!entry.syllable || entry.degree === null || entry.degree === '') return;
    const word = String(entry.syllable).toLowerCase().trim().replace(/[^a-z']/g, '');
    const degStr = String(entry.degree).trim();
    let deg;
    if (degStr.startsWith('b'))      deg = parseFloat(degStr.slice(1)) - 0.5;
    else if (degStr.startsWith('#')) deg = parseFloat(degStr.slice(1)) + 0.5;
    else                             deg = parseFloat(degStr);
    if (word && !isNaN(deg) && deg >= 1 && deg <= 7.5) {
      rbMelodicMap[word] = deg;
    }
  });
  console.log('[Rubato] Word-anchored melodic map built:', Object.keys(rbMelodicMap).length, 'entries', rbMelodicMap);
}

// ── Audio Init ─────────────────────────────────────────────────
function rbInitAudio() {
  if (rbGain) return;
  rbGain = AC.createGain();
  rbGain.gain.value = 1.0;
  rbGain.connect(mGain);

  rbReverbOut = AC.createGain();
  rbReverbOut.gain.value = 0.75;
  rbReverbOut.connect(mGain);

  rbReverbSend = AC.createGain();
  rbReverbSend.gain.value = rbReverbAmount / 100;
  rbGain.connect(rbReverbSend);

  rbHallConv = AC.createConvolver();
  rbHallConv.buffer = _rbMakeImpulse(3.5, 2.0);

  rbPlateConv = AC.createConvolver();
  rbPlateConv.buffer = _rbMakeImpulse(1.6, 3.5);

  _rbConnectReverb();

  // Preload the acoustic piano sampler so first trigger fires instantly
  setTimeout(() => rbPreloadPiano(), 500);
}

function _rbMakeImpulse(dur, decay) {
  const len = Math.floor(AC.sampleRate * dur);
  const buf = AC.createBuffer(2, len, AC.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function _rbConnectReverb() {
  if (!rbReverbSend) return;
  try { rbReverbSend.disconnect(); } catch(e) {}
  if (rbReverbType === 'hall'  && rbHallConv)  { rbReverbSend.connect(rbHallConv);  rbHallConv.connect(rbReverbOut);  }
  if (rbReverbType === 'plate' && rbPlateConv) { rbReverbSend.connect(rbPlateConv); rbPlateConv.connect(rbReverbOut); }
}

function rbSetReverbType(type) {
  rbReverbType = type;
  _rbConnectReverb(); // native chain
  // Also update Tone reverb — reconnect sampler to correct bus
  if (typeof _loadChannelSampler === 'function') {
    const sampler = _chSampler ? _chSampler[RB_MIDI_CH] : null;
    if (sampler) {
      // Disconnect from both reverb buses first
      try { if (_rbToneHall)  sampler.disconnect(_rbToneHall);  } catch(e) {}
      try { if (_rbTonePlate) sampler.disconnect(_rbTonePlate); } catch(e) {}
      // Reconnect to the selected one
      _rbRouteSamplerThroughReverb(sampler);
    }
  }
  renderRubatoCard();
}

function rbSetReverbAmount(pct) {
  rbReverbAmount = parseInt(pct);
  if (rbReverbSend) rbReverbSend.gain.value = rbReverbAmount / 100;
  // Update Tone reverb wet level
  const wetVal = rbReverbAmount / 100;
  if (_rbToneHall  && rbReverbType === 'hall')  _rbToneHall.wet.value  = wetVal;
  if (_rbTonePlate && rbReverbType === 'plate') _rbTonePlate.wet.value = wetVal;
  const el = document.getElementById('rbRevAmtVal');
  if (el) el.textContent = pct + '%';
}

// ── Lyrics Parser ──────────────────────────────────────────────
// Lyrics are comma-separated phrases.
// Each phrase's FIRST word is the trigger word.
// Example: "Great is thy faithfulness, Oh God my, Father, There is no shadow"
// Trigger words: great, oh, father, there
//
// Also supports line-break format (.txt) and RTF files.

function _rbStripRtf(raw) {
  // Strip RTF header and control words, convert \par to comma delimiter
  return raw
    .replace(/\{\\rtf[\s\S]*?(?=\\pard|\\par\b|[A-Za-z])/g, '') // strip header
    .replace(/\\par[d]?\b\*?/g, ',')    // \par → comma (phrase break)
    .replace(/\\\w+\*?\s?/g, '')        // strip all other control words
    .replace(/[{}]/g, '')               // strip braces
    .replace(/\\/g, '')                 // strip remaining backslashes
    .replace(/,+/g, ',')               // collapse multiple commas
    .replace(/^\s*,|,\s*$/g, '')        // trim leading/trailing commas
    .trim();
}

function _rbExtractTriggerFromFilename(filename) {
  let name = filename.split('/').pop().split('\\').pop();
  name = name.replace(/\.midi?$/i, '');

  // Try curly/smart quotes first: \u201cFather\u201d (Mac default)
  const curlyMatch = name.match(/\u201c(.+?)\u201d/);
  if (curlyMatch) {
    name = curlyMatch[1];
  } else {
    // Try straight quotes: "Father"
    const straightMatch = name.match(/"(.+?)"/);
    if (straightMatch) {
      name = straightMatch[1];
    } else {
      // Try 22...22 URL-encoded quotes (older naming)
      const encoded = name.match(/22(.+?)22/i);
      if (encoded) {
        name = encoded[1];
      } else {
        // Try [brackets]: [Intro]
        const brackets = name.match(/\[(.+?)\]/);
        if (brackets) {
          name = brackets[1];
        } else {
          // Strip common prefixes like GITF__ or GITF_
          name = name.replace(/^[A-Z]+__?/i, '');
        }
      }
    }
  }

  // Get first meaningful word
  const words = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/);
  // Special: "oh" at start matches "o" in lyrics (TextEdit drops the h in "O God")
  if (words[0] === 'oh') return 'o';
  // Return first word — even short ones like 'o'
  return words[0] || '';
}

function _rbStripRtf(raw) {
  // TextEdit Mac RTF: text starts after \cf0
  // Phrase breaks = backslash + newline (\<LF>)
  let text = raw;
  const cfMatch = text.match(/\\cf0\s*([\s\S]*)/);
  if (cfMatch) text = cfMatch[1];
  text = text.replace(/\\\n/g, ',');            // backslash+newline → comma
  text = text.replace(/\\uc0\\u8232\s*/g, ','); // Unicode line sep → comma
  text = text.replace(/\\par[d]?\b\*?\s*/g, ','); // \par → comma
  text = text.replace(/\\[a-zA-Z]+\*?-?\d*\s?/g, ''); // strip RTF controls
  text = text.replace(/[{}]/g, '');             // strip braces
  text = text.replace(/\\/g, '');               // strip stray backslashes
  text = text.replace(/,+/g, ',').replace(/^,|,$/g, '').trim();
  return text;
}

function rbParseLyrics() {
  if (!rbLyricsText) return;

  let text = rbLyricsText;

  // Strip RTF if needed
  if (text.trim().startsWith('{\\rtf') || text.includes('\\cf0') || text.includes('\\par')) {
    text = _rbStripRtf(text);
  }

  // Fallback: plain newlines → commas
  if (!text.includes(',') && text.includes('\n')) {
    text = text.split('\n').map(l => l.trim()).filter(l => l).join(',');
  }

  // Split on commas — each segment is one phrase
  const phrases = text.split(',').map(p => p.trim()).filter(p => p.length > 0);

  rbPhrases = phrases.map((phrase, i) => {
    const words = phrase.toLowerCase().split(/\s+/);
    // Strip brackets from first word: [Intro] → intro
    const firstWord = words[0].replace(/[^a-z0-9]/g, '');

    // Find matching chunk
    let trigger = null;
    if (rbChunkFiles[firstWord]) {
      trigger = firstWord;
    } else {
      for (const [chunkKey, filePath] of Object.entries(rbChunkFiles)) {
        const extracted = _rbExtractTriggerFromFilename(filePath || chunkKey);
        if (extracted === firstWord) { trigger = chunkKey; break; }
      }
    }

    const displayLine = phrase.replace(/^\[(.+)\]$/, '$1').trim();
    return { line: displayLine, words, trigger, firstWord, idx: i };
  });

  rbCurrentIdx = -1;

  console.log('[Rubato] Parsed ' + rbPhrases.length + ' phrases. Chunks loaded:', Object.keys(rbChunkFiles));
  rbPhrases.forEach((p, i) => {
    console.log('  ' + (i+1) + '. "' + p.line + '" → trigger: ' + (p.trigger || '(none — firstWord: ' + p.firstWord + ')'));
  });

  renderRubatoCard();
}

// ── Chunk Folder Loading ───────────────────────────────────────
async function rbSelectChunkFolder() {
  const result = await window.vwb.pickAnyFile({ title: 'Select MIDI Chunk Files', multi: true });
  if (!result || result.canceled || !result.filePaths.length) return;

  rbChunkFiles = {};

  result.filePaths.forEach(filePath => {
    const name = filePath.split('/').pop().split('\\').pop().toLowerCase();
    if (name.endsWith('.mid') || name.endsWith('.midi')) {
      const trigger = _rbExtractTriggerFromFilename(name);
      if (trigger) rbChunkFiles[trigger] = filePath;
    }
  });

  rbChunkFolder = Object.keys(rbChunkFiles).length + ' chunks loaded';
  rbParseLyrics();
  renderRubatoCard();
  showNotification('🎹 Rubato: ' + Object.keys(rbChunkFiles).length + ' chunks loaded');
}

async function rbLoadLyricsFile() {
  const result = await window.vwb.pickAnyFile({ title: 'Select Lyrics File (.txt or .rtf)' });
  if (!result || result.canceled || !result.filePaths.length) return;
  const filePath = result.filePaths[0];
  try {
    const rb = await window.vwb.readFileBuffer(filePath);
    if (!rb || !rb.success) { showNotification('❌ Could not read lyrics file'); return; }
    const decoder = new TextDecoder('utf-8');
    rbLyricsText = decoder.decode(new Uint8Array(rb.buffer));
    rbParseLyrics();
    showNotification('📄 Lyrics loaded — ' + rbPhrases.length + ' phrases');
  } catch(e) {
    showNotification('❌ Could not read lyrics file: ' + e.message);
  }
}

// ── Load MIDI file for .vwbr pack playback ────────────────────
async function rbLoadPackMidi() {
  try {
    const result = await window.vwb.pickAnyFile({ title: 'Load MIDI File for ' + (rbSongTitle||'Song') });
    if (!result || result.canceled) return;
    const filePath = result.filePaths[0];
    const rb = await window.vwb.readFileBuffer(filePath);
    if (!rb || !rb.success) { showNotification('❌ Could not read MIDI file'); return; }
    rbPackMidiBuffer = rb.buffer;
    if (rbVwbPack) rbVwbPack._midiPath = filePath;
    showNotification('🎹 MIDI loaded — ready to play');
    renderRubatoCard();
  } catch(e) {
    showNotification('❌ ' + e.message);
  }
}

// ── Load .vwbrs bundle — one file contains both pack + MIDI ───
// Replaces the two-step Song Pack + MIDI File flow.
// The .vwbrs file is a zip with song.vwb (phrases JSON) + song.mid inside.
async function rbLoadRubatoBundle() {
  try {
    const result = await window.vwb.openRubatoBundle();
    if (!result || result.canceled) return;
    if (!result.success) {
      showNotification('❌ ' + (result.error || 'Could not open song bundle'));
      return;
    }

    const pack = result.pack;

    if (pack.format !== 'vwb-rubato-pack') {
      showNotification('⚠ Not a valid VWB song pack inside bundle');
      return;
    }

    // ── Multi-verse support ───────────────────────────────────
    if (pack.verses && pack.verses.length > 0 && !pack._verseOverrideApplied) {
      rbVwbPackVerses = pack.verses;
      rbActiveVerse   = 0;
      pack.verses[0].phrases.forEach((vp, i) => {
        if (pack.phrases[i]) {
          pack.phrases[i].trigger   = vp.trigger   || pack.phrases[i].trigger;
          pack.phrases[i].firstWord = vp.firstWord || pack.phrases[i].firstWord;
          pack.phrases[i].lastWord  = vp.lastWord  || pack.phrases[i].lastWord;
          pack.phrases[i].line      = vp.line      || vp.lyrics || pack.phrases[i].line;
          pack.phrases[i].syllables = vp.syllables || [];
        }
      });
    }

    // Store pack data
    rbVwbPack     = pack;
    rbPackLoaded  = true;
    rbSongTitle   = pack.song?.title   || result.fileName || '';
    rbArtistName  = pack.artist?.name  || '';
    rbArtistRole  = pack.artist?.role  || 'Pianist';
    rbArtistPhoto = pack.artist?.photo || null;

    // Set key from pack
    const packKey = pack.song?.key || 'C';
    const keyIdx  = RB_KEY_NAMES.indexOf(packKey);
    if (keyIdx >= 0) rbTranspose = keyIdx;

    // Build phrases
    rbPhrases    = [];
    rbChunkFiles = {};
    rbSections   = [];
    rbBranchMap  = pack.branchMap || {};
    rbLastWordMap = {};

    if (pack.sections && pack.sections.length > 0) {
      rbSections = pack.sections;
      let phraseIdx = 0;
      pack.sections.forEach(sec => {
        if (!sec.phrases || !sec.phrases.length) return;
        sec.phrases.forEach(p => {
          if (!p.trigger) return;
          rbPhrases.push({
            line:        p.line      || p.trigger,
            trigger:     p.trigger,
            firstWord:   p.trigger,
            lastWord:    p.lastWord  || '',
            section:     sec.label   || '',
            sectionId:   sec.id,
            sectionType: sec.type    || 'section',
            startTime:   p.startTime,
            endTime:     p.endTime,
            duration:    p.duration,
            midiData:    null
          });
          if (p.lastWord) rbLastWordMap[phraseIdx] = p.lastWord;
          rbChunkFiles[p.trigger] = '__vwb_pack__';
          phraseIdx++;
        });
      });
    } else if (pack.phrases && pack.phrases.length) {
      pack.phrases.forEach((p) => {
        if (!p.trigger) return;
        if (p.trigger === 'verse' || p.trigger === 'chorus') return;
        rbPhrases.push({
          line:      p.line      || p.trigger,
          trigger:   p.trigger,
          firstWord: p.trigger,
          lastWord:  p.lastWord  || '',
          section:   p.section   || '',
          startTime: p.startTime,
          endTime:   p.endTime,
          duration:  p.duration,
          midiData:  null
        });
        rbChunkFiles[p.trigger] = '__vwb_pack__';
      });
    }

    // Build word-anchored melodic map for key detection
    if (pack.melodicStructure && pack.melodicStructure.length) {
      _rbBuildMelodicMapFromPack(pack);
    } else {
      rbMelodicMap = {};
    }

    // ── Load MIDI buffer from bundle (no second file needed) ──
    if (result.hasMidi && result.midiBuffer) {
      rbPackMidiBuffer = result.midiBuffer;
      console.log('[Rubato] MIDI loaded from bundle:', result.midiFileName);
    } else {
      rbPackMidiBuffer = null;
      console.warn('[Rubato] Bundle has no MIDI file — phrases will display but no audio');
    }

    rbCurrentIdx  = -1;
    rbPitchLocked = false;

    renderRubatoCard();

    const midiStatus = result.hasMidi ? '' : ' (no MIDI in bundle)';
    showNotification('✅ ' + rbSongTitle + ' — ' + rbPhrases.length + ' phrases loaded' + midiStatus);
    console.log('[Rubato] Bundle loaded:', rbSongTitle, '—', rbPhrases.length, 'phrases, MIDI:', result.hasMidi);

  } catch(e) {
    console.error('[Rubato] Bundle load error:', e);
    showNotification('❌ Could not load song bundle: ' + e.message);
  }
}

// ── Transposition ──────────────────────────────────────────────
function rbSetTranspose(delta) {
  rbTranspose = Math.max(-11, Math.min(11, rbTranspose + delta));
  renderRubatoCard();
}

function rbSetOctave(delta) {
  rbOctave = Math.max(-2, Math.min(2, rbOctave + delta));
  renderRubatoCard();
}

function rbGetKeyName() {
  const idx = ((rbTranspose % 12) + 12) % 12;
  return RB_KEY_NAMES[idx];
}

// ── MIDI Chunk Playback ────────────────────────────────────────
// For .vwbr packs: plays a time slice of the loaded MIDI file.
// For legacy chunk packs: reads a MIDI file and plays it in full.

let rbPackMidiBuffer = null;  // loaded MIDI buffer from .vwbr pack

async function rbPlayChunk(phraseIdx) {
  if (phraseIdx < 0 || phraseIdx >= rbPhrases.length) return;
  const phrase = rbPhrases[phraseIdx];
  if (!phrase.trigger) return;

  rbCurrentPhraseStartTime = Date.now(); // real progress happened — restart the lyric-order fallback clock
  rbFirstNewSoundTime = 0;

  // Stop current playback instantly
  rbStopCurrent();

  rbCurrentIdx = phraseIdx;
  rbPlaying    = true;
  renderRubatoCard();

  const semitones = rbTranspose + (rbOctave * 12);

  try {
    // ── .vwbr pack mode: play a time slice of the pack MIDI ──
    if (rbPackLoaded && rbChunkFiles[phrase.trigger] === '__vwb_pack__') {
      // Load the MIDI file if not already loaded
      if (!rbPackMidiBuffer && rbVwbPack && rbVwbPack._midiPath) {
        const rb = await window.vwb.readFileBuffer(rbVwbPack._midiPath);
        if (rb && rb.success) rbPackMidiBuffer = rb.buffer;
      }

      if (rbPackMidiBuffer && phrase.startTime != null) {
        // Play from startTime to endTime within the full MIDI
        await _rbPlayMidiSlice(rbPackMidiBuffer, phrase.startTime, phrase.endTime, semitones);
      } else if (rbPackMidiBuffer) {
        // No timeline link yet — play whole file as fallback
        await _rbPlayMidiBuffer(rbPackMidiBuffer, semitones);
      } else {
        // No MIDI loaded — just show the phrase visually
        console.warn('[Rubato] No MIDI buffer available for pack playback');
        setTimeout(() => { rbPlaying=false; renderRubatoCard(); }, 3000);
      }
      return;
    }

    // ── Legacy chunk mode: read individual MIDI file ──
    const filePath = rbChunkFiles[phrase.trigger];
    if (!filePath) return;
    const rb = await window.vwb.readFileBuffer(filePath);
    if (!rb || !rb.success) { rbPlaying = false; renderRubatoCard(); return; }
    await _rbPlayMidiBuffer(rb.buffer, semitones);

  } catch(e) {
    console.error('[Rubato] Playback error:', e);
    rbPlaying = false;
    renderRubatoCard();
  }
}

function rbStopCurrent() {
  rbPlaying = false;
  // Clear all pending note timers immediately
  rbActiveNotes.forEach(t => clearTimeout(t));
  rbActiveNotes = [];
  // Send all notes off on the Rubato piano channel specifically
  if (typeof synthAllNotesOff === 'function') synthAllNotesOff();
  // Force note off for all 128 notes on the Rubato channel
  // This ensures no notes linger even if synth channel differs
  if (typeof synthNoteOff === 'function') {
    for (let n = 0; n < 128; n++) {
      try { synthNoteOff(RB_MIDI_CH, n); } catch(e) {}
    }
  }
}

// Dedicated Rubato channel — always uses Acoustic Grand Piano (program 0)
const RB_MIDI_CH = 15;  // channel 15 reserved for rubato so it doesn't conflict with song MIDI

// Preload the piano sampler — force built-in sounds ON, route through reverb chain
async function rbPreloadPiano() {
  if (typeof setSynthMode === 'function') setSynthMode(true);
  if (typeof _loadChannelSampler === 'function') {
    const sampler = await _loadChannelSampler(RB_MIDI_CH, 0);
    console.log('[Rubato] Piano sampler ready on ch' + (RB_MIDI_CH + 1));
    _rbRouteSamplerThroughReverb(sampler);
  } else {
    console.warn('[Rubato] _loadChannelSampler not found');
  }
}

// ── Rubato Reverb via Tone.js ──────────────────────────────────
// We use Tone.js Reverb connected after the sampler — this stays
// inside Tone's graph and avoids native node connection issues.
let _rbToneHall  = null;
let _rbTonePlate = null;
let _rbToneSend  = null;   // Tone.Volume — reverb send level

function _rbEnsureToneReverb() {
  if (_rbToneHall) return;
  _rbToneHall = new Tone.Reverb({ decay: 3.5, preDelay: 0.04, wet: 1.0 }).toDestination();
  _rbToneHall.generate();
  _rbTonePlate = new Tone.Reverb({ decay: 1.6, preDelay: 0.01, wet: 1.0 }).toDestination();
  _rbTonePlate.generate();
  _rbToneSend = new Tone.Volume(-80).toDestination(); // start silent
  console.log('[Rubato] Tone reverb buses ready');
}

// Route the Tone.js sampler's output through reverb
function _rbRouteSamplerThroughReverb(sampler) {
  if (!sampler) return;
  try {
    _rbEnsureToneReverb();
    // Connect sampler → active reverb bus (in addition to default dry output)
    if (rbReverbType === 'hall'  && _rbToneHall)  {
      sampler.connect(_rbToneHall);
      _rbToneHall.wet.value = rbReverbAmount / 100;
    } else if (rbReverbType === 'plate' && _rbTonePlate) {
      sampler.connect(_rbTonePlate);
      _rbTonePlate.wet.value = rbReverbAmount / 100;
    }
    console.log('[Rubato] Reverb connected — type:', rbReverbType, 'amount:', rbReverbAmount);
  } catch(e) {
    console.warn('[Rubato] Reverb routing error:', e.message);
  }
}

// Parse minimal MIDI and schedule notes through the internal synth
async function _rbPlayMidiBuffer(buffer, semitones) {
  const bytes  = new Uint8Array(buffer);
  const parsed = _rbParseMidi(bytes);
  if (!parsed.events.length) { rbPlaying = false; renderRubatoCard(); return; }

  const events  = parsed.events;
  const tempo   = parsed.tempo || 500000;  // microseconds per beat (default 120 BPM)
  const ppq     = parsed.ppq   || 480;
  const msPerTick = (tempo / ppq) / 1000;  // ms per tick using real tempo

  // Ensure synth is ON and piano is loaded before scheduling notes
  if (typeof setSynthMode === 'function') setSynthMode(true);
  if (typeof _loadChannelSampler === 'function') {
    const sampler = await _loadChannelSampler(RB_MIDI_CH, 0);
    _rbRouteSamplerThroughReverb(sampler);
  }
  console.log('[Rubato] Playing ' + events.length + ' note events, tempo=' + tempo + 'µs, ppq=' + ppq + ', msPerTick=' + msPerTick.toFixed(3));

  // Sustain pedal state — tracks which notes are held by pedal
  let sustainDown   = false;
  const heldByPedal = new Set();  // notes held open because pedal is down

  events.forEach(ev => {
    const delayMs = ev.tick * msPerTick;
    const t = setTimeout(() => {
      if (!rbPlaying) return;
      const note = Math.max(0, Math.min(127, (ev.note || 0) + semitones));

      if (ev.type === 'on' && ev.vel > 0) {
        synthNoteOn(RB_MIDI_CH, note, ev.vel, 0);
        heldByPedal.delete(note); // re-striking clears pedal hold

      } else if (ev.type === 'off' || (ev.type === 'on' && ev.vel === 0)) {
        if (sustainDown) {
          // Pedal is down — don't release yet, just mark as held
          heldByPedal.add(note);
        } else {
          synthNoteOff(RB_MIDI_CH, note);
        }

      } else if (ev.type === 'sustain') {
        if (ev.value >= 64) {
          // Pedal pressed
          sustainDown = true;
        } else {
          // Pedal released — now release all notes that were held by pedal
          sustainDown = false;
          heldByPedal.forEach(n => synthNoteOff(RB_MIDI_CH, n));
          heldByPedal.clear();
        }
      }
    }, delayMs);
    rbActiveNotes.push(t);
  });

  // After last note — mark not playing
  const lastTick  = Math.max(...events.map(e => e.tick));
  const endDelay  = (lastTick * msPerTick) + 800;  // 800ms tail for note release
  const endTimer  = setTimeout(() => {
    rbPlaying     = false;
    rbActiveNotes = [];
    renderRubatoCard();
  }, endDelay);
  rbActiveNotes.push(endTimer);
}

// ── Play a time slice of a MIDI file (startSec to endSec) ────
async function _rbPlayMidiSlice(buffer, startSec, endSec, semitones) {
  const bytes  = new Uint8Array(buffer);
  const parsed = _rbParseMidi(bytes);
  if (!parsed.events.length) { rbPlaying=false; renderRubatoCard(); return; }

  const tempo     = parsed.tempo || 500000;
  const ppq       = parsed.ppq   || 480;
  const msPerTick = (tempo / ppq) / 1000;
  const startTick = startSec ? Math.floor((startSec * 1000) / msPerTick) : 0;
  const endTick   = endSec   ? Math.floor((endSec   * 1000) / msPerTick) : Infinity;

  // Filter events within the slice
  const sliceEvents = parsed.events.filter(e => e.tick >= startTick && e.tick <= endTick);
  if (!sliceEvents.length) {
    // Fallback — play full file if slice is empty
    await _rbPlayMidiBuffer(buffer, semitones);
    return;
  }

  // Ensure synth is ready
  if (typeof setSynthMode === 'function') setSynthMode(true);
  if (typeof _loadChannelSampler === 'function') {
    const sampler = await _loadChannelSampler(RB_MIDI_CH, 0);
    _rbRouteSamplerThroughReverb(sampler);
  }

  let sustainDown = false;
  const heldByPedal = new Set();

  sliceEvents.forEach(ev => {
    // Offset time so slice starts at 0
    const delayMs = (ev.tick - startTick) * msPerTick;
    const t = setTimeout(() => {
      if (!rbPlaying) return;
      const note = Math.max(0, Math.min(127, (ev.note||0) + semitones));
      if (ev.type==='on' && ev.vel>0) {
        synthNoteOn(RB_MIDI_CH, note, ev.vel, 0);
        heldByPedal.delete(note);
      } else if (ev.type==='off' || (ev.type==='on' && ev.vel===0)) {
        if (sustainDown) heldByPedal.add(note);
        else synthNoteOff(RB_MIDI_CH, note);
      } else if (ev.type==='sustain') {
        if (ev.value>=64) { sustainDown=true; }
        else { sustainDown=false; heldByPedal.forEach(n=>synthNoteOff(RB_MIDI_CH,n)); heldByPedal.clear(); }
      }
    }, delayMs);
    rbActiveNotes.push(t);
  });

  const lastTick = Math.max(...sliceEvents.map(e=>e.tick));
  const endDelay = ((lastTick - startTick) * msPerTick) + 800;
  const endTimer = setTimeout(() => {
    rbPlaying=false; rbActiveNotes=[]; renderRubatoCard();
  }, endDelay);
  rbActiveNotes.push(endTimer);
}

// Minimal MIDI parser — extracts note on/off events with absolute ticks
// Returns { events, tempo (µs/beat), ppq }
function _rbParseMidi(bytes) {
  const events = [];
  let pos = 0;
  let tempo = 500000;  // default 120 BPM

  function readUint32() { return (bytes[pos++]<<24)|(bytes[pos++]<<16)|(bytes[pos++]<<8)|bytes[pos++]; }
  function readUint16() { return (bytes[pos++]<<8)|bytes[pos++]; }
  function readVarLen() {
    let val = 0, b;
    do { b = bytes[pos++]; val = (val << 7) | (b & 0x7F); } while (b & 0x80);
    return val;
  }

  if (readUint32() !== 0x4D546864) return { events, tempo, ppq: 480 };
  pos += 4; // header length
  pos += 2; // format
  const numTracks = readUint16();
  const ppq = readUint16();

  for (let t = 0; t < numTracks; t++) {
    if (pos + 8 > bytes.length) break;
    if (readUint32() !== 0x4D54726B) break;
    const trackLen = readUint32();
    const trackEnd = pos + trackLen;
    let tick = 0;
    let lastStatus = 0;

    while (pos < trackEnd) {
      tick += readVarLen();
      let status = bytes[pos];

      if (status & 0x80) { lastStatus = status; pos++; }
      else { status = lastStatus; }

      const type = (status >> 4) & 0xF;
      const ch   = status & 0xF;

      if (type === 0x9 || type === 0x8) {
        const note = bytes[pos++];
        const vel  = bytes[pos++];
        events.push({ tick, type: type === 0x9 ? 'on' : 'off', ch, note, vel });
      } else if (type === 0xA) { pos += 2; }
      else if (type === 0xB) {
        // Control Change — capture CC64 (sustain pedal)
        const cc  = bytes[pos++];
        const val = bytes[pos++];
        if (cc === 64) {
          events.push({ tick, type: 'sustain', ch, value: val });
        }
      }
      else if (type === 0xC) { pos += 1; }
      else if (type === 0xD) { pos += 1; }
      else if (type === 0xE) { pos += 2; }
      else if (type === 0xF) {
        if (status === 0xFF) {
          const metaType = bytes[pos++];
          const metaLen  = readVarLen();
          if (metaType === 0x51 && metaLen === 3) {
            // Tempo meta event — extract µs per beat
            tempo = (bytes[pos] << 16) | (bytes[pos+1] << 8) | bytes[pos+2];
          }
          pos += metaLen;
        } else if (status === 0xF0 || status === 0xF7) {
          const len = readVarLen(); pos += len;
        } else { pos++; }
      } else { pos++; }
    }
    pos = trackEnd;
  }

  events.sort((a, b) => a.tick - b.tick);
  return { events, tempo, ppq };
}

// ── Word-Anchored Key Detection Engine ───────────────────────
//
// HOW IT WORKS:
//   1. The .vwb pack contains melodicStructure: [{syllable, degree}]
//      which maps each sung word to its scale degree (e.g. "great"=3).
//   2. _rbBuildMelodicMapFromPack() converts this into rbMelodicMap:
//      a fast word → degree lookup.
//   3. While listening, every time the Speech API hears a word, we:
//      a. Look up its expected scale degree from rbMelodicMap
//      b. Read the current pitch from the AnalyserNode at that instant
//      c. Calculate what key the root would be at if that pitch = that degree
//      d. Cast a vote for that key
//   4. Once enough votes agree (threshold: RB_KEY_VOTE_THRESHOLD),
//      we lock the key, stop searching, and play in that key.
//   5. If the user presses Try Again, votes clear and we start over.

// MIDI note number → key name (chromatic)
const RB_NOTE_NAMES_CHROMATIC = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

// Semitone offset from root for each scale degree in major scale
// Index by integer degree: RB_DEG_SEMITONES[1]=0, [2]=2, [3]=4, [4]=5, [5]=7, [6]=9, [7]=11
const RB_DEG_SEMITONES = [0, 0, 2, 4, 5, 7, 9, 11];

// How many agreeing word-pitch votes before we lock the key
const RB_KEY_VOTE_THRESHOLD = 3.5;

// Pitch detection state
let rbPitchCtx        = null;   // AudioContext for pitch detection
let rbPitchSource     = null;   // MediaStreamAudioSourceNode
let rbPitchAnalyser   = null;   // AnalyserNode
let rbPitchActive     = false;  // true while pitch detection is running
let rbPitchLocked     = false;  // true once key is confirmed and locked
let rbKeyVotes        = {};     // { 'Bb': 3, 'F': 1, ... } — vote tally per key

// Called every time the Speech API hears a new word while key detecting
// word: the recognized word (string)
function rbOnWordForKeyDetection(word) {
  if (!rbKeyDetecting || rbPitchLocked || !rbPitchActive) return;
  if (!rbPitchAnalyser || !rbPitchCtx) return;

  // Clean the word to match melodicMap keys
  const clean = word.toLowerCase().trim().replace(/[^a-z']/g, '');
  // Fuzzy match against the melodic map, not exact-only — an exact-only
  // lookup here wastes most opportunities to vote toward the correct
  // key whenever a word gets slightly mis-transcribed, which is why key
  // detection could previously take an entire song (or more) to lock.
  let degree = rbMelodicMap[clean];
  if (degree === undefined) {
    for (const mapWord in rbMelodicMap) {
      if (_rbFuzzyMatch(clean, mapWord)) { degree = rbMelodicMap[mapWord]; break; }
    }
  }
  if (degree === undefined) return; // word not in this song's map — skip

  // Read pitch right now at this moment
  const freq = _rbDetectPitch();
  if (!freq || freq <= 0) return;

  // Convert frequency to a continuous (unrounded) MIDI note value.
  // Real human singing is rarely dead-on pitch — someone singing
  // slightly flat or sharp (but still clearly, recognizably on the
  // right note) shouldn't get rounded straight to the wrong semitone.
  // Instead of rounding once and casting one all-or-nothing vote, we
  // split the vote between the two nearest semitones, weighted by how
  // close the actual pitch was to each — a consistent slight-flat
  // tendency now still leans toward the correct key rather than
  // reliably tipping every single vote to the wrong one.
  const midiNote = 12 * Math.log2(freq / 440) + 69;
  const lowerNote = Math.floor(midiNote);
  const fracPart  = midiNote - lowerNote;       // 0 (dead on lower) .. 1 (dead on upper)
  const lowerWeight = 1 - fracPart;
  const upperWeight = fracPart;

  // Get the semitone offset for this degree in the major scale
  // Handle flat/sharp halves: b3 = 2.5, so offset = between degree 2 and 3
  const degInt    = Math.floor(degree);        // integer part (1-7)
  const degFrac   = degree - degInt;           // 0 or 0.5
  const baseOffset = RB_DEG_SEMITONES[degInt] || 0;
  // For flat degrees (b3=2.5): use the semitone between degree 2 and 3
  const degOffset  = degFrac > 0 ? baseOffset - 1 : baseOffset;

  const castWeightedVote = (noteVal, weight) => {
    if (weight < 0.02) return; // negligible — not worth logging/counting
    const pitchClass = ((Math.round(noteVal) % 12) + 12) % 12;
    const rootPC = ((pitchClass - degOffset) % 12 + 12) % 12;
    const keyName = RB_NOTE_NAMES_CHROMATIC[rootPC];
    if (!keyName) return;
    rbKeyVotes[keyName] = (rbKeyVotes[keyName] || 0) + weight;
  };
  castWeightedVote(lowerNote, lowerWeight);
  castWeightedVote(lowerNote + 1, upperWeight);

  console.log(`[Rubato] Word "${clean}" (deg ${degree}) → pitch ${Math.round(freq)}Hz (MIDI ${midiNote.toFixed(2)}) → votes`, rbKeyVotes);

  // Check if any key has reached the vote threshold outright
  let winner = Object.entries(rbKeyVotes).find(([k, v]) => v >= RB_KEY_VOTE_THRESHOLD);

  // Fallback: no key hit the threshold outright, but if one key is
  // CLEARLY ahead of the rest after enough evidence has accumulated,
  // lock onto it anyway. Without this, natural pitch variation across
  // different sung notes (not just one note being a bit flat) can
  // spread votes across several nearby keys and never let any single
  // one reach the threshold, even when one is obviously the right key.
  if (!winner) {
    const entries = Object.entries(rbKeyVotes).sort((a, b) => b[1] - a[1]);
    const totalVotes = entries.reduce((sum, [, v]) => sum + v, 0);
    if (entries.length >= 2 && totalVotes >= 5) {
      const [leadKey, leadVotes] = entries[0];
      const [, secondVotes] = entries[1];
      if (leadVotes >= secondVotes * 1.35 && leadVotes >= 2.0) {
        console.log(`[Rubato] No key hit the outright threshold, but "${leadKey}" is clearly leading `
          + `(${leadVotes.toFixed(2)} vs next-best ${secondVotes.toFixed(2)}) after ${totalVotes.toFixed(2)} total votes — locking.`);
        winner = [leadKey, leadVotes];
      }
    }
  }

  if (winner) {
    _rbLockKey(winner[0]);
  }
}

// Lock the detected key, apply to MIDI, stop detection, notify user
// Plays the song's instrumental lead-in (if the song has one), before
// any phrase/trigger tracking starts. Reuses the same MIDI-slice
// playback used for regular chunks, just without requiring a trigger
// word — since a purely instrumental intro has no words to trigger on.
async function _rbPlayLeadIn() {
  if (rbLeadInPlayed) return; // already played this session — Reset to make it available again
  if (!rbVwbPack || !rbVwbPack.leadIn) return; // no lead-in on this song
  const { startTime, endTime } = rbVwbPack.leadIn;
  if (startTime == null || endTime == null) return;

  if (!rbPackMidiBuffer && rbVwbPack._midiPath) {
    const rb = await window.vwb.readFileBuffer(rbVwbPack._midiPath);
    if (rb && rb.success) rbPackMidiBuffer = rb.buffer;
  }
  if (!rbPackMidiBuffer) return;

  rbStopCurrent(); // clear anything currently playing before starting the intro
  rbLeadInPlayed = true;
  const semitones = rbTranspose + (rbOctave * 12);
  console.log('[Rubato] Playing instrumental lead-in (' + startTime + 's - ' + endTime + 's)');
  rbPlaying = true;
  renderRubatoCard();
  await _rbPlayMidiSlice(rbPackMidiBuffer, startTime, endTime, semitones);
}

function _rbLockKey(keyName) {
  const semitones = RB_NOTE_NAMES_CHROMATIC.indexOf(keyName);
  if (semitones < 0) return;

  rbTranspose    = semitones;
  rbPitchLocked  = true;
  rbKeyDetecting = false;

  rbStopPitchDetection();
  renderRubatoCard();

  // Announce key lock and auto-start playback at the first phrase
  showNotification('🎵 Key locked: ' + keyName + ' — playing now');
  console.log('[Rubato] 🔑 Key locked:', keyName, '(semitones:', semitones, ') — votes:', rbKeyVotes);

  // Auto-advance to first phrase and play if not already playing.
  // NOTE: the instrumental lead-in (if this song has one) is deliberately
  // NOT played here — this function only ever runs from automatic voice-
  // based key detection, and an intro has no purpose once the singer has
  // already started singing. The lead-in is only reachable via an
  // explicit manual trigger (see the "Play Intro" button in Manual mode).
  if (!rbPlaying && rbPhrases.length > 0) {
    if (rbCurrentIdx < 0) rbCurrentIdx = 0;
    rbPlayChunk(rbCurrentIdx);
  }
}

// Start pitch detection (attaches to existing mic stream from Vosk)
function rbStartPitchDetection(stream) {
  if (rbPitchActive || !stream) return;
  try {
    rbPitchCtx      = new AudioContext();
    rbPitchSource   = rbPitchCtx.createMediaStreamSource(stream);
    rbPitchAnalyser = rbPitchCtx.createAnalyser();
    rbPitchAnalyser.fftSize = 4096; // larger = better low-freq resolution
    rbPitchSource.connect(rbPitchAnalyser);
    rbKeyVotes   = {};
    rbPitchActive = true;
    console.log('[Rubato] Pitch detection ready — waiting for word matches');
  } catch(e) {
    console.warn('[Rubato] Pitch detection failed to start:', e.message);
  }
}

// Stop pitch detection and clean up
function rbStopPitchDetection() {
  rbPitchActive = false;
  try { if (rbPitchSource)   rbPitchSource.disconnect();  } catch(e) {}
  try { if (rbPitchAnalyser) rbPitchAnalyser.disconnect(); } catch(e) {}
  try { if (rbPitchCtx)      rbPitchCtx.close();          } catch(e) {}
  rbPitchCtx = null; rbPitchSource = null; rbPitchAnalyser = null;
  console.log('[Rubato] Pitch detection stopped');
}

// Autocorrelation pitch detector — reads from AnalyserNode at call time
// Returns frequency in Hz, or null if signal too weak or undetectable
function _rbDetectPitch() {
  if (!rbPitchAnalyser || !rbPitchCtx) return null;
  const bufLen = rbPitchAnalyser.fftSize;
  const buf    = new Float32Array(bufLen);
  rbPitchAnalyser.getFloatTimeDomainData(buf);

  // RMS check — reject silence
  let rms = 0;
  for (let i = 0; i < bufLen; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / bufLen);
  if (rms < 0.008) return null;

  // Autocorrelation
  const sampleRate = rbPitchCtx.sampleRate;
  const corr       = new Float32Array(bufLen);
  for (let lag = 0; lag < bufLen; lag++) {
    let sum = 0;
    for (let i = 0; i < bufLen - lag; i++) sum += buf[i] * buf[i + lag];
    corr[lag] = sum;
  }

  // Find first peak after the correlation drops below half its zero-lag value
  const minLag = Math.floor(sampleRate / 1050); // ~1050Hz max (above singing)
  const maxLag = Math.floor(sampleRate / 55);   // ~55Hz min (low bass)
  let bestLag = -1, bestVal = -Infinity, dipped = false;
  for (let lag = minLag; lag < maxLag; lag++) {
    if (!dipped && corr[lag] < corr[0] * 0.5) dipped = true;
    if (dipped && corr[lag] > bestVal) { bestVal = corr[lag]; bestLag = lag; }
  }

  if (bestLag < 1) return null;
  return sampleRate / bestLag;
}

// Try Again — fade out current music, reset detection, resume listening
async function rbTryAgainKeyDetection() {
  // Fade out current chunk gracefully
  if (rbPlaying) {
    if (rbGain) {
      rbGain.gain.setTargetAtTime(0, AC.currentTime, 0.3);
      setTimeout(() => {
        rbStopCurrent();
        if (rbGain) rbGain.gain.setTargetAtTime(1.0, AC.currentTime, 0.1);
      }, 600);
    } else {
      rbStopCurrent();
    }
  }

  // Reset key detection state
  rbPitchLocked  = false;
  rbKeyVotes     = {};
  rbKeyDetecting = true;

  // Restart pitch detection on existing mic stream if available
  rbStopPitchDetection();
  const stream = rbMicStream || null;
  if (stream) {
    rbStartPitchDetection(stream);
    showNotification('🎵 Try Again — keep singing, VWB is listening for the key...');
  } else {
    // Need to open mic again
    try {
      const constraints = {
        audio: rbMicDeviceId
          ? { deviceId: { exact: rbMicDeviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true },
        video: false
      };
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      rbStartPitchDetection(newStream);
      showNotification('🎵 Try Again — keep singing, VWB is listening for the key...');
    } catch(e) {
      rbKeyDetecting = false;
      showNotification('❌ Microphone access denied');
    }
  }

  renderRubatoCard();
}

// Reset key detection so it can detect again
function rbResetKeyDetection() {
  rbPitchLocked  = false;
  rbKeyVotes     = {};
  rbKeyDetecting = false;
  rbStopPitchDetection();
  showNotification('🎵 Key detection cleared');
  renderRubatoCard();
  console.log('[Rubato] Key detection reset');
}

// Uses the Web Audio API getUserMedia path that VWB's Armor Bearer
// VAD already uses successfully. Vosk runs entirely in the browser
// as WebAssembly — no internet, no Google, no external tools.
// Model downloads once (~40MB) then is cached permanently.

let rbMicDeviceId  = '';           // '' = system default
let rbMicLabel     = 'Default Mic';
let rbMicStream    = null;         // active MediaStream
let rbVoskModel    = null;         // loaded Vosk model
let rbVoskRec      = null;         // Vosk recognizer instance
let rbVoskCtx      = null;         // AudioContext for Vosk
let rbVoskSource   = null;         // MediaStreamAudioSourceNode
let rbVoskProc     = null;         // ScriptProcessorNode
let rbVoskReady    = false;        // true when model is loaded

// ── Vosk Model Loader ─────────────────────────────────────────
async function rbLoadVoskModel() {
  if (rbVoskReady) return true;
  if (typeof Vosk === 'undefined') {
    console.warn('[Rubato] Vosk not loaded — check script tag in index.html');
    return false;
  }
  try {
    showNotification('⏳ Loading speech model (one-time setup)…');
    console.log('[Rubato] Loading Vosk model...');

    // Use the small English model — 40MB, downloads once, cached by browser
    // Reverted to the small model — the large model (1.8GB) caused the
    // Listen button to hang, likely from a slow/failed download or
    // memory constraints on this machine. The free-form recognition
    // change (no more grammar constraint) and the fuzzy/homophone
    // matching should still meaningfully help even with the small model.
    const MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';

    rbVoskModel = await Vosk.createModel(MODEL_URL);
    rbVoskReady = true;
    showNotification('✅ Speech model ready');
    console.log('[Rubato] Vosk model loaded successfully');
    return true;
  } catch(e) {
    console.error('[Rubato] Vosk model load failed:', e.message);
    showNotification('❌ Speech model failed to load: ' + e.message);
    return false;
  }
}

// ── Key Detection Toggle (separate from word listening) ────────
async function rbToggleKeyDetection() {
  if (rbKeyDetecting) {
    // Stop key detection
    rbKeyDetecting = false;
    rbStopPitchDetection();
    renderRubatoCard();
    showNotification('🎵 Key detection stopped');
    return;
  }

  // Start key detection — needs mic open
  rbKeyDetecting = true;

  // If already listening for words, reuse existing mic stream
  if (rbListening && rbMicStream) {
    rbStartPitchDetection(rbMicStream);
    renderRubatoCard();
    showNotification('🎵 Key detection active — sing the melody');
    return;
  }

  // Otherwise open mic just for pitch detection
  try {
    const constraints = {
      audio: rbMicDeviceId
        ? { deviceId: { exact: rbMicDeviceId }, echoCancellation: true, noiseSuppression: true }
        : { echoCancellation: true, noiseSuppression: true },
      video: false
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    rbStartPitchDetection(stream);
    renderRubatoCard();
    showNotification('🎵 Key detection active — sing the melody');
  } catch(e) {
    rbKeyDetecting = false;
    showNotification('❌ Microphone access denied');
  }
}

// Reset key detection
// ── Start Listening ───────────────────────────────────────────
async function rbStartListening() {
  if (rbListening) { rbStopListening(); return; }
  if (!rbPhrases.length) { showNotification('⚠ Load lyrics first'); return; }

  // Step 1: Load Vosk model if not already loaded
  const modelReady = await rbLoadVoskModel();
  if (!modelReady) {
    showNotification('❌ Speech model not ready — check internet for first-time setup');
    return;
  }

  // Step 2: Open microphone using same getUserMedia as Armor Bearer VAD
  try {
    const constraints = {
      audio: rbMicDeviceId
        ? { deviceId: { exact: rbMicDeviceId }, echoCancellation: true, noiseSuppression: true }
        : { echoCancellation: true, noiseSuppression: true },
      video: false
    };
    rbMicStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('[Rubato] Microphone opened:', rbMicLabel);
  } catch(e) {
    showNotification('❌ Microphone access denied — check System Settings > Privacy > Microphone');
    console.error('[Rubato] getUserMedia failed:', e.message);
    return;
  }

  // Step 3: Create Vosk recognizer and connect to microphone stream
  try {
    const sampleRate = 16000;

    // NOTE: previously used a grammar-constrained recognizer (limited to
    // only this song's trigger words + [unk]). Singing distorts
    // pronunciation more than normal speech (sustained notes, pitch
    // bends, stretched vowels), and a tiny constrained vocabulary gives
    // Vosk no room to make a "close enough" guess — it just outputs
    // [unk] when the acoustic match isn't near-perfect. Switched to
    // free-form recognition against Vosk's full vocabulary instead,
    // relying on the fuzzy/homophone matching in _rbMatchTranscript to
    // handle whatever it actually transcribes.
    rbVoskRec = new rbVoskModel.KaldiRecognizer(sampleRate);
    rbVoskRec.setWords(true);

    // Listen for results from Vosk recognizer
    rbVoskRec.on('result', (message) => {
      if (!rbListening) return;
      // Vosk provides per-word confidence (0-1) via setWords(true), in
      // message.result.result — this was previously ignored entirely,
      // which is why the Confidence slider had no real effect. Now we
      // filter out words below the slider's threshold before matching.
      const wordResults = (message.result && Array.isArray(message.result.result))
        ? message.result.result
        : null;
      let text;
      if (wordResults) {
        text = wordResults
          .filter(w => (w.conf === undefined || w.conf >= rbConfidence))
          .map(w => w.word)
          .join(' ')
          .trim();
        if (wordResults.length && text.length === 0) {
          console.log('[Rubato] All words below confidence threshold (' + Math.round(rbConfidence*100) + '%), discarded:',
            wordResults.map(w => w.word + '@' + Math.round((w.conf||0)*100) + '%'));
        }
      } else {
        text = message.result && message.result.text ? message.result.text.trim() : '';
      }
      if (text.length > 0) {
        console.log('[Rubato] Vosk heard:', text);
        _rbMatchTranscript(text.toLowerCase());
      }
    });

    rbVoskRec.on('partialresult', (message) => {
      if (!rbListening) return;
      // Note: Vosk doesn't provide per-word confidence on partial (still-
      // decoding) results, only on final results above — so confidence
      // filtering only applies to the 'result' handler, not here.
      const partial = message.result && message.result.partial ? message.result.partial.trim() : '';
      if (partial.length > 2) {
        console.log('[Rubato] Vosk partial:', partial);
        _rbMatchTranscript(partial.toLowerCase());
      }
    });

    // Wire: mic stream → AudioContext → ScriptProcessor → Vosk
    rbVoskCtx    = new AudioContext({ sampleRate });
    rbVoskSource = rbVoskCtx.createMediaStreamSource(rbMicStream);
    rbVoskProc   = rbVoskCtx.createScriptProcessor(4096, 1, 1);

    rbVoskProc.onaudioprocess = (e) => {
      if (!rbListening || !rbVoskRec) return;
      try {
        // vosk-browser accepts the AudioBuffer directly
        rbVoskRec.acceptWaveform(e.inputBuffer);
      } catch(err) {
        // ignore transient errors during processing
      }
    };

    rbVoskSource.connect(rbVoskProc);
    rbVoskProc.connect(rbVoskCtx.destination);

    // If key detection is also active, start pitch detection on same stream
    if (rbKeyDetecting) {
      rbStartPitchDetection(rbMicStream);
    }

    rbListening = true;
    renderRubatoCard();
    showNotification('🎙 Rubato listening (offline) — ' + rbMicLabel);
    console.log('[Rubato] Vosk listening started on:', rbMicLabel);

  } catch(e) {
    console.error('[Rubato] Vosk start error:', e.message);
    showNotification('❌ Could not start speech recognition: ' + e.message);
    _rbReleaseMic();
  }
}

// ── Stop Listening ────────────────────────────────────────────
function rbStopListening() {
  rbListening = false;
  rbStopPitchDetection();
  try { if (rbVoskProc)   { rbVoskProc.disconnect();   rbVoskProc   = null; } } catch(e) {}
  try { if (rbVoskSource) { rbVoskSource.disconnect();  rbVoskSource = null; } } catch(e) {}
  try { if (rbVoskCtx)    { rbVoskCtx.close();          rbVoskCtx    = null; } } catch(e) {}
  try { if (rbVoskRec)    { rbVoskRec.remove();         rbVoskRec    = null; } } catch(e) {}
  _rbReleaseMic();
  renderRubatoCard();
  console.log('[Rubato] Vosk listening stopped');
}

function _rbReleaseMic() {
  if (rbMicStream) {
    rbMicStream.getTracks().forEach(t => t.stop());
    rbMicStream = null;
  }
}

// ── Mic Device Selection ──────────────────────────────────────
function rbSetMicDevice(deviceId, label) {
  rbMicDeviceId = deviceId || '';
  rbMicLabel    = label   || 'Default Mic';
  if (rbListening) {
    rbStopListening();
    setTimeout(() => rbStartListening(), 300);
  }
  console.log('[Rubato] Mic device set:', rbMicLabel);
}

async function rbPopulateMicDevices(selectElementId) {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics    = devices.filter(d => d.kind === 'audioinput');
    const sel     = document.getElementById(selectElementId);
    if (!sel) return;
    sel.innerHTML = '<option value="">Default Mic</option>';
    mics.forEach(d => {
      const opt    = document.createElement('option');
      opt.value    = d.deviceId;
      opt.text     = d.label || ('Microphone ' + d.deviceId.slice(0, 6));
      opt.selected = d.deviceId === rbMicDeviceId;
      sel.appendChild(opt);
    });
    console.log('[Rubato] Found', mics.length, 'microphone devices');
  } catch(e) {
    console.warn('[Rubato] Could not enumerate mic devices:', e.message);
  }
}

// Called by future Whisper IPC integration
function rbOnWhisperTranscript(transcript) {
  if (!rbListening) return;
  console.log('[Rubato] Transcript:', transcript);
  _rbMatchTranscript(transcript.toLowerCase().trim());
}

// Match recognized transcript against trigger words
// ── Fuzzy word matching ─────────────────────────────────────────
// Vosk (like any speech recognizer) doesn't always transcribe a word
// perfectly — different accents, pronunciation, or just mic noise can
// produce a near-miss (e.g. "prayr" instead of "prayer"). An exact
// string match has zero tolerance for that. This allows a small edit
// distance, scaled by word length so short words (where a 1-letter
// difference usually means a genuinely different word, like "to" vs
// "so") still require an exact match.
function _rbLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}
// Common homophones — words that sound identical but aren't close in
// spelling, so edit distance alone won't catch them (e.g. "hear"/"here"
// differ by 2 letters). Curated for worship-lyric vocabulary rather than
// exhaustive — add pairs here as real mismatches turn up in testing.
const RB_HOMOPHONES = [
  ['hear', 'here'], ['their', 'there'], ['theyre', 'there'],
  ['your', 'youre'], ['no', 'know'], ['some', 'sum'],
  ['our', 'hour'], ['praise', 'prays'], ['throne', 'thrown'],
  ['for', 'four'], ['to', 'too'], ['two', 'too'], ['be', 'bee'],
  ['see', 'sea'], ['son', 'sun'], ['whole', 'hole'], ['right', 'write'],
  ['sees', 'seas'], ['made', 'maid'], ['reign', 'rain'], ['reign', 'rein'],
  ['soul', 'sole'], ['weight', 'wait'], ['wait', 'weigh'], ['dear', 'deer'],
  ['heal', 'heel'], ['peace', 'piece'], ['presence', 'presents'],
  ['grant', 'great'],  // not a true homophone, but a confirmed real ASR
                       // mishearing during live testing — 2 letters apart,
                       // just past the normal fuzzy-match tolerance
  ['lord', 'laura']    // confirmed real ASR mishearing — 3 letters apart,
                       // well past fuzzy-match tolerance on its own
];
const RB_HOMOPHONE_MAP = {};
RB_HOMOPHONES.forEach(([a, b]) => {
  (RB_HOMOPHONE_MAP[a] = RB_HOMOPHONE_MAP[a] || new Set()).add(b);
  (RB_HOMOPHONE_MAP[b] = RB_HOMOPHONE_MAP[b] || new Set()).add(a);
});

function _rbFuzzyMatch(a, b) {
  if (a === b) return true;
  if (RB_HOMOPHONE_MAP[a] && RB_HOMOPHONE_MAP[a].has(b)) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false; // short words: exact match only
  const maxDist = minLen >= 7 ? 2 : 1;
  return _rbLevenshtein(a, b) <= maxDist;
}
function _rbFuzzyIncludes(heardArr, target) {
  if (!target) return false;
  return heardArr.some(w => _rbFuzzyMatch(w, target));
}

// Extended tolerance — ONLY used for the one specific word expected
// immediately next, never for scanning further ahead. Since we already
// know exactly what word we're hoping to hear, it's safe to be more
// generous about an imperfectly-sung attempt at THAT word. Using this
// same tolerance broadly (for arbitrary later phrases) would risk
// confusing genuinely different words in the song with each other —
// tested and confirmed real pairs like "peace"/"place" or "sing"/"king"
// can fall within loose distance too, so this stays scoped to the
// single most-likely case: the singer is trying to say the next word.
// A handful of common English letter/sound ambiguities — same phoneme,
// different spelling. Normalized only for the prefix check below, so
// e.g. "klein" (k) and "cline" (c) are recognized as starting the same
// even though they don't share a literal first letter.
function _rbPhoneticPrefix(w) {
  return w.replace(/^k/, 'c').replace(/^ph/, 'f').replace(/^wh/, 'w');
}

function _rbFuzzyMatchNext(a, b) {
  if (_rbFuzzyMatch(a, b)) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 3) return false;
  // Very short words (3 letters) get a small, tight allowance — short
  // connector words like "in"/"and" previously had zero tolerance at
  // all here, which made them disproportionately hard to trigger.
  if (minLen === 3) {
    return _rbPhoneticPrefix(a)[0] === _rbPhoneticPrefix(b)[0] && _rbLevenshtein(a, b) <= 1;
  }
  const prefixLen = minLen >= 6 ? 2 : 1;
  if (_rbPhoneticPrefix(a).slice(0, prefixLen) !== _rbPhoneticPrefix(b).slice(0, prefixLen)) return false;
  const maxDist = minLen >= 5 ? 3 : 2;
  return _rbLevenshtein(a, b) <= maxDist;
}
function _rbFuzzyIncludesNext(heardArr, target) {
  if (!target) return false;
  return heardArr.some(w => _rbFuzzyMatchNext(w, target));
}

// Moves to a phrase — plays it normally if the key is already locked,
// or just silently tracks the position (no audio) if key detection is
// still in progress. This is what makes two things work together: (1)
// nothing plays in the wrong key while detection is still running, and
// (2) once the key DOES lock, playback picks up wherever the singer
// actually is by then, since rbCurrentIdx was already being tracked —
// not forced back to the beginning.
function _rbAdvanceTo(idx, matchDescription) {
  if (rbKeyDetecting && !rbPitchLocked) {
    console.log('[Rubato] Tracking position during key detection (silent, no audio yet): ' + matchDescription);
    rbCurrentIdx = idx;
    rbCurrentPhraseStartTime = Date.now();
    rbFirstNewSoundTime = 0;
    renderRubatoCard();
  } else {
    console.log('[Rubato] Matched ' + matchDescription);
    rbPlayChunk(idx);
  }
}

function _rbMatchTranscript(transcript) {
  const heard = transcript.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''));

  // ── Word-anchored key detection: pass each heard word to the key engine ──
  if (rbKeyDetecting && !rbPitchLocked) {
    heard.forEach(w => { if (w) rbOnWordForKeyDetection(w); });
  }

  // ── Smart branching: at end of a section, listen for ALL possible next sections ──
  if (rbCurrentIdx >= 0 && rbSections.length > 0) {
    const curPhrase = rbPhrases[rbCurrentIdx];
    const lastWord  = rbLastWordMap[rbCurrentIdx] || '';
    const heardStr  = heard.join(' ');
    // Check if singer just sang the last word of current phrase
    const atSectionEnd = lastWord && heardStr.includes(lastWord.replace(/[^a-z0-9]/gi,'').toLowerCase());
    if (atSectionEnd && curPhrase && curPhrase.sectionId !== undefined) {
      // Find all possible next section trigger words and listen for them
      const branches = rbBranchMap[curPhrase.sectionId] || [];
      for (const branch of branches) {
        const branchTrig = (branch.trigger||'').toLowerCase().replace(/[^a-z0-9]/g,'');
        if (branchTrig && _rbFuzzyIncludes(heard, branchTrig)) {
          // Find the first phrase of this branch section
          const branchPhrase = rbPhrases.findIndex(p =>
            p.sectionId === branch.sectionId && p.trigger === branchTrig);
          if (branchPhrase >= 0) {
            console.log('[Rubato] Smart branch → '+branch.label);
            rbPlayChunk(branchPhrase); return;
          }
        }
      }
    }
  }

  // Look ahead from current position, no distance limit — natural song
  // progression means once a repeated phrase has already been sung,
  // hearing those same words again should trigger the NEXT occurrence
  // further into the song, not jump back to an earlier one. Forward
  // matches always take priority over backward matches.
  const startSearch = Math.max(0, rbCurrentIdx + 1);
  const curTrigWord = (rbCurrentIdx >= 0 && rbPhrases[rbCurrentIdx]) ? rbPhrases[rbCurrentIdx].firstWord : null;
  for (let checkIdx = startSearch; checkIdx < rbPhrases.length; checkIdx++) {
    const phrase = rbPhrases[checkIdx];
    if (!phrase.trigger) continue;
    // If this candidate's trigger word is the SAME TEXT as the phrase
    // we're already on, and it's not the very next phrase, skip it.
    // Vosk fires multiple recognition events for one sung utterance, so
    // hearing the current word again shortly after is far more likely
    // to be a re-firing of the SAME word than the singer intentionally
    // skipping ahead to a distant repeat of it.
    if (curTrigWord && phrase.firstWord === curTrigWord && checkIdx !== startSearch) continue;
    // Extended tolerance for the immediate next word only — see
    // _rbFuzzyMatchNext's comment for why this is scoped this narrowly.
    const isImmediateNext = checkIdx === startSearch;
    const matched = isImmediateNext
      ? _rbFuzzyIncludesNext(heard, phrase.firstWord)
      : _rbFuzzyIncludes(heard, phrase.firstWord);
    if (matched) {
      _rbAdvanceTo(checkIdx, '"' + phrase.firstWord + '" (forward) from heard: ' + JSON.stringify(heard));
      return;
    }
  }

  // Nothing ahead matched. Before treating this as a possible restart,
  // check whether it's just re-confirming the trigger for the phrase
  // we're already on — Vosk fires both a "partial" and a "final" result
  // for the same utterance, so the current phrase's own trigger word
  // commonly gets heard again right as the singer starts the next word.
  // (This check intentionally runs AFTER forward search, not before —
  // otherwise a partial transcript containing both the current word and
  // the start of the next one would get stopped here before forward
  // search ever got a chance to see it.)
  if (rbCurrentIdx >= 0 && rbPhrases[rbCurrentIdx]) {
    const curTrig = rbPhrases[rbCurrentIdx].firstWord;
    if (curTrig && _rbFuzzyIncludes(heard, curTrig)) {
      return; // already on this phrase — nothing to do
    }
  }

  // Reaching here means something OTHER than the current phrase's own
  // trigger was heard — the singer has genuinely moved on to something
  // new, even if we don't yet know exactly what. Mark the moment this
  // was first noticed; this is what the lyric-order fallback below
  // waits from, so it reacts to the ONSET of new singing rather than
  // waiting near the full length of time it takes to sing a word.
  if (!rbFirstNewSoundTime) rbFirstNewSoundTime = Date.now();

  // Per the intended design, the song should
  // never jump back to an arbitrary earlier chunk mid-song — restart is
  // ONLY reachable once the singer has actually reached the end of the
  // song (the last phrase), never from the middle. Real singing doesn't
  // jump back to the beginning partway through; it only starts over
  // after the whole song (or verse) has been completed.
  //
  // This check also deliberately uses EXACT match (or a true homophone)
  // only — not the looser edit-distance fuzzy matching used elsewhere.
  // Restarting the whole song is a much bigger, more disruptive action
  // than moving forward one phrase, so it needs a much higher bar to
  // fire. Confirmed real case: "year" (an unrelated word that showed up
  // in a garbled transcription of "incline") is only 1 letter different
  // from "hear", which was enough to pass the normal fuzzy tolerance
  // and trigger an accidental restart.
  if (rbCurrentIdx === rbPhrases.length - 1 && rbPhrases.length > 0) {
    const firstPhrase = rbPhrases[0];
    const firstTrig = firstPhrase.trigger ? firstPhrase.firstWord : null;
    const exactRestartMatch = firstTrig && heard.some(w =>
      w === firstTrig || (RB_HOMOPHONE_MAP[w] && RB_HOMOPHONE_MAP[w].has(firstTrig)));
    if (exactRestartMatch) {
      _rbAdvanceTo(0, 'song restart ("' + firstPhrase.firstWord + '") — back to the top.');
      return;
    }
  }

  // Fallback for expected words that keep failing to match by spelling
  // no matter how long the singer keeps going. Originally built around
  // counting failed attempts, but that's the wrong model — a real
  // singer doesn't deliberately repeat a word hoping for a trigger,
  // they just keep singing forward once, continuously. Counting
  // discrete "attempts" depends on how often Vosk happens to fire
  // partial results, which has nothing to do with the singer's actual
  // behavior. Elapsed TIME is the right signal instead — but critically,
  // time since NEW singing was first noticed (rbFirstNewSoundTime), not
  // time since the current phrase started playing. Waiting from
  // phrase-start meant the fallback fired only once an elongated word
  // was nearly finished being sung — which sounded late, like the music
  // was chasing the singer instead of following them. A real
  // accompanist reacts the moment they hear the singer START the next
  // line, not after they finish it — so this now waits only a short
  // moment after the FIRST sign of new vocalization, not a long window
  // from the start of the current phrase.
  //
  // The deeper cause this addresses: singing — especially slow/rubato
  // style — elongates and sustains a word over a held pitch, stretching
  // it far beyond the acoustic pattern any speech engine expects,
  // whether the word is short or long. Speaking the same word quickly
  // and clearly recognizes fine; singing/holding it is what breaks
  // recognition, confirmed directly by Kenneth via live A/B testing.
  //
  // Short words (<=3 letters) get a shorter wait, since fuzzy matching
  // genuinely can't help them regardless of cause. Longer words get a
  // slightly longer window first, since normal/extended fuzzy matching
  // does often succeed for them — but both waits are now short (under a
  // second) since they're measured from the onset of new singing, not
  // from the whole phrase's start — similar in spirit to how Armor
  // Bearer advances based on the singer having started something new,
  // not on recognizing specific notes.
  const nextPhrase = rbPhrases[startSearch];
  if (nextPhrase && nextPhrase.trigger && heard.some(w => w.length >= 2) && rbFirstNewSoundTime) {
    const isShortWord = nextPhrase.firstWord.length <= 3;
    const waitMs = isShortWord ? 350 : 600;
    const elapsedMs = Date.now() - rbFirstNewSoundTime;
    if (elapsedMs >= waitMs) {
      console.log('[Rubato] Expected word "' + nextPhrase.firstWord + '" not matching '
        + Math.round(elapsedMs) + 'ms after new singing began (heard: ' + JSON.stringify(heard) + ') — trusting lyric order, advancing anyway.');
      _rbAdvanceTo(startSearch, '(lyric-order fallback) "' + nextPhrase.firstWord + '"');
      return;
    }
  }

  const nextIdx = rbPhrases.findIndex((p, i) => i > rbCurrentIdx && p.trigger);
  console.log('[Rubato] No trigger match. Heard:', heard,
    '| expected next trigger:', nextIdx >= 0 ? rbPhrases[nextIdx].firstWord : '(none — end of song, waiting for restart)');
}

// ── Manual Controls ────────────────────────────────────────────
function rbManualNext() {
  const next = rbCurrentIdx + 1;
  if (next >= rbPhrases.length) return;
  // Find next phrase that has a trigger
  for (let i = next; i < rbPhrases.length; i++) {
    if (rbPhrases[i].trigger) { rbPlayChunk(i); return; }
  }
}

function rbManualPrev() {
  const prev = rbCurrentIdx - 1;
  if (prev < 0) return;
  for (let i = prev; i >= 0; i--) {
    if (rbPhrases[i].trigger) { rbPlayChunk(i); return; }
  }
}

function rbToggleManualMode() {
  rbManualMode = !rbManualMode;
  // Stop listening if switching to manual mode
  if (rbManualMode && rbListening) rbStopListening();
  renderRubatoCard();
}

function rbManualTrigger(idx) {
  rbPlayChunk(idx);
  // Song Map stays open — rbSongMapOpen is not changed here
}

function rbReset() {
  rbStopCurrent();
  rbCurrentIdx = -1;
  rbLeadInPlayed = false; // a full reset is the one legitimate reason to allow the intro again
  rbCurrentPhraseStartTime = Date.now();
  rbFirstNewSoundTime = 0;
  renderRubatoCard();
}

// ── Render ─────────────────────────────────────────────────────
function renderRubatoCard() {
  const wrap = document.getElementById('rbWrap');
  if (!wrap) return;

  const keyName    = rbGetKeyName();
  const hasChunks  = Object.keys(rbChunkFiles).length > 0;
  const hasLyrics  = rbPhrases.length > 0;
  const ready      = (hasChunks && hasLyrics) || rbPackLoaded;

  // Phrase display — previous, current, next, coming up
  const prevPhrase = rbCurrentIdx > 0 ? rbPhrases[rbCurrentIdx - 1] : null;
  const curPhrase  = rbCurrentIdx >= 0 ? rbPhrases[rbCurrentIdx] : null;
  const nextPhrase = rbCurrentIdx + 1 < rbPhrases.length ? rbPhrases[rbCurrentIdx + 1] : null;
  const upcoming   = rbCurrentIdx + 2 < rbPhrases.length ? rbPhrases[rbCurrentIdx + 2] : null;

  // Find next actionable phrase (one with a trigger)
  let nextTriggerIdx = -1;
  for (let i = rbCurrentIdx + 1; i < rbPhrases.length; i++) {
    if (rbPhrases[i].trigger) { nextTriggerIdx = i; break; }
  }

  const btnStyle = `font-family:'Outfit',sans-serif;font-size:.7rem;font-weight:600;
    padding:.25rem .55rem;border-radius:6px;cursor:pointer;transition:all .15s;`;

  // Reverb FX panel
  const hallActive  = rbReverbType === 'hall';
  const plateActive = rbReverbType === 'plate';
  const fxPanel = `
    <div style="margin-top:.5rem;">
      <button onclick="rbFxOpen=!rbFxOpen;renderRubatoCard();"
        style="${btnStyle}border:1px solid ${rbFxOpen ? 'rgba(255,136,68,.5)' : 'var(--border)'};
               background:${rbFxOpen ? 'rgba(255,136,68,.1)' : 'none'};
               color:${rbFxOpen ? '#FF8844' : 'var(--text-dim)'};">
        FX ${rbFxOpen ? '▾' : '▸'}
      </button>
    </div>
    ${rbFxOpen ? `
    <div style="margin-top:.35rem;padding:.4rem .55rem;border-radius:7px;
                border:1px solid rgba(255,136,68,.18);background:rgba(255,136,68,.04);
                display:flex;flex-direction:column;gap:.35rem;">
      <div style="display:flex;align-items:center;gap:.4rem;">
        <span style="font-size:.65rem;color:var(--text-dim);min-width:50px;">Reverb</span>
        <button onclick="rbSetReverbType(rbReverbType==='hall'?'none':'hall')"
          style="${btnStyle}border:1px solid ${hallActive ? '#7eb8d4' : 'var(--border)'};
                 background:${hallActive ? 'rgba(126,184,212,.25)' : 'none'};
                 color:${hallActive ? '#7eb8d4' : 'var(--text-dim)'};">Hall</button>
        <button onclick="rbSetReverbType(rbReverbType==='plate'?'none':'plate')"
          style="${btnStyle}border:1px solid ${plateActive ? '#d4a07e' : 'var(--border)'};
                 background:${plateActive ? 'rgba(212,160,126,.25)' : 'none'};
                 color:${plateActive ? '#d4a07e' : 'var(--text-dim)'};">Plate</button>
        <span style="font-size:.6rem;color:var(--text-dim);">${rbReverbType === 'none' ? '— off' : ''}</span>
      </div>
      ${rbReverbType !== 'none' ? `
      <div style="display:flex;align-items:center;gap:.5rem;">
        <span style="font-size:.65rem;color:var(--text-dim);min-width:50px;">Amount</span>
        <input type="range" min="0" max="100" value="${rbReverbAmount}" step="1"
          style="-webkit-appearance:none;flex:1;height:3px;border-radius:2px;background:var(--bg-primary);"
          oninput="rbSetReverbAmount(this.value)">
        <span id="rbRevAmtVal"
          style="font-family:'Space Mono',monospace;font-size:.65rem;color:var(--text-dim);min-width:30px;text-align:right;">
          ${rbReverbAmount}%
        </span>
      </div>` : ''}
    </div>` : ''}
  `;

  wrap.innerHTML = `

    ${rbPackLoaded ? `
    <!-- Song Pack Info Banner -->
    <div style="display:flex;align-items:center;gap:.75rem;padding:.6rem .75rem;
                background:linear-gradient(135deg,rgba(249,115,22,.08),rgba(251,191,36,.05));
                border:1px solid rgba(249,115,22,.2);border-radius:8px;margin-bottom:.75rem;">
      ${rbArtistPhoto ? `
      <img src="${rbArtistPhoto}" alt="${rbArtistName}"
        style="width:38px;height:38px;border-radius:50%;object-fit:cover;
               border:2px solid rgba(249,115,22,.4);flex-shrink:0;">` : `
      <div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--orange),var(--gold));
                  display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0;">🎹</div>`}
      <div style="flex:1;min-width:0;">
        <div style="font-size:.95rem;font-weight:700;color:var(--text-primary);
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${rbSongTitle}</div>
        <div style="font-size:.65rem;color:var(--text-dim);text-transform:uppercase;
                    letter-spacing:.08em;">${rbArtistRole} &nbsp;·&nbsp; ${rbArtistName}</div>
      </div>
      <button onclick="rbLoadRubatoBundle()"
        style="${btnStyle}border:1px solid var(--border);background:none;
               color:var(--text-dim);font-size:.65rem;">↺ Change</button>
    </div>` : ''}

    <!-- Setup row -->
    <div style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-start;margin-bottom:.75rem;">

      <!-- Load Song — single button loads .vwbrs bundle (pack + MIDI in one file) -->
      <div style="display:flex;flex-direction:column;gap:.25rem;">
        <span style="font-size:.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;">Song</span>
        <button onclick="rbLoadRubatoBundle()"
          style="${btnStyle}border:1px solid ${rbPackLoaded ? 'var(--orange)' : 'var(--border)'};
                 background:${rbPackLoaded ? 'rgba(249,115,22,.1)' : 'none'};
                 color:${rbPackLoaded ? 'var(--orange)' : 'var(--text-dim)'};">
          ${rbPackLoaded
            ? '✓ ' + rbPhrases.length + ' phrases' + (rbPackMidiBuffer ? ' + MIDI' : ' (no MIDI)')
            : '🎵 Load Song (.vwbrs)'}
        </button>
      </div>

      <!-- Key / Transpose -->
      <div style="display:flex;flex-direction:column;gap:.25rem;">
        <span style="font-size:.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;">Key
          ${rbPitchLocked ? '<span style="color:#44dd88;font-size:.6rem;margin-left:.3rem;">🎵 Auto</span>' : ''}
        </span>
        <div style="display:flex;align-items:center;gap:.3rem;">
          <button onclick="rbSetTranspose(-1)"
            style="${btnStyle}border:1px solid var(--border);background:none;color:var(--text-dim);padding:.2rem .4rem;">−</button>
          <span style="font-family:'Space Mono',monospace;font-size:.9rem;font-weight:700;
                       color:${rbPitchLocked ? '#44dd88' : 'var(--orange)'};min-width:28px;text-align:center;">${keyName}</span>
          <button onclick="rbSetTranspose(1)"
            style="${btnStyle}border:1px solid var(--border);background:none;color:var(--text-dim);padding:.2rem .4rem;">+</button>
          ${rbPitchLocked ? `<button onclick="rbResetKeyDetection()" title="Reset key detection"
            style="${btnStyle}border:1px solid rgba(68,221,136,.3);background:none;color:#44dd88;padding:.2rem .35rem;font-size:.65rem;">↺</button>` : ''}
        </div>
      </div>

      <!-- Octave -->
      <div style="display:flex;flex-direction:column;gap:.25rem;">
        <span style="font-size:.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;">Octave</span>
        <div style="display:flex;align-items:center;gap:.3rem;">
          <button onclick="rbSetOctave(-1)"
            style="${btnStyle}border:1px solid var(--border);background:none;color:var(--text-dim);padding:.2rem .4rem;">−</button>
          <span style="font-family:'Space Mono',monospace;font-size:.9rem;font-weight:700;
                       color:var(--text-secondary);min-width:22px;text-align:center;">
            ${rbOctave === 0 ? '0' : (rbOctave > 0 ? '+' + rbOctave : rbOctave)}
          </span>
          <button onclick="rbSetOctave(1)"
            style="${btnStyle}border:1px solid var(--border);background:none;color:var(--text-dim);padding:.2rem .4rem;">+</button>
        </div>
      </div>

      <!-- Confidence -->
      <div style="display:flex;flex-direction:column;gap:.25rem;min-width:120px;">
        <span style="font-size:.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;">
          Confidence
        </span>
        <div style="display:flex;align-items:center;gap:.4rem;">
          <span style="font-size:.6rem;color:var(--text-dim);">Low</span>
          <input type="range" min="0.1" max="0.8" step="0.05" value="${rbConfidence}"
            style="-webkit-appearance:none;width:80px;height:3px;border-radius:2px;background:var(--bg-primary);"
            oninput="rbConfidence=parseFloat(this.value);document.getElementById('rbConfVal').textContent=Math.round(this.value*100)+'%'">
          <span style="font-size:.6rem;color:var(--text-dim);">High</span>
          <span id="rbConfVal"
            style="font-family:'Space Mono',monospace;font-size:.65rem;color:var(--text-dim);">
            ${Math.round(rbConfidence * 100)}%
          </span>
        </div>
      </div>

      <!-- Microphone Input Selector -->
      <div style="display:flex;flex-direction:column;gap:.25rem;min-width:160px;">
        <span style="font-size:.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;">
          Mic Input
        </span>
        <div style="display:flex;align-items:center;gap:.3rem;">
          <select id="rbMicSelect"
            onchange="rbSetMicDevice(this.value, this.options[this.selectedIndex].text)"
            style="flex:1;background:var(--bg-primary);border:1px solid var(--border);
                   color:var(--text-primary);padding:.18rem .35rem;border-radius:5px;
                   font-size:.65rem;font-family:'Outfit',sans-serif;">
            <option value="">${rbMicLabel || 'Default Mic'}</option>
          </select>
          <button onclick="rbPopulateMicDevices('rbMicSelect')"
            title="Refresh microphone list"
            style="${btnStyle}border:1px solid var(--border);background:none;
                   color:var(--text-dim);padding:.18rem .4rem;font-size:.75rem;">
            ↻
          </button>
        </div>
      </div>

    </div>

    <!-- FX Panel -->
    ${fxPanel}

    ${ready ? `
    <!-- Live Performance Area -->
    <div style="margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--border);">

      <!-- Transport controls -->
      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem;flex-wrap:wrap;">

        <!-- Listen for Words button -->
        <button onclick="rbManualMode=false;rbStartListening()"
          title="${rbListening ? 'Stop word listening' : 'Start voice listening — triggers MIDI chunks from sung words'}"
          style="${btnStyle}
                 border:1px solid ${rbListening ? '#44cc88' : 'var(--border)'};
                 background:${rbListening ? 'rgba(68,204,136,.15)' : 'none'};
                 color:${rbListening ? '#44cc88' : 'var(--text-dim)'};
                 ${rbListening ? 'box-shadow:0 0 8px rgba(68,204,136,.3);' : ''}">
          ${rbListening ? '🎙 Listening…' : '🎙 Listen'}
        </button>

        <!-- Manual mode button — click phrases to trigger instead of voice -->
        <button onclick="rbToggleManualMode()"
          title="${rbManualMode ? 'Switch back to voice-triggered mode' : 'Manual mode — click any phrase in the Song Map to trigger it'}"
          style="${btnStyle}
                 border:1px solid ${rbManualMode ? 'var(--orange)' : 'var(--border)'};
                 background:${rbManualMode ? 'rgba(255,136,68,.15)' : 'none'};
                 color:${rbManualMode ? 'var(--orange)' : 'var(--text-dim)'};
                 ${rbManualMode ? 'box-shadow:0 0 8px rgba(255,136,68,.2);' : ''}">
          ${rbManualMode ? '👆 Manual' : '👆 Manual'}
        </button>

        ${rbManualMode && rbVwbPack && rbVwbPack.leadIn ? `
        <!-- Play Intro button — Manual mode only, one-shot per session -->
        <button onclick="_rbPlayLeadIn()"
          ${rbLeadInPlayed ? 'disabled' : ''}
          title="${rbLeadInPlayed ? 'Intro already played — click Reset to play it again' : 'Play the instrumental intro'}"
          style="${btnStyle}
                 border:1px solid ${rbLeadInPlayed ? 'var(--border)' : 'var(--accent)'};
                 background:none;
                 color:${rbLeadInPlayed ? 'var(--text-dim)' : 'var(--accent)'};
                 opacity:${rbLeadInPlayed ? '.5' : '1'};
                 cursor:${rbLeadInPlayed ? 'default' : 'pointer'};">
          ${rbLeadInPlayed ? '✓ Intro Played' : '🎬 Play Intro'}
        </button>` : ''}

        <!-- Detect Key button — separate from word listening -->
        <button onclick="${rbPitchLocked ? 'rbTryAgainKeyDetection()' : 'rbToggleKeyDetection()'}"
          title="${rbPitchLocked ? 'Key is locked — click to try again' : rbKeyDetecting ? 'Stop key detection' : 'Auto-detect key from sung melody'}"
          style="${btnStyle}
                 border:1px solid ${rbPitchLocked ? 'rgba(68,221,136,.4)' : rbKeyDetecting ? '#fbbf24' : 'var(--border)'};
                 background:${rbPitchLocked ? 'rgba(68,221,136,.08)' : rbKeyDetecting ? 'rgba(251,191,36,.12)' : 'none'};
                 color:${rbPitchLocked ? '#44dd88' : rbKeyDetecting ? '#fbbf24' : 'var(--text-dim)'};
                 ${rbKeyDetecting ? 'box-shadow:0 0 8px rgba(251,191,36,.2);' : ''}">
          ${rbPitchLocked ? '✓ Key Locked — Try Again?' : rbKeyDetecting ? '🎵 Detecting…' : '🎵 Detect Key'}
        </button>

        <button onclick="rbManualPrev()"
          title="Previous phrase"
          style="${btnStyle}border:1px solid var(--border);background:none;color:var(--text-dim);">◀ Prev</button>
        <button onclick="rbManualNext()"
          title="Trigger next phrase manually"
          style="${btnStyle}border:1px solid var(--border);background:none;color:var(--text-dim);">Next ▶</button>
        <button onclick="rbStopCurrent();renderRubatoCard();"
          style="${btnStyle}border:1px solid var(--border);background:none;color:var(--text-dim);">■ Stop</button>
        <button onclick="rbReset()"
          style="${btnStyle}border:1px solid var(--border);background:none;color:var(--text-dim);">↺ Reset</button>
        <span style="font-size:.65rem;color:var(--text-dim);margin-left:auto;">
          ${rbCurrentIdx >= 0 ? (rbCurrentIdx + 1) + ' / ' + rbPhrases.length : '—'}
        </span>
      </div>

      <!-- Phrase display -->
      <div style="display:flex;flex-direction:column;gap:.3rem;">

        ${prevPhrase ? `
        <!-- Just played -->
        <div style="padding:.35rem .6rem;border-radius:7px;background:var(--bg-secondary);
                    border:1px solid var(--border);opacity:.45;">
          <div style="font-size:.58rem;color:var(--text-dim);margin-bottom:.1rem;">✓ JUST PLAYED</div>
          <div style="font-size:.8rem;color:var(--text-dim);">${prevPhrase.line}</div>
        </div>` : ''}

        ${curPhrase ? `
        <!-- Now playing -->
        <div style="padding:.45rem .6rem;border-radius:7px;
                    background:${rbPlaying ? 'rgba(64,224,208,.1)' : 'rgba(170,68,255,.08)'};
                    border:2px solid ${rbPlaying ? 'var(--accent)' : 'rgba(170,68,255,.3)'};
                    box-shadow:${rbPlaying ? '0 0 12px rgba(64,224,208,.2)' : 'none'};">
          <div style="font-size:.58rem;color:${rbPlaying ? 'var(--accent)' : 'var(--text-dim)'};margin-bottom:.1rem;">
            ${rbPlaying ? '▶ NOW PLAYING' : '● CURRENT'}
          </div>
          <div style="font-size:.88rem;font-weight:600;color:var(--text-primary);">${curPhrase.line}</div>
          ${curPhrase.trigger ? `<div style="font-size:.6rem;color:var(--text-dim);margin-top:.15rem;">
            trigger: <span style="color:var(--orange);">${curPhrase.trigger}</span>
          </div>` : ''}
        </div>` : `
        <!-- No phrase playing yet -->
        <div style="padding:.6rem;border-radius:7px;background:var(--bg-secondary);
                    border:1px dashed var(--border);text-align:center;">
          <div style="font-size:.75rem;color:var(--text-dim);">
            Use Next ▶ or click Trigger to play each phrase
          </div>
        </div>`}

        ${nextTriggerIdx >= 0 ? `
        <!-- Up next — with manual trigger button -->
        <div style="padding:.4rem .6rem;border-radius:7px;background:rgba(255,136,68,.05);
                    border:1px solid rgba(255,136,68,.2);display:flex;align-items:center;gap:.5rem;">
          <div style="flex:1;">
            <div style="font-size:.58rem;color:#FF8844;margin-bottom:.1rem;">⏭ UP NEXT</div>
            <div style="font-size:.82rem;color:var(--text-secondary);">${rbPhrases[nextTriggerIdx].line}</div>
          </div>
          <button onclick="rbManualTrigger(${nextTriggerIdx})"
            title="Trigger this phrase now"
            style="${btnStyle}border:1px solid #FF8844;background:rgba(255,136,68,.15);
                   color:#FF8844;white-space:nowrap;padding:.3rem .55rem;">
            ▶ Trigger
          </button>
        </div>` : ''}

        ${upcoming ? `
        <!-- Coming up -->
        <div style="padding:.3rem .6rem;border-radius:7px;background:var(--bg-secondary);
                    border:1px solid var(--border);opacity:.6;">
          <div style="font-size:.58rem;color:var(--text-dim);margin-bottom:.05rem;">── COMING UP</div>
          <div style="font-size:.75rem;color:var(--text-dim);">${upcoming.line}</div>
        </div>` : ''}

      </div>

      <!-- Phrase list (scrollable) -->
      ${rbPhrases.length > 0 ? `
      <div style="margin-top:.6rem;">
        <button onclick="rbSongMapOpen=!rbSongMapOpen;renderRubatoCard();"
          style="${btnStyle}border:1px solid var(--border);background:none;color:var(--text-dim);font-size:.65rem;">
          Song Map ${rbSongMapOpen ? '▾' : '▸'}
        </button>
        ${rbSongMapOpen ? `
        <div style="margin-top:.35rem;max-height:220px;overflow-y:auto;
              border:1px solid var(--border);border-radius:6px;padding:.3rem;">
          ${rbPhrases.map((p, i) => `
            <div onclick="rbManualTrigger(${i})"
              style="display:flex;align-items:center;gap:.4rem;padding:.25rem .35rem;border-radius:4px;
                     cursor:pointer;
                     background:${i === rbCurrentIdx ? 'rgba(64,224,208,.1)' : rbManualMode ? 'rgba(255,136,68,.04)' : 'none'};
                     border-left:2px solid ${i === rbCurrentIdx ? 'var(--accent)' : rbManualMode && p.trigger ? 'rgba(255,136,68,.3)' : 'transparent'};
                     margin-bottom:.1rem;"
              title="${rbManualMode && p.trigger ? 'Click to trigger: ' + p.line : ''}">
              <span style="font-size:.6rem;color:var(--text-dim);min-width:20px;">${i+1}</span>
              <span style="font-size:.72rem;color:${i === rbCurrentIdx ? 'var(--text-primary)' : 'var(--text-dim)'};">${p.line}</span>
              ${p.trigger
                ? `<span style="font-size:.58rem;color:${rbManualMode ? 'var(--orange)' : 'var(--orange)'};margin-left:auto;">${rbManualMode ? '▶ ' : ''}${p.trigger}</span>`
                : `<span style="font-size:.58rem;color:var(--text-dim);margin-left:auto;font-style:italic;">no trigger</span>`}
            </div>`).join('')}
        </div>` : ''}
      </div>` : ''}
    </div>` : `
    <!-- Not ready state -->
    <div style="margin-top:.75rem;padding:.75rem;border-radius:8px;background:var(--bg-secondary);
                border:1px dashed var(--border);text-align:center;">
      <div style="font-size:.75rem;color:var(--text-dim);">
        ${!hasLyrics && !hasChunks ? 'Load lyrics and MIDI chunks above to get started' :
          !hasLyrics ? 'Load a lyrics text file to continue' :
          'Load MIDI chunk files to continue'}
      </div>
    </div>`}
  `;
}

// ── Session Save/Restore ───────────────────────────────────────
function getRubatoState() {
  return {
    transpose:    rbTranspose,
    octave:       rbOctave,
    confidence:   rbConfidence,
    reverbType:   rbReverbType,
    reverbAmount: rbReverbAmount
  };
}

function restoreRubatoState(state) {
  if (!state) return;
  rbTranspose    = state.transpose    || 0;
  rbOctave       = state.octave       || 0;
  rbConfidence   = state.confidence   || 0.35;
  rbReverbType   = state.reverbType   || 'none';
  rbReverbAmount = state.reverbAmount !== undefined ? state.reverbAmount : 30;
  renderRubatoCard();
}
