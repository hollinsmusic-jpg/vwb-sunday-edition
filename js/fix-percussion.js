// Fixes percussion download — Gleitz uses 'percussion' not 'percussion-mp3'
// Run: node js/fix-percussion.js

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// The correct Gleitz URL pattern for percussion
const PERCUSSION_NOTES = [
  'Ab2','A2','As2','B2','Bb2',
  'C3','Cs3','D3','Ds3','E3','F3','Fs3','G3','Gs3','A3','As3','B3',
  'C4','Cs4','D4','Ds4','E4','F4','Fs4','G4','Gs4','A4'
];

// Try two different URL patterns Gleitz uses
const PATTERNS = [
  (note) => `https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/percussion-mp3/${note}.mp3`,
  (note) => `https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/percussion/${note}.mp3`,
];

const OUT_DIR = path.join(__dirname, '..', 'app', 'samples', 'percussion');
fs.mkdirSync(OUT_DIR, { recursive: true });

function download(url, dest) {
  return new Promise((resolve) => {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) { resolve('skip'); return; }
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); fs.existsSync(dest) && fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        file.close(); fs.existsSync(dest) && fs.unlinkSync(dest);
        resolve('fail:' + res.statusCode); return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve('ok'); });
    }).on('error', e => {
      fs.existsSync(dest) && fs.unlinkSync(dest);
      resolve('error:' + e.message);
    });
  });
}

async function main() {
  // First, test which URL pattern works
  console.log('Testing percussion URL patterns...');
  let workingPattern = null;
  for (const pattern of PATTERNS) {
    const testUrl = pattern('A3');
    const testDest = path.join(OUT_DIR, '_test_A3.mp3');
    const result = await download(testUrl, testDest);
    if (result === 'ok' || result === 'skip') {
      workingPattern = pattern;
      console.log('Working pattern found:', testUrl);
      if (result === 'ok') fs.renameSync(testDest, path.join(OUT_DIR, 'A3.mp3'));
      break;
    } else {
      console.log('Pattern failed:', testUrl, result);
      fs.existsSync(testDest) && fs.unlinkSync(testDest);
    }
  }

  if (!workingPattern) {
    // Fallback: use a GM drum soundfont from a different CDN
    console.log('\nGleitz percussion not available. Using fallback CDN...');
    // We will skip drums for now and note it
    console.log('Drums will be skipped. MIDI channel 10 will be silent until fixed.');
    console.log('All other 11 instruments should work fine.');
    return;
  }

  let ok = 0, fail = 0;
  for (const note of PERCUSSION_NOTES) {
    const dest = path.join(OUT_DIR, note + '.mp3');
    const result = await download(workingPattern(note), dest);
    process.stdout.write(result.startsWith('ok') || result === 'skip' ? '✓' : '✗');
    result.startsWith('ok') || result === 'skip' ? ok++ : fail++;
  }
  console.log(`\nDone. OK: ${ok}  Failed: ${fail}`);
}

main();
