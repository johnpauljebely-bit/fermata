// Vercel → hosted reader (Hugging Face Space) for /api/read/<id>, /api/read/<id>/page/<n>
// and /api/read/<id>/cancel. Adds the shared secret; the browser never sees it.
const READER = (process.env.READER_URL ?? "").replace(/\/$/, "");

async function forward(request) {
  if (!READER) return Response.json({ error: "No reader configured." }, { status: 404 });
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!/^[0-9a-f-]{36}(\/page\/\d+|\/cancel)?$/.test(path)) return Response.json({ error: "Not found" }, { status: 404 });
  const res = await fetch(`${READER}/api/read/${path}`, {
    method: request.method,
    headers: { "x-fermata-key": process.env.READER_SECRET ?? "" },
    cache: "no-store",
  });
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" },
  });
}

export const GET = forward;
export const POST = forward;
