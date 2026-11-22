// Singing -> notes. Pure functions, no browser APIs, so they can be tested in Node.

export const ANALYSIS_RATE = 16000;
const FRAME = 1024;          // 64 ms window at 16 kHz
const HOP = 160;             // 10 ms hop
export const HOP_SEC = HOP / ANALYSIS_RATE;

/** Downsample mono audio to 16 kHz (box low-pass + linear interpolation). */
export function resample(samples, srIn, srOut = ANALYSIS_RATE) {
  if (srIn === srOut) return Float32Array.from(samples);
  const ratio = srIn / srOut;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  const half = Math.max(0, Math.floor(ratio / 2));
  // prefix sums for fast box filter
  const pre = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) pre[i + 1] = pre[i] + samples[i];
  for (let i = 0; i < n; i++) {
    const c = Math.round(i * ratio);
    const a = Math.max(0, c - half), b = Math.min(samples.length, c + half + 1);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

/** YIN pitch detector. Returns {freq, conf} or null. */
export function yin(buf, sr, minF = 65, maxF = 1100, threshold = 0.15) {
  const W = Math.floor(buf.length / 2);
  const tauMin = Math.max(2, Math.floor(sr / maxF));
  const tauMax = Math.min(W - 1, Math.ceil(sr / minF));
  const d = new Float32Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) { const v = buf[j] - buf[j + tau]; s += v * v; }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  const cm = new Float32Array(tauMax + 2);
  cm[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    run += d[tau];
    cm[tau] = run > 0 ? d[tau] * tau / run : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cm[t] < threshold) {
      while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
      tau = t; break;
    }
  }
  if (tau < 0) return null;
  // parabolic interpolation
  const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
  const den = a + c - 2 * b;
  const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
  const t = tau + (Math.abs(shift) < 1 ? shift : 0);
  return { freq: sr / t, conf: 1 - b };
}

export const freqToMidi = f => 69 + 12 * Math.log2(f / 440);

/**
 * Frame-by-frame pitch track.
 * Returns {frames: [{t, midi|null, rms}], gate}
 * opts.gateRatio: frames quieter than peak*gateRatio count as silence.
 */
export function pitchTrack(samples, sr, opts = {}) {
  const x = resample(samples, sr);
  const gateRatio = opts.gateRatio ?? 0.08;
  const nFrames = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  const rmsArr = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let s = 0;
    const o = i * HOP;
    for (let j = 0; j < FRAME; j++) s += x[o + j] * x[o + j];
    rmsArr[i] = Math.sqrt(s / FRAME);
  }
  const sorted = Array.from(rmsArr).sort((a, b) => a - b);
  const peak = sorted[Math.floor(sorted.length * 0.98)] || 0;
  const gate = Math.max(0.002, peak * gateRatio);
  const frames = [];
  const buf = new Float32Array(FRAME);
  for (let i = 0; i < nFrames; i++) {
    const o = i * HOP;
    const t = (o + FRAME / 2) / ANALYSIS_RATE;
    let midi = null;
    if (rmsArr[i] >= gate) {
      // remove DC
      let m = 0;
      for (let j = 0; j < FRAME; j++) m += x[o + j];
      m /= FRAME;
      for (let j = 0; j < FRAME; j++) buf[j] = x[o + j] - m;
      const p = yin(buf, ANALYSIS_RATE);
      if (p && p.conf > 0.75) midi = freqToMidi(p.freq);
    }
    frames.push({ t, midi, rms: rmsArr[i] });
  }
  // median filter (5) to kill octave blips
  const raw = frames.map(f => f.midi);
  for (let i = 0; i < frames.length; i++) {
    if (raw[i] == null) continue;
    const w = [];
    for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < raw.length && raw[k] != null) w.push(raw[k]);
    w.sort((a, b) => a - b);
    frames[i].midi = w[Math.floor(w.length / 2)];
  }
  return { frames, gate };
}

