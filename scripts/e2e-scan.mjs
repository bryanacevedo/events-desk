/* The scanner, end to end, in a real browser with a fake camera (docs/SCANNER.md 11). Chrome is started with a video file for its camera: a QR code that carries a vCard.
   The test then goes offline, scans that code and a business card, comes back online, syncs, and checks that both arrived once on the event, with consent and source stored.
   Run against `make demo`:  BASE=http://localhost:8982 EVENT=evt_... node scripts/e2e-scan.mjs  (Chrome path: CHROME). */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { writeBarcode } from "zxing-wasm/writer";

const BASE = process.env.BASE ?? "http://localhost:8982";
const EVENT = process.env.EVENT ?? "evt_nrf-2026-retail-s-big-show";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REP = "Maya Ortiz";
const work = join(process.env.TMPDIR ?? tmpdir(), "scan-e2e"); mkdirSync(work, { recursive: true });
const STAMP = Date.now().toString(36);
const email = `e2e.${STAMP}@orrery.example`;

// A printed test badge: a QR code with a vCard, as video the browser plays as its camera.
const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:Eva Test ${STAMP}\nORG:Orrery\nTITLE:Head of Payments\nEMAIL:${email}\nEND:VCARD`;
const qr = await writeBarcode(vcard, { format: "QRCode", scale: 8, ecLevel: "M" });
writeFileSync(join(work, "qr.png"), Buffer.from(await qr.image.arrayBuffer()));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-i", join(work, "qr.png"), "-vf", "scale=640:640:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p", "-t", "20", "-r", "10", "-f", "yuv4mpegpipe", join(work, "badge.y4m")]);

const browser = await chromium.launch({ executablePath: CHROME, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${join(work, "badge.y4m")}`] });
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, permissions: ["camera"] });
if (process.env.WASM) await ctx.addInitScript(() => { delete window.BarcodeDetector; });
await ctx.addInitScript((a) => { try { localStorage.setItem("actor", a); } catch {} }, REP);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
const fail = (m) => { console.error("FAIL: " + m); process.exitCode = 1; };
const shots = process.env.SHOTS;
const shoot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${name}.png`) }); } };

await page.goto(`${BASE}/scan/${EVENT}`);
await page.waitForSelector(".sc[data-ready]");
await page.waitForFunction(() => document.querySelector(".sc-top")?.textContent?.includes("Online"));
await page.waitForTimeout(1500);                          // the service worker takes control and keeps the shell
await shoot("1-scan");
await ctx.setOffline(true);
await page.waitForFunction(() => document.querySelector(".sc-top")?.textContent?.includes("Offline"));

// 1. The badge code is decoded on the phone, offline.
await page.waitForSelector(".sc-sheet", { timeout: 20000 }).catch(() => fail("the code was not decoded from the camera"));
console.log("decoder:", await page.evaluate(() => window.__decoder));
const heading = await page.textContent(".sc-person h3").catch(() => "");
if (!heading?.includes("Eva Test")) fail(`expected the person from the vCard, got "${heading}"`);
await shoot("2-after-scan");
await page.click('.sc-heat button:has-text("Hot")');
await page.fill('.sc-field:has-text("Note") textarea', "Wants payouts in Brazil");
await page.fill('.sc-field:has-text("What we promised") textarea', "Send the Brazil one-pager");
await page.click(".sc-consent input");
const t0 = Date.now();
await page.click('.sc-dock .btn.big:has-text("Save")');
await page.waitForSelector(".sc-sheet", { state: "detached" });
if (!(await page.textContent(".sc-top")).includes("1 unsynced")) fail("one scan should be unsynced after saving offline");

// 2. A business card: a photo taken offline, stored with the scan.
await page.click('.sc-methods button:has-text("Card")');
await page.click(".sc-shutter");
await page.waitForSelector(".sc-sheet");
await page.click('.sc-dock .btn.big:has-text("Save")');
await page.waitForSelector(".sc-sheet", { state: "detached" });
if (!(await page.textContent(".sc-top")).includes("2 unsynced")) fail("the card should make two unsynced");
await shoot("3-offline-two");

// 3. Back online, one sync: both arrive once.
await ctx.setOffline(false);
await page.waitForFunction(() => document.querySelector(".sc-top")?.textContent?.includes("0 unsynced"), null, { timeout: 30000 }).catch(() => fail("the phone never reached 0 unsynced"));
const list = await (await fetch(`${BASE}/api/events/${EVENT}/scans`, { headers: { "x-actor": encodeURIComponent(REP) } })).json();
const mine = list.scans.filter((s) => s.rep === REP);
const badge = mine.find((s) => s.method === "badge_code" && s.fields.email === email);
const card = mine.find((s) => s.method === "card_photo" && new Date(s.received_at).getTime() >= t0 - 60_000);
if (!badge) fail("the badge scan did not arrive"); else {
  if (badge.state !== "placed") fail(`badge state ${badge.state}`);
  if (!badge.marketing_consent || !badge.consent_wording || badge.consent_notice_version == null) fail("consent was not stored with its wording");
  if (badge.temperature !== "hot" || badge.promise !== "Send the Brazil one-pager") fail("the screen's answers were not stored");
  if (list.scans.filter((s) => s.id === badge.id).length !== 1) fail("the badge arrived more than once");
}
if (!card) fail("the card photo scan did not arrive"); else if (!card.has_photo) fail("the card's photo did not arrive");
await shoot("4-synced");
// A second sync changes nothing: the same ids are one scan each.
await page.click('.sc-top .textlink');
await page.waitForTimeout(1500);
const again = await (await fetch(`${BASE}/api/events/${EVENT}/scans`, { headers: { "x-actor": encodeURIComponent(REP) } })).json();
if (again.scans.length !== list.scans.length) fail("a second sync made new scans");
if (errors.length) fail("console errors: " + errors.join(" | "));
await browser.close();
console.log(process.exitCode ? "scan e2e FAILED" : `scan e2e passed: badge decoded offline, card photographed offline, both synced once (${mine.length} scans for ${REP})`);
