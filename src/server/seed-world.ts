/* The demo on the shared world (docs/SHARED-WORLD.md 13.3). Runs after the demo's own seed when WORLD=lumen (the demo's default; unset keeps the demo's own events, for the tests that need them).
   It reads the public files of the vendored lumen-world slice and nothing else: nothing from the world's private directory, no id from it. Everything is keyed by the world's own event ids, written explicitly
   (the dinner is past, Money20/20 USA 2025 is scored) so nothing depends on a clock, and it never calls a vendor or a model.

   Where it meets the demo's own seed: the 11 conferences are the same events (same names, dates and cities as samples/real-events.json), so they are kept and only take the world's id as
   `external_id`; the demo's own customer dinner at Money20/20 USA 2026 is not made (seedPlan with `world`), and the world's side dinner takes its place (decision 91). */

import type { Db } from "./db.ts";
import { createHash } from "node:crypto";
import { addInvolvement, createPlan } from "./plan.ts";
import { addSource, setAnswer } from "./assessment.ts";
import { saveSponsorship } from "./sponsorship.ts";
import { acceptTalk, approveAbstract, createTalk, saveTalk, submitTalk } from "./talks.ts";
import { patchHosted } from "./hosted.ts";
import { recordEventCost, writeScorecards } from "./closeout.ts";
import { LAST_DAY_SQL } from "./motion.ts";
import { addDays } from "../shared/motion.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { worldData, type WorldData, type WorldPerson } from "./world-slice.ts";

const CAMILLE = "Camille Laurent", DAN = "Dan Whitlock";
export const WORLD_DINNER = "ev_11c1de1ec2";
export const WORLD_M2020_2025 = "ev_ccd7569a7f";
const cents = (usd: number) => Math.round(usd * 100);
const idOf = (worldId: string) => `evt_${worldId}`;
const ownerName = (email: string, roster: WorldData["roster"]) => roster.find((r) => r.email === email)?.name ?? DAN;
const token = (...parts: string[]) => "w" + createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 31);
const lc = (s: string) => s.trim().toLowerCase();

