// The admin dashboard's API (admin.tryfermata.app). One password, set as ADMIN_PASSWORD in
// Vercel; signing in sets a week-long, http-only cookie.
//   POST /api/admin?do=login  {password}   POST /api/admin?do=logout   GET /api/admin  → stats
import { adminReady, clearCookie, loginAllowed, passwordMatches, sessionCookie, signedIn, stats, storageReady } from "../server/analytics.mjs";

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function POST(request) {
  const action = new URL(request.url).searchParams.get("do");
  if (action === "logout") return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  if (action !== "login") return json({ error: "Unknown action." }, 400);
  if (!adminReady()) return json({ error: "Set ADMIN_PASSWORD (8+ characters) in Vercel first." }, 503);
  if (!(await loginAllowed(request))) return json({ error: "Too many tries. Wait 15 minutes." }, 429);
  const { password } = (await request.json().catch(() => ({}))) ?? {};
  if (!passwordMatches(password)) return json({ error: "Wrong password." }, 401);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie() });
}

export async function GET(request) {
  if (!signedIn(request)) return json({ error: "Sign in first." }, 401);
  if (!storageReady()) return json({ error: "storage", message: "Analytics storage isn't connected yet." }, 503);
  const days = Math.min(90, Math.max(7, Number(new URL(request.url).searchParams.get("days")) || 30));
  try {
    return json(await stats(days));
  } catch (error) {
    return json({ error: error.message }, 502);
  }
}
