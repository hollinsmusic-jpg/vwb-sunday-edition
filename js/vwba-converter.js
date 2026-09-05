#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  VWB Arrangement Converter
//
//  Takes a standard Type 1 .mid file — recorded in the House Band
//  Training Data Standard track order (Piano, Organ, Aux Strings,
//  Guitar, Bass, Percussion, Drums) — validates the track count
//  AND the MIDI channel on each track, then packages it into a
//  .vwba arrangement file VWB can load.
//
//  Two independent checks, both must pass:
//    1. Track POSITION — the 1st track in the file is always Piano,
//       2nd is always Organ, etc. This is what VWB actually uses
//       to route sound at playback time.
//    2. Track CHANNEL — a belt-and-suspenders sanity check. Each
//       track's MIDI channel must match the expected channel for
//       its position (see CHANNEL_MAP below). This catches an
//       accidentally reordered track before a bad file ever
//       reaches VWB, instead of silently mis-routing.
//
//  USAGE
//    node vwba-converter.js --in "Total Praise.mid" \
//         --title "Total Praise" --key Eb --tempo 72 \
//         --timeSig 4/4 --style "Worship Ballad" --feel Straight
//
//  Optional:
//    --out FILENAME.vwba       (default: auto-built from title/key/tempo)
//    --notes "free text"
//    --force                   (skip the channel cross-check, position
//                                still enforced — use only if you didn't
//                                bother setting channels in Studio One)
//
//  Requires Node.js. No external dependencies.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const REQUIRED_TRACK_ORDER = ['piano', 'organ', 'auxStrings', 'guitar', 'bass', 'percussion', 'drums'];
const REQUIRED_TRACK_LABELS = ['Piano', 'Organ', 'Aux Strings', 'Guitar', 'Bass', 'Percussion', 'Drums'];
// Expected MIDI channel per track position, 0-indexed byte value
// (Studio One / most DAWs display these as channel + 1, i.e. 1-16).
const EXPECTED_CHANNEL = [0, 2, 4, 3, 1, 8, 9]; // Piano=1, Organ=3, AuxStrings=5, Guitar=4, Bass=2, Percussion=9, Drums=10 (as displayed)
const FORMAT_VERSION = 1;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function readVarLen(buf, pos) {
  let val = 0, p = pos;
  while (true) {
    const b = buf[p++];
    val = (val << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { val, pos: p };
}

// Full per-track walk: reads the MThd header, then walks every MTrk
// chunk to find which MIDI channel(s) each track's note events use.
// Needed for the channel cross-check — the header alone only gives
// us the track count.
function readMidiTracksInfo(buffer) {
  const hdrId = buffer.toString('ascii', 0, 4);
  if (hdrId !== 'MThd') {
    throw new Error('Not a valid MIDI file (missing MThd header). Make sure you exported a standard .mid file from Studio One.');
  }
  const hdrLen = buffer.readUInt32BE(4);
  const format = buffer.readUInt16BE(8);
  const numTracks = buffer.readUInt16BE(10);
  let pos = 8 + hdrLen;

  const tracks = [];
  for (let t = 0; t < numTracks; t++) {
    pos += 4; // 'MTrk'
    const trkLen = buffer.readUInt32BE(pos);
    pos += 4;
    const trkEnd = pos + trkLen;
    let runningStatus = 0;
    const channelCounts = {};
    let noteCount = 0;

    while (pos < trkEnd) {
      const dv = readVarLen(buffer, pos); pos = dv.pos; // delta time, unused here
      let statusByte = buffer[pos];
      if (statusByte & 0x80) {
        pos++;
        if (statusByte < 0xF0) runningStatus = statusByte;
      } else {
        statusByte = runningStatus;
      }
      const type = statusByte & 0xF0;
      const ch = statusByte & 0x0F;

      if (type === 0x90 || type === 0x80) {
        const note = buffer[pos++], vel = buffer[pos++];
        if (type === 0x90 && vel > 0) {
          channelCounts[ch] = (channelCounts[ch] || 0) + 1;
          noteCount++;
        }
      } else if (type === 0xA0 || type === 0xB0 || type === 0xE0) {
        pos += 2;
      } else if (type === 0xC0 || type === 0xD0) {
        pos += 1;
      } else if (statusByte === 0xFF) {
        pos++; // meta type
        const lv = readVarLen(buffer, pos); pos = lv.pos + lv.val;
      } else if (statusByte === 0xF0 || statusByte === 0xF7) {
        const lv = readVarLen(buffer, pos); pos = lv.pos + lv.val;
      } else {
        pos++;
      }
    }
    pos = trkEnd;

    // Primary channel = whichever channel had the most note-on events
    let primaryChannel = null, best = -1;
    Object.keys(channelCounts).forEach(ch => {
      if (channelCounts[ch] > best) { best = channelCounts[ch]; primaryChannel = Number(ch); }
    });

    tracks.push({ index: t, primaryChannel, noteCount, channelsUsed: Object.keys(channelCounts).map(Number) });
  }

  return { format, numTracks, tracks };
}

function slugify(s) {
  return String(s || '').replace(/[^a-zA-Z0-9]+/g, '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.in) {
    console.error('\nUsage:\n  node vwba-converter.js --in "SongName.mid" --title "Song Title" --key Eb --tempo 72 --timeSig 4/4 --style "Worship Ballad" --feel Straight\n');
    process.exit(1);
  }

  const inPath = path.resolve(args.in);
  if (!fs.existsSync(inPath)) {
    console.error('File not found: ' + inPath);
    process.exit(1);
  }

  const midBuffer = fs.readFileSync(inPath);

  let info;
  try {
    info = readMidiTracksInfo(midBuffer);
  } catch (e) {
    console.error('\n✗ ' + e.message + '\n');
    process.exit(1);
  }

  console.log('\nRead: ' + path.basename(inPath));
  console.log('  MIDI format: ' + info.format + '  |  Tracks: ' + info.numTracks);

  if (info.numTracks !== 7) {
    console.error('\n✗ REJECTED — this file has ' + info.numTracks + ' track(s). VWB Arrangements require exactly 7,');
    console.error('  in this order: ' + REQUIRED_TRACK_LABELS.join(' \u2192 '));
    console.error('  Re-export from Studio One using the standard House Band track layout and try again.\n');
    process.exit(1);
  }

  // ── Channel cross-check ────────────────────────────────────────
  console.log('\n  Track   Instrument     Notes   Channel (found / expected)');
  let channelMismatch = false;
  info.tracks.forEach((t, i) => {
    const expected = EXPECTED_CHANNEL[i];
    const found = t.primaryChannel;
    const ok = t.noteCount === 0 ? true : found === expected; // empty tracks can't mismatch
    if (!ok) channelMismatch = true;
    const flag = t.noteCount === 0 ? '(empty — ok)' : (ok ? 'OK' : '✗ MISMATCH');
    console.log(
      '  ' + String(i + 1).padEnd(8) +
      REQUIRED_TRACK_LABELS[i].padEnd(15) +
      String(t.noteCount).padEnd(8) +
      (found === null ? '—' : (found + 1)) + ' / ' + (expected + 1) + '   ' + flag
    );
  });

  if (channelMismatch && !args.force) {
    console.error('\n✗ REJECTED — one or more tracks are on the wrong MIDI channel (see table above).');
    console.error('  Track position looked correct, but the channel doesn\'t match what that position');
    console.error('  should be — that mismatch is exactly what this check exists to catch.');
    console.error('  Fix the channel assignments in Studio One and re-export, or re-run with --force');
    console.error('  to convert anyway using track position only (not recommended unless you\'re sure).\n');
    process.exit(1);
  }
  if (channelMismatch && args.force) {
    console.warn('\n  ⚠ Channel mismatch present but --force given — converting anyway using track position.\n');
  } else {
    console.log('\n  ✓ All track channels match their expected position.\n');
  }

  const title = args.title || path.basename(inPath, path.extname(inPath));
  const key = args.key || '';
  const tempo = args.tempo ? Number(args.tempo) : undefined;
  const timeSig = args.timeSig || '4/4';
  const style = args.style || '';
  const feel = args.feel || '';
  const notes = args.notes || '';

  if (!key) console.warn('  ⚠ No --key given — VWB will fall back to whatever key the MIDI file detects.');
  if (!tempo) console.warn('  ⚠ No --tempo given — VWB will fall back to whatever tempo the MIDI file detects.');

  const vwba = {
    format: 'vwb-arrangement',
    formatVersion: FORMAT_VERSION,
    meta: { title, key, tempo, timeSig, style, feel, notes, createdDate: new Date().toISOString().slice(0, 10) },
    trackMap: REQUIRED_TRACK_ORDER.map((instrument, i) => ({ track: i + 1, instrument })),
    sections: [],
    midiData: midBuffer.toString('base64')
  };

  const defaultOutName = 'ARR_' + slugify(title) + (key ? '_' + slugify(key) : '') + (tempo ? '_' + String(tempo).padStart(3, '0') : '') + '.vwba';
  const outName = args.out || defaultOutName;
  const outPath = path.resolve(outName);

  fs.writeFileSync(outPath, JSON.stringify(vwba, null, 2), 'utf8');

  console.log('✓ Wrote ' + outPath);
  console.log('  Title: ' + title + (key ? '  |  Key: ' + key : '') + (tempo ? '  |  Tempo: ' + tempo + ' BPM' : ''));
  console.log('  Ready to load into VWB via the Add Flex File button.\n');
}

main();