const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Estimate how sharp/flat the singer is overall, in semitones (-0.5..0.5). */
export function tuningOffset(frames) {
  let sx = 0, sy = 0;
  for (const f of frames) if (f.midi != null) {
    const ang = 2 * Math.PI * (f.midi - Math.round(f.midi));
    sx += Math.cos(ang); sy += Math.sin(ang);
  }
  if (sx === 0 && sy === 0) return 0;
  return Math.atan2(sy, sx) / (2 * Math.PI);
}

/**
 * Group pitch frames into notes: [{start, end, midi, pitchExact}] in seconds.
 * opts.minNoteSec, opts.tuning (bool)
 */
export function segmentNotes(frames, opts = {}) {
  const minNote = opts.minNoteSec ?? 0.07;
  const offset = opts.tuning === false ? 0 : tuningOffset(frames);
  const SPLIT = 0.75;     // semitones away from the note to count as a new pitch
  const CONFIRM = 4;      // frames (40 ms) the new pitch must hold
  const MAXGAP = 3;       // unvoiced frames bridged inside a note
  const notes = [];
  let cur = null, pending = [], gap = 0;

  const close = (endIdx) => {
    if (!cur) return;
    cur.endIdx = endIdx;
    notes.push(cur);
    cur = null;
  };
  for (let i = 0; i < frames.length; i++) {
    const m = frames[i].midi;
    if (m == null) {
      gap++;
      if (cur && gap > MAXGAP) { close(i - gap + 1); pending = []; }
      continue;
    }
    gap = 0;
    if (!cur) { cur = { startIdx: i, pitches: [m] }; pending = []; continue; }
    const ref = median(cur.pitches.slice(-12));
    if (Math.abs(m - ref) > SPLIT) {
      if (pending.length && Math.abs(m - median(pending.map(p => p.m))) > SPLIT) pending = [];
      pending.push({ i, m });
      if (pending.length >= CONFIRM) {
        close(pending[0].i);
        cur = { startIdx: pending[0].i, pitches: pending.map(p => p.m) };
        pending = [];
      }
    } else {
      for (const p of pending) cur.pitches.push(p.m);
      pending = [];
      cur.pitches.push(m);
    }
  }
  close(frames.length);

  const hop = frames.length > 1 ? frames[1].t - frames[0].t : HOP_SEC;
  return notes
    .map(n => {
      const exact = median(n.pitches) - offset;
      return {
        start: frames[n.startIdx].t - hop / 2,
        end: frames[Math.min(n.endIdx, frames.length) - 1].t + hop / 2,
        midi: Math.round(exact),
        pitchExact: exact,
      };
    })
    .filter(n => n.end - n.start >= minNote && n.midi >= 21 && n.midi <= 108);
}

/**
 * Snap notes to a beat grid. Units are sixteenth notes.
 * opts: bpm, step (grid in 16ths: 1 = 16th, 2 = 8th), beatsPerBar,
 *       anchor (seconds of beat 1 of bar 1, or null = first note), fillGaps (bool)
 * Returns [{s, e, midi}] with s/e in sixteenths from bar 1.
 */
export function quantize(notes, opts) {
  const { bpm, step = 1, beatsPerBar = 4, fillGaps = true } = opts;
  if (!notes.length) return [];
  const six = 60 / bpm / 4;
  const anchor = opts.anchor ?? notes[0].start;
  const q = t => Math.round((t - anchor) / six / step) * step;
  let ev = notes.map(n => {
    const s = q(n.start);
    let e = q(n.end);
    if (e <= s) e = s + step;
    return { s, e, midi: n.midi };
  });
  // anything before bar 1 (a pickup) pushes the whole thing later by whole bars
  const bar = beatsPerBar * 4;
  const minS = Math.min(...ev.map(n => n.s));
  if (minS < 0) {
    const shift = Math.ceil(-minS / bar) * bar;
    ev.forEach(n => { n.s += shift; n.e += shift; });
  }
  // monophonic cleanup
  ev.sort((a, b) => a.s - b.s);
  const out = [];
  for (const n of ev) {
    const prev = out[out.length - 1];
    if (prev && n.s < prev.e) {
      if (n.s <= prev.s) { // same slot: keep the longer one
        if (n.e - n.s > prev.e - prev.s) out[out.length - 1] = n;
        continue;
      }
      prev.e = n.s;
    }
    out.push(n);
  }
  if (fillGaps) {
    for (let i = 0; i < out.length - 1; i++) {
      const gap = out[i + 1].s - out[i].e;
      if (gap > 0 && gap <= step) out[i].e = out[i + 1].s;
    }
  }
  return out;
}

