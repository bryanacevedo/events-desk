/* The demo's plans, made through the real code paths (docs/EVENT-PLAN.md section 10, as amended by 17 and the notes at the end of 18).
   AWS re:Invent 2026 is the plan in flight: passes, a sponsorship with its eight deliverables due on the offsets below, a talk with no title yet, a goal, budget lines, an assessment that finds
   an emailed list, and two requests to the organizer. GITEX Global 2026 has a request whose follow-up is late. Money20/20 USA 2026 and Dreamforce 2026 are the past events that read against
   their goals. Every date that must read as near is an offset from `today` (SEED_DATES), and restampDemoPlan moves exactly those rows so a snapshot built weeks ago still shows work due this week.
   The part that needs a delivered list (held meetings and the scorecard) is seedPastResults, which runs after the demo has built the lists. */

import type { Db } from "./db.ts";
import { readFileSync } from "node:fs";
import { setBudgetLine } from "./budget-lines.ts";
import { addInvolvement, addPerson, approvePlan, createPlan, submitPlan, updatePlan } from "./plan.ts";
import { addPromise, saveSponsorship, standardDeliverables, updateDeliverable } from "./sponsorship.ts";
import { addSource, closeOrganizerRequest, confirmAssessment, draftOrganizerRequest, markRequestCopied, patchOrganizerRequest, proposeAnswers, setAnswer } from "./assessment.ts";
import { mockLlm } from "./providers.ts";
import { bookMeeting, recordOutcome } from "./meetings.ts";
import { recordEventCost, writeScorecards } from "./closeout.ts";
import { moveMotion } from "./motion-state.ts";
import { LAST_DAY_SQL } from "./motion.ts";
import { DESK, type LifecycleDeps } from "./lifecycle-deps.ts";
import { addDays } from "../shared/motion.ts";
import { STANDARD_DELIVERABLES } from "../shared/plan.ts";
import { CAPITOL, GG_STEP_FEE, GG_STEP_FREE, GOLDEN_GATE, seedHostedYear } from "./seed-hosted.ts";

const CAMILLE = "Camille Laurent", DAN = "Dan Whitlock", MAYA = "Maya Ortiz";
export const REINVENT = "evt_aws-re-invent-2026", M2020 = "evt_money20-20-usa-2026", DREAMFORCE = "evt_dreamforce-2026", GITEX = "evt_gitex-global-2026";
export const DINNER_MADRID = "evt_demo_dinner_madrid", DINNER_M2020 = "evt_m2020_usa_2026_dinner";
const delivId = (prefix: string, n: number) => `dlv_seed_${prefix}_${STANDARD_DELIVERABLES[n].kind}`;

export type SeedTable = "sponsorship_deliverables" | "sponsorships" | "organizer_requests" | "events" | "event_venues" | "venue_cancellation_steps";
export interface SeedDate { table: SeedTable; id: string; /** The column `id` is matched against. `id` unless the table is keyed otherwise. */ key?: string; column: string; /** Days from today. null leaves the date empty. */ offset: number | null }

