// Gathers everything the reader needs into reader-space/ (deploy that folder to Cloud Run).
//   npm run reader:bundle
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const out = new URL("../reader-space/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL("server/", out), { recursive: true });
for (const f of ["Dockerfile", "server.mjs", "package.json"]) cpSync(new URL(`../reader/${f}`, import.meta.url), new URL(f, out));
for (const f of ["plugin.mjs", "ai.mjs", "dewarp.mjs", "summary.mjs", "knowledge.mjs"]) cpSync(new URL(`../server/${f}`, import.meta.url), new URL(`server/${f}`, out));
writeFileSync(
  new URL("README.md", out),
  `# Fermata reader

Audiveris + page straightening as a small HTTP server for Google Cloud Run.
Requests need the \`x-fermata-key\` header (READER_SECRET). Deploy from the Fermata folder:

    gcloud run deploy fermata-reader --source reader-space --region us-central1 \\
      --memory 4Gi --cpu 2 --timeout 600 --concurrency 2 --max-instances 2 \\
      --allow-unauthenticated --set-env-vars READER_SECRET=<your secret>
`,
);
// Cloud Build skips these when uploading the source.
writeFileSync(new URL(".gcloudignore", out), "node_modules/\n");
console.log("reader-space/ is ready: deploy it with gcloud run deploy (see its README).");
