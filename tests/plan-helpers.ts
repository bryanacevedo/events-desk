/* Shared set-up for the plan tests: a planner writes, an approver who did not write it approves. */

import type { Db } from "../src/server/db.ts";
import { setBudgetLine } from "../src/server/budget-lines.ts";
import { addInvolvement, approvePlan, createPlan, submitPlan, updatePlan, type PlanInput } from "../src/server/plan.ts";

export const CAMILLE = "Camille Laurent";
export const DAN = "Dan Whitlock";
export const MAYA = "Maya Ortiz";
export const LEO = "Leo Marsh";
export const TODAY = "2026-11-13";
export const as = (a: string) => ({ "x-actor": encodeURIComponent(a), "content-type": "application/json" });

/** A conference plan: passes, a goal, one passes line, a reason. Not yet asked for. Dates are far enough out to be `confirmed` once approved. */
export async function draftPlan(db: Db, over: Partial<PlanInput> & { id?: string; maker?: string; approvers?: string[]; goal?: boolean; passes_cents?: number; price?: number } = {}) {
  const maker = over.maker ?? CAMILLE;
  const { id: fixed, maker: _m, approvers, goal = true, passes_cents = 300_000, price = 100_000, ...input } = over;
  const { id } = await createPlan(db, maker, { name: "Test Summit", venue: "Hall", country: "Portugal", starts_on: "2027-06-01", ends_on: "2027-06-03", seat_price_cents: price, reason: "The buyers we sell to are in the room.", ...input }, { id: fixed, approvers });
  await addInvolvement(db, maker, id, { kind: "passes", pass_count: 3 });
  if (goal) await updatePlan(db, maker, id, { goal_meetings_held: 20 });
  await setBudgetLine(db, maker, id, { category: "passes", planned_cents: passes_cents });
  return id;
}

/** A plan asked for and approved by Dan. */
export async function approvedPlan(db: Db, over: Parameters<typeof draftPlan>[1] = {}) {
  const id = await draftPlan(db, over);
  await submitPlan(db, over.maker ?? CAMILLE, id, { today: TODAY });
  await approvePlan(db, { eventId: id, actor: DAN, today: TODAY });
  return id;
}

export const one = async <T>(db: Db, sql: string, p: unknown[] = []) => (await db.query<T>(sql, p))[0];
