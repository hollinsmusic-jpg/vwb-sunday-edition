#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  VWB MIDI Channel Fixer v2
//  - Assigns correct MIDI channel to each track by position
//  - Injects program change events for all 7 musicians
//  - Remaps non-standard drum notes to GM standard
//
//  USAGE:
//    node vwb-midi-fix-v2.js "Thank You Lord.mid"
//
//  OUTPUT:
//    Creates "Thank You Lord_VWB.mid" — load this into VWB.
//    Your original file is never touched.
// ═══════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

// ── Channel map: track index (0-based) → MIDI channel (0-based)
const TRACK_TO_CHANNEL = [
  9,   // Track 1 → Jason  (Drums)      — MIDI ch 10
  8,   // Track 2 → Diane  (Percussion) — MIDI ch 9
  1,   // Track 3 → Terry  (Bass)       — MIDI ch 2
  0,   // Track 4 → Julian (Keys)       — MIDI ch 1
  2,   // Track 5 → Paul   (Organ)      — MIDI ch 3
  3,   // Track 6 → Sanchez(Guitar)     — MIDI ch 4
  4,   // Track 7 → Larry  (Aux)        — MIDI ch 5
];

// ── Program map: track index → GM program number (0-based)
// These tell VWB which instrument sound to use for each musician
const TRACK_TO_PROGRAM = [
  null,  // Drums  — no program change needed (ch 10 = always drums)
  null,  // Diane  — custom perc kit (program 200, handled by house-band-engine)
  33,    // Terry  — Electric Bass (finger) — GM program 34, 0-based = 33
  0,     // Julian — Acoustic Grand Piano   — GM program 1,  0-based = 0
  16,    // Paul   — Drawbar Organ          — GM program 17, 0-based = 16
  27,    // Sanchez— Electric Guitar clean  — GM program 28, 0-based = 27
  48,    // Larry  — Strings                — GM program 49, 0-based = 48
];

const TRACK_NAMES = [
  'Jason Washington  — Drums',
  'Diane Moore       — Percussion',
  'Terry Washington  — Bass',
  'Julian Cross      — Keys',
  'Paul Simmons      — Organ',
  'Sanchez Rivera    — Guitar',
  'Larry Evans       — Aux',
];

// ── Percussion note shift ──────────────────────────────────────
// Impact XT triggers Diane's samples one octave higher than VWB expects.
// Shift all percussion track notes down by 12 semitones automatically.
const PERC_NOTE_SHIFT = -12;

// ── MIDI utilities ─────────────────────────────────────────────

function readUint32(buf, pos) {
  return ((buf[pos] << 24) | (buf[pos+1] << 16) | (buf[pos+2] << 8) | buf[pos+3]) >>> 0;
}
function readUint16(buf, pos) {
  return (buf[pos] << 8) | buf[pos+1];
}
function writeUint16(buf, pos, val) {
  buf[pos] = (val >> 8) & 0xFF; buf[pos+1] = val & 0xFF;
}
function writeUint32(buf, pos, val) {
  buf[pos]   = (val >> 24) & 0xFF; buf[pos+1] = (val >> 16) & 0xFF;
  buf[pos+2] = (val >> 8)  & 0xFF; buf[pos+3] = val & 0xFF;
}
function readVLQ(buf, pos) {
  let value = 0, bytesRead = 0, byte;
  do { byte = buf[pos + bytesRead]; value = (value << 7) | (byte & 0x7F); bytesRead++; }
  while (byte & 0x80);
  return { value, bytesRead };
}
function writeVLQ(arr, val) {
  if (val < 0x80) { arr.push(val); return; }
  const bytes = [];
  while (val > 0) { bytes.unshift(val & 0x7F); val >>= 7; }
  for (let i = 0; i < bytes.length - 1; i++) arr.push(bytes[i] | 0x80);
  arr.push(bytes[bytes.length - 1]);
}

