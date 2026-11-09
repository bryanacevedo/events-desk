/* Sample events, built through the real code paths so the demo cannot show a
   state the product could not reach. Every event, venue and person is fictional. */

import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { decideApproval, patchSettings } from "./approvals.ts";
import { answerCase, listCases } from "./cases.ts";
import { requestOutreachCard, requestResearchCard } from "./research.ts";
import { createEvent } from "./events.ts";
import { confirmCompile, editDraft, publishCompile, runBench, saveDocument, setBench, startCompile } from "./icp.ts";
import { processEvent } from "./pipeline.ts";
import { mockLlm, mockVendors } from "./providers.ts";
import { simDeps } from "./sim-vendors.ts";
import { seedYear } from "./seed-year.ts";
import { seedReal } from "./seed-real.ts";
import { seedSamplePools } from "./pools.ts";
import { ingestUpload } from "./uploads.ts";
import { decideSeat, requestSeat, type Goal } from "./seats.ts";
import { recordTicket } from "./budget.ts";

const MAYA = "Maya Ortiz";
const DAN = "Dan Whitlock";
const list = () => readFileSync(new URL("../../samples/attendees.csv", import.meta.url), "utf8");

type Upto = "requested" | "approved" | "mapped" | "quoted" | "delivered";
const SAMPLE: [string, string, string, string, number, number, Upto][] = [
  ["evt_harbor", "Harborline Revenue Summit", "Pier 9 Hall, Lisbon", "2027-02-09", 4, 149900, "requested"],
  ["evt_lantern", "Lantern Growth Days", "Old Mill, Dublin", "2027-04-13", 2, 99900, "approved"],
  ["evt_cedar", "Cedar Commerce Live", "Riverside Halls, Denver", "2027-05-04", 5, 129900, "mapped"],
  ["evt_north", "Northbound Payments Forum", "Convention Centre, Toronto", "2027-03-16", 6, 219900, "quoted"],
  ["evt_quarry", "Quarry Data Week", "The Foundry, Berlin", "2026-12-02", 2, 119900, "delivered"],
];

/** The large fictional event: about 1,650 rows from about 420 companies, made by scripts/gen-world.ts.
    "none" leaves it out (tests), "background" takes it to an approved cost card and leaves the run to
    whoever kicks it (the server does at boot), "delivered" runs it to the end here with the simulated vendors. */
export type LargeEvent = "none" | "background" | "delivered";
export const MERIDIAN = { id: "evt_meridian", name: "Meridian Trade Expo", venue: "Meridian Exhibition Centre, Valencia", starts_on: "2027-03-30", seat_count: 60, seat_price_cents: 189900, country: "Spain" };
const largeList = () => readFileSync(new URL("../../samples/attendees-large.csv", import.meta.url), "utf8");

/** The fictional people who asked for a seat at the large event, in their own words. The Summary's "Why this event" reads from these. */
const MERIDIAN_SEATS: { who: string; team: string; role: string; goal: Goal; why_event: string; why_you: string; meetings: number; known: string | null }[] = [
  { who: MAYA, team: "Field marketing", role: "Field marketing manager", goal: "new_pipeline", meetings: 8, known: "Larkspur Freight, Pinefold",
    why_event: "Half of the logistics buyers on our target list register for Meridian, and it is the one week they are all in Valencia.", why_you: "I run the field programme for Iberia and will book the meetings before we fly." },
  { who: "Leo Marchetti", team: "Sales", role: "Account executive", goal: "new_pipeline", meetings: 10, known: "Brightwater Retail",
    why_event: "Three of my open deals have people on the floor, and the two biggest accounts I have never reached exhibit here.", why_you: "I own Spain and Portugal and the deals are mine to close." },
  { who: "Sofia Reyes", team: "Customer success", role: "Customer success manager", goal: "existing_customers", meetings: 5, known: null,
    why_event: "Four customers renew in the second quarter and their operations leads will be at the expo.", why_you: "I run those four renewals." },
];

