/* The shared world, as far as this desk reads it: a copy of lumen-world's own `slice` output for `events_desk` (public files only), pinned by commit and checked against the
   slice's manifest (docs/SHARED-WORLD.md 12.5). It is a copy so the desk runs without that repository, the network or another desk. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "samples", "lumen-world");
const FILES = ["clock.json", "events.csv", "seller.json", "team.csv"] as const;

const csv = (text: string): Record<string, string>[] => {
  const rows: string[][] = []; let row: string[] = [], cur = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
};

export interface WorldSlice {
  pin: { repository: string; commit: string; release: string; world_version: string };
  now: string; seller: { name: string; domain: string; home_currency: string };
  events: { id: string; name: string; kind: string; start: string; end: string; city: string; region: string; confidence: string }[];
  roster: { email: string; name: string; title: string; events_desk_role: string }[];
}

/** Reads and verifies the slice: every file's SHA-256 against the slice's manifest, the format version, and the 18 events. Throws on any difference. */
export function worldSlice(dir = DIR): WorldSlice {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const pin = JSON.parse(readFileSync(join(dir, "PIN.json"), "utf8"));
  if (String(manifest.format_version) !== "1" || manifest.slice_of?.desk !== "events_desk") throw new Error("The world slice is not an events_desk slice of format 1.");
  const text: Record<string, string> = {};
  for (const f of FILES) {
    text[f] = readFileSync(join(dir, f), "utf8");
    const want = manifest.sha256[`public/${f}`], got = createHash("sha256").update(text[f]).digest("hex");
    if (want !== got) throw new Error(`The world slice file ${f} does not match its manifest.`);
  }
  const events = csv(text["events.csv"]).map((e) => ({ id: e.event_id, name: e.name, kind: e.kind, start: e.start, end: e.end, city: e.city, region: e.region, confidence: e.confidence }));
  const by = (k: string) => events.filter((e) => e.kind === k).length;
  if (events.length !== 18 || by("conference") !== 11 || by("webinar") !== 5 || by("dinner") !== 2) throw new Error("The world slice does not hold its 18 events (11 conferences, 5 webinars, 2 dinners).");
  const seller = JSON.parse(text["seller.json"]), clock = JSON.parse(text["clock.json"]);
  const roster = csv(text["team.csv"]).filter((r) => r.events_desk_role && !r.left_on).map((r) => ({ email: r.email, name: r.name, title: r.title, events_desk_role: r.events_desk_role }));
  return { pin: { repository: pin.repository, commit: pin.commit, release: pin.release, world_version: String(manifest.world_version) }, now: clock.now, seller: { name: seller.name, domain: seller.domain, home_currency: seller.home_currency }, events, roster };
}
