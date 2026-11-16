/* The demo's "before the list" (docs/CHOOSING.md, section 10). Runs after seed-world when the world seed runs, from the world's public files and two sample pages this repository holds.
   Nothing here is a model's words and no repeat decision or wording is made: with two scored past events the desk says "too few to say", and that is what the demo shows.
   Everything is keyed by fixed ids, so a second seed writes the same rows. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { bookMeeting } from "./meetings.ts";
import { addPage, addSeriesLink } from "./overlap.ts";
import { updatePlan } from "./plan.ts";
import { DESK } from "./lifecycle-deps.ts";
import { mockLlm } from "./providers.ts";
import { GITEX } from "./seed-plan.ts";
import { worldData } from "./world-slice.ts";
import { addDays } from "../shared/motion.ts";

const CAMILLE = "Camille Laurent";
export const SAMPLE_LIST_NOTE = "Sample list from the shared world";
export const SAMPLE_PAGES = [
  { file: "saastr-annual-2027-sponsors.txt", catalog_id: "cat_saastr-annual-2027", kind: "sponsor" as const, filename: "saastr-annual-2027-sponsors (sample).txt" },
  { file: "forrester-b2b-2027-speakers.txt", catalog_id: "cat_forrester-b2b-summit-north-america-2027", kind: "speaker" as const, filename: "forrester-b2b-2027-speakers (sample).txt" },
];
/** The two sample rows that give a candidate a scored earlier edition. */
export const SAMPLE_CATALOG = [
  { id: "cat_sample_money20-20-usa-2027", name: "Money20/20 USA 2027", venue: "The Venetian", city: "Las Vegas", country: "United States", starts_on: "2027-10-18", ends_on: "2027-10-21", like: "cat_money20-20-usa-2026" },
  { id: "cat_sample_dreamforce-2027", name: "Dreamforce 2027", venue: "", city: "San Francisco", country: "United States", starts_on: "2027-09-14", ends_on: "2027-09-16", like: "cat_dreamforce-2026" },
];
/** The event that gets a goal and booked meetings, so the tracker reads "days out": 13 days before it starts on the demo's day. */
export const TRACKED = GITEX;
export const TRACKED_GOAL = 20;
export const TRACKED_BOOKINGS = 7;

const hash = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex");
const rosterText = (file: string) => readFileSync(new URL(`../../samples/rosters/${file}`, import.meta.url), "utf8");

export async function seedChoosing(db: Db, opts: { today?: string } = {}) {
  const today = opts.today ?? "2026-11-24";

  // 1. The target accounts: the 142 companies of the world's people-to-meet file, as an uploaded list. The world has no company region and no owner, so none is invented.
  const seen = new Set<string>();
  for (const t of worldData().targets) {
    const domain = t.domain.trim().toLowerCase();
    if (!t.company || seen.has(t.company.toLowerCase())) continue;
    seen.add(t.company.toLowerCase());
    await db.query("INSERT INTO target_accounts (id, name, domain, source, created_by) VALUES ($1, $2, $3, 'upload', $4) ON CONFLICT DO NOTHING", [`tac_w${hash("world", domain || t.company).slice(0, 14)}`, t.company, domain || null, SAMPLE_LIST_NOTE]);
  }

  // 1b. Four of the companies the team met at Money20/20 USA 2026 were added to the list after the show (sample): so the result's "target accounts met" reads a real count, not zero.
  const met = await db.query<{ name: string; domain: string }>(
    `SELECT min(co.name) AS name, mt.domain FROM meetings mt JOIN contacts k ON k.id = mt.contact_id JOIN companies co ON co.id = k.company_id
      WHERE mt.event_id = 'evt_money20-20-usa-2026' AND mt.status = 'held' GROUP BY mt.domain ORDER BY mt.domain LIMIT 4`);
  for (const m of met) await db.query("INSERT INTO target_accounts (id, name, domain, source, created_by) VALUES ($1, $2, $3, 'manual', $4) ON CONFLICT DO NOTHING", [`tac_m${hash("met", m.domain).slice(0, 14)}`, m.name, m.domain, "Sample: added after the show"]);

  // 2. Two sample catalog rows, marked as samples, so a candidate has a scored earlier edition.
  for (const c of SAMPLE_CATALOG) {
    const [like] = await db.query<{ website: string | null; seat_price_cents: number; size: string | null; brand_color: string | null }>("SELECT website, seat_price_cents, size, brand_color FROM catalog_events WHERE id = $1", [c.like]);
    await db.query(
      `INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents, price_is_estimate, source, suggested_by, confidence, size, brand_color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, 'suggested', 'sample', 'sample', $10, $11) ON CONFLICT (id) DO NOTHING`,
      [c.id, c.name, c.venue, c.city, c.country, c.starts_on, c.ends_on, like?.website ?? null, like?.seat_price_cents ?? 0, like?.size ?? null, like?.brand_color ?? null]);
  }

  // 3. The series link: SaaStr AI Annual 2026 became SaaStr Annual 2027.
  await addSeriesLink(db, CAMILLE, { name: "SaaStr Annual 2027", same_as: "SaaStr AI Annual 2026", reason: "Renamed for 2027" });

  // 4. Two sample pages, added the way a planner adds an uploaded page.
  for (const p of SAMPLE_PAGES) await addPage(db, CAMILLE, p.catalog_id, { kind: p.kind, input: "uploaded", filename: p.filename, text: rosterText(p.file) });

  // 5. A goal and booked meetings on an event that has not started, through the real booking path, so the tracker shows days out. Most of the people going have nothing booked yet.
  await updatePlan(db, CAMILLE, TRACKED, { goal_meetings_held: TRACKED_GOAL });
  const deps = { connectors: {}, llm: mockLlm, now: () => new Date(`${today}T12:00:00Z`) } as never;
  const [ev] = await db.query<{ starts_on: string }>("SELECT starts_on::text AS starts_on FROM events WHERE id = $1", [TRACKED]);
  const reps = (await db.query<{ requester: string }>("SELECT DISTINCT requester FROM seat_requests WHERE event_id = $1 AND status = 'approved' ORDER BY requester", [TRACKED])).map((r) => r.requester).slice(0, 3);
  const people = await db.query<{ id: string }>(
    `SELECT DISTINCT ON (lower(k.email)) k.id FROM contacts k JOIN companies co ON co.id = k.company_id
     WHERE k.event_id = $1 AND k.dropped_at IS NULL AND k.email IS NOT NULL AND co.primary_domain IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.domain = co.primary_domain AND m.status IN ('held', 'booked', 'rescheduled'))
     ORDER BY lower(k.email) LIMIT $2`, [TRACKED, TRACKED_BOOKINGS * 3]);
  let booked = 0;
  const domains = new Set<string>();
  for (const p of people) {
    if (booked >= TRACKED_BOOKINGS || !reps.length) break;
    const [d] = await db.query<{ domain: string }>("SELECT co.primary_domain AS domain FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.id = $1", [p.id]);
    if (domains.has(d.domain)) continue;
    domains.add(d.domain);
    // The first rep takes three, the next two take two each: a spread by rep, and the rest of those going have nothing booked.
    const rep = reps[booked < 3 ? 0 : booked < 5 ? 1 : 2] ?? reps[0];
    await bookMeeting(db, deps, { contact_id: p.id, scheduled_at: `${addDays(ev.starts_on, booked % 3)}T${String(9 + (booked % 5)).padStart(2, "0")}:00:00Z`, source: "manual", rep }, DESK);
    booked++;
  }
}
