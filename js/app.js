import {
  pitchTrack, segmentNotes, quantize, estimateKey, keyFromName, ALL_KEYS, buildTimeline,
  yin, freqToMidi, guessTempo, spell,
} from './transcribe.js';
import { toABC, toMusicXML, toMidi, quantizedToTicks, secondsToTicks } from './export.js';

const $ = id => document.getElementById(id);
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const noteName = m => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

// ---------- settings ----------
for (const k of ALL_KEYS) $('key').add(new Option(k.endsWith('m') ? k.replace('m', ' minor') : k + ' major', k));
const settings = () => ({
  bpm: Math.min(240, Math.max(30, +$('bpm').value || 90)),
  beatsPerBar: +$('meter').value,
  step: +$('grid').value,
  key: $('key').value,
  clef: $('clef').value,
  title: $('title').value.trim() || 'My melody',
  metro: $('metro').checked,
  tuning: $('tuning').checked,
  gate: +$('gate').value,
});

// ---------- state ----------
let ctx = null;
let take = null;        // {samples, sr, anchor (sec) | null}
let trackCache = null;  // {gate, frames}
let result = null;      // latest transcription

function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
function setStatus(msg, err = false) { $('status').textContent = msg; $('status').classList.toggle('err', err); }

// ---------- metronome ----------
function click(time, accent) {
  const c = audioCtx();
  const o = c.createOscillator(), g = c.createGain();
  o.frequency.value = accent ? 1760 : 1175;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  o.connect(g).connect(c.destination);
  o.start(time); o.stop(time + 0.06);
}

// ---------- recording ----------
let rec = null; // {stream, src, proc, chunks, firstTime, countInEnd, metroTimer, analyser, raf}

async function startRecording() {
  const c = audioCtx();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    setStatus(location.protocol === 'file:'
      ? 'The microphone is blocked when the page is opened as a file. Use the online version or a local web server (see README).'
      : 'Could not use the microphone: ' + (e.message || e.name) + '. Check that the browser is allowed to use it.', true);
    return;
  }
  const s = settings();
  const src = c.createMediaStreamSource(stream);
  const proc = c.createScriptProcessor(4096, 1, 1);
  const analyser = c.createAnalyser();
  analyser.fftSize = 2048;
  const mute = c.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute).connect(c.destination);
  src.connect(analyser);
  rec = { stream, src, proc, analyser, mute, chunks: [], firstTime: null, countInEnd: null, metro: s.metro, bpm: s.bpm, beats: s.beatsPerBar };
  proc.onaudioprocess = e => {
    const d = e.inputBuffer.getChannelData(0);
    if (rec.firstTime == null) rec.firstTime = c.currentTime - d.length / c.sampleRate;
    rec.chunks.push(new Float32Array(d));
  };
  if (s.metro) {
    const beat = 60 / s.bpm;
    const t0 = c.currentTime + 0.25;
    rec.countInEnd = t0 + beat * s.beatsPerBar;
    let n = 0;
    const schedule = () => {
      while (t0 + n * beat < c.currentTime + 0.3) { click(t0 + n * beat, n % s.beatsPerBar === 0); n++; }
    };
    schedule();
    rec.metroTimer = setInterval(schedule, 50);
  }
  $('rec').classList.add('on');
  $('rec-label').textContent = 'Stop';
  $('rec').setAttribute('aria-label', 'Stop recording');
  setStatus(s.metro ? `Count-in: ${s.beatsPerBar} clicks, then sing.` : 'Recording… sing now.');
  liveLoop();
}

function liveLoop() {
  if (!rec) return;
  const c = ctx, a = rec.analyser;
  const buf = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(buf);
  let rms = 0; for (const v of buf) rms += v * v; rms = Math.sqrt(rms / buf.length);
  $('meter-fill').style.width = Math.min(100, rms * 400) + '%';
  const el = $('live-note');
  if (rec.metro && c.currentTime < rec.countInEnd) {
    const left = Math.ceil((rec.countInEnd - c.currentTime) / (60 / rec.bpm));
    el.textContent = left; el.classList.add('beat');
  } else {
    el.classList.remove('beat');
    if (rec.metro && el.dataset.go !== '1') { setStatus('Recording… sing now. Press Stop when you are done.'); el.dataset.go = '1'; }
    const p = rms > 0.01 ? yin(buf, c.sampleRate) : null;
    if (p && p.conf > 0.8) {
      const m = freqToMidi(p.freq), r = Math.round(m), cents = Math.round((m - r) * 100);
      el.textContent = `${noteName(r)} ${cents >= 0 ? '+' : ''}${cents}¢`;
    } else el.textContent = '·';
  }
  rec.raf = requestAnimationFrame(liveLoop);
}

