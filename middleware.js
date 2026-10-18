// Vercel routing middleware: the subdomains each get their own page.
//   legal.tryfermata.app → legal.html (terms & privacy)
//   admin.tryfermata.app → admin.html (analytics, password-protected)
// (The home page would otherwise win: vercel.json rewrites only run after real files.)
import { next, rewrite } from "@vercel/functions";

export const config = { matcher: ["/", "/index.html"] };

export default function middleware(request) {
  const url = new URL(request.url);
  const sub = url.hostname.split(".")[0];
  if (sub === "legal") return rewrite(new URL("/legal.html", url));
  if (sub === "admin") return rewrite(new URL("/admin.html", url));
  return next();
}