/** The only place these dates are written. seedPlan and restampDemoPlan both read it, by fixed id. Days from the demo's today. */
export const SEED_DATES: SeedDate[] = [
  // AWS re:Invent 2026: eight deliverables so This week shows Late, Today and This week groups, and two that are further out.
  { table: "sponsorship_deliverables", id: delivId("reinvent", 0), column: "due_on", offset: -3 },    // logo and copy: 3 days late
  { table: "sponsorship_deliverables", id: delivId("reinvent", 3), column: "due_on", offset: -1 },    // sponsor session: 1 day late
  { table: "sponsorship_deliverables", id: delivId("reinvent", 2), column: "due_on", offset: 0 },     // staff badges: today
  { table: "sponsorship_deliverables", id: delivId("reinvent", 7), column: "due_on", offset: 2 },     // lead retrieval: this week
  { table: "sponsorship_deliverables", id: delivId("reinvent", 1), column: "due_on", offset: 5 },     // booth graphics: this week
  { table: "sponsorship_deliverables", id: delivId("reinvent", 5), column: "due_on", offset: 12 },    // electrical: not on This week
  { table: "sponsorship_deliverables", id: delivId("reinvent", 6), column: "due_on", offset: 12 },    // internet: not on This week
  { table: "sponsorship_deliverables", id: delivId("reinvent", 4), column: "due_on", offset: null },  // freight: no date yet
  { table: "sponsorships", id: "spo_seed_reinvent", column: "contract_signed_on", offset: -20 },
  { table: "sponsorships", id: "spo_seed_reinvent", column: "deposit_due_on", offset: 3 },
  { table: "sponsorships", id: "spo_seed_reinvent", column: "balance_due_on", offset: 60 },
  // The first request to the organizer, answered: the list arrived emailed, so it reads received. The second asks for the refreshed list nearer the show.
  { table: "organizer_requests", id: "org_seed_reinvent_first", column: "sent_on", offset: -10 },
  { table: "organizer_requests", id: "org_seed_reinvent_first", column: "expected_on", offset: -3 },
  { table: "organizer_requests", id: "org_seed_reinvent_first", column: "follow_up_on", offset: null },
  { table: "organizer_requests", id: "org_seed_reinvent", column: "sent_on", offset: -6 },
  { table: "organizer_requests", id: "org_seed_reinvent", column: "expected_on", offset: 4 },
  { table: "organizer_requests", id: "org_seed_reinvent", column: "follow_up_on", offset: 5 },
  // GITEX Global 2026: sent, no answer, follow-up 2 days late.
  { table: "organizer_requests", id: "org_seed_gitex", column: "sent_on", offset: -9 },
  { table: "organizer_requests", id: "org_seed_gitex", column: "follow_up_on", offset: -2 },
  { table: "events", id: DINNER_MADRID, column: "starts_on", offset: 20 },
  // Hosted dinners: the Golden Gate guarantee is due in 13 days, its free cancellation ends in 5 (so This week shows it), and Capitol Revenue Roadshow is on the demo's day, at the door.
  { table: "event_venues", id: GOLDEN_GATE, key: "event_id", column: "guarantee_by", offset: 13 },
  { table: "venue_cancellation_steps", id: GG_STEP_FREE, column: "by_date", offset: 5 },
  { table: "venue_cancellation_steps", id: GG_STEP_FEE, column: "by_date", offset: 13 },
  { table: "events", id: CAPITOL, column: "starts_on", offset: 0 },
];

const dateOf = (today: string, id: string, column: string) => {
  const d = SEED_DATES.find((x) => x.id === id && x.column === column);
  if (!d) throw new Error(`No seed date for ${id}.${column}`);
  return d.offset === null ? null : addDays(today, d.offset);
};

/** Rewrites every dated column of the offset table from `today`, by fixed id. One UPDATE per row; a second run changes nothing. Returns how many rows it wrote. */
export async function restampDemoPlan(db: Db, today: string): Promise<number> {
  let n = 0;
  for (const d of SEED_DATES) {
    const r = await db.query<{ id: string }>(`UPDATE ${d.table} SET ${d.column} = ${d.offset === null ? "NULL" : "$2::date + $3::int"} WHERE ${d.key ?? "id"} = $1 RETURNING ${d.key ?? "id"} AS id`, d.offset === null ? [d.id] : [d.id, today, d.offset]);
    n += r.length;
  }
  return n;
}

const todayDefault = () => new Date().toISOString().slice(0, 10);
const readSample = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").trim();

/** An assessment of seven confirmed answers made by hand, from what a person knows first hand. The detail says it is sample data. */
async function handAssessment(db: Db, id: string, answers: Record<string, [string, string]>) {
  for (const [question, [answer, detail]] of Object.entries(answers)) await setAnswer(db, CAMILLE, id, question, { answer, detail, source_kind: "first_hand" });
  await confirmAssessment(db, CAMILLE, id);
}