function stopRecording() {
  const r = rec; rec = null;
  cancelAnimationFrame(r.raf);
  clearInterval(r.metroTimer);
  r.proc.onaudioprocess = null;
  r.src.disconnect(); r.proc.disconnect(); r.mute.disconnect();
  r.stream.getTracks().forEach(t => t.stop());
  $('rec').classList.remove('on');
  $('rec-label').textContent = 'Record again';
  $('rec').setAttribute('aria-label', 'Start recording');
  $('live-note').textContent = '–'; $('live-note').dataset.go = '';
  $('meter-fill').style.width = '0';
  const len = r.chunks.reduce((a, b) => a + b.length, 0);
  const samples = new Float32Array(len);
  let o = 0; for (const ch of r.chunks) { samples.set(ch, o); o += ch.length; }
  if (len < ctx.sampleRate * 0.3) { setStatus('That was too short. Try again.', true); return; }
  const anchor = r.metro && r.firstTime != null ? r.countInEnd - r.firstTime : null;
  loadTake({ samples, sr: ctx.sampleRate, anchor });
}

$('rec').onclick = () => (rec ? stopRecording() : startRecording());

// ---------- file input ----------
$('file').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  setStatus('Reading ' + f.name + '…');
  try {
    const buf = await f.arrayBuffer();
    const audio = await audioCtx().decodeAudioData(buf);
    const n = audio.length, mono = new Float32Array(n);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const d = audio.getChannelData(ch);
      for (let i = 0; i < n; i++) mono[i] += d[i] / audio.numberOfChannels;
    }
    loadTake({ samples: mono, sr: audio.sampleRate, anchor: null, name: f.name });
  } catch (err) {
    setStatus('Could not read that file. Try a WAV, MP3, M4A or OGG.', true);
  }
  e.target.value = '';
};

