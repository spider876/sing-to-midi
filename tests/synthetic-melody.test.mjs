import { pitchTrack, segmentNotes, quantize, estimateKey, buildTimeline } from '../js/transcribe.js';
import { toABC, toMusicXML, toMidi, quantizedToTicks } from '../js/export.js';
import fs from 'fs';

const sr = 44100, bpm = 100, six = 60/bpm/4;
// "Twinkle twinkle" in G: G G D D E E D(half) C C B B A A G(half), plus an F# to test spelling
const mel = [[67,4],[67,4],[74,4],[74,4],[76,4],[76,4],[74,8],[72,4],[72,4],[71,4],[71,4],[69,4],[66,2],[69,2],[67,8]];
const lead = 0.4; let total = lead + mel.reduce((a,m)=>a+m[1],0)*six + 0.5;
const x = new Float32Array(Math.ceil(total*sr));
let t = lead, phase = 0;
const detune = -0.3; // singer 30 cents flat
for (const [m, d] of mel) {
  const dur = d*six, gap = 0.06;
  const a = Math.floor(t*sr), b = Math.floor((t+dur-gap)*sr);
  for (let i=a;i<b;i++){
    const tt=(i-a)/sr;
    const vib = 0.35*Math.sin(2*Math.PI*5.5*tt)*Math.min(1,tt/0.3);
    const f = 440*2**((m+detune+vib-69)/12);
    phase += 2*Math.PI*f/sr;
    const env = Math.min(1,tt/0.03)*Math.min(1,(b-i)/sr/0.03);
    x[i] = env*(0.5*Math.sin(phase)+0.3*Math.sin(2*phase)+0.15*Math.sin(3*phase)) + (Math.random()-0.5)*0.01;
  }
  t += dur;
}
console.time('track');
const { frames } = pitchTrack(x, sr);
console.timeEnd('track');
const notes = segmentNotes(frames);
console.log('notes:', notes.map(n=>n.midi).join(' '));
console.log('want :', mel.map(m=>m[0]).join(' '));
const ev = quantize(notes, { bpm, step: 1, beatsPerBar: 4 });
console.log('durs :', ev.map(n=>n.e-n.s).join(' '));
const key = estimateKey(ev); console.log('key', key);
const tl = buildTimeline(ev, 4);
const o = { bpm, beatsPerBar: 4, key, clef: 'treble', title: 'Test' };
console.log(toABC(tl, o));
fs.writeFileSync('./out.musicxml', toMusicXML(tl, o));
fs.writeFileSync('./out.mid', toMidi(quantizedToTicks(ev), { bpm }));
import { guessTempo } from '../js/transcribe.js';
console.log('guessed tempo', guessTempo(notes), '(true 100)');
