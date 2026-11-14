/* The demo's plans, made through the real code paths (docs/EVENT-PLAN.md section 10, the part Session 1 needs so the Plan tab has data):
   AWS re:Invent 2026 as the conference plan in flight, with passes, a sponsorship, a talk with no title yet, a goal, budget lines and who goes; and a small
   hosted dinner asked for and waiting on its approver. The past events read against their goals, the sponsorship deliverables and the assessment are Session 2 and 3. Dates that must read as near are offsets from `today`. */

import type { Db } from "./db.ts";
import { setBudgetLine } from "./budget-lines.ts";
import { addInvolvement, addPerson, approvePlan, createPlan, submitPlan, updatePlan } from "./plan.ts";
import { addDays } from "../shared/motion.ts";

const CAMILLE = "Camille Laurent", DAN = "Dan Whitlock";

export async function seedDemoPlan(db: Db, today: string = new Date().toISOString().slice(0, 10)) {
  // AWS re:Invent 2026 is the plan in flight (Bryan, 2026-11-13). The real-events seed already holds it as a paused event with twelve approved seats and a 140-row
  // list, so the plan is written onto that event rather than a second one: a plan and its list side by side. Its dates, city and ticket price are the listed ones.
  const id = "evt_aws-re-invent-2026";
  await db.query("UPDATE events SET approval_mode = 'budget', plan_stage = 'planning', requested_by = $2 WHERE id = $1 AND parent_event_id IS NULL", [id, CAMILLE]);
  await updatePlan(db, CAMILLE, id, { reason: "re:Invent is where the cloud buyers on our target list spend one week together. We have not gone before. A booth and a talk put us in front of the platform and data teams outbound has not reached, and twelve passes let the whole field team hold meetings all week." });
  await addInvolvement(db, CAMILLE, id, { kind: "passes", label: "Twelve passes", pass_count: 12 });
  const { id: spo } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Booth in the expo hall" });
  await addInvolvement(db, CAMILLE, id, { kind: "talk", label: "Breakout session", talk_title: "", speaker: "" });
  await updatePlan(db, CAMILLE, id, { goal_meetings_held: 30, goal_accounts_met: 12, goal_pipeline_cents: 50_000_000 });
  const line = (category: string, planned_cents: number, over: { label?: string; contracted_cents?: number; involvement_id?: string } = {}) => setBudgetLine(db, CAMILLE, id, { category, planned_cents, ...over });
  await line("passes", 2_998_800, { label: "Twelve passes" });
  await line("travel", 1_440_000);
  await line("sponsorship", 6_500_000, { label: "Expo booth", contracted_cents: 6_500_000, involvement_id: spo });
  await line("booth", 1_800_000, { label: "Booth build", contracted_cents: 1_640_000 });
  await line("booth", 400_000, { label: "Booth graphics" });
  await line("swag", 350_000);
  await line("dinners", 900_000, { label: "Customer dinner" });
  await submitPlan(db, CAMILLE, id, { today });
  await approvePlan(db, { eventId: id, actor: DAN, today });
  const dinner = await createPlan(db, CAMILLE, {
    name: "Partner dinner, Madrid", venue: "Salón Cibeles, Madrid", country: "Spain", starts_on: addDays(today, 20), reason: "Eight partner leads at one table before the quarter closes.",
    hosted: { format: "dinner", headcount: 8 },
  }, { id: "evt_demo_dinner_madrid" });
  await addPerson(db, CAMILLE, dinner.id, { person: CAMILLE, roles: ["host"] });
  await addPerson(db, CAMILLE, dinner.id, { person: "Ana Duarte", roles: ["host"], team: "Partnerships" });
  await setBudgetLine(db, CAMILLE, dinner.id, { category: "dinners", label: "Dinner", planned_cents: 640_000 });
  await submitPlan(db, CAMILLE, dinner.id, { today });
}
