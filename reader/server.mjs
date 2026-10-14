// Fermata's hosted music reader: Audiveris + page straightening + the AI check, as a small
// HTTP server. Runs on Google Cloud Run (free tier). Fermata on Vercel talks to it through
// its own /api routes, adding the shared secret, so the public can't use it.
//
// Environment (set when deploying, see README):
//   READER_SECRET   required: any long random string, the same one you give Vercel
//   GEMINI_API_KEY  optional: lets the reader's AI check add tempo/dynamics and fix notes
//   GROQ_API_KEY    optional backup AI
//   PORT            set by Cloud Run (8080)

import http from "node:http";
import { createHandler } from "./server/plugin.mjs";

const secret = process.env.READER_SECRET ?? "";
if (!secret) console.warn("READER_SECRET is not set: refusing all requests until it is.");
const handle = createHandler({ geminiKey: process.env.GEMINI_API_KEY, groqKey: process.env.GROQ_API_KEY });

http
  .createServer((req, res) => {
    if (req.url === "/" || req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("Fermata reader is running.\n");
    }
    if (!secret || req.headers["x-fermata-key"] !== secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not allowed." }));
    }
    handle(req, res, () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });
  })
  .listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => console.log(`Fermata reader on :${process.env.PORT ?? 8080}`));