export async function seedPlan(db: Db, opts: { today?: string } | string = {}) {
  const today = typeof opts === "string" ? opts : opts.today ?? todayDefault();
  await seedReinvent(db, today);
  await seedMadrid(db, today);
  await seedGitex(db, today);
  await seedPastEvents(db, today);
  // The hosted dinners and their guest lists, written through the code the routes use.
  await seedHostedYear(db, today);
}
/** The name the first slice used. */
export const seedDemoPlan = seedPlan;

async function seedReinvent(db: Db, today: string) {
  // AWS re:Invent 2026 is the plan in flight (Bryan, 2026-11-13). The real-events seed already holds it as a paused event with twelve approved seats and a 140-row
  // list, so the plan is written onto that event rather than a second one: a plan and its list side by side. Its dates, city and ticket price are the listed ones.
  const id = REINVENT;
  await db.query("UPDATE events SET approval_mode = 'budget', plan_stage = 'planning', requested_by = $2 WHERE id = $1 AND parent_event_id IS NULL", [id, CAMILLE]);
  await updatePlan(db, CAMILLE, id, { reason: "re:Invent is where the cloud buyers on our target list spend one week together. We have not gone before. A booth and a talk put us in front of the platform and data teams outbound has not reached, and twelve passes let the whole field team hold meetings all week." });
  await addInvolvement(db, CAMILLE, id, { kind: "passes", label: "Twelve passes", pass_count: 12 });
  const { id: spo } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Booth in the expo hall" });
  await addInvolvement(db, CAMILLE, id, { kind: "talk", label: "Breakout session", talk_title: "", speaker: "" });
  await updatePlan(db, CAMILLE, id, { goal_meetings_held: 30, goal_accounts_met: 12, goal_pipeline_cents: 50_000_000 });
  const line = (category: string, planned_cents: number, over: { label?: string; contracted_cents?: number } = {}) => setBudgetLine(db, CAMILLE, id, { category, planned_cents, ...over });
  await line("passes", 2_998_800, { label: "Twelve passes" });
  await line("travel", 1_440_000);
  // The package writes the sponsorship's one budget line and the standard eight deliverables, with fixed ids, so a rerun is the same.
  await saveSponsorship(db, CAMILLE, id, spo, { tier: "Gold", price_cents: 6_500_000, contract_signed_on: dateOf(today, "spo_seed_reinvent", "contract_signed_on"), deposit_cents: 1_950_000, deposit_due_on: dateOf(today, "spo_seed_reinvent", "deposit_due_on"), balance_due_on: dateOf(today, "spo_seed_reinvent", "balance_due_on") },
    { id: "spo_seed_reinvent", deliverable_ids: STANDARD_DELIVERABLES.map((_, n) => delivId("reinvent", n)) });
  const owners = ["Camille Laurent", "Jonas Weber", "Ana Duarte", "Camille Laurent", "Jonas Weber", "Jonas Weber", "Jonas Weber", "Ana Duarte"];
  for (const [n] of STANDARD_DELIVERABLES.entries()) {
    await updateDeliverable(db, CAMILLE, id, delivId("reinvent", n), { due_on: dateOf(today, delivId("reinvent", n), "due_on"), owner: owners[n] }, { planner: true });
  }
  await line("booth", 1_800_000, { label: "Booth build", contracted_cents: 1_640_000 });
  await line("booth", 400_000, { label: "Booth graphics" });
  await line("swag", 350_000);
  await line("dinners", 900_000, { label: "Customer dinner" });
  await submitPlan(db, CAMILLE, id, { today });
  await approvePlan(db, { eventId: id, actor: DAN, today });
  // The assessment finds an emailed list. These are sample answers written for the demo, said so in their detail, not the organizer's own words.
  const sample = "Sample answer written for the demo.";
  await handAssessment(db, id, {
    directory_present: ["yes", sample], directory_tickets: ["unknown", ""], directory_fields: ["unknown", ""], can_hide: ["unknown", ""], download: ["emailed", sample], sponsor_adds: ["unknown", ""], terms: ["unknown", ""],
  });
  // The first request was answered: the organizer emailed the list (the upload carries that source), and receiving it closes the request. The second asks for the refreshed list.
  const first = "org_seed_reinvent_first";
  await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true, id: first });
  await markRequestCopied(db, CAMILLE, id, first);
  await patchOrganizerRequest(db, CAMILLE, id, first, { sent_on: dateOf(today, first, "sent_on")!, expected_on: dateOf(today, first, "expected_on")!, status: "sent" });
  await db.tx((q) => closeOrganizerRequest(q, id, DESK));
  await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true, id: "org_seed_reinvent" });
  await markRequestCopied(db, CAMILLE, id, "org_seed_reinvent");
  await patchOrganizerRequest(db, CAMILLE, id, "org_seed_reinvent", { sent_on: dateOf(today, "org_seed_reinvent", "sent_on")!, expected_on: dateOf(today, "org_seed_reinvent", "expected_on")!, status: "sent" });
}