/**
 * Guess a tempo (BPM) from note onsets, for recordings made without the metronome.
 * Picks the tempo whose 8th-note grid best fits the gaps between note starts.
 */
export function guessTempo(notes, lo = 70, hi = 140) {
  if (notes.length < 4) return null;
  const on = notes.map(n => n.start);
  const iois = [];
  for (let i = 1; i < on.length; i++) {
    iois.push(on[i] - on[i - 1]);
    if (i > 1) iois.push(on[i] - on[i - 2]);
  }
  let best = null;
  for (let bpm = lo; bpm <= hi; bpm += 0.5) {
    const g = 60 / bpm / 2;
    let err = 0;
    for (const d of iois) { const r = d / g; const f = r - Math.round(r); err += f * f + (Math.round(r) === 0 ? 0.25 : 0); }
    err = err / iois.length + 0.01 * ((bpm - 100) / 40) ** 2;
    if (!best || err < best.err) best = { bpm, err };
  }
  return Math.round(best.bpm);
}

// ---------- key & spelling ----------
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// tonic pc -> [name, fifths]
const MAJOR_KEYS = { 0: ['C', 0], 7: ['G', 1], 2: ['D', 2], 9: ['A', 3], 4: ['E', 4], 11: ['B', 5], 6: ['F#', 6],
  1: ['Db', -5], 8: ['Ab', -4], 3: ['Eb', -3], 10: ['Bb', -2], 5: ['F', -1] };
const MINOR_KEYS = { 9: ['Am', 0], 4: ['Em', 1], 11: ['Bm', 2], 6: ['F#m', 3], 1: ['C#m', 4], 8: ['G#m', 5], 3: ['Ebm', -6],
  10: ['Bbm', -5], 5: ['Fm', -4], 0: ['Cm', -3], 7: ['Gm', -2], 2: ['Dm', -1] };

function corr(a, b) {
  const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
}

/** Krumhansl–Schmuckler key estimate. Returns {name, fifths}. */
export function estimateKey(events) {
  const hist = new Array(12).fill(0);
  for (const n of events) hist[((n.midi % 12) + 12) % 12] += n.e - n.s;
  if (hist.every(v => v === 0)) return { name: 'C', fifths: 0 };
  const total = hist.reduce((a, b) => a + b, 0);
  // fraction of the melody that would need accidentals in a key with this many sharps/flats
  const outside = fifths => {
    const sig = keySignature(fifths);
    const inScale = new Set(LETTERS.map(L => (LETTER_PC[L] + sig[L] + 12) % 12));
    return hist.reduce((a, v, pc) => a + (inScale.has(pc) ? 0 : v), 0) / total;
  };
  let best = { score: -2, name: 'C', fifths: 0 };
  for (let t = 0; t < 12; t++) {
    const rot = p => Array.from({ length: 12 }, (_, i) => p[(i - t + 12) % 12]);
    const sMaj = corr(hist, rot(MAJOR_PROFILE)) - 4 * outside(MAJOR_KEYS[t][1]);
    const sMin = corr(hist, rot(MINOR_PROFILE)) - 4 * outside(MINOR_KEYS[t][1]);
    if (sMaj > best.score) best = { score: sMaj, name: MAJOR_KEYS[t][0], fifths: MAJOR_KEYS[t][1] };
    if (sMin > best.score) best = { score: sMin, name: MINOR_KEYS[t][0], fifths: MINOR_KEYS[t][1] };
  }
  return { name: best.name, fifths: best.fifths };
}