/** Hosted guests in bulk: the world's own states, written as the desk keeps them. Nobody here has an `invited` state to send (the dinner is past). */
async function insertGuests(db: Db, eventId: string, owner: string, day: string, rows: (WorldPerson & { status: string; registered_at: string; invited_at?: string; responded_at?: string })[]) {
  const seen = new Set<string>();
  for (const r of rows) {
    const email = lc(r.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const attended = r.status === "attended", noShow = r.status === "no_show", wait = r.status === "waitlist";
    const status = attended ? "attended" : noShow ? "no_show" : wait ? "waitlist" : r.status === "declined" ? "declined" : "registered";
    const answered = r.responded_at || r.registered_at || null;
    await db.query(
      `INSERT INTO event_guests (id, event_id, name, email, company, title, owner, source, status, rsvp_token, invited_at, rsvp_at, waitlisted_at, checked_in_at, checked_in_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8, $9, $10, $11, $12, $13, $14, $7)`,
      [`gst_${token(eventId, email).slice(0, 14)}`, eventId, r.name, email, r.company, r.title, owner, status, token(eventId, email, "rsvp"), r.invited_at || null, status === "registered" || attended || noShow || status === "declined" ? answered : null,
        wait ? answered : null, attended ? `${day}T19:00:00Z` : null, attended ? owner : null]);
  }
  return seen.size;
}

/** People as an event's contacts, through an upload row of their own, the way a list the organizer sent would be. Companies are keyed by name within the event. */
async function insertContacts(db: Db, eventId: string, filename: string, rows: WorldPerson[], opts: { source: "attendee" | "prospect"; priority?: (r: WorldPerson) => string | null; uploader: string }) {
  const uploadId = `upl_${token(eventId, filename).slice(0, 14)}`;
  await db.query("INSERT INTO uploads (id, event_id, filename, mapping, row_count, uploaded_by) VALUES ($1, $2, $3, '{}'::jsonb, $4, $5)", [uploadId, eventId, filename, rows.length, opts.uploader]);
  let n = 0;
  for (const r of rows) {
    const key = lc(r.company).replace(/[^a-z0-9]+/g, "-");
    const [co] = await db.query<{ id: string }>(
      `INSERT INTO companies (id, event_id, key, name, primary_domain, identity_state, identity_via) VALUES ($1, $2, $3, $4, $5, 'resolved', 'world')
       ON CONFLICT (event_id, key) DO UPDATE SET name = companies.name RETURNING id`, [`co_${token(eventId, key).slice(0, 14)}`, eventId, key, r.company, r.domain]);
    const rowId = `row_${token(eventId, filename, String(n)).slice(0, 14)}`;
    await db.query("INSERT INTO source_rows (id, event_id, upload_id, row_number, raw, kind, company_id, issues) VALUES ($1, $2, $3, $4, $5::jsonb, 'person', $6, '[]'::jsonb)", [rowId, eventId, uploadId, ++n, JSON.stringify({ name: r.name, title: r.title, email: r.email, company: r.company }), co.id]);
    await db.query("INSERT INTO contacts (id, event_id, source_row_id, company_id, full_name, title, email, source, priority) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [`con_${token(eventId, lc(r.email)).slice(0, 14)}`, eventId, rowId, co.id, r.name, r.title, lc(r.email), opts.source, opts.priority?.(r) ?? null]);
  }
}

export async function seedWorld(db: Db, opts: { today?: string } = {}) {
  const w = worldData();
  const byName = async (name: string) => (await db.query<{ id: string }>("SELECT id FROM events WHERE name = $1 AND parent_event_id IS NULL ORDER BY id LIMIT 1", [name]))[0]?.id ?? null;
  const full = new Map(w.events.map((e) => [e.id, e]));

  // 1. The 18 events. A conference is the same event the demo already has: it takes the world's id. Everything else is made as a hosted or planned event, with the world's id in its own.
  for (const e of w.events.filter((x) => x.kind === "conference")) {
    const id = await byName(e.name);
    if (!id) throw new Error(`The world's conference ${e.name} is not in the demo.`);
    await db.query("UPDATE events SET external_id = $2 WHERE id = $1", [id, e.id]);
  }
  const roster = w.roster;
  const dinnerHost = ownerName(w.extra.find((x) => x.id === WORLD_DINNER)?.owner ?? "", roster);
  const attendanceOf = (id: string) => w.attendance.filter((a) => a.event_id === id);
  for (const e of w.events.filter((x) => x.kind !== "conference")) {
    const id = idOf(e.id), owner = ownerName("dan.whitlock@lumenledger.example", roster);
    await createPlan(db, CAMILLE, {
      name: e.name, venue: e.city === "Online" ? "Online" : e.city, country: e.city === "Online" ? null : e.city === "London" ? "United Kingdom" : "United States", starts_on: e.start, ends_on: e.end !== e.start ? e.end : null,
      reason: `${e.kind === "webinar" ? "A Lumen Ledger webinar" : "A Lumen Ledger dinner"} on usage billing and revenue recognition.`, hosted: { format: e.kind === "webinar" ? "webinar" : "dinner", headcount: null },
    }, { id });
    await db.query("UPDATE events SET external_id = $2 WHERE id = $1", [id, e.id]);
    await patchHosted(db, CAMILLE, id, { host_name: owner, host_email: "dan.whitlock@lumenledger.example" });
    await insertGuests(db, id, owner, e.start, attendanceOf(e.id).map((a) => ({ ...a })));
  }

  // 2. The side dinner in Las Vegas, a child of Money20/20 USA 2026, with its guests in the world's states. The dinner is past, so none is `invited` or `registered`.
  const dinner = w.extra.find((x) => x.id === WORLD_DINNER)!;
  const parent = await byName("Money20/20 USA 2026");
  const dinnerId = idOf(dinner.id);
  await createPlan(db, CAMILLE, { name: dinner.name, venue: dinner.venue, country: dinner.country, starts_on: dinner.start, reason: "A table for finance leaders at fit companies, away from the show floor.", hosted: { format: "dinner", conference_event_id: parent, headcount: 24 } }, { id: dinnerId });
  await db.query("UPDATE events SET external_id = $2 WHERE id = $1", [dinnerId, dinner.id]);
  await patchHosted(db, CAMILLE, dinnerId, { capacity: 24, host_name: dinnerHost, host_email: dinner.owner, doors_at: "18:30" });
  await insertGuests(db, dinnerId, dinnerHost, dinner.start, w.guests.filter((g) => g.event_id === dinner.id));
  if (dinner.cost_usd !== null) await recordEventCost(db, dinnerId, DAN, "dinners", cents(dinner.cost_usd), dinner.cost_note);

  // 3. Attendance as the lists the desk would have received, for the conferences that have none yet (a demo list already there is kept; decision 91), and the targets of the four coming conferences.
  for (const e of w.events.filter((x) => x.kind === "conference")) {
    const id = (await byName(e.name))!;
    const [has] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM uploads WHERE event_id = $1", [id]);
    const rows = attendanceOf(e.id);
    if (!has.n && rows.length) await insertContacts(db, id, `${e.name} registrations (world).csv`, rows, { source: "attendee", uploader: DAN });
    const t = w.targets.filter((x) => x.event_id === e.id);
    if (t.length) await insertContacts(db, id, `${e.name} people to meet (world).csv`, t, { source: "prospect", priority: (r) => (w.targets.find((x) => x.email === r.email && x.event_id === e.id)?.likelihood === "high" ? "A" : "B"), uploader: DAN });
  }

  // 4. Money20/20 USA 2025: a past conference to be scored (seedWorldScored runs once the demo's lists exist). Its price and cost are unknown in the world, so none is invented.
  const prior = w.extra.find((x) => x.id === WORLD_M2020_2025)!;
  await createPlan(db, CAMILLE, { name: prior.name, venue: `${prior.venue}, ${prior.city}`, country: prior.country, starts_on: prior.start, ends_on: prior.end, reason: "Last year's Money20/20 USA, kept as the year to read this one against.", price_cents: 0 } as never, { id: idOf(prior.id) });
  await db.query("UPDATE events SET external_id = $2 WHERE id = $1", [idOf(prior.id), prior.id]);

  // 5. Money20/20 USA 2026's assessment: the world's facts as a source, and answers from them. A sample mark says where the world does not know or invented the value.
  if (parent) {
    const f = w.facts.facts, known = (k: string) => (f[k]?.status === "known" ? String(typeof f[k].value === "object" ? JSON.stringify(f[k].value) : f[k].value) : null);
    const page = `${w.facts.event_name}. City: ${known("city") ?? "unknown"}. Venue: ${known("venue") ?? "unknown"}. Size: ${known("size_class") ?? "unknown"}. Theme: ${known("theme") ?? "unknown"}. Ticket price: not in the world. Attendee mix: not in the world.`;
    const src = await addSource(db, CAMILLE, parent, { input: "pasted", source_kind: "event_page", text: page });
    await setAnswer(db, CAMILLE, parent, "directory_tickets", { answer: "Not known: the ticket price is not recorded", detail: "Sample: the world marks the ticket price unknown", source_id: src.id, source_kind: "event_page" });
  }

  // 6. A sponsorship and a talk at SaaStr Annual 2027, through the desk's own tables and rules (a second person approves the abstract).
  const spo = w.sponsorship, talk = w.talk;
  if (spo) {
    const id = (await byName(full.get(spo.event_id)!.name))!;
    const inv = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: spo.package });
    await saveSponsorship(db, CAMILLE, id, inv.id, { tier: spo.package, price_cents: cents(spo.price_usd), contract_signed_on: spo.confirmed_on });
  }
  if (talk) {
    const id = (await byName(full.get(talk.event_id)!.name))!;
    const inv = await addInvolvement(db, CAMILLE, id, { kind: "talk", label: "Session" });
    const made = await createTalk(db, CAMILLE, id, { involvement_id: inv.id });
    await saveTalk(db, CAMILLE, made.id, { title: talk.title, abstract: `${talk.title}. Sample abstract: the world records the title and the day, not the words.`, speaker: talk.speaker_name });
    await approveAbstract(db, DAN, made.id);
    await submitTalk(db, CAMILLE, made.id, "2026-10-01");
    await acceptTalk(db, DAN, made.id);
  }
  void opts;
}

/** Money20/20 USA 2025 is a past conference the world records with no list and no cost: it is marked delivered and scored, and its 30-day reading is written through the real path on a clock
    thirty days after its last day. It reads as an event with nothing to count, which is what the world holds. */
export async function seedWorldScored(db: Db, deps: LifecycleDeps) {
  const id = idOf(WORLD_M2020_2025);
  const [e] = await db.query<{ last_day: string; motion: string }>(`SELECT (${LAST_DAY_SQL})::date::text AS last_day, e.motion FROM events e WHERE e.id = $1`, [id]);
  if (!e) return;
  if (e.motion !== "scored") await db.query("UPDATE events SET stage = 'delivered', motion = 'closing', plan_stage = 'following_up' WHERE id = $1", [id]);
  await writeScorecards(db, { ...deps, now: () => new Date(`${addDays(e.last_day, 30)}T12:00:00Z`) }, { only: [id] });
}
