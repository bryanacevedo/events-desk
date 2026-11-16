/* The demo's plans, seeded through the real code paths on a fixed day (docs/EVENT-PLAN.md section 10, as amended by 17 and the notes at the end of 18),
   and restampDemoPlan, which moves exactly the rows of the offset table when the day moves. Seeds are slow, so each describe builds one database. */

import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { assessmentView } from "../src/server/assessment.ts";
import { goalResult, goalWords, planView, weekDeadlines } from "../src/server/plan.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { mockLlm } from "../src/server/providers.ts";
import { DINNER_M2020, DREAMFORCE, GITEX, M2020, REINVENT, restampDemoPlan, SEED_DATES, seedPastResults, seedPlan } from "../src/server/seed-plan.ts";
import { seedReal } from "../src/server/seed-real.ts";
import { simDeps } from "../src/server/sim-vendors.ts";
import { addDays } from "../src/shared/motion.ts";
import { STANDARD_DELIVERABLES } from "../src/shared/plan.ts";
import { freshDb } from "./helpers.ts";
import { CAMILLE, DAN, TODAY } from "./plan-helpers.ts";

const lifecycle = { connectors: {}, llm: mockLlm } as never;
let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await seedReal(db);
  await seedPlan(db, { today: TODAY });
  // The demo builds the past events' lists in the background; here they are built the same way, then the results are seeded.
  for (const id of [M2020, DREAMFORCE]) await processEvent(db, id, simDeps());
  await seedPastResults(db, lifecycle);
}, 120_000);

const q = <T>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);
const delivs = async (event: string) => Object.fromEntries((await q<{ kind: string; due_on: string | null; owner: string; done: boolean }>(
  "SELECT kind, due_on::text AS due_on, owner, done_at IS NOT NULL AS done FROM sponsorship_deliverables WHERE event_id = $1", [event])).map((d) => [d.kind, d]));

