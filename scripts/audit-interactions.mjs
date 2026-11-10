/* Interaction audit: drives the app in a real browser and checks what screenshots cannot: that it behaves. Written after Bryan caught
   a side sheet sending the page back to its top (2026-11-10): "this is the kind of annoyance of building something really premium".
   Fails on:
   - opening, switching or closing a side sheet moving the reader's place on the page
   - opening or closing a side sheet rebuilding the page underneath (a marked node must survive)
   - a sheet that Esc, a click outside or the browser's back button does not close
   - any console error on any page visited
   Usage: node scripts/audit-interactions.mjs [baseUrl]   (server must be running, demo data loaded) */

import { chromium } from "playwright-core";

const base = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 8787}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? CHROME });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 820 } })).newPage();
const problems = [], errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(`${page.url()}: ${m.text()}`); });
page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
const pause = (ms) => page.waitForTimeout(ms);

async function as(actor, path) {
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate((a) => localStorage.setItem("actor", a), actor);
  await page.goto(base + path, { waitUntil: "networkidle" });
  await pause(900);
}

/** Opens a sheet from `opener` while scrolled, and checks place and page survive opening and each way of closing. */
async function sheet(name, actor, path, opener) {
  await as(actor, path);
  const row = page.locator(opener).first();
  if (!(await row.count())) { problems.push(`${name}: nothing to open (${opener})`); return; }
  for (const how of ["Esc", "outside", "back", "close button"]) {
    await row.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 60));
    await page.evaluate(() => { document.querySelector(".main").__mark = true; });
    const before = await page.evaluate(() => Math.round(scrollY));
    // Clicked as a person clicks: where the row already is, with no scrolling first (the driver's own scroll would move the page).
    await row.evaluate((el) => el.click());
    await pause(700);
    const opened = await page.evaluate(() => ({ y: Math.round(scrollY), sheet: Boolean(document.querySelector("aside.sheet")), same: Boolean(document.querySelector(".main").__mark) }));
    if (!opened.sheet) { problems.push(`${name}: the sheet did not open`); return; }
    if (Math.abs(opened.y - before) > 2) problems.push(`${name}: opening moved the page from ${before} to ${opened.y}`);
    if (!opened.same) problems.push(`${name}: opening rebuilt the page underneath`);
    if (how === "Esc") await page.keyboard.press("Escape");
    // Outside means a part of the page that is not itself something to open: the main column's own background.
    else if (how === "outside") await page.evaluate(() => document.querySelector(".main").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    else if (how === "back") await page.goBack();
    else await page.locator("aside.sheet [data-close]").click();
    await pause(600);
    const closed0 = await page.evaluate(() => Boolean(document.querySelector("aside.sheet")));
    const closed = await page.evaluate(() => ({ y: Math.round(scrollY), sheet: Boolean(document.querySelector("aside.sheet")), same: Boolean(document.querySelector(".main").__mark) }));
    if (closed.sheet) problems.push(`${name}: ${how} did not close the sheet`);
    if (Math.abs(closed.y - before) > 2) problems.push(`${name}: closing with ${how} moved the page from ${before} to ${closed.y}`);
    if (!closed.same) problems.push(`${name}: closing with ${how} rebuilt the page underneath`);
    if (closed0) { await page.keyboard.press("Escape"); await pause(300); }
  }
}

await sheet("Overview event sheet", "Dan Whitlock", "/", "[data-opens-sheet][data-row]");
await sheet("My day reply", "Maya Ortiz", "/my-day", ".ob-tray .ob-row");
await sheet("My day meeting", "Maya Ortiz", "/my-day", ".ob-meet");
await sheet("Event reply", "Maya Ortiz", "/event/evt_money20-20-usa-2026#outreach", ".m-replies .ob-row");
await sheet("Result deal meeting", "Dan Whitlock", "/event/evt_nrf-2026-retail-s-big-show#result", ".rs-deal");
await sheet("Events sheet", "Dan Whitlock", "/events", "[data-opens-sheet]");

await browser.close();
for (const e of [...new Set(errors)]) problems.push(`console error: ${e}`);
if (problems.length) { console.error(`${problems.length} interaction problems:\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log("Interactions hold: every sheet keeps the reader's place and the page, and closes four ways. No console errors.");
