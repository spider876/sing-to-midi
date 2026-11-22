# 🎤 Sing to MIDI

Sing a melody into your microphone and get **sheet music**, a **MIDI file** and a **MusicXML file**. Everything runs in your browser. Your voice is never uploaded anywhere.

**▶ Use it here: https://spider876.github.io/sing-to-midi/**

## How to use it

1. Open the link above in Chrome, Edge, Firefox or Safari (computer or phone).
2. Set the **Tempo** you want to sing at. Leave **Metronome + count-in** ticked, and wear headphones if you can.
3. Press **Record** and allow the microphone. You'll hear one bar of clicks; then sing your melody on "da" or "la".
4. Press **Stop**. Your sheet music appears below.
5. Press **⬇ MIDI** to save the MIDI file (for GarageBand, FL Studio, Ableton, etc.) or **⬇ MusicXML** to open the score in MuseScore, Sibelius, Finale or Dorico. **🖨 Print / PDF** saves the sheet music as a PDF.

You can also **open an audio file** (WAV, MP3, M4A…) instead of recording.

## Settings (change them after recording; the result updates instantly)

| Setting | What it does |
|---|---|
| Tempo | Beats per minute. Without the metronome, the app guesses it for you. |
| Time signature | 4/4, 3/4 or 2/4. |
| Shortest note | The rhythm grid. 8th notes is a good default. Use 16th for fast runs, quarter for slow tunes. |
| Key | Auto-detected, or pick one yourself to control sharps/flats. |
| Clef | Treble or bass. Auto picks bass for low voices. |
| Adjust to my tuning | Corrects for singing a little sharp or flat overall. |
| Ignore quiet sounds | Slide right if background noise turns into notes; left if quiet notes go missing. |

Two MIDI options: **MIDI** matches the sheet music (snapped to the beat). **MIDI (natural timing)** keeps exactly how you sang it.

## How it works

1. The audio is resampled to 16 kHz and run through the **YIN** pitch detector every 10 ms.
2. Pitch frames are grouped into notes (a new note starts when the pitch moves more than ~¾ of a semitone and stays there for 40 ms; short silences end a note). Vibrato and small wobbles are ignored.
3. Notes are snapped to a beat grid (anchored to the metronome count-in, or to your first note).
4. The key is estimated with the Krumhansl–Schmuckler method, preferring keys that need fewer accidentals.
5. Notes are spelled with proper key signatures, accidentals, ties across bar lines and beat-aware note splitting, then drawn with [abcjs](https://www.abcjs.net/) and written out as standard MIDI and MusicXML files.

## Limits

- One voice, one note at a time. It can't transcribe chords or a song with backing music.
- Rhythm is only as steady as the singing. Using the metronome helps a lot.
- Very fast ornaments may get merged or dropped. Choose 16th notes for "Shortest note" if you need them.

## Running it yourself

It's a plain static site with no build step. The microphone needs `https://` or `localhost`, so serve the folder instead of double-clicking `index.html`:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

Files: `index.html`, `style.css`, `js/transcribe.js` (pitch detection, note finding, quantizing, key), `js/export.js` (ABC, MusicXML, MIDI writers), `js/app.js` (recording, UI, playback), `vendor/abcjs-basic-min.js` (sheet music renderer, MIT licence).

## Licence

MIT
