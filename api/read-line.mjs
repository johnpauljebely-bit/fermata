// Vercel: reads ONE line of music (a crop of the page) with the AI, guided by what
// Fermata's own page reader measured (sent as ?hint=…). Small and fast, so the app can read
// a page line by line, several at once.
import { aiProviders, askAI } from "../server/ai.mjs";

const done = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  const keys = { geminiKey: process.env.GEMINI_API_KEY, groqKey: process.env.GROQ_API_KEY };
  const providers = aiProviders(keys);
  if (!providers.gemini && !providers.groq) return done({ error: "No AI key on this deployment yet." }, 503);
  const hint = (new URL(request.url).searchParams.get("hint") ?? "").slice(0, 3000);
  const bytes = Buffer.from(await request.arrayBuffer());
  if (!bytes.length) return done({ error: "Empty image." }, 400);
  try {
    const ai = await askAI(keys, "line", `DETECTOR:\n${hint}`, [{ mime: "image/jpeg", base64: bytes.toString("base64") }]);
    return done({ provider: ai.provider, model: ai.model, result: ai.result });
  } catch (error) {
    return done({ error: error.message }, 502);
  }
}
