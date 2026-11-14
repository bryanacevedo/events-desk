/* Money20/20 USA 2026 read "$0 of $800,000 pipeline" in a build with no CRM. The scorecard could not read pipeline there, and the goal line took the unread figure for a measured zero.
   An unread pipeline says it was not read; a pipeline the CRM measured reads against the goal (the demo build, which has the sample CRM). */

import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { withDemoCrm } from "../src/server/demo-run.ts";
import { goalResult, goalWords, planView } from "../src/server/plan.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { mockLlm } from "../src/server/providers.ts";
import { DREAMFORCE, M2020, seedPastResults, seedPlan } from "../src/server/seed-plan.ts";
import { seedReal } from "../src/server/seed-real.ts";
import { simCrm, simDeps } from "../src/server/sim-vendors.ts";
import { freshDb } from "./helpers.ts";
import { CAMILLE, TODAY } from "./plan-helpers.ts";

let db: Db;
const crm = () => withDemoCrm(simCrm(), db, () => new Date());
const withCrm = () => ({ crm: crm(), connectors: {}, llm: mockLlm }) as never;
const noCrm = { connectors: {}, llm: mockLlm } as never;

beforeAll(async () => {
  db = await freshDb();
  await seedReal(db);
  await seedPlan(db, { today: TODAY });
  for (const id of [M2020, DREAMFORCE]) await processEvent(db, id, simDeps());
  // The demo's way: the sample CRM is connected when the scorecard is written.
  await seedPastResults(db, withCrm());
}, 180_000);

describe("the pipeline line of a goal", () => {
  it("reads the measured pipeline against the goal when the scorecard was written with a CRM", async () => {
    const r = await goalResult(db, withCrm(), M2020);
    expect(r.pipeline).toMatchObject({ goal_cents: 80_000_000, read: true });
    expect(r.pipeline!.actual_cents).toBeGreaterThan(0);
    expect(goalWords(r, true)[2]).toMatch(/^\$[\d,.]+ of \$800,000 pipeline$/);
    expect(goalWords(r, true)[2]).not.toMatch(/^\$0 of/);
  });

  it("says the pipeline was not read, never $0, when the scorecard had no CRM to read", async () => {
    const [row] = await db.query<{ metrics: any }>("SELECT metrics FROM scorecards WHERE event_id = $1 AND window_days = 30", [M2020]);
    const m = { ...row.metrics, influence: { ...row.metrics.influence, available: false, opportunities: 0, pipeline_cents: 0, sourced: { n: 0, cents: 0 }, influenced: { n: 0, cents: 0 }, deals: [] } };
    await db.query("UPDATE scorecards SET metrics = $2::jsonb WHERE event_id = $1 AND window_days = 30", [M2020, JSON.stringify(m)]);
    const r = await goalResult(db, noCrm, M2020);
    expect(r.pipeline).toEqual({ goal_cents: 80_000_000, actual_cents: null, short_by_cents: null, read: false });
    expect(goalWords(r, true)).toEqual(["Held 10 of 16 meetings", "Met 4 of 10 target accounts", "Pipeline not read, no CRM connected (goal $800,000)"]);
    // A planner's plan read carries the same words; a rep's carries neither the figure nor the goal.
    const lead = await planView(db, noCrm, M2020, CAMILLE) as any;
    expect(lead.result.words.at(-1)).toBe("Pipeline not read, no CRM connected (goal $800,000)");
    const rep = await planView(db, noCrm, M2020, "Maya Ortiz") as any;
    expect(JSON.stringify(rep.result)).not.toMatch(/800,000|cents/);
  });
});
