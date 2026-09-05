// ═══════════════════════════════════════════════════════════════
//  VWB Sunday Edition — Global State
//  All shared variables, AudioContext setup, and timing math.
//  Every other module reads from / writes to these globals.
// ═══════════════════════════════════════════════════════════════

// ── Audio Context ──────────────────────────────────────────────
const AC = new (window.AudioContext || window.webkitAudioContext)();
const mGain = AC.createGain();
mGain.gain.value = 0.8;
mGain.connect(AC.destination);

let maxCh = 2;
try { maxCh = AC.destination.maxChannelCount || 2; } catch(e) {}

// ── Playback State ─────────────────────────────────────────────
let playing = false;
let startAt = 0;        // AC.currentTime when playback began
let pauseAt = 0;        // offset into song when paused
let curSec = -1;        // currently active section index (-1 = none)
let qSec = -1;          // queued section to jump on next downbeat
let afId = null;
let rMode = 'stereo';
let songEndedNaturally = false;

// ── Section Loop ───────────────────────────────────────────────
let secLoopOn = false;
let secLoopJumping = false;

// ── Crossfade ──────────────────────────────────────────────────
let crossfadeMode = 'manual';
let crossfadeDuration = 3;
let crossfading = false;

// ── Song Model ─────────────────────────────────────────────────
let song = { title: '', tempo: 72, ts: '4/4', secs: [] };
let setlist = [];

// ── Stems — 4 dedicated channels ──────────────────────────────
const SK = ['piano', 'bass', 'guitar', 'rhythm'];
const SL = {
  piano:  '🎹 Piano',
  bass:   '🎸 Bass',
  guitar: '🎸 Guitar',
  rhythm: '🔁 Rhythm Loop'
};
const SC = {
  piano:  '#40E0D0',
  bass:   '#ff8844',
  guitar: '#44dd88',
  rhythm: '#ff4466'
};
const S = {};
SK.forEach(k => {
  const g = AC.createGain();
  g.gain.value = 0.8;
  g.connect(mGain);
  S[k] = { buf: null, src: null, gn: g, muted: false, solo: false, vol: 80, fn: '', out: 0, storedPath: '' };
});

// ── Aux Sub-Mixer — multiple tracks summed to stereo Ch 6-7 ───
const auxMasterGain = AC.createGain();
auxMasterGain.gain.value = 0.8;
auxMasterGain.connect(mGain);

let auxTracks = [];       // { buf, src, gn, vol, fn, muted, storedPath }
let auxMasterVol = 80;
let auxMasterMuted = false;
let auxSolo = false;

// ── Fixed 8-channel routing map ────────────────────────────────
const ROUTE_MAP = {
  piano:  { ch: [0, 1], stereo: true  },   // Ch 1-2
  bass:   { ch: [2],    stereo: false },    // Ch 3
  guitar: { ch: [3],    stereo: false },    // Ch 4
  rhythm: { ch: [4],    stereo: false },    // Ch 5
  aux:    { ch: [5, 6], stereo: true  }     // Ch 6-7
};

// ── Monitor Bus (Q/Click) — Ch 8, isolated from house ─────────
const monitorMasterGain = AC.createGain();
monitorMasterGain.gain.value = 0.9;
// NOTE: intentionally NOT connected to mGain — stays off house in stereo mode.

const MONITOR_SLOTS  = ['cues', 'click'];
const MONITOR_LABELS = { cues: '🗣 Cues', click: '🥁 Click' };
const MONITOR_COLORS = { cues: '#ff6464', click: '#ff9944' };
const MON = {};
MONITOR_SLOTS.forEach(k => {
  const gn = AC.createGain();
  gn.gain.value = 0.9;
  gn.connect(monitorMasterGain);
  MON[k] = { buf: null, src: null, gn, vol: 90, muted: false, fn: '', storedPath: '' };
});

// ── Panic ──────────────────────────────────────────────────────
let panicActive = false;

// ── Session ────────────────────────────────────────────────────
let currentSessionPath = '';

// ── Section type presets ───────────────────────────────────────
const SEC_TYPES = [
  'Intro','Verse','Pre-Chorus','Chorus','Bridge',
  'Vamp','Altar Call','Outro','Interlude','Tag','Custom'
];

// ═══════════════════════════════════════════════════════════════
//  TIMING MATH  (pure functions — depend only on `song`)
// ═══════════════════════════════════════════════════════════════

function bpb() {
  const t = song.ts;
  return t === '3/4' ? 3 : t === '6/8' ? 6 : t === '12/8' ? 12 : 4;
}
function secPerBeat() { return 60 / (song.tempo || 72); }
function secPerBar()  { return secPerBeat() * bpb(); }
function bar2time(bar) { return (bar - 1) * secPerBar(); }   // bar 1 = time 0
function time2bar(t)   { return Math.floor(t / secPerBar()) + 1; }
function beatInBar(t) {
  const spb = secPerBar();
  return Math.floor(((t % spb) + 0.0005) / secPerBeat()) % bpb();
}
function totalBars() {
  const d = getDur();
  return d > 0 ? Math.ceil(d / secPerBar()) : 0;
}
function getDur() {
  let mx = 0;
  SK.forEach(k => { if (S[k].buf) mx = Math.max(mx, S[k].buf.duration); });
  auxTracks.forEach(t => { if (t.buf) mx = Math.max(mx, t.buf.duration); });
  MONITOR_SLOTS.forEach(k => { if (MON[k].buf) mx = Math.max(mx, MON[k].buf.duration); });
  return mx;
}
function stemCount() {
  return SK.filter(k => S[k].buf).length +
         auxTracks.filter(t => t.buf).length +
         MONITOR_SLOTS.filter(k => MON[k].buf).length;
}
function fmt(s) {
  const m = Math.floor(s / 60), sc = Math.floor(s % 60);
  return m + ':' + (sc < 10 ? '0' : '') + sc;
}
