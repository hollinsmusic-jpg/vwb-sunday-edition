#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  VWB Drum Sample Downloader v2
//  Uses the Soundfont2 / Benjamin Gleitz FatBoy soundfont
//  which actually has percussion.
//  Run: node download-drums.js
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const OUT = path.join(__dirname, 'app', 'percussion');
fs.mkdirSync(OUT, { recursive: true });

// GM Drum note numbers → note names used in the FatBoy soundfont
// FatBoy uses standard note names like A2, Bb2, B2, C3 etc.
const GM_DRUMS = [
  { midi: 35, name: 'Bass Drum 2',      gleitz: 'B1'  },
  { midi: 36, name: 'Bass Drum 1',      gleitz: 'C2'  },
  { midi: 37, name: 'Side Stick',       gleitz: 'Db2' },
  { midi: 38, name: 'Snare',            gleitz: 'D2'  },
  { midi: 39, name: 'Hand Clap',        gleitz: 'Eb2' },
  { midi: 40, name: 'Electric Snare',   gleitz: 'E2'  },
  { midi: 41, name: 'Low Floor Tom',    gleitz: 'F2'  },
  { midi: 42, name: 'Closed Hi-Hat',    gleitz: 'Gb2' },
  { midi: 43, name: 'High Floor Tom',   gleitz: 'G2'  },
  { midi: 44, name: 'Pedal Hi-Hat',     gleitz: 'Ab2' },
  { midi: 45, name: 'Low Tom',          gleitz: 'A2'  },
  { midi: 46, name: 'Open Hi-Hat',      gleitz: 'Bb2' },
  { midi: 47, name: 'Low-Mid Tom',      gleitz: 'B2'  },
  { midi: 48, name: 'Hi-Mid Tom',       gleitz: 'C3'  },
  { midi: 49, name: 'Crash Cymbal 1',   gleitz: 'Db3' },
  { midi: 50, name: 'High Tom',         gleitz: 'D3'  },
  { midi: 51, name: 'Ride Cymbal 1',    gleitz: 'Eb3' },
  { midi: 53, name: 'Ride Bell',        gleitz: 'F3'  },
  { midi: 55, name: 'Splash Cymbal',    gleitz: 'G3'  },
  { midi: 57, name: 'Crash Cymbal 2',   gleitz: 'A3'  },
  { midi: 59, name: 'Ride Cymbal 2',    gleitz: 'B3'  },
];

// Try multiple CDN patterns in order until one works
const URL_PATTERNS = [
  d => `https://gleitz.github.io/midi-js-soundfonts/FatBoy/percussion-mp3/${d.gleitz}.mp3`,
  d => `https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/percussion-mp3/${d.gleitz}.mp3`,
  // Fallback: use the soundfont2 js CDN via jsDelivr
  d => `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FatBoy/percussion-mp3/${d.gleitz}.mp3`,
  d => `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/percussion-mp3/${d.gleitz}.mp3`,
];

function download(url, dest) {
  return new Promise((resolve) => {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 500) {
      resolve('skip'); return;
    }
    const proto = url.startsWith('https') ? https : http;
    const tmp   = dest + '.tmp';
    const file  = fs.createWriteStream(tmp);
    proto.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); fs.existsSync(tmp) && fs.unlinkSync(tmp);
        download(res.headers.location, dest).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        file.close(); fs.existsSync(tmp) && fs.unlinkSync(tmp);
        resolve('fail:' + res.statusCode); return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        fs.renameSync(tmp, dest);
        resolve('ok');
      });
    }).on('error', e => {
      fs.existsSync(tmp) && fs.unlinkSync(tmp);
      resolve('error:' + e.message);
    });
  });
}

async function downloadWithFallback(drum) {
  for (const pattern of URL_PATTERNS) {
    const url    = pattern(drum);
    const dest   = path.join(OUT, drum.midi + '.mp3');
    const result = await download(url, dest);
    if (result === 'ok' || result === 'skip') return { result, url };
  }
  return { result: 'fail:all_patterns', url: 'all patterns tried' };
}

async function main() {
  console.log('VWB Drum Downloader v2 — trying multiple CDN sources\n');
  let ok = 0, skipped = 0, failed = 0;
  const failures = [];

  for (const drum of GM_DRUMS) {
    const { result, url } = await downloadWithFallback(drum);
    if (result === 'ok') {
      console.log(`  ✓ ${drum.midi} — ${drum.name}`);
      ok++;
    } else if (result === 'skip') {
      console.log(`  · ${drum.midi} — ${drum.name} (exists)`);
      skipped++;
    } else {
      console.log(`  ✗ ${drum.midi} — ${drum.name}`);
      failures.push(drum);
      failed++;
    }
  }

  console.log(`\n─────────────────────────────────`);
  console.log(`OK: ${ok}  Skipped: ${skipped}  Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nStill failed:', failures.map(d => d.midi + ' ' + d.name).join(', '));
    console.log('\nThese drum sounds will be silent. All others will work.');
  } else {
    console.log('\n✅ All drums ready! Restart VWB.');
  }
}

main();
