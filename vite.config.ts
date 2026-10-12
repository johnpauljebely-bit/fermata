import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { snapPlayServer } from "./server/plugin.mjs";

export default defineConfig(({ mode, command }) => {
  // Keys stay on the server side (no VITE_ prefix, so they're never sent to the browser).
  const env = loadEnv(mode, ".", "");
  // Phones only allow the microphone on https pages, so serve https (self-signed) by default.
  // SNAP_HTTP=1 serves plain http instead (for testing on this Mac).
  const https = command === "serve" && env.SNAP_HTTP !== "1";
  return {
    plugins: [react(), ...(https ? [basicSsl({ name: "snap-play" })] : []), snapPlayServer({ geminiKey: env.GEMINI_API_KEY, groqKey: env.GROQ_API_KEY })],
    // host: true → reachable from your phone on the same Wi-Fi.
    server: { port: 5190, host: true },
    preview: { port: 5191, host: true },
  };
});