// ---------- transcription ----------
function loadTake(t) {
  take = t; trackCache = null;
  setStatus('Listening back…');
  setTimeout(() => {
    analyse();
    if (take.anchor == null && result && result.notes.length >= 4) {
      const g = guessTempo(result.notes);
      if (g) { $('bpm').value = g; analyse(); }
      setStatus(`Done. No metronome, so the tempo was guessed as ${$('bpm').value} BPM. Change it in Settings if the rhythm looks off.`);
    } else if (result) {
      setStatus(result.notes.length ? 'Done! Scroll down for your sheet music.' : 'No notes found. Sing louder or move “Ignore quiet sounds” to the left.', !result.notes.length);
    }
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 30);
}

function analyse() {
  if (!take) return;
  const s = settings();
  if (!trackCache || trackCache.gate !== s.gate) {
    trackCache = { gate: s.gate, ...pitchTrack(take.samples, take.sr, { gateRatio: s.gate }) };
  }
  const frames = trackCache.frames;
  const notes = segmentNotes(frames, { tuning: s.tuning });
  const events = quantize(notes, { bpm: s.bpm, step: s.step, beatsPerBar: s.beatsPerBar, anchor: take.anchor, fillGaps: true });
  const key = s.key === 'auto' ? estimateKey(events) : keyFromName(s.key);
  const med = events.length ? events.map(e => e.midi).sort((a, b) => a - b)[Math.floor(events.length / 2)] : 67;
  const clef = s.clef === 'auto' ? (med < 57 ? 'bass' : 'treble') : s.clef;
  const timeline = buildTimeline(events, s.beatsPerBar);
  const opts = { title: s.title, bpm: s.bpm, beatsPerBar: s.beatsPerBar, key, clef };
  const abc = toABC(timeline, opts);
  result = { frames, notes, events, key, clef, timeline, opts, abc, s };
  render();
}

function render() {
  const r = result;
  $('result').classList.remove('hidden');
  $('abc').value = r.abc;
  window.ABCJS.renderAbc('sheet', r.abc, { responsive: 'resize', staffwidth: 900, paddingtop: 10, paddingbottom: 10 });
  const lo = r.events.length ? Math.min(...r.events.map(e => e.midi)) : 0;
  const hi = r.events.length ? Math.max(...r.events.map(e => e.midi)) : 0;
  $('summary').textContent = r.events.length
    ? `${r.events.length} notes · key ${r.key.name.replace(/m$/, ' minor')}${r.key.name.endsWith('m') ? '' : ' major'} · range ${noteName(lo)}–${noteName(hi)} · ${r.opts.bpm} BPM`
    : 'No notes detected.';
  drawRoll();
}

function drawRoll() {
  const cv = $('roll'), r = result;
  const W = cv.clientWidth || 900, H = 220, dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const pitched = r.frames.filter(f => f.midi != null);
  if (!pitched.length) return;
  const all = pitched.map(f => f.midi);
  let lo = Math.floor(Math.min(...all)) - 2, hi = Math.ceil(Math.max(...all)) + 2;
  if (hi - lo < 12) { const c = (hi + lo) / 2; lo = Math.floor(c - 6); hi = Math.ceil(c + 6); }
  const tEnd = r.frames[r.frames.length - 1].t;
  const X = t => 34 + (t / tEnd) * (W - 40), Y = m => H - 10 - ((m - lo) / (hi - lo)) * (H - 20);
  g.font = '10px system-ui'; g.fillStyle = '#999'; g.strokeStyle = '#ece9e1';
  for (let m = Math.ceil(lo); m <= hi; m++) {
    g.beginPath(); g.moveTo(34, Y(m)); g.lineTo(W, Y(m)); g.lineWidth = m % 12 === 0 ? 1.2 : 0.5; g.stroke();
    if (m % 12 === 0 || hi - lo <= 16) g.fillText(noteName(m).replace(/\d/, d => d), 2, Y(m) + 3);
  }
  g.fillStyle = 'rgba(47,111,222,.28)'; g.strokeStyle = '#2f6fde'; g.lineWidth = 1;
  for (const n of r.notes) {
    const y = Y(n.midi);
    g.fillRect(X(n.start), y - 5, Math.max(2, X(n.end) - X(n.start)), 10);
    g.strokeRect(X(n.start), y - 5, Math.max(2, X(n.end) - X(n.start)), 10);
  }
  g.fillStyle = '#555';
  for (const f of pitched) g.fillRect(X(f.t), Y(f.midi) - 1, 1.6, 2);
}

for (const id of ['bpm', 'meter', 'grid', 'key', 'clef', 'title', 'tuning', 'gate'])
  $(id).addEventListener(id === 'title' || id === 'bpm' ? 'input' : 'change', () => { if (take) analyse(); });
window.addEventListener('resize', () => { if (result) drawRoll(); });

// ---------- playback ----------
let playing = [];
function stopPlayback() { playing.forEach(n => { try { n.stop(); } catch {} }); playing = []; }

$('play').onclick = () => {
  stopPlayback();
  if (!result || !result.events.length) return;
  const c = audioCtx(), six = 60 / result.opts.bpm / 4, t0 = c.currentTime + 0.1;
  for (const e of result.events) {
    const st = t0 + e.s * six, en = t0 + e.e * six;
    const o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain();
    o.type = 'triangle'; o2.type = 'sine';
    o.frequency.value = 440 * 2 ** ((e.midi - 69) / 12); o2.frequency.value = o.frequency.value * 2;
    g.gain.setValueAtTime(0.0001, st);
    g.gain.exponentialRampToValueAtTime(0.25, st + 0.02);
    g.gain.setTargetAtTime(0.15, st + 0.03, 0.1);
    g.gain.setTargetAtTime(0.0001, Math.max(st + 0.03, en - 0.03), 0.02);
    const g2 = c.createGain(); g2.gain.value = 0.15;
    o.connect(g); o2.connect(g2).connect(g); g.connect(c.destination);
    o.start(st); o2.start(st); o.stop(en + 0.15); o2.stop(en + 0.15);
    playing.push(o, o2);
  }
};
$('play-orig').onclick = () => {
  stopPlayback();
  if (!take) return;
  const c = audioCtx();
  const b = c.createBuffer(1, take.samples.length, take.sr);
  b.copyToChannel(take.samples, 0);
  const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start();
  playing.push(s);
};

// ---------- downloads ----------
const safeName = () => (result.opts.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'melody');
function download(data, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const midiOpts = () => ({ bpm: result.opts.bpm, beatsPerBar: result.opts.beatsPerBar, title: result.opts.title,
  fifths: result.key.fifths, minor: result.key.name.endsWith('m') });
$('dl-midi').onclick = () => result && download(toMidi(quantizedToTicks(result.events), midiOpts()), safeName() + '.mid', 'audio/midi');
$('dl-midi-raw').onclick = () => result && download(toMidi(secondsToTicks(result.notes, result.opts.bpm), midiOpts()), safeName() + '-natural.mid', 'audio/midi');
$('dl-xml').onclick = () => result && download(toMusicXML(result.timeline, result.opts), safeName() + '.musicxml', 'application/vnd.recordare.musicxml+xml');
$('print').onclick = () => window.print();

if (!navigator.mediaDevices?.getUserMedia) {
  $('rec').disabled = true;
  setStatus('This browser cannot record from the microphone. You can still open an audio file below.', true);
}

// expose for debugging / automated tests
window.__sing2midi = { loadTake, get result() { return result; }, spell };
