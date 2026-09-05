#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  VWB Sample Downloader
//  Run once during development: node download-samples.js
//  Downloads .mp3 files for all 12 VWB instruments into
//  app/samples/<instrument_name>/
//
//  Total size: ~35-40 MB
//  After running, commit the app/samples/ folder — it ships
//  inside the Electron installer and works fully offline.
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE_URL  = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM';
const OUT_DIR   = path.join(__dirname, 'app', 'samples');

// ── Same 12 instruments as midi-synth.js ───────────────────────
const INSTRUMENTS = [
  {
    sf: 'acoustic_grand_piano',
    notes: ['A0','C1','Ds1','Fs1','A1','C2','Ds2','Fs2','A2',
            'C3','Ds3','Fs3','A3','C4','Ds4','Fs4','A4',
            'C5','Ds5','Fs5','A5','C6','Ds6','Fs6','A6',
            'C7','Ds7','Fs7','A7','C8']
  },
  {
    sf: 'electric_piano_1',
    notes: ['A1','C2','Ds2','Fs2','A2','C3','Ds3','Fs3',
            'A3','C4','Ds4','Fs4','A4','C5','Ds5','Fs5','A5','C6','Ds6','Fs6','A6']
  },
  {
    sf: 'drawbar_organ',
    notes: ['C2','C3','C4','C5','C6']
  },
  {
    sf: 'acoustic_guitar_nylon',
    notes: ['Fs2','B2','E3','A3','D4','G4','B4','E5']
  },
  {
    sf: 'electric_guitar_clean',
    notes: ['Fs2','B2','E3','A3','D4','G4','B4','E5']
  },
  {
    sf: 'electric_bass_finger',
    notes: ['E1','A1','D2','G2','B2','E3']
  },
  {
    sf: 'string_ensemble_1',
    notes: ['C2','Ds2','Fs2','A2','C3','Ds3','Fs3','A3',
            'C4','Ds4','Fs4','A4','C5','Ds5','Fs5','A5','C6']
  },
  {
    sf: 'brass_section',
    notes: ['As2','D3','F3','As3','D4','F4','As4','D5','F5']
  },
  {
    sf: 'pad_1_new_age',
    notes: ['C2','C3','C4','C5','C6']
  },
  {
    sf: 'pad_2_warm',
    notes: ['C2','C3','C4','C5','C6']
  },
  {
    sf: 'glockenspiel',
    notes: ['G5','A5','B5','C6','D6','E6','F6','G6']
  },
  {
    sf: 'percussion',
    notes: ['C2','D2','E2','F2','G2','A2','B2',
            'C3','D3','E3','F3','G3','A3','B3',
            'C4','D4','E4','F4','G4','A4']
  },
];

// ── Helpers ────────────────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) { resolve('skip'); return; }
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve('ok'); });
    }).on('error', e => {
      fs.existsSync(dest) && fs.unlinkSync(dest);
      reject(e);
    });
  });
}

// Gleitz repo uses 'Ds' for D# and 'Fs' for F# in filenames
// Tone.js uses 'D#4' and 'F#4' in note names
// We store files with Gleitz names, and the midi-synth.js
// _sampleUrl() function translates Tone note names to filenames.
function toneNoteToFilename(note) {
  // 'D#4' → 'Ds4', 'F#5' → 'Fs5', 'A#3' → 'As3'
  return note.replace('#', 's');
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let total = 0, skipped = 0, failed = 0;

  for (const inst of INSTRUMENTS) {
    const dir = path.join(OUT_DIR, inst.sf);
    fs.mkdirSync(dir, { recursive: true });
    process.stdout.write(`\n  ${inst.sf}  `);

    for (const note of inst.notes) {
      const filename = toneNoteToFilename(note) + '.mp3';
      const url  = `${BASE_URL}/${inst.sf}-mp3/${filename}`;
      const dest = path.join(dir, filename);
      try {
        const result = await download(url, dest);
        process.stdout.write(result === 'skip' ? '·' : '✓');
        result === 'skip' ? skipped++ : total++;
      } catch (e) {
        process.stdout.write('✗');
        console.error(`\n    FAILED: ${url}\n    ${e.message}`);
        failed++;
      }
    }
  }

  console.log(`\n\nDone.  Downloaded: ${total}  Skipped (already exist): ${skipped}  Failed: ${failed}`);
  if (failed > 0) console.log('Re-run the script to retry failed files.');
}

main();
