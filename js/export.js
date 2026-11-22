// Turn a notation timeline / note list into ABC (for on-screen sheet music), MusicXML and MIDI files.
import { spell, keySignature } from './transcribe.js';

const ACC_ABC = { '-1': '_', '0': '=', '1': '^' };
const ACC_XML = { '-1': 'flat', '0': 'natural', '1': 'sharp' };

function abcPitch(letter, octave) {
  if (octave >= 5) return letter.toLowerCase() + "'".repeat(octave - 5);
  return letter + ','.repeat(Math.max(0, 4 - octave));
}

/** Walk the timeline, deciding which accidentals must be printed (they last until the barline). */
function withAccidentals(timeline, fifths) {
  const sig = keySignature(fifths);
  return timeline.bars.map(bar => {
    const state = {};
    return bar.map(it => {
      if (it.type !== 'note') return { ...it };
      const sp = spell(it.midi, fifths);
      const k = sp.letter + sp.octave;
      const current = k in state ? state[k] : sig[sp.letter];
      const show = current !== sp.alter;
      state[k] = sp.alter;
      return { ...it, ...sp, showAcc: show };
    });
  });
}

export function toABC(timeline, o) {
  const { title = 'My melody', bpm, beatsPerBar, key, clef } = o;
  const bars = withAccidentals(timeline, key.fifths);
  const lines = [
    'X:1',
    `T:${title.replace(/[\r\n]/g, ' ')}`,
    `M:${beatsPerBar}/4`,
    'L:1/16',
    `Q:1/4=${Math.round(bpm)}`,
    `K:${key.name}${clef === 'bass' ? ' clef=bass' : ''}`,
  ];
  let body = '';
  bars.forEach((bar, bi) => {
    let s = '';
    bar.forEach(it => {
      let tok;
      if (it.type === 'rest') tok = (it.whole ? 'z' : 'z') + it.dur;
      else tok = (it.showAcc ? ACC_ABC[it.alter] : '') + abcPitch(it.letter, it.octave) + (it.dur === 1 ? '' : it.dur) + (it.tieNext ? '-' : '');
      s += tok;
      if ((it.start + it.dur) % 4 === 0) s += ' ';
    });
    body += s + (bi === bars.length - 1 ? '|]' : '| ');
    if (bi % 4 === 3 && bi !== bars.length - 1) body += '\n';
  });
  return lines.join('\n') + '\n' + body + '\n';
}

const XML_TYPE = { 1: ['16th', 0], 2: ['eighth', 0], 3: ['eighth', 1], 4: ['quarter', 0], 6: ['quarter', 1],
  8: ['half', 0], 12: ['half', 1], 16: ['whole', 0] };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toMusicXML(timeline, o) {
  const { title = 'My melody', bpm, beatsPerBar, key, clef } = o;
  const bars = withAccidentals(timeline, key.fifths);
  const mode = key.name.endsWith('m') ? 'minor' : 'major';
  let tiedFromPrev = false;
  const measures = bars.map((bar, bi) => {
    let x = `<measure number="${bi + 1}">`;
    if (bi === 0) {
      x += `<attributes><divisions>4</divisions><key><fifths>${key.fifths}</fifths><mode>${mode}</mode></key>` +
        `<time><beats>${beatsPerBar}</beats><beat-type>4</beat-type></time>` +
        (clef === 'bass' ? '<clef><sign>F</sign><line>4</line></clef>' : '<clef><sign>G</sign><line>2</line></clef>') +
        `</attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(bpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(bpm)}"/></direction>`;
    }
    for (const it of bar) {
      if (it.type === 'rest') {
        if (it.whole) x += `<note><rest measure="yes"/><duration>${it.dur}</duration></note>`;
        else {
          const [type, dot] = XML_TYPE[it.dur];
          x += `<note><rest/><duration>${it.dur}</duration><type>${type}</type>${dot ? '<dot/>' : ''}</note>`;
        }
        tiedFromPrev = false;
        continue;
      }
      const [type, dot] = XML_TYPE[it.dur];
      const ties = (tiedFromPrev ? '<tie type="stop"/>' : '') + (it.tieNext ? '<tie type="start"/>' : '');
      const tied = (tiedFromPrev ? '<tied type="stop"/>' : '') + (it.tieNext ? '<tied type="start"/>' : '');
      x += `<note><pitch><step>${it.letter}</step>${it.alter ? `<alter>${it.alter}</alter>` : ''}<octave>${it.octave}</octave></pitch>` +
        `<duration>${it.dur}</duration>${ties}<type>${type}</type>${dot ? '<dot/>' : ''}` +
        (it.showAcc ? `<accidental>${ACC_XML[it.alter]}</accidental>` : '') +
        (tied ? `<notations>${tied}</notations>` : '') + '</note>';
      tiedFromPrev = it.tieNext;
    }
    if (bi === bars.length - 1) x += '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
    return x + '</measure>';
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${esc(title)}</work-title></work>
<identification><encoding><software>Sing to MIDI</software></encoding></identification>
<part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
<part id="P1">${measures.join('\n')}</part></score-partwise>
`;
}

// ---------- MIDI ----------
function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}
const str = s => Array.from(s, c => c.charCodeAt(0) & 0xff);
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/**
 * notes: [{startTick, endTick, midi}] ; returns Uint8Array of a type-0 .mid file
 */
export function toMidi(notes, { bpm, beatsPerBar = 4, program = 0, title = 'Melody', ppq = 480, fifths = 0, minor = false }) {
  const ev = [];
  const meta = (type, data) => [0xff, type, ...vlq(data.length), ...data];
  ev.push({ t: 0, d: meta(0x03, str(title.slice(0, 100))) });
  const us = Math.round(60e6 / bpm);
  ev.push({ t: 0, d: meta(0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]) });
  ev.push({ t: 0, d: meta(0x58, [beatsPerBar, 2, 24, 8]) });
  ev.push({ t: 0, d: meta(0x59, [fifths & 255, minor ? 1 : 0]) });
  ev.push({ t: 0, d: [0xc0, program & 127] });
  for (const n of notes) {
    ev.push({ t: n.startTick, d: [0x90, n.midi, n.velocity ?? 90], on: 1 });
    ev.push({ t: n.endTick, d: [0x80, n.midi, 64], on: 0 });
  }
  ev.sort((a, b) => a.t - b.t || (a.on ?? 2) - (b.on ?? 2)); // note-offs before note-ons at the same tick
  const track = [];
  let last = 0;
  for (const e of ev) { track.push(...vlq(e.t - last), ...e.d); last = e.t; }
  track.push(0, 0xff, 0x2f, 0);
  return new Uint8Array([
    ...str('MThd'), ...u32(6), 0, 0, 0, 1, (ppq >> 8) & 255, ppq & 255,
    ...str('MTrk'), ...u32(track.length), ...track,
  ]);
}

/** quantized events (16ths) -> midi note list */
export const quantizedToTicks = (events, ppq = 480) =>
  events.map(n => ({ startTick: n.s * ppq / 4, endTick: n.e * ppq / 4, midi: n.midi }));

/** raw notes (seconds) -> midi note list, keeping the natural timing */
export const secondsToTicks = (notes, bpm, ppq = 480) => {
  const t0 = notes.length ? notes[0].start : 0;
  const k = bpm / 60 * ppq;
  return notes.map(n => ({ startTick: Math.round((n.start - t0) * k), endTick: Math.max(Math.round((n.start - t0) * k) + 1, Math.round((n.end - t0) * k)), midi: n.midi }));
};
