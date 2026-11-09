/* Layout audit: loads every screen in a real browser and measures instead of eyeballing.
   Fails on:
   - anything wider than the viewport (sideways scroll), measured against the real width
   - content that starts off the shared left edge of the main column
   - a detail row whose label and value baselines differ
   - a lane whose door marker sits outside its track, or a bar that runs past its door
   - text spilling out of a button, a lane label, a caption, a panel or a list row without an ellipsis
   - on a phone: a tap target under 44px, the sidebar or lanes still showing, the tab bar or agenda missing
   - on a desktop: the sidebar missing or the tab bar showing
   Usage: node scripts/audit-layout.mjs [baseUrl]   (server must be running) */

import { chromium } from "playwright-core";

const base = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 8787}`;
const GTM = "GTM Team", MAYA = "Maya Ortiz";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Each page is a path and who is acting. Settings is GTM Team's; Maya sees the refusal line there.
const sections = ["", "?section=scoring", "?section=titles", "?section=lists", "?section=data", "?section=spend", "?section=connections", "?section=team"];
// Event pages come from the demo itself: one per stage, so every screen state is measured.
// The flagship's research runs in the background after boot; the audit waits for it so the case screen is measured for real.
let all;
for (let i = 0; i < 90; i++) {
  all = (await (await fetch(base + "/api/events")).json()).events;
  if (!all.some((e) => ["researching", "finding_people", "flagging", "tiering", "enriching"].includes(e.stage))) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const byStage = (stage, not = () => false) => all.find((e) => e.stage === stage && !not(e));
const byName = (name) => all.find((e) => e.name.startsWith(name))?.id;
const ids = ["delivered", "approved", "mapped", "quoted", "requested", "paused", "declined", "ready_for_review"].map((st) => byStage(st)?.id).filter(Boolean);
const flagship = byName("Web Summit 2026") ?? ids[0];
// The event page at its four volumes: the flagship (about 1,650 rows, cases open), about 200 rows, about 25 rows, and no attendee list yet. Plus the second Run step.
const volumes = [flagship, byName("Dreamforce 2026"), byName("SaaS North 2026"), byStage("approved")?.id, byName("GITEX Global 2026")].filter(Boolean);
const catalog = (await (await fetch(base + "/api/catalog")).json()).catalog;
const listed = catalog.find((c) => !c.event_id && c.ends_on >= new Date().toISOString().slice(0, 10))?.id ?? "";
const pages = [
  ["/", MAYA], ["/events", MAYA], [`/events?event=${ids[1] ?? flagship}`, MAYA], ["/events?time=all", MAYA], ["/events?time=past&region=na", MAYA], ["/events?add=1", GTM], [`/events?event=${flagship}`, MAYA], ["/events?request=1", MAYA], [`/events?request=1&catalog=${listed}`, MAYA],
  [`/?event=${ids[1] ?? flagship}`, MAYA], ["/budget", "Dan Whitlock"], ["/budget?year=2027", MAYA], ["/budget?year=2027&q=money", MAYA], ["/usage", MAYA], ["/more", MAYA],
  ["/seats", "Dan Whitlock"], ["/seats?status=all", "Dan Whitlock"], ["/seats?request=1", MAYA], ["/seats?mine=1&status=all", MAYA],
  ...sections.map((q) => [`/settings${q}`, GTM]), ["/settings", MAYA], ["/settings?section=spend", "Dan Whitlock"],
  ...[...new Set([...volumes, ...ids])].map((id) => [`/event/${id}`, MAYA]),
  [`/event/${flagship}`, "Dan Whitlock"], [`/event/${byName("Dreamforce 2026") ?? flagship}?s=dropped`, MAYA], [`/event/${flagship}?ct=unknown&cq=a`, MAYA],
];
// 330px approximates a 412px phone with system text enlarged about 125%.
const widths = [1440, 1024, 412, 360, 330];

// The ICP flow has screens that only exist for a compile in progress. Make three through the API, as a person would: one waiting to be read,
// one drafted (the confirm screen, with its marked gap), one confirmed and tested, so every step is measured too.
async function icpCompiles() {
  const h = { "x-actor": "GTM%20Team", "content-type": "application/json" };
  const j = async (path, method, body) => (await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined })).json();
  const text = await (await import("node:fs/promises")).readFile(new URL("../samples/orrery-icp.md", import.meta.url), "utf8");
  const bench = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../samples/orrery-bench.json", import.meta.url), "utf8"));
  // Drafts left by an audit that stopped early would show on Settings; clear them first.
  const left = await (await fetch(base + "/api/icp")).json();
  for (const c of left.open ?? []) if (c.filename === "audit-icp.md") await j(`/api/icp/compiles/${c.id}/cancel`, "POST");
  const make = async () => j("/api/icp/documents", "POST", { filename: "audit-icp.md", text });
  const a = await make();
  const b = await make(); await j(`/api/icp/compiles/${b.compile_id}/start`, "POST", { accepted_cents: b.estimate.cents });
  const c = await make(); await j(`/api/icp/compiles/${c.compile_id}/start`, "POST", { accepted_cents: c.estimate.cents });
  await j(`/api/icp/compiles/${c.compile_id}/draft`, "PATCH", { op: "answer_gap", gap: "region", answer: { accept: true } });
  await j(`/api/icp/compiles/${c.compile_id}/confirm`, "POST");
  await j(`/api/icp/compiles/${c.compile_id}/bench`, "PUT", { companies: [...bench, { name: "Tricky Co With A Rather Long Name Indeed", employees: 4000, industry: "Data platforms", business_model: "B2B", expected: 3, kind: "bad_fit" }] });
  await j(`/api/icp/compiles/${c.compile_id}/bench/run`, "POST");
  return { paths: [`/settings?compile=${a.compile_id}`, `/settings?compile=${b.compile_id}`, `/settings?compile=${c.compile_id}`], ids: [a.compile_id, b.compile_id, c.compile_id], cancel: (id) => j(`/api/icp/compiles/${id}/cancel`, "POST") };
}
const compiles = await icpCompiles();
pages.push(...compiles.paths.map((p) => [p, GTM]));

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? CHROME });
let problems = 0;
try {

// The side sheet, with real clicks: closes on a click outside, Esc and the close control; a click on another card switches it; focus goes back to the card.
async function sheetBehaviour(width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const bad = (m) => { problems++; console.log(`${width}px side sheet  ${m}`); };
  await page.goto(base + "/"); await page.evaluate(() => localStorage.setItem("actor", "Maya Ortiz"));
  for (const home of ["/", "/events"]) {
    const sel = home === "/" ? "a.card[data-opens-sheet]" : "a.tl-row[data-opens-sheet]";
    await page.goto(base + home, { waitUntil: "networkidle" }); await page.waitForSelector("[data-ready]");
    const cards = page.locator(sel); const n = await cards.count();
    if (n < 2) { bad(`${home}: fewer than two cards to open`); continue; }
    const idOf = (i) => cards.nth(i).getAttribute("data-row");
    const [a, b] = [await idOf(0), await idOf(1)];
    const open = async (i) => { await cards.nth(i).click({ position: { x: 12, y: 12 } }); await page.waitForSelector("[data-sheet]"); };
    const gone = async (how) => { await page.waitForTimeout(250); if (await page.locator("[data-sheet]").count()) bad(`${home}: still open after ${how}`); if (new URL(page.url()).searchParams.get("event")) bad(`${home}: ?event= still in the URL after ${how}`); };
    await open(0);
    if (!page.url().includes(`event=${a}`)) bad(`${home}: opening a card did not put ?event= in the URL`);
    if (new URL(page.url()).pathname !== new URL(base + home).pathname) bad(`${home}: opening left the page`);
    if (!(await page.evaluate(() => document.querySelector("[data-sheet]").contains(document.activeElement)))) bad(`${home}: focus did not move into the sheet`);
    await cards.nth(1).click({ position: { x: 12, y: 12 } }); await page.waitForTimeout(300);
    if ((await page.locator("[data-sheet]").getAttribute("data-sheet")) !== b) bad(`${home}: a click on another card did not switch the sheet`);
    // Click outside: a real mouse click on the page title, which is not a card.
    await page.locator("h1").first().click(); await gone("a click outside");
    await open(0); await page.keyboard.press("Escape"); await gone("Esc");
    if (!(await page.evaluate((id) => document.activeElement?.getAttribute("data-row") === id, a))) bad(`${home}: focus did not return to the card after Esc`);
    await open(0); await page.locator("[data-sheet] [data-close]").click(); await gone("the close control");
    await open(0);
    // The trap: Tab many times and focus never leaves the sheet.
    for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => document.querySelector("[data-sheet]")?.contains(document.activeElement)))) bad(`${home}: Tab left the sheet`);
    const full = page.getByRole("button", { name: "Open the full page" });
    await full.click(); await page.waitForTimeout(300);
    if (!/\/event\//.test(new URL(page.url()).pathname)) bad(`${home}: Open the full page did not go to the event`);
  }
  await page.close();
}
await sheetBehaviour(1440); await sheetBehaviour(1024);

for (const width of widths) {
  const phone = width < 500;
  const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
  let acting = "";
  for (const [path, actor] of pages) {
    if (actor !== acting) { acting = actor; await page.goto(base + "/", { waitUntil: "networkidle" }); await page.evaluate((a) => localStorage.setItem("actor", a), actor); }
    // On an event page, the time from the event's data arriving to the first useful content must stay under about a second.
    const eventPage = path.startsWith("/event/");
    const arrived = eventPage ? page.waitForResponse((r) => /\/api\/events\/[^/?]+$/.test(r.url())).then(() => Date.now()) : null;
    await page.goto(base + path, { waitUntil: "networkidle" });
    // A page that never draws is a problem to report, not a reason to stop measuring the rest.
    if (!(await page.waitForSelector("[data-ready]", { timeout: 8000 }).then(() => true).catch(() => false))) { problems++; console.log(`${width}px ${path}  never became ready`); continue; }
    if (arrived) { const gap = Date.now() - await arrived; if (gap > 1000) { problems++; console.log(`${width}px ${path}  first content ${gap} ms after the data arrived`); } }
    if (path.includes("?event=")) await page.waitForSelector("[data-sheet] [data-stage]", { timeout: 8000 });
    if (path.includes("add=1")) await page.waitForSelector("[data-add]", { timeout: 8000 });
    // Open the on-request sections and one person, so their layout is measured too.
    for (const label of ["See why", "Cost and the card", "Show more"]) { const b = page.getByRole("button", { name: label, exact: true }); if (await b.count()) await b.first().click(); }
    for (const text of ["Cost", "What happened so far"]) { const d = page.locator("details.fold > summary", { hasText: text }); if (await d.count()) await d.first().click(); }
    const more = page.locator(".reasons .morebtn button"); if (await more.count()) await more.click();
    if (eventPage) { await page.waitForTimeout(300); const row = page.locator("button.prow").first(); if (await row.count()) await row.click(); }
    // The request form: open the list of events once, and on one page choose "My event isn't listed" so the suggestion fields are measured too.
    const combo = page.locator("input[aria-controls=event-options]");
    if (await combo.count()) { await combo.click(); if (path === "/events?request=1") await page.getByRole("option", { name: /isn't listed/ }).click(); }
    const av = page.locator("button.av").first(); if (await av.count()) await av.click();
    const found = await page.evaluate((vw) => {
      const out = [];
      const r = (el) => el.getBoundingClientRect();
      const visible = (el) => { const b = r(el); return b.width > 0 && b.height > 0 && getComputedStyle(el).display !== "none"; };
      const baseline = (el) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.textContent.trim() && n.parentElement.getClientRects().length ? 1 : 3 });
        const t = w.nextNode();
        if (!t) return r(el).bottom;
        const wrap = document.createElement("span"), m = document.createElement("span");
        m.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
        t.parentNode.insertBefore(wrap, t); wrap.appendChild(m); wrap.appendChild(t);
        const y = m.getBoundingClientRect().top;
        wrap.parentNode.insertBefore(t, wrap); wrap.remove();
        return y;
      };

      // 1. Sideways scroll.
      if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px wide in a ${vw}px viewport`);

      // 2. Shared content edge: every block in main starts where its padding ends.
      const main = document.querySelector("main.main");
      const edge = r(main).left + parseFloat(getComputedStyle(main).paddingLeft);
      for (const el of main.children) {
        if (!visible(el) || el.matches(".sheet, .railwrap")) continue;
        const dx = r(el).left - edge;
        if (Math.abs(dx) > 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || el.getAttribute("aria-label")} starts ${Math.round(dx)}px off the content edge`);
      }

      // 3. Baselines in detail rows.
      for (const row of document.querySelectorAll(".detail .row")) {
        const [k, v] = row.children;
        if (!k || !v || !v.textContent.trim()) continue;
        const d = Math.abs(baseline(k) - baseline(v));
        if (d > 1.5) out.push(`detail "${k.textContent.trim().slice(0, 30)}": label and value baselines differ by ${d.toFixed(1)}px`);
      }

      // 4. The timeline: the date dot sits inside its track, the runway ends at the dot, the date label stays inside the track, the today line sits on the tracks.
      for (const row of document.querySelectorAll(".tl-row")) {
        if (!visible(row)) continue;
        const track = row.querySelector(".tl-track"), dot = row.querySelector(".tl-dot"), bar = row.querySelector(".tl-bar"), end = row.querySelector(".tl-end");
        if (!track || !dot) continue;
        const t = r(track), d = r(dot), name = row.getAttribute("aria-label") ?? row.textContent.trim().slice(0, 30);
        if (d.left < t.left - 7 || d.right > t.right + 7) out.push(`date dot for "${name}" sits outside its track`);
        if (bar && r(bar).right > d.left + d.width / 2 + 1.5) out.push(`runway runs past its date for "${name}"`);
        if (end && (r(end).left < t.left - 1 || r(end).right > t.right + 1)) out.push(`date label for "${name}" leaves its track`);
      }
      const marks = document.querySelector(".tl-marks"), firstTrack = document.querySelector(".tl-row .tl-track");
      if (marks && firstTrack && visible(firstTrack) && Math.abs(r(marks).left - r(firstTrack).left) > 1) out.push(`today line column is ${Math.round(r(marks).left - r(firstTrack).left)}px off the tracks`);
      const axis = document.querySelector(".tl-axis-track");
      if (axis && firstTrack && visible(firstTrack) && Math.abs(r(axis).left - r(firstTrack).left) > 1) out.push(`month axis is ${Math.round(r(axis).left - r(firstTrack).left)}px off the tracks`);

      // 5. Spill: text running outside its own box without an ellipsis.
      for (const el of document.querySelectorAll(".btn, .cap, .who-text p, .panel p, .panel h2, .need p, .tl-name p, .tl-state, .tl-end, .tl-tick, .detail .row > span, .dropped li > span, .hero h1, .event-head h1, .stage-note, .lede, .sheet-link code, .icp p, .tiers dd, .rbody .what, .rrule q, .idoc-text, .ihead h1, .ifig b, .tres > span, .tres-name b, .oo-list li > *, .st-label, .st-who, .figs dt, .figs dd, .caps dd, .runmoney b, .pname b, .pname span, .pco span, .pmail, .cwho, .csum, .cside dd, .reasons span, .topco .tcn, .tkey li, .flag, .cgname, .choice, .fold > summary, .chevrow")) {
        if (!visible(el)) continue;
        const cs = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.textOverflow !== "ellipsis" && cs.overflowX === "visible") {
          out.push(`text spills out of ${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ("${el.textContent.trim().slice(0, 24)}"), ${el.scrollWidth - el.clientWidth}px over`);
        }
      }

      // 6. Phone and desktop shells.
      const side = document.querySelector(".side"), tabs = document.querySelector(".tabs");
      if (vw < 760) {
        for (const el of document.querySelectorAll(".btn, .textlink, button.av, .tab, .phone-actor, .tl-row, .navitem, .blk + .blk, .risk .btn, button.prow, .cgbtn, .choice, .seg button, .filter select, .fold > summary, .pager .btn, .search")) {
          if (el.matches(".blk")) continue;
          if (!visible(el)) continue;
          if (r(el).height < 43.5) out.push(`tap target ${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ("${el.textContent.trim().slice(0, 20)}") is ${Math.round(r(el).height)}px tall`);
        }
        if (side && visible(side)) out.push("the sidebar is still showing on a phone");
        if (!tabs || !visible(tabs)) out.push("the tab bar is missing on a phone");
      } else {
        if (!side || !visible(side)) out.push("the sidebar is missing on a desktop");
        if (tabs && visible(tabs)) out.push("the tab bar is showing on a desktop");
      }
      return [...new Set(out)];
    }, width);
    if (eventPage && volumes.some((id) => path === `/event/${id}`)) {
      const st = await page.getAttribute("[data-ready]", "data-stage");
      const ok = st === "approved" ? await page.locator("label.btn", { hasText: "Add the attendee list" }).count() : st === "delivered" ? await page.locator("button.prow").count() : await page.locator("[data-run], [data-cases], .corow").count();
      if (!ok) found.push(`the ${st} event page shows nothing of its stage`);
    }
    for (const f of found) { problems++; console.log(`${width}px ${path}  ${f}`); }
  }
  await page.close();
}
await browser.close();
} finally {
  // The three compiles were made for measuring only; cancelling them keeps the demo's Settings page clean, even when the audit stops early.
  for (const id of compiles.ids) await compiles.cancel(id);
}
console.log(problems ? `\n${problems} layout problems.` : "Layout audit passed: edges, lanes, baselines, tap targets and widths all hold.");
process.exit(problems ? 1 : 0);