async function seedMadrid(db: Db, today: string) {
  const dinner = await createPlan(db, CAMILLE, {
    name: "Partner dinner, Madrid", venue: "Salón Cibeles, Madrid", country: "Spain", starts_on: dateOf(today, DINNER_MADRID, "starts_on")!, reason: "Eight partner leads at one table before the quarter closes.",
    hosted: { format: "dinner", headcount: 8 },
  }, { id: DINNER_MADRID });
  await addPerson(db, CAMILLE, dinner.id, { person: CAMILLE, roles: ["host"] });
  await addPerson(db, CAMILLE, dinner.id, { person: "Ana Duarte", roles: ["host"], team: "Partnerships" });
  await setBudgetLine(db, CAMILLE, dinner.id, { category: "dinners", label: "Dinner", planned_cents: 640_000 });
  await submitPlan(db, CAMILLE, dinner.id, { today });
}

async function seedGitex(db: Db, today: string) {
  // A planner drafts the request by hand: this event has no assessment. It was sent nine days ago with no answer, so the follow-up (a week after) is two days late.
  const id = GITEX;
  await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true, id: "org_seed_gitex" });
  await markRequestCopied(db, CAMILLE, id, "org_seed_gitex");
  await patchOrganizerRequest(db, CAMILLE, id, "org_seed_gitex", { sent_on: dateOf(today, "org_seed_gitex", "sent_on")!, status: "sent" });
}

