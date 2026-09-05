/**
 * VWB Chord Theory Engine
 * Converts absolute chord symbols (e.g. "Dm7", "G7b5#9") into VWB's
 * scale-degree label system (e.g. "Two, Minor 7", "Five, Dominant 7, Flat 5, Sharp 9")
 * relative to a given song key, per the VWB House Band Training Data Standard v1.
 */

const NOTE_TO_SEMITONE = {
  'C': 0, 'B#': 0,
  'C#': 1, 'Db': 1,
  'D': 2,
  'D#': 3, 'Eb': 3,
  'E': 4, 'Fb': 4,
  'F': 5, 'E#': 5,
  'F#': 6, 'Gb': 6,
  'G': 7,
  'G#': 8, 'Ab': 8,
  'A': 9,
  'A#': 10, 'Bb': 10,
  'B': 11, 'Cb': 11,
};

// Scale degree semitone distances from the root, in a major scale reference frame
const DEGREE_SEMITONES = [
  { degree: 1, semitone: 0 },
  { degree: 2, semitone: 2, flatLabel: 'Flat 2', sharpLabel: null },
  { degree: 2, semitone: 1, flatLabel: 'Flat 2' },
  { degree: 3, semitone: 4 },
  { degree: 3, semitone: 3, flatLabel: 'Flat 3' },
  { degree: 4, semitone: 5 },
  { degree: 4, semitone: 6, sharpLabel: 'Sharp 4' }, // also referred to as Sharp 11 in extended context
  { degree: 5, semitone: 7 },
  { degree: 5, semitone: 6, flatLabel: 'Flat 5' },
  { degree: 5, semitone: 8, sharpLabel: 'Sharp 5' },
  { degree: 6, semitone: 9 },
  { degree: 6, semitone: 8, flatLabel: 'Flat 6' }, // enharmonic with Sharp 5, context-dependent
  { degree: 7, semitone: 11 },
  { degree: 7, semitone: 10, flatLabel: 'Flat 7' },
];

// Canonical degree label lookup by semitone distance from key root (0-11)
const SEMITONE_TO_LABEL = {
  0: 'One',
  1: 'Flat 2',
  2: 'Two',
  3: 'Flat 3',
  4: 'Three',
  5: 'Four',
  6: 'Sharp 4', // ambiguous w/ Flat 5; resolved by chord quality context in resolveDegreeLabel()
  7: 'Five',
  8: 'Flat 6',  // ambiguous w/ Sharp 5; resolved by chord quality context
  9: 'Six',
  10: 'Flat 7',
  11: 'Seven',
};

function noteNameToSemitone(note) {
  const cleaned = note.trim();
  if (!(cleaned in NOTE_TO_SEMITONE)) {
    throw new Error(`Unrecognized note name: "${note}"`);
  }
  return NOTE_TO_SEMITONE[cleaned];
}

/**
 * Resolves a root note to its scale-degree label relative to a key.
 * Uses chord-quality context to disambiguate enharmonic spellings
 * (e.g. semitone 6 -> "Sharp 4" typically, but context can favor "Flat 5").
 */
