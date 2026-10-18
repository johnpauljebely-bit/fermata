// Vercel: read a photo/PDF with the AI in one request (serverless functions keep no jobs,
// so this answers when it's done instead of handing out a job id to poll).
// The app shrinks photos before sending them; Vercel accepts up to 4.5 MB per request.
import { aiProviders, askAI } from "../server/ai.mjs";
import { trackReading } from "../server/analytics.mjs";


function sniff(b) {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/heic";
  return null;
}

const done = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const READER = (process.env.READER_URL ?? "").replace(/\/$/, "");

export async function POST(request) {
  const started = Date.now();
  const bytes = new Uint8Array(await request.arrayBuffer());
  // A hosted reader (Audiveris on Google Cloud Run) is configured: it reads the page within
  // this one request and answers with the finished reading, page images included. If it
  // can't read the page, the AI below transcribes it instead.
  if (READER) {
    try {
      const res = await fetch(`${READER}/api/read-sync${new URL(request.url).search}`, {
        method: "POST",
        headers: { "x-fermata-key": process.env.READER_SECRET ?? "", "Content-Type": "application/octet-stream" },
        body: bytes,
        signal: AbortSignal.timeout(200_000), // leave time for the AI
      });
      const reading = await res.json().catch(() => null);
      if (reading?.state === "done") {
        await trackReading(request, { ok: true, how: "reader", kind: kindOf(bytes), seconds: (Date.now() - started) / 1000 });
        return done(reading);
      }
      console.log(`Reader couldn't read it (${reading?.error ?? res.status}); asking the AI`);
    } catch (error) {
      console.log(`Reader unavailable (${error.message}); asking the AI`);
    }
  }
  const answer = await transcribe(request, bytes, started);
  const body = await answer.clone().json().catch(() => ({}));
  await trackReading(request, { ok: body.state === "done", how: body.state === "done" ? "ai" : "none", kind: kindOf(bytes), seconds: (Date.now() - started) / 1000, error: body.error });
  return answer;
}

const kindOf = (bytes) => (sniff(bytes) === "application/pdf" ? "pdf" : "photo");

async function transcribe(request, bytes, started) {
  const keys = { geminiKey: process.env.GEMINI_API_KEY, groqKey: process.env.GROQ_API_KEY };
  const providers = aiProviders(keys);
  if (!providers.gemini && !providers.groq) {
    return done({ error: "This deployment has no AI key yet. Add GEMINI_API_KEY (and/or GROQ_API_KEY) in Vercel → Settings → Environment Variables." }, 503);
  }
  // Fermata's page reader (in the browser) sends how many lines and bars the page has.
  const hint = (new URL(request.url).searchParams.get("hint") ?? "").slice(0, 2000);
  const mime = sniff(bytes);
  if (!mime) return done({ error: "That isn't a photo or a PDF." }, 415);
  if (mime === "application/pdf" && !providers.gemini) return done({ error: "Reading PDFs needs a Gemini key. Send a photo instead." }, 415);

  const base = { phase: "ai", progress: 1, pages: 1, queuePosition: 0, pieces: [], pageCount: 0, layout: null };
  try {
    const ai = await askAI(keys, "transcribe", hint || "(no reader result: read the page yourself)", [{ mime, base64: Buffer.from(bytes).toString("base64") }]);
    return done({ ...base, state: "done", seconds: Math.round((Date.now() - started) / 1000), error: null, ai: { mode: "transcribe", ...ai }, aiError: null });
  } catch (error) {
    return done({ ...base, state: "error", seconds: Math.round((Date.now() - started) / 1000), error: `The AI couldn't read that page: ${error.message}` });
  }
}
