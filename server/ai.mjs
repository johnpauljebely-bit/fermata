// The AI half of the reader: Gemini (preferred) or Groq look at the page images, check the
// music reader's notes with a full music-reading reference, and report tempo, dynamics,
// articulations and fixes — or transcribe the page themselves when the reader isn't available.
// Keys come from .env.local on this computer and are only ever sent to Google / Groq.

import { execFileSync } from "node:child_process";
import { KNOWLEDGE } from "./knowledge.mjs";

// Groq's free tier allows ~7,000 input tokens a minute: send it the essential sections only.
const SHORT_SECTIONS = /^## (1|2|3|4|5|6|9)\./;
const KNOWLEDGE_SHORT = KNOWLEDGE.split(/(?=^## )/m)
  .filter((part, i) => i === 0 || SHORT_SECTIONS.test(part))
  .join("")
  .replace(/\n{3,}/g, "\n\n");

/** Shrinks a page image (Groq counts image pixels against that budget). */
function shrink(img, maxSide) {
  if (!img.mime.startsWith("image/")) return img;
  for (const bin of ["magick", "/opt/homebrew/bin/magick", "/usr/local/bin/magick"]) {
    try {
      const out = execFileSync(bin, ["-", "-resize", `${maxSide}x${maxSide}>`, "-colorspace", "Gray", "png:-"], {
        input: Buffer.from(img.base64, "base64"),
        maxBuffer: 1 << 27,
      });
      return { mime: "image/png", base64: out.toString("base64") };
    } catch {
      // try the next path
    }
  }
  return img;
}
const TIMEOUT_MS = 150_000;

const EXPRESSION_SCHEMA = `"expressions": [
    // one object per marking you can see; measure = bar number (1-based, playing order); beat = 1-based beat in the bar (decimals ok)
    { "type": "dynamic", "value": "ppp|pp|p|mp|mf|f|ff|fff|sfz|fp", "measure": 1, "beat": 1, "part": 1 },
    { "type": "crescendo" | "diminuendo", "measure": 4, "beat": 1, "endMeasure": 6, "endBeat": 1, "part": 1 },
    { "type": "articulation", "value": "staccato|accent|marcato|tenuto|fermata", "measure": 2, "beat": 3, "part": 1 },
    { "type": "tempo", "bpm": 96, "text": "Moderato", "measure": 1, "beat": 1 },
    { "type": "ritardando" | "accelerando", "measure": 30, "beat": 1, "endMeasure": 32, "endBeat": 4 }
  ]`;

const CHECK_TASK = `TASK: check the music reader's transcription (below) against the page image(s) and report what playback needs.

Reply with ONE JSON object, nothing else:
{
  "title": string | null,
  "composer": string | null,
  "tempo": { "bpm": number | null, "text": string | null },
  "key": { "fifths": number, "mode": "major" | "minor" } | null,
  "time": { "beats": number, "beatType": number } | null,
  ${EXPRESSION_SCHEMA},
  "noteFixes": [ { "measure": 5, "part": 1, "beat": 2, "from": "E4", "to": "F#4", "reason": "short reason" } ],
  "skippedMeasures": [ { "afterMeasure": 12, "count": 2, "where": "page 1, line 3" } ],
  "confidence": "high" | "medium" | "low",
  "notes": "one or two sentences for the musician: what you checked and anything uncertain"
}

Rules: use the reader's bar numbers. Only list a noteFix when the image clearly shows a different pitch at that bar/beat (pitch names like "Bb3", "F#4"). If there's no tempo mark, estimate bpm from the style and say so in notes. Use the mnemonics and checks in the reference.`;

const TRANSCRIBE_TASK = `TASK: no automatic reader result is available. Transcribe the music in the image(s) yourself, as accurately as you can, for piano playback.

Reply with ONE JSON object, nothing else:
{
  "title": string | null,
  "composer": string | null,
  "tempo": { "bpm": number | null, "text": string | null },
  "key": { "fifths": number, "mode": "major" | "minor" },
  "time": { "beats": number, "beatType": number },
  "parts": [
    {
      "name": "Voice",
      "clef": "treble" | "bass" | "treble8vb",
      "measures": [
        { "events": [ { "pitches": ["E4"], "duration": "quarter", "dots": 0, "tieToNext": false } ] }
      ]
    }
  ],
  ${EXPRESSION_SCHEMA},
  "confidence": "high" | "medium" | "low",
  "notes": "one or two sentences for the musician"
}

Rules: "pitches" is [] for a rest; several pitches = a chord. duration is one of whole, half, quarter, eighth, 16th, 32nd. Apply the key signature and accidentals yourself (write the sounding pitch, e.g. "F#4"). Every bar of every part must add up to the time signature (a pickup bar may be shorter). All parts must have the same number of bars; staves bracketed together on one line play at the same time. Read every line on every page in order — do not skip lines.`;

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("The AI didn't return valid JSON.");
  }
}

async function fetchJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// Busy / rate-limited / temporarily unavailable: worth trying the next model.
const isBusy = (e) => /high demand|overloaded|unavailable|try again|rate limit|quota|resource.?exhausted|HTTP (429|500|502|503|504)/i.test(e.message);

