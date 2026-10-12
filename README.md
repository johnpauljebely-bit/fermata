# Fermata

Take a photo (or pick a PDF) of sheet music and hear it on piano, with dynamics, crescendos,
accents, staccatos, fermatas and rit./accel. Plus a tuner, vocal warm-ups with feedback, and
"sing this note" coaching.

It runs two ways:

| | **On your Mac** (`npm run dev`) | **On Vercel** |
|---|---|---|
| Reads notes with | Audiveris + AI check | AI (Gemini, Groq as backup) |
| Page straightening | yes | – |
| "Your pages" view | yes | clean score only |
| Tuner, warm-ups, sing a note | yes | yes |

## Deploy on Vercel

1. Import this repo in Vercel (it detects Vite; `vercel.json` sets everything else).
2. Settings → **Environment Variables**: add `GEMINI_API_KEY` (and optionally `GROQ_API_KEY`).
3. Deploy. The `api/` folder becomes the serverless functions (`/api/status`, `/api/read`).

Photos are shrunk in the browser before upload (Vercel accepts up to 4.5 MB per request).
PDFs need the Gemini key.

## Run it on your Mac

```bash
npm install
npm run dev
```

Install [Audiveris](https://github.com/Audiveris/audiveris) in /Applications and ImageMagick
(`brew install imagemagick`) for the full reader. Create `.env.local` with your keys:

```
GEMINI_API_KEY=...
GROQ_API_KEY=...
```

On your phone open **https://<your-mac's-wifi-address>:5190** (`ipconfig getifaddr en0`). The first
time, Safari warns the connection isn't private: that's the Mac's own home-made certificate. Tap
*Show Details → visit this website*. It has to be https, or the phone won't allow the microphone.
Tip: Share → *Add to Home Screen*.

Keys stay server-side (never sent to the phone, never committed) and only go to Google / Groq.

## How it reads music

1. **Audiveris** (Mac) reads the notes. Photos are turned upright, converted (HEIC too) and
   **straightened** first, so curved or tilted lines aren't skipped.
2. **The AI** looks at the page images with a long music-reading reference
   (`server/knowledge.md`: clefs and *Every Good Boy Deserves Fudge* / *FACE* / *Good Boys Do Fine
   Always* / *All Cows Eat Grass*, key signatures, rhythm, dynamics, hairpins, articulations, tempo
   words…) and returns tempo, dynamics, crescendos, articulations, rit./accel. and wrong notes.
   These are applied to the score, drawn on it, and played. Without Audiveris (Vercel) the AI
   transcribes the page itself.

After editing `server/knowledge.md`, run `npm run knowledge` to rebuild the bundled copy.

## Using it

- **Your pages** (Mac, default): your own page with the playing bar lit up and a cursor on the
  beat. **Clean score** shows the engraved version.
- **Tap a note** to hear it, then *Play from here*. **Hold a note** (phone) or **right-click**
  (computer) to **sing it**: a live ladder shows your voice against the note, "go higher / lower",
  whether you're in another octave (that counts), and an *octave down / up* suggestion if you keep
  cracking or can't reach it.
- **Pick notes** to play only the ones you choose. Part buttons mute/unmute staves; the ruler
  changes speed.
- **Tuner**: the note you're singing, how sharp or flat, and the last few seconds of pitch.
- **Warm-ups**: notes scroll towards you as bars and your voice is drawn over them. Afterwards you
  get a score and tips; drag back through your take and tap any bar to see how that note went and
  what to work on. Optional sheet music. Use headphones so the mic hears you.

## Credits

- Piano: [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander
  Holm, CC BY 3.0.
- [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org), [Tone.js](https://tonejs.github.io),
  [pitchy](https://github.com/ianprime0509/pitchy), [Audiveris](https://github.com/Audiveris/audiveris).
- Fonts: [Doto](https://fonts.google.com/specimen/Doto) and
  [Inter Tight](https://fonts.google.com/specimen/Inter+Tight).
