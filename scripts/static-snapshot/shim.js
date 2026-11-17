// The static snapshot's stand-in for the server (scripts/build-static-snapshot.ts). Loaded before the app, it answers
// every call the app makes to /api from the saved answers in /_snapshot, and refuses every change with the desk's own
// kind of sentence (the public demo's refusal of files reads the same way). Nothing here talks to a server: there is none.
(function () {
  "use strict";
  var REFUSED = "This public demo does not take changes. To try them, run the desk yourself: the README shows how.";
  var MISSING = "This view is not in the snapshot. Run the desk yourself to see it.";
  var realFetch = window.fetch.bind(window);
  var shards = {};
  var config = null;

  // The scanner is a phone app that needs a camera and its own service worker; the snapshot has neither. Its link opens the event.
  var scan = /^\/scan\/([^/]+)\/?$/.exec(location.pathname);
  if (scan) { location.replace("/event/" + scan[1] + "#scanner"); return; }

  function canon(v) {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      var o = {};
      Object.keys(v).sort().forEach(function (k) { o[k] = canon(v[k]); });
      return o;
    }
    return v;
  }

  // The request as the build keyed it: method, path, sorted query pairs.
  function keyOf(method, url) {
    var pairs = [];
    url.searchParams.forEach(function (v, k) { pairs.push([k, v]); });
    pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
    return JSON.stringify([method, url.pathname, pairs, null]);
  }

  async function sha1(text) {
    var buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  async function gunzipJson(path) {
    var res = await realFetch(path);
    if (!res.ok) return null;
    var bytes = new Uint8Array(await res.arrayBuffer());
    // A host may already have undone the gzip in transit; only gzip bytes go through the decompressor.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return JSON.parse(await new Response(stream).text());
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function shard(name) {
    if (!shards[name]) shards[name] = gunzipJson("/_snapshot/" + name + ".json.gz").catch(function () { return null; });
    return shards[name];
  }

  function reply(status, body) {
    return new Response(JSON.stringify(body), { status: status, headers: { "Content-Type": "application/json" } });
  }

  // Who is asking: the name the app sends in x-actor (URL-encoded), or nobody, as the app does before a person is chosen.
  function actor(input, init) {
    var raw = null, h = init && init.headers;
    if (!h && input && typeof input === "object" && input.headers) h = input.headers;
    if (h) raw = h instanceof Headers ? h.get("x-actor") : (h["x-actor"] || h["X-Actor"] || null);
    if (!raw) return "";
    try { return decodeURIComponent(raw).trim().slice(0, 60); } catch (e) { return ""; }
  }

  // An entry holds one answer for everyone ("*") or one for each person ("a:<name>", "a:" for nobody). A name the build did not ask as is answered as nobody.
  function pick(entry, who) {
    return entry["*"] || entry["a:" + who] || entry["a:"] || null;
  }

  // Some screens swallow a refused change without a word (a reply marked answered). When nothing on the page says the change was
  // refused a moment after, the shim says it itself, in the app's own toast.
  function say(text) {
    if (typeof document === "undefined" || typeof setTimeout === "undefined") return;
    setTimeout(function () {
      if (!document.body || document.body.innerText.indexOf(text) !== -1) return;
      var old = document.getElementById("snapshot-toast");
      if (old) old.remove();
      var t = document.createElement("div");
      t.id = "snapshot-toast"; t.className = "toast"; t.style.width = "max-content"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite");
      var span = document.createElement("span"); span.textContent = text;
      var x = document.createElement("button"); x.type = "button"; x.setAttribute("aria-label", "Dismiss"); x.innerHTML = "&times;";
      x.onclick = function () { t.remove(); };
      t.appendChild(span); t.appendChild(x); document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 7000);
    }, 600);
  }

  // For tests/static-snapshot.test.ts: the key the shim looks up, compared with the build's.
  window.__snapshotKey = keyOf;

  window.fetch = async function (input, init) {
    var url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href);
    if (url.origin !== location.origin || !/^\/api\//.test(url.pathname)) return realFetch(input, init);
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") { say(REFUSED); return reply(403, { error: REFUSED }); }
    var hash = await sha1(keyOf("GET", url));
    var saved = await shard(hash.slice(0, 3));
    var entry = saved && saved[hash];
    var hit = entry && pick(entry, actor(input, init));
    if (hit) return reply(hit[0], hit[1]);
    return reply(404, { error: MISSING });
  };
})();
