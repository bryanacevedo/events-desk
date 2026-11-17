/* The built app's files (dist/): what is cached, what is compressed, and what a missing file answers.
   - /assets/* are hashed and never change under their name: compressed, cached for a year. A hashed file that is not there is a 404, never the page: after a deploy an open tab asks for
     the old chunk by its old name, and answering with index.html (cached for a year) turned that into a blank app that stayed blank.
   - Every page (/, /index.html and any deep link) is revalidated on each load (no-cache), so a new build reaches the browser on the next visit. */
import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import type { Hono } from "hono";

export function mountStatic(api: Hono<any>, root = "./dist") {
  api.use("/assets/*", compress(), async (c, next) => { await next(); if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable"); });
  // A file under /assets/ that serveStatic does not find ends here, before the page fallback below can answer it.
  api.use("/assets/*", serveStatic({ root }));
  api.all("/assets/*", (c) => c.text("Not found", 404, { "Cache-Control": "no-store" }));
  // Pages: compressed, and never cached without asking the server (also "/" and "/index.html", which serveStatic answers itself).
  api.use("*", compress(), async (c, next) => { await next(); if (c.req.method === "GET" && c.res.ok && (c.res.headers.get("Content-Type") ?? "").startsWith("text/html")) c.header("Cache-Control", "no-cache"); });
  api.use("/*", serveStatic({ root }));
  api.get("*", serveStatic({ path: `${root}/index.html` }));
}
