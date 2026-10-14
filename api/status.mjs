// Vercel: what this deployment can do. With READER_URL set, Audiveris on Google Cloud Run
// reads the notes (it wakes on the first request); otherwise the AI reads pages on its own.
import { aiProviders } from "../server/ai.mjs";

export function GET() {
  const ai = aiProviders({ geminiKey: process.env.GEMINI_API_KEY, groqKey: process.env.GROQ_API_KEY });
  const reader = !!process.env.READER_URL;
  return Response.json({ reader, straighten: reader, ai, hosted: true }, { headers: { "Cache-Control": "no-store" } });
}
