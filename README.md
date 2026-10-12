# Fermata

Take a photo (or pick a PDF) of sheet music on your phone and hear it on piano, with dynamics,
crescendos, accents, staccatos, fermatas and rit./accel. Plus a tuner, vocal warm-ups, and
"sing this note" coaching.

Everything runs on your Mac; your phone just opens a web page on the same Wi-Fi.

## Start it

```bash
cd ~/snap-play && npm run dev
```

On your phone open **https://192.168.1.81:5190** (your Mac's Wi-Fi address; `ipconfig getifaddr en0` shows it).
The first time, Safari warns that the connection isn't private. That's the Mac's own
home-made certificate. Tap *Show Details → visit this website*. It has to be https, or the phone won't
allow the microphone. Tip: Share → *Add to Home Screen* to open it like an app.

## AI keys (optional, makes it much smarter)

Open `.env.local` in this folder and paste your keys after the `=`:

```
GEMINI_API_KEY=...
GROQ_API_KEY=...
```

Save, and the server picks them up by itself. Keys stay on the Mac (never sent to the phone)
and are only ever sent to Google / Groq. Gemini goes first; Groq is the backup.

## How it reads music

1. **Audiveris** (free, installed in /Applications) reads the notes. Photos are turned
   upright, converted (HEIC too) and **straightened** first, so curved or tilted lines aren't skipped.
2. **The AI** looks at the same page images with a long music-reading reference
   (`server/knowledge.md`: clefs and *Every Good Boy Deserves Fudge* / *FACE* / *Good Boys Do Fine
   Always* / *All Cows Eat Grass*, key signatures, rhythm, dynamics, hairpins, articulations,
   tempo words…) and returns the tempo, dynamics, crescendos, articulations, rit./accel. and any
   notes the reader got wrong. These are applied to the score and drawn on it.
3. No Audiveris? The AI transcribes the page on its own.

Tap **AI checked** at the top of a score to see what it found and fixed.

## Using it

- **Tap a note** to hear it. *Play from here* plays from that note.
- **Hold a note** (phone) or **right-click** (computer) to **sing it**: a live ladder shows
  your voice against the note, with "go higher / lower", whether you're in another octave
  (that counts), and an *octave down / up* suggestion if you keep cracking or can't reach it.
- **Pick notes** to choose several and play only those.
- Part chips mute/unmute staves; the slider changes speed.
- **Tuner** and **Warm-ups** tabs at the bottom. Warm-ups go up a semitone each round
  and come back down, in Low / Middle / High voice ranges.

Use headphones for warm-ups so the mic hears you, not the piano.
