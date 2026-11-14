/* The scanner's service worker: the app shell and its files are kept so /scan/<event> opens with no signal. It touches nothing under /api: scans go through the app's own queue. */
const CACHE = "scan-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch("/index.html", { cache: "reload" });
    const html = await res.clone().text();
    await cache.put("/index.html", res);
    const listed = await fetch("/scan-assets.json", { cache: "reload" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const urls = [...new Set([...listed, ...[...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])])];
    await Promise.all(urls.map((u) => cache.add(u).catch(() => undefined)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // The page itself: the network when there is one, the saved shell when there is not.
  if (req.mode === "navigate" && url.pathname.startsWith("/scan/")) {
    event.respondWith((async () => {
      try { return await fetch(req); } catch { return (await caches.match("/index.html")) || Response.error(); }
    })());
    return;
  }
  // Hashed build files never change: saved on first use, served from the saved copy after.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
  }
});