// ── Drum note remapping ────────────────────────────────────────
// Maps non-standard drum notes from your electric kit → GM standard
const DRUM_NOTE_REMAP = {
  33: 36,  // Your kick → GM Kick (Bass Drum 1)
  32: 36,  // Alt kick  → GM Kick
  34: 36,  // Alt kick  → GM Kick
};

// ── Track rewriter ─────────────────────────────────────────────
// Rewrites channel events, remaps drum notes, shifts perc notes

function rewriteTrack(trackData, targetCh, programNum, isDrumTrack, isPercTrack) {
  const output = [];
  let pos = 0;
  let runningStatus = 0;

  // Inject program change at time 0 if needed
  if (programNum !== null && programNum !== undefined) {
    writeVLQ(output, 0);                          // delta = 0
    output.push(0xC0 | (targetCh & 0x0F));        // program change status
    output.push(programNum & 0x7F);               // program number
    console.log('    → Program change: ' + programNum + ' injected');
  }

  while (pos < trackData.length) {
    const delta = readVLQ(trackData, pos);
    pos += delta.bytesRead;
    writeVLQ(output, delta.value);

    const byte = trackData[pos];

    // Meta event — copy as-is
    if (byte === 0xFF) {
      output.push(trackData[pos++]);
      const type = trackData[pos++]; output.push(type);
      const lenVLQ = readVLQ(trackData, pos); pos += lenVLQ.bytesRead;
      writeVLQ(output, lenVLQ.value);
      for (let i = 0; i < lenVLQ.value; i++) output.push(trackData[pos++]);
      runningStatus = 0; continue;
    }
    // SysEx — copy as-is
    if (byte === 0xF0 || byte === 0xF7) {
      output.push(trackData[pos++]);
      const lenVLQ = readVLQ(trackData, pos); pos += lenVLQ.bytesRead;
      writeVLQ(output, lenVLQ.value);
      for (let i = 0; i < lenVLQ.value; i++) output.push(trackData[pos++]);
      runningStatus = 0; continue;
    }

    // Channel event
    if (byte & 0x80) { runningStatus = byte; pos++; }

    const statusType = runningStatus & 0xF0;
    const newStatus  = statusType | (targetCh & 0x0F);
    output.push(newStatus);

    let dataBytes = 0;
    if      (statusType === 0x80 || statusType === 0x90 ||
             statusType === 0xA0 || statusType === 0xB0 ||
             statusType === 0xE0) dataBytes = 2;
    else if (statusType === 0xC0 || statusType === 0xD0) dataBytes = 1;

    if (isDrumTrack && (statusType === 0x90 || statusType === 0x80) && dataBytes === 2) {
      let note = trackData[pos];
      const vel  = trackData[pos+1];
      // Remap non-standard drum notes to GM standard
      if (DRUM_NOTE_REMAP[note]) note = DRUM_NOTE_REMAP[note];
      output.push(note);
      output.push(vel);
      pos += 2;
    } else if (isPercTrack && (statusType === 0x90 || statusType === 0x80) && dataBytes === 2) {
      let note = trackData[pos];
      const vel  = trackData[pos+1];
      // Shift percussion notes down one octave to match Diane's note map
      note = Math.max(0, Math.min(127, note + PERC_NOTE_SHIFT));
      output.push(note);
      output.push(vel);
      pos += 2;
    } else {
      for (let i = 0; i < dataBytes; i++) output.push(trackData[pos++]);
    }
  }

  return Buffer.from(output);
}

// ── Meta-only track detector ───────────────────────────────────
function _isMetaOnlyTrack(trackData) {
  let pos = 0;
  while (pos < trackData.length) {
    const delta = readVLQ(trackData, pos); pos += delta.bytesRead;
    const byte = trackData[pos];
    if (byte !== 0xFF) return false;
    pos++;
    pos++;
    const lenVLQ = readVLQ(trackData, pos); pos += lenVLQ.bytesRead + lenVLQ.value;
  }
  return true;
}