// ---------- Gemini ----------

let geminiModels = null;
async function rankGeminiModels(key) {
  if (geminiModels) return geminiModels;
  const body = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
  const usable = (body.models ?? []).filter(
    (m) =>
      m.supportedGenerationMethods?.includes("generateContent") &&
      /^models\/gemini-\d/.test(m.name) &&
      !/(tts|image|live|embedding|audio|robotics|learnlm|gemma|omni|transcribe|nano|computer-use|customtools|lyria)/.test(m.name),
  );
  const version = (n) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0);
  // Flash first (fast, great at reading pages), then pro; lite and previews last.
  const rank = (n) => (/flash/.test(n) ? 2 : /pro/.test(n) ? 1 : 0) - (/lite/.test(n) ? 1.5 : 0) - (/preview|exp/.test(n) ? 0.5 : 0);
  usable.sort((a, b) => rank(b.name) - rank(a.name) || version(b.name) - version(a.name));
  if (!usable.length) throw new Error("Your Gemini key has no models that can read images.");
  geminiModels = usable.map((m) => m.name).slice(0, 6);
  return geminiModels;
}

async function askGemini(key, task, context, images) {
  const errors = [];
  for (const model of await rankGeminiModels(key)) {
    let thinking = true;
    for (let attempt = 0; attempt < 2; attempt++)
    try {
      const body = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: KNOWLEDGE }] },
          contents: [{ role: "user", parts: [{ text: `${task}\n\n${context}` }, ...images.map((img) => ({ inline_data: { mime_type: img.mime, data: img.base64 } }))] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
            // Long "thinking" makes a page take minutes; a little is plenty for checking.
            ...(thinking ? { thinkingConfig: /gemini-2\./.test(model) ? { thinkingBudget: 2048 } : { thinkingLevel: "low" } } : {}),
          },
        }),
      });
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      return { provider: "Gemini", model: model.replace("models/", ""), result: parseJson(text) };
    } catch (error) {
      // A model that doesn't take the thinking setting: ask again without it.
      if (thinking && /thinking/i.test(error.message)) {
        thinking = false;
        continue;
      }
      errors.push(`${model.replace("models/", "")}: ${error.message}`);
      if (!isBusy(error)) return Promise.reject(new Error(errors.join(" / ")));
      break;
    }
  }
  throw new Error(errors.join(" / "));
}

// ---------- Groq ----------

let groqModels = null;
async function rankGroqModels(key) {
  if (groqModels) return groqModels;
  const body = await fetchJson("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  const ids = (body.data ?? []).map((m) => m.id);
  // Models that can look at images: Llama 4 (Maverick/Scout), vision models, Qwen.
  const score = (id) => (/maverick/.test(id) ? 5 : /scout/.test(id) ? 4 : /vision|vl\b|-vl/.test(id) ? 3 : /qwen/.test(id) ? 2 : /llama-4/.test(id) ? 1 : 0);
  const vision = ids.filter((id) => score(id) > 0 && !/guard|whisper|orpheus/.test(id)).sort((a, b) => score(b) - score(a));
  if (!vision.length) throw new Error("Your Groq account has no image-reading models available.");
  groqModels = vision.slice(0, 3);
  return groqModels;
}

async function askGroq(key, task, context, images) {
  const errors = [];
  for (const model of await rankGroqModels(key)) {
    try {
      const body = await fetchJson("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: KNOWLEDGE_SHORT },
            {
              role: "user",
              content: [
                { type: "text", text: `${task}\n\n${context}` },
                // Groq accepts a handful of images per request; smaller pages fit the free tier.
                ...images
                  .filter((img) => img.mime.startsWith("image/"))
                  .slice(0, 3)
                  .map((img) => shrink(img, images.length > 1 ? 900 : 1100))
                  .map((img) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.base64}` } })),
              ],
            },
          ],
        }),
      });
      // Thinking models may wrap their answer in <think>…</think>.
      const text = (body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
      return { provider: "Groq", model, result: parseJson(text) };
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
      if (!isBusy(error)) break;
    }
  }
  throw new Error(errors.join(" / "));
}

// ---------- public ----------

export function aiProviders(keys) {
  return { gemini: Boolean(keys.geminiKey), groq: Boolean(keys.groqKey) };
}

/**
 * @param {{geminiKey?: string, groqKey?: string}} keys
 * @param {"check" | "transcribe"} mode
 * @param {string} context  e.g. the reader's bar-by-bar transcription
 * @param {{ mime: string, base64: string }[]} images  page images (or a PDF for Gemini)
 */
export async function askAI(keys, mode, context, images) {
  const task = mode === "check" ? CHECK_TASK : TRANSCRIBE_TASK;
  const errors = [];
  if (keys.geminiKey) {
    try {
      return await askGemini(keys.geminiKey, task, context, images);
    } catch (error) {
      errors.push(`Gemini: ${error.message}`);
    }
  }
  if (keys.groqKey) {
    try {
      return await askGroq(keys.groqKey, task, context, images);
    } catch (error) {
      errors.push(`Groq: ${error.message}`);
    }
  }
  throw new Error(errors.join(" · ") || "No AI key set.");
}