async function seedLarge(db: Db, mode: LargeEvent) {
  const m = MERIDIAN;
  // The large event runs the two-card flow: a Research card, open cases, then an Outreach card.
  await createEvent(db, MAYA, { name: m.name, venue: m.venue, starts_on: m.starts_on, seat_count: m.seat_count, seat_price_cents: m.seat_price_cents, country: m.country, flow: "two_card" }, m.id);
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [m.id]))[0].id;
  await decideApproval(db, { approvalId: await pending(), actor: DAN, decision: "approve" });
  // Seats, through the real path: a catalog entry, one request per person, each approved by Dan, and the first ticket recorded as bought.
  await db.query(
    `INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents, source) VALUES ('cat_meridian', $1, 'Meridian Exhibition Centre', 'Valencia', 'Spain', $2, $3, 'https://meridian-expo.example', $4, 'listed')`,
    [m.name, m.starts_on, "2027-04-01", m.seat_price_cents]);
  await db.query("UPDATE events SET catalog_id = 'cat_meridian' WHERE id = $1", [m.id]);
  for (const [i, s] of MERIDIAN_SEATS.entries()) {
    const r = await requestSeat(db, s.who, { catalog_id: "cat_meridian", suggestion: null, team: s.team, role: s.role, goal: s.goal, why_event: s.why_event, why_you: s.why_you, expected_meetings: s.meetings, known_accounts: s.known, travel_cents: null, decide_by: null }, { today: "2000-01-01" });
    await decideSeat(db, { requestId: r.id, actor: DAN, decision: "approve" });
    if (i === 0) await recordTicket(db, DAN, r.id, m.seat_price_cents / 100);
  }
  await ingestUpload(db, m.id, MAYA, "attendees-large.csv", largeList());
  await requestResearchCard(db, m.id, MAYA);
  // A cost card is confirmed by the person who uploaded the list (Maya), not by leadership. Seats stay with Dan.
  await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "approve" });
  if (mode !== "delivered") return;
  const deps = simDeps();
  await processEvent(db, m.id, deps);
  // The demo's reviewer takes every suggested answer, then the settled companies finish their research.
  for (const k of await listCases(db, m.id)) if (!k.decision) await answerCase(db, m.id, k.id, DAN, k.suggested ?? k.options[0].value as string);
  await processEvent(db, m.id, deps);
  await requestOutreachCard(db, m.id, MAYA);
  await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "approve" });
  await processEvent(db, m.id, deps);
}

/** Orrery's ICP, published through the same steps a person takes: upload, see the cost, compile, answer the gaps, confirm, test, publish. */
export async function seedIcp(db: Db) {
  const text = readFileSync(new URL("../../samples/orrery-icp.md", import.meta.url), "utf8");
  const bench = JSON.parse(readFileSync(new URL("../../samples/orrery-bench.json", import.meta.url), "utf8"));
  const { compile_id, estimate } = await saveDocument(db, MAYA, "orrery-icp.md", text, 1);
  await startCompile(db, compile_id, MAYA, mockLlm, estimate.cents);
  // The document never says where Orrery sells. Maya confirms that no region rule is fine.
  await editDraft(db, compile_id, MAYA, { op: "answer_gap", gap: "region", answer: { accept: true } });
  await confirmCompile(db, compile_id, MAYA);
  await setBench(db, compile_id, bench);
  await runBench(db, compile_id, MAYA, mockLlm);
  await publishCompile(db, compile_id, MAYA, { note: "First version, from orrery-icp.md" });
}

/** `real` is the demo: the real events from samples/real-events.json with a fictional roster asking for seats. It replaces the fictional sample events. */
export async function seed(db: Db, opts: { large?: LargeEvent; year?: boolean; real?: boolean } = {}) {
  await seedIcp(db);
  if (opts.real) { await seedSamplePools(db); return seedReal(db); }
  for (const [id, name, venue, starts_on, seat_count, seat_price_cents, upto] of SAMPLE) {
    await createEvent(db, MAYA, { name, venue, starts_on, seat_count, seat_price_cents }, id);
    if (upto === "requested") continue;
    const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1", [id]);
    await decideApproval(db, { approvalId: a.id, actor: DAN, decision: "approve" });
    if (upto === "approved") continue;
    await ingestUpload(db, id, MAYA, "attendees.csv", list());
    if (id === "evt_quarry") await patchSettings(db, id, MAYA, { add_prospects: true });
    if (upto === "mapped") continue;
    // The two-card flow, as a person takes it: the Research card is confirmed by Maya, who uploaded the list; she answers the cases; then the Outreach card.
    await requestResearchCard(db, id, MAYA);
    if (upto === "quoted") continue;
    const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
    await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "approve" });
    const deps = { llm: mockLlm, vendorsFor: mockVendors };
    await processEvent(db, id, deps);
    for (const k of await listCases(db, id)) if (!k.decision) await answerCase(db, id, k.id, DAN, k.suggested ?? (k.options[0].value as string));
    await processEvent(db, id, deps);
    await requestOutreachCard(db, id, MAYA);
    await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "approve" });
    await processEvent(db, id, deps);
  }
  if (opts.large && opts.large !== "none") await seedLarge(db, opts.large);
  if (opts.year) await seedYear(db);
}
