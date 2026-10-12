// Vercel: what this deployment can do. No Audiveris here, so pages are read by the AI alone.
import { aiProviders } from "../server/ai.mjs";

export function GET() {
  const ai = aiProviders({ geminiKey: process.env.GEMINI_API_KEY, groqKey: process.env.GROQ_API_KEY });
  return Response.json({ reader: false, straighten: false, ai, hosted: true }, { headers: { "Cache-Control": "no-store" } });
}
