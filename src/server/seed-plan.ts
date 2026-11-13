/* The demo's plans, made through the real code paths (docs/EVENT-PLAN.md section 10, the part Session 1 needs so the Plan tab has data):
   a conference plan in flight, with passes, a sponsorship, a talk with no title yet, a goal, budget lines and who goes; and a small
   hosted dinner asked for and waiting on its approver. The full Money20/20 seed is Session 3. Dates that must read as near are offsets from `today`. */

import type { Db } from "./db.ts";
import { setBudgetLine } from "./budget-lines.ts";
import { addInvolvement, addPerson, approvePlan, createPlan, submitPlan, updatePlan } from "./plan.ts";
import { addDays } from "../shared/motion.ts";

const CAMILLE = "Camille Laurent", DAN = "Dan Whitlock";

export async function seedDemoPlan(db: Db, today: string = new Date().toISOString().slice(0, 10)) {
  const { id } = await createPlan(db, CAMILLE, {
    name: "Money20/20 USA 2027", venue: "The Venetian, Las Vegas", city: "Las Vegas", country: "United States", starts_on: "2027-10-18", ends_on: "2027-10-20", seat_price_cents: 350_000,
    reason: "Money20/20 is where our payments buyers meet once a year. Last year we went with passes only and met people in the halls. This year a booth and a talk put us in front of the bank and fintech accounts that outbound has not reached.",
  }, { id: "evt_money20-20-usa-2027" });
  await addInvolvement(db, CAMILLE, id, { kind: "passes", label: "Six passes", pass_count: 6 });
  const { id: spo } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Gold sponsorship" });
  await addInvolvement(db, CAMILLE, id, { kind: "talk", label: "Main stage talk", talk_title: "", speaker: "" });
  await updatePlan(db, CAMILLE, id, { goal_meetings_held: 30, goal_accounts_met: 12, goal_pipeline_cents: 50_000_000 });
  const line = (category: string, planned_cents: number, over: { label?: string; contracted_cents?: number; involvement_id?: string } = {}) => setBudgetLine(db, CAMILLE, id, { category, planned_cents, ...over });
  await line("passes", 2_100_000, { label: "Six passes" });
  await line("travel", 1_440_000);
  await line("sponsorship", 8_500_000, { label: "Gold", contracted_cents: 8_500_000, involvement_id: spo });
  await line("booth", 1_800_000, { label: "Booth build", contracted_cents: 1_640_000 });
  await line("booth", 400_000, { label: "Booth graphics" });
  await line("swag", 350_000);
  await line("dinners", 900_000, { label: "Customer dinner" });
  await submitPlan(db, CAMILLE, id, { today });
  await approvePlan(db, { eventId: id, actor: DAN, today });
  for (const [person, team, role_title, roles] of [[CAMILLE, "Field Marketing", "Field marketer", ["host", "attend"]], ["Jonas Weber", "Field Marketing", "Events manager", ["host", "attend"]], ["Leo Marsh", "Account Executives", "Enterprise AE", ["attend"]], ["Sofia Reyes", "Account Executives", "Mid-market AE", ["attend"]], [DAN, "Sales Leadership", "Head of Sales", ["attend"]]] as const)
    await addPerson(db, CAMILLE, id, { person, team, role_title, roles: [...roles], needs_pass: true });

  const dinner = await createPlan(db, CAMILLE, {
    name: "Partner dinner, Madrid", venue: "Salón Cibeles, Madrid", country: "Spain", starts_on: addDays(today, 20), reason: "Eight partner leads at one table before the quarter closes.",
    hosted: { format: "dinner", headcount: 8 },
  }, { id: "evt_demo_dinner_madrid" });
  await addPerson(db, CAMILLE, dinner.id, { person: CAMILLE, roles: ["host"] });
  await addPerson(db, CAMILLE, dinner.id, { person: "Ana Duarte", roles: ["host"], team: "Partnerships" });
  await setBudgetLine(db, CAMILLE, dinner.id, { category: "dinners", label: "Dinner", planned_cents: 640_000 });
  await submitPlan(db, CAMILLE, dinner.id, { today });
}
