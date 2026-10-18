// Counts one app event for Fermata's own analytics (see server/analytics.mjs). Always answers 204.
import { track } from "../server/analytics.mjs";

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (body && typeof body.n === "string") await track(request, body.n, { ref: body.r });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