// ── Main ───────────────────────────────────────────────────────

function fixMidi(inputPath) {
  if (!fs.existsSync(inputPath)) {
    console.error('❌  File not found:', inputPath); process.exit(1);
  }

  const buf = fs.readFileSync(inputPath);
  if (buf.toString('ascii', 0, 4) !== 'MThd') {
    console.error('❌  Not a valid MIDI file'); process.exit(1);
  }

  const format    = readUint16(buf, 8);
  const numTracks = readUint16(buf, 10);
  const timingDiv = readUint16(buf, 12);

  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  VWB MIDI Channel Fixer v2');
  console.log('══════════════════════════════════════════');
  console.log('  File:   ', path.basename(inputPath));
  console.log('  Format: ', format === 0 ? 'Type 0 (merged)' : 'Type 1 (multi-track)');
  console.log('  Tracks: ', numTracks);
  console.log('');

  const outputChunks = [];

  // Copy header, force Type 1
  const headerChunk = Buffer.alloc(14);
  buf.copy(headerChunk, 0, 0, 14);
  if (format === 0) writeUint16(headerChunk, 8, 1);
  outputChunks.push(headerChunk);

  let pos = 14, trackIndex = 0, tracksProcessed = 0;

  while (pos < buf.length) {
    const chunkTag = buf.toString('ascii', pos, pos + 4);
    const chunkLen = readUint32(buf, pos + 4);

    if (chunkTag !== 'MTrk') {
      outputChunks.push(buf.slice(pos, pos + 8 + chunkLen));
      pos += 8 + chunkLen; continue;
    }

    const trackData   = buf.slice(pos + 8, pos + 8 + chunkLen);
    const isTempoTrack = (format === 1 && trackIndex === 0 && _isMetaOnlyTrack(trackData));
    let newTrackData;

    if (isTempoTrack) {
      console.log('  Track 0: Tempo track — copied as-is');
      newTrackData = trackData;
    } else {
      const musicianIdx = tracksProcessed;
      const targetCh    = musicianIdx < TRACK_TO_CHANNEL.length
        ? TRACK_TO_CHANNEL[musicianIdx] : (musicianIdx % 16);
      const programNum  = musicianIdx < TRACK_TO_PROGRAM.length
        ? TRACK_TO_PROGRAM[musicianIdx] : null;
      const isDrumTrack = targetCh === 9;   // Jason — GM drums
      const isPercTrack = targetCh === 8;   // Diane — custom perc kit
      const name        = TRACK_NAMES[musicianIdx] || ('Track ' + (musicianIdx + 1));
      const chDisplay   = targetCh + 1;

      console.log('  Track ' + trackIndex + ': ' + name + ' → Channel ' + chDisplay + ' ✓');
      newTrackData = rewriteTrack(trackData, targetCh, programNum, isDrumTrack, isPercTrack);
      tracksProcessed++;
    }

    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write('MTrk', 0, 'ascii');
    writeUint32(chunkHeader, 4, newTrackData.length);
    outputChunks.push(chunkHeader);
    outputChunks.push(newTrackData);

    pos += 8 + chunkLen;
    trackIndex++;
  }

  const ext        = path.extname(inputPath);
  const base       = path.basename(inputPath, ext);
  const dir        = path.dirname(inputPath);
  const outputPath = path.join(dir, base + '_VWB' + ext);

  fs.writeFileSync(outputPath, Buffer.concat(outputChunks));

  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  ✅  Done!');
  console.log('  Output: ' + path.basename(outputPath));
  console.log('  Load this file into VWB.');
  console.log('══════════════════════════════════════════');
  console.log('');
}

const inputFile = process.argv[2];
if (!inputFile) {
  console.log('Usage: node vwb-midi-fix-v2.js "your-song.mid"');
  process.exit(0);
}
fixMidi(path.resolve(inputFile));