export function keyFromName(name) {
  for (const [pc, [n, f]] of Object.entries(MAJOR_KEYS)) if (n === name) return { name, fifths: f, tonic: +pc };
  for (const [pc, [n, f]] of Object.entries(MINOR_KEYS)) if (n === name) return { name, fifths: f, tonic: +pc };
  return { name: 'C', fifths: 0, tonic: 0 };
}
export const ALL_KEYS = [...Object.values(MAJOR_KEYS), ...Object.values(MINOR_KEYS)].map(k => k[0]);

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** letter -> -1/0/+1 from the key signature */
export function keySignature(fifths) {
  const sig = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  if (fifths > 0) 'FCGDAEB'.slice(0, fifths).split('').forEach(l => sig[l] = 1);
  if (fifths < 0) 'BEADGCF'.slice(0, -fifths).split('').forEach(l => sig[l] = -1);
  return sig;
}

const SHARP_SPELL = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLAT_SPELL = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];

/** Spell a MIDI note in a key: {letter, alter, octave} */
export function spell(midi, fifths) {
  const pc = ((midi % 12) + 12) % 12;
  const sig = keySignature(fifths);
  let letter, alter;
  for (const L of LETTERS) {
    if ((LETTER_PC[L] + sig[L] + 12) % 12 === pc) { letter = L; alter = sig[L]; break; }
  }
  if (!letter) [letter, alter] = (fifths >= 0 ? SHARP_SPELL : FLAT_SPELL)[pc];
  const octave = Math.floor((midi - alter) / 12) - 1;
  return { letter, alter, octave };
}

// ---------- notation timeline ----------
const NICE = [16, 12, 8, 6, 4, 3, 2, 1]; // durations in 16ths that are one written note

function splitDur(start, len, beat) {
  // split into notatable pieces; prefer not to cross beats awkwardly for odd lengths
  const out = [];
  let pos = start, left = len;
  while (left > 0) {
    let d = NICE.find(v => v <= left);
    // a dotted/odd value starting off the beat looks bad: break at the next beat instead
    const off = pos % beat;
    // only allow the common "eighth-quarter-eighth" syncopation to cross a beat
    if (off && d > beat - off && !(off === 2 && d === 4)) d = beat - off;
    out.push(d); pos += d; left -= d;
  }
  return out;
}

/**
 * Build bars of written notes/rests from quantized events.
 * Returns {bars: [[{type:'note'|'rest', midi, dur, tieNext, start}]], barLen}
 */
export function buildTimeline(events, beatsPerBar = 4) {
  const barLen = beatsPerBar * 4;
  const beat = 4;
  const end = events.length ? events[events.length - 1].e : barLen;
  const total = Math.max(barLen, Math.ceil(end / barLen) * barLen);
  const items = [];
  let pos = 0;
  for (const n of events) {
    if (n.s > pos) items.push({ type: 'rest', s: pos, e: n.s });
    items.push({ type: 'note', s: n.s, e: n.e, midi: n.midi });
    pos = n.e;
  }
  if (pos < total) items.push({ type: 'rest', s: pos, e: total });
  const bars = Array.from({ length: total / barLen }, () => []);
  for (const it of items) {
    let s = it.s;
    while (s < it.e) {
      const b = Math.floor(s / barLen);
      const segEnd = Math.min(it.e, (b + 1) * barLen);
      const inBar = s - b * barLen;
      if (it.type === 'rest' && inBar === 0 && segEnd - s === barLen) {
        bars[b].push({ type: 'rest', dur: barLen, start: 0, whole: true });
      } else {
        const pieces = splitDur(inBar, segEnd - s, beat);
        let p = inBar;
        pieces.forEach((d) => {
          const isLastOfNote = s + (p - inBar) + d >= it.e;
          bars[b].push({ type: it.type, midi: it.midi, dur: d, start: p, tieNext: it.type === 'note' && !isLastOfNote });
          p += d;
        });
      }
      s = segEnd;
    }
  }
  return { bars, barLen };
}