describe("seedReal and seedPlan on 2026-11-13", () => {
  it("AWS re:Invent 2026 has a sponsorship with the eight standard deliverables on the offsets, and a deposit due in three days", async () => {
    const [s] = await q<{ id: string; tier_name: string; contract_signed_on: string; deposit_due_on: string; balance_due_on: string }>("SELECT id, tier AS tier_name, contract_signed_on::text AS contract_signed_on, deposit_due_on::text AS deposit_due_on, balance_due_on::text AS balance_due_on FROM sponsorships WHERE event_id = $1", [REINVENT]);
    expect(s).toEqual({ id: "spo_seed_reinvent", tier_name: "Gold", contract_signed_on: "2026-10-24", deposit_due_on: "2026-11-16", balance_due_on: "2027-01-12" });
    const d = await delivs(REINVENT);
    expect(Object.keys(d)).toHaveLength(STANDARD_DELIVERABLES.length);
    expect(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.due_on]))).toEqual({
      logo_copy: "2026-11-10", sponsor_session: "2026-11-12", staff_badges: "2026-11-13", lead_retrieval: "2026-11-15", booth_graphics: "2026-11-18", electrical: "2026-11-25", internet: "2026-11-25", freight: null,
    });
    expect(Object.values(d).every((x) => x.owner !== "" && !x.done)).toBe(true);
    expect((await q<{ id: string }>("SELECT id FROM sponsorship_deliverables WHERE event_id = $1 ORDER BY position", [REINVENT])).map((x) => x.id)).toEqual(STANDARD_DELIVERABLES.map((x) => `dlv_seed_reinvent_${x.kind}`));
  });

  it("This week shows Late, Today and This week, and GITEX's follow-up is 2 days late", async () => {
    const w = await weekDeadlines(db, TODAY);
    const mine = w.filter((x) => x.event_id === REINVENT).map((x) => `${x.group}:${x.due_words}:${x.label}`);
    expect(mine).toEqual([
      "late:3 days late:Logo and copy", "late:1 day late:Sponsor session or side event", "today:Today:Staff badges", "week:Due Sunday:Lead retrieval",
      "week:Due Monday:Sponsorship deposit", "week:Due Tuesday:Attendee list expected from the organizer", "week:Due Wednesday:Booth graphics", "week:Due Wednesday:Follow up with the organizer",
    ]);
    const gitex = w.filter((x) => x.event_id === GITEX);
    expect(gitex).toEqual([expect.objectContaining({ kind: "organizer_follow_up", group: "late", due_words: "2 days late", due_on: "2026-11-11", owner: CAMILLE })]);
    expect(new Set(w.map((x) => x.group))).toEqual(new Set(["late", "today", "week"]));
  });

  it("AWS re:Invent's assessment finds an emailed list, confirmed, and its first request is received after the emailed list arrived", async () => {
    const v = await assessmentView(db, REINVENT);
    expect(v.assessment).toMatchObject({ status: "confirmed", confirmed_by: CAMILLE });
    expect(v.finds_networking).toBe(true);
    const by = Object.fromEntries(v.questions.map((x) => [x.id, x.answer]));
    expect(by.directory_present).toMatchObject({ answer: "yes", state: "confirmed", source_kind: "first_hand" });
    expect(by.download).toMatchObject({ answer: "emailed", state: "confirmed" });
    const reqs = await q<{ id: string; status: string; sent_on: string | null; expected_on: string | null; follow_up_on: string | null; created_by: string }>(
      "SELECT id, status, sent_on::text AS sent_on, expected_on::text AS expected_on, follow_up_on::text AS follow_up_on, created_by FROM organizer_requests WHERE event_id = $1 ORDER BY id", [REINVENT]);
    expect(reqs).toEqual([
      { id: "org_seed_reinvent", status: "sent", sent_on: "2026-11-07", expected_on: "2026-11-17", follow_up_on: "2026-11-18", created_by: CAMILLE },
      { id: "org_seed_reinvent_first", status: "received", sent_on: "2026-11-03", expected_on: "2026-11-10", follow_up_on: null, created_by: CAMILLE },
    ]);
    expect(v.organizer_request?.id).toBe("org_seed_reinvent");
    expect(v.request_open).toBe(true);
  });

  it("its list carries emailed by the organizer on the upload, every row and every person (decision 51)", async () => {
    const [u] = await q<{ list_source: string }>("SELECT list_source FROM uploads WHERE event_id = $1", [REINVENT]);
    expect(u.list_source).toBe("emailed_by_organizer");
    expect((await q("SELECT 1 FROM source_rows WHERE event_id = $1 AND list_source <> 'emailed_by_organizer'", [REINVENT])).length).toBe(0);
    expect((await q("SELECT 1 FROM contacts WHERE event_id = $1 AND source = 'attendee' AND list_source IS DISTINCT FROM 'emailed_by_organizer'", [REINVENT])).length).toBe(0);
    // No other seeded event claims it.
    expect((await q<{ n: number }>("SELECT count(DISTINCT event_id)::int AS n FROM uploads WHERE list_source = 'emailed_by_organizer'"))[0].n).toBe(1);
  });

  it("GITEX Global 2026 has a request sent nine days ago by a planner by hand, with its follow-up two days late", async () => {
    const [r] = await q<{ status: string; sent_on: string; expected_on: string | null; follow_up_on: string }>("SELECT status, sent_on::text AS sent_on, expected_on::text AS expected_on, follow_up_on::text AS follow_up_on FROM organizer_requests WHERE event_id = $1", [GITEX]);
    expect(r).toEqual({ status: "sent", sent_on: "2026-11-04", expected_on: null, follow_up_on: "2026-11-11" });
  });

  it("Money20/20 USA 2026 has a reason, a goal, passes, a sponsorship with every deliverable done, promises that read as the spec says, and cost lines entered", async () => {
    const e = await planView(db, undefined, M2020, DAN);
    expect(e.reason.length).toBeGreaterThan(40);
    expect(e.goal).toEqual({ meetings_held: 16, accounts_met: 10, pipeline_cents: 80_000_000 });
    expect(e.involvements.map((i) => i.kind).sort()).toEqual(["passes", "sponsorship", "talk"]);
    const d = await delivs(M2020);
    expect(Object.keys(d)).toHaveLength(8);
    expect(Object.values(d).every((x) => x.done && x.due_on! >= "2026-09-01" && x.due_on! <= "2026-10-31")).toBe(true);
    expect(e.promises.map((p) => p.words)).toEqual(["10 passes: 8 issued", "Attendee list: not received"]);
    expect(e.budget!.categories.find((c) => c.category === "sponsorship")).toMatchObject({ planned_cents: 4_800_000, contracted_cents: 4_800_000, actual_cents: 4_800_000 });
    expect(e.budget!.categories.find((c) => c.category === "booth")!.actual_cents).toBe(1_450_000);
    // Its date is in the past on the demo's day, so no deliverable is open and nothing of it is on This week.
    expect((await weekDeadlines(db, TODAY)).some((x) => x.event_id === M2020)).toBe(false);
  });

  it("Money20/20 USA 2026's assessment is confirmed, browse only, with the FAQ quote the model proposed and a person confirmed", async () => {
    const v = await assessmentView(db, M2020);
    expect(v.assessment!.status).toBe("confirmed");
    const by = Object.fromEntries(v.questions.map((x) => [x.id, x.answer!]));
    expect(by.download).toMatchObject({ answer: "browse_only", quote: "view, sort, and filter the attendee list", proposed_by: "model", confirmed_by: CAMILLE, state: "confirmed" });
    expect(by.directory_present).toMatchObject({ answer: "yes", proposed_by: "model", quote: "view, sort, and filter the attendee list" });
    expect(["directory_tickets", "directory_fields", "can_hide", "sponsor_adds", "terms"].every((k) => by[k].answer === "unknown")).toBe(true);
    // The quote is in the source the desk holds.
    const [s] = await q<{ body: string }>("SELECT s.body FROM assessment_sources s JOIN event_assessments a ON a.id = s.assessment_id WHERE a.event_id = $1", [M2020]);
    expect(s.body).toContain("view, sort, and filter the attendee list");
    // An unknown answer is still the person's own word, so no organizer request is offered: it is a browse-only list. The assessment finds networking all the same.
    expect(v.finds_networking).toBe(true);
  });

  // The hosted year seeds target accounts, so accounts met counts them (docs/CHOOSING.md section 5), not the tier 1 stand-in: none of them met a past conference company.
  it("both past events read exact goal lines from a written scorecard: one short, one met", async () => {
    for (const id of [M2020, DREAMFORCE]) expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM scorecards WHERE event_id = $1 AND window_days = 30", [id]))[0].n).toBe(1);
    expect(goalWords(await goalResult(db, lifecycle, M2020), true)).toEqual(["Held 10 of 16 meetings", "Met 0 of 10 target accounts", "Pipeline not read, no CRM connected (goal $800,000)"]);
    expect(goalWords(await goalResult(db, lifecycle, DREAMFORCE), true)).toEqual(["Held 8 of 8 meetings"]);
    const m = await goalResult(db, lifecycle, M2020), d = await goalResult(db, lifecycle, DREAMFORCE);
    expect(m.meetings!.short_by).toBe(6);
    expect(d.meetings!.short_by).toBe(0);
    // Thirty days after the last day the motion moves from closing to scored, as it does for any event.
    for (const id of [M2020, DREAMFORCE]) expect((await q<{ motion: string }>("SELECT motion FROM events WHERE id = $1", [id]))[0].motion).toBe("scored");
    // Held meetings came through bookMeeting and recordOutcome: each has its touches.
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM touches t WHERE t.event_id = $1 AND t.kind = 'meeting_held'", [M2020]))[0].n).toBeGreaterThanOrEqual(10);
  });

  it("the scorecard was written on a clock thirty days after the event's last day", async () => {
    const [s] = await q<{ metrics: { held_all: number } }>("SELECT metrics FROM scorecards WHERE event_id = $1", [M2020]);
    expect(s.metrics.held_all).toBe(10);
  });

  it("a side dinner at Money20/20 USA 2026 is its own hosted event naming the conference, shown on the conference's plan", async () => {
    const [i] = await q<{ kind: string; conference_event_id: string; hosted_format: string }>("SELECT kind, conference_event_id, hosted_format FROM involvements WHERE event_id = $1", [DINNER_M2020]);
    expect(i).toEqual({ kind: "hosted", conference_event_id: M2020, hosted_format: "dinner" });
    expect((await q<{ starts_on: string }>("SELECT starts_on::text AS starts_on FROM events WHERE id = $1", [DINNER_M2020]))[0].starts_on).toBe("2026-10-19");
    const conf = await planView(db, undefined, M2020, DAN);
    expect(conf.side_events.map((s) => s.id)).toEqual([DINNER_M2020]);
  });

  it("Camille Laurent is a planner and Dan Whitlock the approver, from the config", async () => {
    const cfg = JSON.parse((await import("node:fs")).readFileSync("config/defaults.json", "utf8"));
    expect(cfg.planners).toContain(CAMILLE);
    expect(cfg.approvers).toContain(DAN);
  });
});