/** The two past events and the side dinner at Money20/20 USA 2026. Meetings and the scorecard wait for the delivered lists (seedPastResults). */
async function seedPastEvents(db: Db, today: string) {
  // Money20/20 USA 2026: the past event with a goal it fell short of, a sponsorship whose deliverables are all done, promises not all kept, and a browse-only assessment.
  const id = M2020;
  await updatePlan(db, CAMILLE, id, { reason: "Money20/20 USA is where the payments and fintech buyers on our target list meet once a year. Fifteen passes put the field team on the floor all week, and a booth gave the meetings a place to happen.", goal_meetings_held: 16, goal_accounts_met: 10, goal_pipeline_cents: 80_000_000 });
  await addInvolvement(db, CAMILLE, id, { kind: "passes", label: "Fifteen passes", pass_count: 15 });
  const { id: spo } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Booth package" });
  await saveSponsorship(db, CAMILLE, id, spo, { tier: "Booth", price_cents: 4_800_000, contract_signed_on: "2026-06-02", deposit_cents: 1_440_000, deposit_due_on: "2026-06-09", deposit_paid_on: "2026-06-09", balance_due_on: "2026-08-21", balance_paid_on: "2026-08-20" },
    { id: "spo_seed_m2020", deliverable_ids: STANDARD_DELIVERABLES.map((_, n) => delivId("m2020", n)) });
  const due = ["2026-09-04", "2026-09-18", "2026-09-25", "2026-09-30", "2026-10-02", "2026-10-02", "2026-10-05", "2026-10-09"];
  for (const [n] of STANDARD_DELIVERABLES.entries()) {
    const did = delivId("m2020", n);
    await updateDeliverable(db, CAMILLE, id, did, { due_on: due[n], owner: n % 2 ? "Jonas Weber" : "Camille Laurent", done: true }, { planner: true });
    await db.query("UPDATE sponsorship_deliverables SET done_at = ($2::date + time '12:00')::timestamptz WHERE id = $1", [did, due[n]]);
  }
  await addPromise(db, CAMILLE, id, { item: "passes", label: "10 passes", promised_qty: 10, received_qty: 8 });
  await addPromise(db, CAMILLE, id, { item: "attendee_list", label: "Attendee list" });
  const [seat] = await db.query<{ n: number }>("SELECT seat_price_cents AS n FROM events WHERE id = $1", [id]);
  await setBudgetLine(db, CAMILLE, id, { category: "passes", label: "Fifteen passes", planned_cents: 15 * seat.n });
  await setBudgetLine(db, CAMILLE, id, { category: "travel", planned_cents: 2_400_000 });
  await setBudgetLine(db, CAMILLE, id, { category: "booth", label: "Booth build", planned_cents: 1_500_000, contracted_cents: 1_450_000 });
  await setBudgetLine(db, CAMILLE, id, { category: "dinners", label: "Customer dinner", planned_cents: 600_000 });
  await recordEventCost(db, id, DAN, "sponsorship", 4_800_000, "Booth package, paid in two parts");
  await recordEventCost(db, id, DAN, "booth", 1_450_000, "Booth build and graphics");
  await recordEventCost(db, id, DAN, "dinners", 584_000, "Customer dinner, Monday");
  // The assessment: what we hold is a research note quoting the FAQ. The simulated model proposes two answers from it with the quote; the person confirms those and says "unknown" to the rest.
  await addSource(db, CAMILLE, id, { input: "pasted", source_kind: "faq", text: readSample("samples/assessment-money2020-note.txt") });
  const [src] = await db.query<{ id: string }>("SELECT s.id FROM assessment_sources s JOIN event_assessments a ON a.id = s.assessment_id WHERE a.event_id = $1", [id]);
  await proposeAnswers(db, mockLlm, id, CAMILLE, src.id);
  for (const q of ["directory_present", "download"]) await setAnswer(db, CAMILLE, id, q, { confirm: true });
  for (const q of ["directory_tickets", "directory_fields", "can_hide", "sponsor_adds", "terms"]) await setAnswer(db, CAMILLE, id, q, { answer: "unknown", source_kind: "first_hand" });
  await confirmAssessment(db, CAMILLE, id);
  // A side dinner at the conference: its own hosted event, naming the conference it hangs off.
  const d = await createPlan(db, CAMILLE, { name: "Customer dinner at Money20/20 USA 2026", venue: "Las Vegas", country: "United States", starts_on: "2026-10-19", reason: "Six customers and four prospects at one table in the middle of the week, away from the show floor.", hosted: { format: "dinner", conference_event_id: id, headcount: 10 } }, { id: DINNER_M2020 });
  await addPerson(db, CAMILLE, d.id, { person: CAMILLE, roles: ["host"] });
  await setBudgetLine(db, CAMILLE, d.id, { category: "dinners", label: "Dinner", planned_cents: 600_000 });
  await submitPlan(db, CAMILLE, d.id, { today });
  await approvePlan(db, { eventId: d.id, actor: DAN, today });

  // Dreamforce 2026: a goal it met.
  const df = DREAMFORCE;
  await updatePlan(db, CAMILLE, df, { reason: "Our customers and the Salesforce admins who buy for them are in San Francisco for three days. A small team and a few booked dinners cover the accounts we already work.", goal_meetings_held: 8 });
  await addInvolvement(db, CAMILLE, df, { kind: "passes", label: "Passes for the field team" });
  const [dseat] = await db.query<{ n: number }>("SELECT seat_price_cents AS n FROM events WHERE id = $1", [df]);
  const [dn] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM seat_requests WHERE event_id = $1 AND status = 'approved'", [df]);
  await setBudgetLine(db, CAMILLE, df, { category: "passes", planned_cents: dn.n * dseat.n });
  await setBudgetLine(db, CAMILLE, df, { category: "travel", planned_cents: 1_800_000 });
}