function resolveDegreeLabel(rootNote, keyNote, qualityHint = '') {
  const rootST = noteNameToSemitone(rootNote);
  const keyST = noteNameToSemitone(keyNote);
  const distance = ((rootST - keyST) % 12 + 12) % 12;

  // Disambiguation: if chord quality suggests a "five" function (dominant, major, minor, etc.
  // built a tritone+1 away acting as V), prefer "Flat 5" / "Sharp 5" framing over "Sharp 4" / "Flat 6"
  if (distance === 6 && /b5|flat5|°|dim/i.test(qualityHint)) return 'Flat 5';
  if (distance === 8 && /#5|sharp5|aug/i.test(qualityHint)) return 'Sharp 5';

  return SEMITONE_TO_LABEL[distance];
}

/**
 * Parses a chord symbol string into { root, quality, alterations }
 * Handles standard jazz/gospel notation: G7, Dm7, G7b5#9, Gmaj7#11, Cdim, Caug, Csus, Dm11, etc.
 */
function parseChordSymbol(symbol) {
  const clean = symbol.trim();

  // Extract root note (letter + optional accidental)
  const rootMatch = clean.match(/^([A-G])(#|b)?/);
  if (!rootMatch) {
    throw new Error(`Could not parse root from chord symbol: "${symbol}"`);
  }
  const root = rootMatch[1] + (rootMatch[2] || '');
  let remainder = clean.slice(rootMatch[0].length);

  // Handle slash chords (over scale degree) - capture but treat root as primary
  let overNote = null;
  const slashMatch = remainder.match(/\/([A-G](#|b)?)$/);
  if (slashMatch) {
    overNote = slashMatch[1];
    remainder = remainder.slice(0, slashMatch.index);
  }

  // Determine base quality
  let quality = 'Major';
  let qualityConsumed = '';

  const qualityPatterns = [
    { re: /^maj13/i, label: 'Major 13', len: 5 },
    { re: /^maj11/i, label: 'Major 11', len: 5 },
    { re: /^maj9/i, label: 'Major 9', len: 4 },
    { re: /^maj7/i, label: 'Major 7', len: 4 },
    { re: /^m11|^min11/i, label: 'Minor 11' },
    { re: /^m9|^min9/i, label: 'Minor 9' },
    { re: /^m7b5|^min7b5|^m7-5|^ø/i, label: 'Minor 7 Flat 5 (Half-Diminished)' },
    { re: /^m7|^min7/i, label: 'Minor 7' },
    { re: /^m6|^min6/i, label: 'Minor 6' },
    { re: /^m(?![a-z])|^min(?![a-z])/i, label: 'Minor' },
    { re: /^dim7/i, label: 'Diminished 7' },
    { re: /^dim|^°/i, label: 'Diminished' },
    { re: /^aug|^\+/i, label: 'Augmented' },
    { re: /^7sus4/i, label: 'Suspended 4, Flat 7' },
    { re: /^7sus2/i, label: 'Suspended 2, Flat 7' },
    { re: /^7sus/i, label: 'Suspended, Flat 7' },
    { re: /^sus4/i, label: 'Suspended 4' },
    { re: /^sus2/i, label: 'Suspended 2' },
    { re: /^sus/i, label: 'Suspended' },
    { re: /^13/i, label: 'Dominant 13' },
    { re: /^11/i, label: 'Dominant 11' },
    { re: /^9/i, label: 'Dominant 9' },
    { re: /^7/i, label: 'Dominant 7' },
    { re: /^6/i, label: 'Major 6' },
  ];

  for (const pat of qualityPatterns) {
    const m = remainder.match(pat.re);
    if (m) {
      quality = pat.label;
      qualityConsumed = m[0];
      remainder = remainder.slice(m[0].length);
      break;
    }
  }

  // Parse alterations: look for combinations like b5, #5, b9, #9, #11, 13
  const alterations = [];
  const alterRe = /(b|#)(5|9|11|13)/gi;
  let am;
  while ((am = alterRe.exec(remainder)) !== null) {
    const sign = am[1] === 'b' ? 'Flat' : 'Sharp';
    alterations.push(`${sign} ${am[2]}`);
  }
  // Bare extension numbers without alteration sign, e.g. trailing "13" meaning add13
  const bareExtMatch = remainder.match(/(?<!b|#)\b(9|11|13)\b/g);
  if (bareExtMatch) {
    bareExtMatch.forEach(ext => {
      if (!alterations.some(a => a.endsWith(ext))) {
        alterations.push(ext); // natural extension, e.g. "13" with no flat/sharp
      }
    });
  }

  return { root, overNote, quality, alterations, raw: symbol };
}

/**
 * Full pipeline: chord symbol + key -> VWB scale-degree label
 * Returns e.g. { degreeLabel: "Five", quality: "Dominant 7", alterations: ["Flat 5","Sharp 9"], full: "Five, Dominant 7, Flat 5, Sharp 9" }
 */
function chordToVWBLabel(chordSymbol, keyNote) {
  const parsed = parseChordSymbol(chordSymbol);
  const degreeLabel = resolveDegreeLabel(parsed.root, keyNote, parsed.quality + parsed.alterations.join(''));

  const parts = [degreeLabel, parsed.quality, ...parsed.alterations];
  let full = parts.join(', ');

  let overDegreeLabel = null;
  if (parsed.overNote) {
    overDegreeLabel = resolveDegreeLabel(parsed.overNote, keyNote);
    full += ` over ${overDegreeLabel}`;
  }

  return {
    degreeLabel,
    quality: parsed.quality,
    alterations: parsed.alterations,
    overNote: parsed.overNote,
    overDegreeLabel,
    full,
    raw: chordSymbol,
  };
}

// House Band roster note: per band-registry.js (source of truth), drummer is
// "Jason Washington" (intentionally paired with bassist "Terry Washington" as
// a visual/branding "twins" pairing), NOT "Jason Briggs" as listed in the
// v3.1 vision document. Vision doc should be updated to match.
//
// No module.exports here -- matches the plain global-script convention used
// throughout VWB's existing js/ files (band-registry.js, state.js,
// loop-library.js, etc, all rely on global function scope, no require/export).
