// Counts app events for Fermata's own analytics (api/event.mjs). No cookies, nothing personal:
// just the event's name (and, for a visit, which site sent you). Skipped while developing.
type Event = "view" | "camera" | "upload" | "sample" | "recent" | "play" | "sing" | "tuner" | "warmups" | "warmup_done";

export function track(n: Event) {
  if (import.meta.env.DEV) return;
  try {
    const body = JSON.stringify(n === "view" ? { n, r: document.referrer } : { n });
    if (!navigator.sendBeacon?.("/api/event", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/event", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => undefined);
    }
  } catch {
    // never let counting break the app
  }
}
