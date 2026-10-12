// Turns server/knowledge.md (the readable source) into server/knowledge.mjs, so the
// AI reference is bundled as code (serverless functions can't count on reading files).
// Run after editing the .md:  npm run knowledge
import { readFileSync, writeFileSync } from "node:fs";

const md = readFileSync(new URL("../server/knowledge.md", import.meta.url), "utf8");
writeFileSync(
  new URL("../server/knowledge.mjs", import.meta.url),
  `// Generated from knowledge.md by scripts/build-knowledge.mjs. Edit the .md, then run: npm run knowledge\nexport const KNOWLEDGE = ${JSON.stringify(md)};\n`,
);
console.log(`knowledge.mjs: ${md.length} characters`);
