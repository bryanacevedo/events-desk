/* The shared world, as far as this desk reads it: a copy of lumen-world's own `slice` output for `events_desk` (public files only), pinned by commit and checked against the
   slice's manifest (docs/SHARED-WORLD.md 12.5). It is a copy so the desk runs without that repository, the network or another desk. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "samples", "lumen-world");
const FILES = ["clock.json", "events.csv", "seller.json", "team.csv"] as const;
/** Added in 1.3.0 for this desk's slice (docs/SHARED-WORLD.md 13.2 and 13.9): public files only, none carrying an id from the private directory. */
const EXTRA_FILES = ["events_extra.csv", "events_desk_clock.json", "events_desk_attendance.csv", "events_desk_guests.csv", "events_desk_targets.csv", "assessment_facts.json", "sponsorships.csv", "talks.csv"] as const;

export const csv = (text: string): Record<string, string>[] => {
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
  pin: { repository: string; tag: string | null; commit: string; release: string; world_version: string };
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
  for (const f of EXTRA_FILES) {
    const t = readFileSync(join(dir, f), "utf8");
    const got = createHash("sha256").update(t).digest("hex");
    if (manifest.sha256[`public/${f}`] !== got || (pin.files && pin.files[f] !== got)) throw new Error(`The world slice file ${f} does not match its manifest.`);
  }
  const events = csv(text["events.csv"]).map((e) => ({ id: e.event_id, name: e.name, kind: e.kind, start: e.start, end: e.end, city: e.city, region: e.region, confidence: e.confidence }));
  const by = (k: string) => events.filter((e) => e.kind === k).length;
  if (events.length !== 18 || by("conference") !== 11 || by("webinar") !== 5 || by("dinner") !== 2) throw new Error("The world slice does not hold its 18 events (11 conferences, 5 webinars, 2 dinners).");
  const seller = JSON.parse(text["seller.json"]), clock = JSON.parse(text["clock.json"]);
  const roster = csv(text["team.csv"]).filter((r) => r.events_desk_role && !r.left_on).map((r) => ({ email: r.email, name: r.name, title: r.title, events_desk_role: r.events_desk_role }));
  return { pin: { repository: pin.repository, tag: pin.tag ?? null, commit: pin.commit, release: pin.release, world_version: String(manifest.world_version) }, now: clock.now, seller: { name: seller.name, domain: seller.domain, home_currency: seller.home_currency }, events, roster };
}

/* ------------------------------------------------------------------ release 1.3.0: what the demo loader reads */

export interface WorldPerson { event_id: string; name: string; title: string; email: string; company: string; domain: string }
export interface WorldData {
  today: string;
  events: WorldSlice["events"];
  extra: { id: string; name: string; kind: string; start: string; end: string; city: string; country: string; venue: string; size: string; theme: string; confidence: string; owner: string; parent: string; cost_usd: number | null; cost_note: string }[];
  attendance: (WorldPerson & { status: string; registered_at: string })[];
  guests: (WorldPerson & { status: string; registered_at: string; invited_at: string; responded_at: string })[];
  targets: (WorldPerson & { why: string; likelihood: string })[];
  facts: { event_id: string; event_name: string; facts: Record<string, { value: unknown; source: string | null; confidence: string; status: string; note?: string }> };
  sponsorship: { event_id: string; sponsor: string; package: string; price_usd: number; deliverables: string[]; status: string; confirmed_on: string; note: string } | null;
  talk: { event_id: string; title: string; speaker_name: string; speaker_email: string; status: string; session_date: string; note: string } | null;
  roster: WorldSlice["roster"];
}

/** Everything the demo loader reads, from the verified vendored slice (public files only). Verification runs first, so a file that is not the one the pin names stops it. */
export function worldData(dir = DIR): WorldData {
  const base = worldSlice(dir), read = (f: string) => readFileSync(join(dir, f), "utf8");
  const p = (r: Record<string, string>): WorldPerson => ({ event_id: r.event_id, name: r.name, title: r.title, email: r.email, company: r.company, domain: r.domain });
  const sp = csv(read("sponsorships.csv"))[0], tk = csv(read("talks.csv"))[0];
  return {
    today: JSON.parse(read("events_desk_clock.json")).events_desk_today, events: base.events,
    extra: csv(read("events_extra.csv")).map((r) => ({ id: r.event_id, name: r.name, kind: r.kind, start: r.start, end: r.end, city: r.city, country: r.country, venue: r.venue, size: r.size, theme: r.theme, confidence: r.confidence, owner: r.owner, parent: r.parent_event_id, cost_usd: r.cost_usd === "" ? null : Number(r.cost_usd), cost_note: r.cost_note })),
    attendance: csv(read("events_desk_attendance.csv")).map((r) => ({ ...p(r), status: r.status, registered_at: r.registered_at })),
    guests: csv(read("events_desk_guests.csv")).map((r) => ({ ...p(r), status: r.status, registered_at: r.registered_at, invited_at: r.invited_at, responded_at: r.responded_at })),
    targets: csv(read("events_desk_targets.csv")).map((r) => ({ ...p(r), why: r.why, likelihood: r.likelihood })),
    facts: JSON.parse(read("assessment_facts.json")),
    sponsorship: sp ? { event_id: sp.event_id, sponsor: sp.sponsor, package: sp.package, price_usd: Number(sp.price_usd), deliverables: sp.deliverables.split(";"), status: sp.status, confirmed_on: sp.confirmed_on, note: sp.note } : null,
    talk: tk ? { event_id: tk.event_id, title: tk.title, speaker_name: tk.speaker_name, speaker_email: tk.speaker_email, status: tk.status, session_date: tk.session_date, note: tk.note } : null,
    roster: base.roster,
  };
}