describe("restampDemoPlan", () => {
  const FP = ["events", "sponsorships", "sponsorship_deliverables", "organizer_requests", "event_venues", "venue_cancellation_steps"] as const;
  const KEY: Record<string, string> = { event_venues: "event_id" };
  const fingerprint = async () => Object.fromEntries(await Promise.all(FP.map(async (t) => [t, Object.fromEntries((await q<{ id: string; j: string }>(`SELECT ${KEY[t] ?? "id"} AS id, to_jsonb(t)::text AS j FROM ${t} t`)).map((r) => [r.id, r.j]))])));
  type Fp = Awaited<ReturnType<typeof fingerprint>>;
  const changed = (a: Fp, b: Fp) => FP.flatMap((t) => Object.keys(b[t]).filter((id) => a[t][id] !== b[t][id]).map((id) => `${t}:${id}`)).sort();

  it("moves exactly the rows of the offset table, from the day it is given, and a second run changes nothing", async () => {
    const before = await fingerprint();
    const NEW = "2026-12-20";
    const wrote = await restampDemoPlan(db, NEW);
    const after = await fingerprint();
    // Every row of the table with a date moves (a null offset stays null), and nothing else does.
    const moving = [...new Set(SEED_DATES.filter((d) => d.offset !== null).map((d) => `${d.table}:${d.id}`))].sort();
    expect(changed(before, after)).toEqual(moving);
    expect(wrote).toBe(SEED_DATES.length);
    for (const d of SEED_DATES) {
      const [row] = await q<{ v: string | null }>(`SELECT ${d.column}::text AS v FROM ${d.table} WHERE ${d.key ?? "id"} = $1`, [d.id]);
      expect(row.v, `${d.table}:${d.id}.${d.column}`).toBe(d.offset === null ? null : addDays(NEW, d.offset));
    }
    // Rows outside the table, such as Money20/20's own fixed dates, are as they were.
    expect((await delivs(M2020)).logo_copy.due_on).toBe("2026-09-04");
    const again = await restampDemoPlan(db, NEW);
    expect(again).toBe(wrote);
    expect(changed(after, await fingerprint())).toEqual([]);
    // And the week reads the same way on the new day.
    const w = await weekDeadlines(db, NEW);
    expect(new Set(w.filter((x) => x.event_id === REINVENT).map((x) => x.group))).toEqual(new Set(["late", "today", "week"]));
    expect(w.find((x) => x.event_id === GITEX)!.due_words).toBe("2 days late");
  }, 60_000);
});
