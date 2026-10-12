// Vercel: read a photo/PDF with the AI in one request (serverless functions keep no jobs,
// so this answers when it's done instead of handing out a job id to poll).
// The app shrinks photos before sending them; Vercel accepts up to 4.5 MB per request.
import { aiProviders, askAI } from "../server/ai.mjs";


function sniff(b) {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/heic";
  return null;
}

const done = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  const started = Date.now();
  const keys = { geminiKey: process.env.GEMINI_API_KEY, groqKey: process.env.GROQ_API_KEY };
  const providers = aiProviders(keys);
  if (!providers.gemini && !providers.groq) {
    return done({ error: "This deployment has no AI key yet. Add GEMINI_API_KEY (and/or GROQ_API_KEY) in Vercel → Settings → Environment Variables." }, 503);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  const mime = sniff(bytes);
  if (!mime) return done({ error: "That isn't a photo or a PDF." }, 415);
  if (mime === "application/pdf" && !providers.gemini) return done({ error: "Reading PDFs needs a Gemini key. Send a photo instead." }, 415);

  const base = { phase: "ai", progress: 1, pages: 1, queuePosition: 0, pieces: [], pageCount: 0, layout: null };
  try {
    const ai = await askAI(keys, "transcribe", "(no reader result: read the page yourself)", [{ mime, base64: Buffer.from(bytes).toString("base64") }]);
    return done({ ...base, state: "done", seconds: Math.round((Date.now() - started) / 1000), error: null, ai: { mode: "transcribe", ...ai }, aiError: null });
  } catch (error) {
    return done({ ...base, state: "error", seconds: Math.round((Date.now() - started) / 1000), error: `The AI couldn't read that page: ${error.message}` });
  }
}