/* ---------------------------------------------------------------- the past events read against their goals */

/** Held meetings each past event is topped up to, by the real paths. Money20/20 falls short of its goal of 16; Dreamforce meets its goal of 8. The lists are small, so a count is one the list can reach. */
export const PAST_RESULTS: { id: string; held: number }[] = [{ id: M2020, held: 10 }, { id: DREAMFORCE, held: 8 }];

/** For each past event: top it up to a fixed number of held meetings through bookMeeting then recordOutcome, move its motion to closing if the demo run left it earlier,
    and write the 30-day scorecard (writeScorecards, which runs computeScorecard) on a clock thirty days after its last day. Nothing is inserted into scorecards or meetings by hand. People are chosen in a fixed order
    (company name, then email), one per company, so the count and the companies are the same on every build. */
export async function seedPastResults(db: Db, deps: LifecycleDeps) {
  for (const { id, held } of PAST_RESULTS) {
    const [e] = await db.query<{ last_day: string; starts_on: string; motion: string }>(`SELECT (${LAST_DAY_SQL})::date::text AS last_day, e.starts_on::text AS starts_on, e.motion FROM events e WHERE e.id = $1`, [id]);
    if (!e) continue;
    const after = { ...deps, now: () => new Date(`${addDays(e.last_day, 1)}T12:00:00Z`) };
    const heldNow = async () => (await db.query<{ n: number }>("SELECT held_all AS n FROM event_funnel WHERE event_id = $1", [id]))[0].n;
    if ((await heldNow()) < held) {
      // Companies with a held meeting already are not met twice.
      const people = await db.query<{ id: string }>(
        `SELECT DISTINCT ON (co.primary_domain) k.id FROM contacts k JOIN companies co ON co.id = k.company_id
         WHERE k.event_id = $1 AND k.dropped_at IS NULL AND k.email IS NOT NULL AND co.primary_domain IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.domain = co.primary_domain AND m.status IN ('held', 'booked', 'rescheduled'))
         ORDER BY co.primary_domain, lower(k.email)`, [id]);
      const ordered = (await db.query<{ id: string; k: string }>("SELECT id, lower(email) AS k FROM contacts WHERE id = ANY($1::text[]) ORDER BY lower(email), id", [people.map((p) => p.id)]));
      // A company another event already reached is credited to that event, so a meeting booked here may not count here. Keep going until this event reads the target.
      for (const [i, p] of ordered.entries()) {
        if ((await heldNow()) >= held) break;
        const when = `${addDays(e.starts_on, i % 3)}T${String(14 + (i % 4)).padStart(2, "0")}:00:00Z`;
        const m = await bookMeeting(db, after, { contact_id: p.id, scheduled_at: when, source: "manual", rep: MAYA }, DESK);
        await recordOutcome(db, after, m.id, "held", DESK);
      }
    }
    if (!["closing", "scored"].includes(e.motion)) await db.tx((q) => moveMotion(q, id, "closing", DESK, "Thirty days after the event"));
    // The real path: the 30-day scorecard is computed and kept as written, and the motion moves on to scored, as it does for any event thirty days after its last day.
    await writeScorecards(db, { ...deps, now: () => new Date(`${addDays(e.last_day, 30)}T12:00:00Z`) }, { only: [id] });
  }
}
