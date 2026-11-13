/* Budget lines (docs/EVENT-PLAN.md 4.1). A line stores what a person planned and what a signed agreement obliges. It never stores what was paid:
   actual is read from eventCost, the one source every screen uses (tickets, travel, the cost ledger of decision 40, AI), so it cannot be counted twice.
   The word "committed" is not used here: decision 15 gives it to approved seats not yet bought. Every key that holds dollars ends in `cents`, so forRep strips it. */

import type { Db } from "./db.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { eventCost } from "./closeout.ts";
import { BUDGET_CATEGORIES, BUDGET_WORDS, type BudgetCategory } from "../shared/plan.ts";

export interface BudgetLine {
  id: string; event_id: string; involvement_id: string | null; category: BudgetCategory; label: string;
  planned_cents: number; contracted_cents: number | null; note: string; updated_by: string; updated_at: string;
}
export interface BudgetLineInput { id?: string; category: string; label?: string; planned_cents: number; contracted_cents?: number | null; note?: string; involvement_id?: string | null }

const LINE_COLS = "id, event_id, involvement_id, category, label, planned_cents::float8 AS planned_cents, contracted_cents::float8 AS contracted_cents, note, updated_by, updated_at";
export const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", cents % 100 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 })}`;

/** The sum of every planned line on an event, in cents. */
export async function plannedTotal(q: Db["query"], eventId: string) {
  const [r] = await q<{ n: number }>("SELECT coalesce(sum(planned_cents), 0)::float8 AS n FROM budget_lines WHERE event_id = $1", [eventId]);
  return Number(r.n);
}

const cents = (v: unknown, what: string) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new RuleError(`Give ${what} in cents, zero or more.`);
  return v;
};

/** Adds a line, or changes the one named by `input.id`. */
export async function setBudgetLine(db: Db, actor: string, eventId: string, input: BudgetLineInput) {
  if (!(BUDGET_CATEGORIES as readonly string[]).includes(input.category)) throw new RuleError(`A budget line is one of: ${BUDGET_CATEGORIES.join(", ")}.`);
  const planned = cents(input.planned_cents, "the planned amount");
  const contracted = input.contracted_cents === undefined || input.contracted_cents === null ? null : cents(input.contracted_cents, "the contracted amount");
  const label = (input.label ?? "").trim().slice(0, 120), note = (input.note ?? "").trim().slice(0, 300);
  return db.tx(async (q) => {
    const [e] = await q<{ id: string; parent_event_id: string | null; stage: string }>("SELECT id, parent_event_id, stage FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (!e) throw new RuleError("That event does not exist.");
    if (e.parent_event_id) throw new RuleError("New registrations have no plan of their own.");
    if (e.stage === "declined") throw new RuleError("This event was declined, so its plan is closed.");
    if (input.involvement_id) {
      const [i] = await q("SELECT 1 FROM involvements WHERE id = $1 AND event_id = $2", [input.involvement_id, eventId]);
      if (!i) throw new RuleError("That involvement is not on this event.");
    }
    if (input.category === "sponsorship" && input.involvement_id) {
      const [dup] = await q("SELECT 1 FROM budget_lines WHERE involvement_id = $1 AND category = 'sponsorship' AND id <> $2", [input.involvement_id, input.id ?? ""]);
      if (dup) throw new RuleError("That sponsorship already has its budget line. Change it instead.");
    }
    let id = input.id;
    if (id) {
      const [mine] = await q<{ planned_cents: number }>("SELECT planned_cents::float8 AS planned_cents FROM budget_lines WHERE id = $1 AND event_id = $2 FOR UPDATE", [id, eventId]);
      if (!mine) throw new RuleError("That budget line is not on this event.");
      await q("UPDATE budget_lines SET category = $2, label = $3, planned_cents = $4, contracted_cents = $5, note = $6, involvement_id = $7, updated_by = $8, updated_at = now() WHERE id = $1",
        [id, input.category, label, planned, contracted, note, input.involvement_id ?? null, actor]);
    } else {
      id = newId("bln");
      await q("INSERT INTO budget_lines (id, event_id, involvement_id, category, label, planned_cents, contracted_cents, note, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [id, eventId, input.involvement_id ?? null, input.category, label, planned, contracted, note, actor]);
    }
    await logActivity(q, eventId, actor, "budget", `${BUDGET_WORDS[input.category as BudgetCategory]}${label ? ` (${label})` : ""}: planned ${dollars(planned)}${contracted === null ? "" : `, contracted ${dollars(contracted)}`}`);
    return { id };
  });
}

export async function removeBudgetLine(db: Db, actor: string, eventId: string, lineId: string) {
  return db.tx(async (q) => {
    const [gone] = await q<{ category: string; label: string; planned_cents: number }>("DELETE FROM budget_lines WHERE id = $1 AND event_id = $2 RETURNING category, label, planned_cents::float8 AS planned_cents", [lineId, eventId]);
    if (!gone) throw new RuleError("That budget line is not on this event.");
    await logActivity(q, eventId, actor, "budget", `Took off ${BUDGET_WORDS[gone.category as BudgetCategory]}${gone.label ? ` (${gone.label})` : ""}, planned ${dollars(Number(gone.planned_cents))}`);
    return { removed: true };
  });
}

export interface BudgetCategoryRow { category: BudgetCategory; label: string; line_ids: string[]; planned_cents: number; contracted_cents: number | null; actual_cents: number | null }

/** One event's budget: lines by category with planned, contracted and actual. Actual comes from eventCost: passes from tickets, travel from approved seats,
    every other category from its ledger entry (null when nothing is entered, so it reads "Not entered", not zero). AI has its own figure and no plan. */
export async function eventBudget(db: Db, eventId: string) {
  const lines = (await db.query<BudgetLine>(`SELECT ${LINE_COLS} FROM budget_lines WHERE event_id = $1 ORDER BY category, updated_at, id`, [eventId])).map((l) => ({ ...l, planned_cents: Number(l.planned_cents), contracted_cents: l.contracted_cents === null ? null : Number(l.contracted_cents) }));
  const cost = await eventCost(db, eventId);
  const [ev] = await db.query<{ approved_budget_cents: number | null }>("SELECT approved_budget_cents::float8 AS approved_budget_cents FROM events WHERE id = $1", [eventId]);
  const categories: BudgetCategoryRow[] = [];
  for (const category of BUDGET_CATEGORIES) {
    const mine = lines.filter((l) => l.category === category);
    const entered = cost.extras.find((x) => x.category === category);
    const actual = category === "passes" ? cost.tickets_cents : category === "travel" ? cost.travel_cents : entered ? entered.amount_cents : null;
    // A category with no line and nothing paid is left out; tickets and travel at zero are not worth a row.
    if (!mine.length && (actual === null || (actual === 0 && (category === "passes" || category === "travel")))) continue;
    const signed = mine.filter((l) => l.contracted_cents !== null);
    categories.push({ category, label: BUDGET_WORDS[category], line_ids: mine.map((l) => l.id), planned_cents: mine.reduce((n, l) => n + l.planned_cents, 0), contracted_cents: signed.length ? signed.reduce((n, l) => n + (l.contracted_cents as number), 0) : null, actual_cents: actual });
  }
  return {
    lines, categories,
    ai_actual_cents: cost.ai_cents,
    total_planned_cents: lines.reduce((n, l) => n + l.planned_cents, 0),
    total_contracted_cents: lines.reduce((n, l) => n + (l.contracted_cents ?? 0), 0),
    total_actual_cents: cost.total_cents,
    approved_budget_cents: ev?.approved_budget_cents === null || ev?.approved_budget_cents === undefined ? null : Number(ev.approved_budget_cents),
  };
}

/** The year's plan, one row per event that starts in it: planned, contracted and actual, with totals. A top-up is never a row, a side event is its own row (its money is never added into its conference), and a declined event is left out. */
export async function yearBudget(db: Db, year: number) {
  const events = await db.query<{ id: string; name: string; starts_on: string; plan_stage: string }>(
    "SELECT id, name, starts_on::text AS starts_on, plan_stage FROM events WHERE parent_event_id IS NULL AND stage <> 'declined' AND extract(year FROM starts_on) = $1::int ORDER BY starts_on, name", [year]);
  const rows: { event_id: string; name: string; starts_on: string; plan_stage: string; planned_cents: number; contracted_cents: number; actual_cents: number }[] = [];
  for (const e of events) {
    const b = await eventBudget(db, e.id);
    rows.push({ event_id: e.id, name: e.name, starts_on: e.starts_on, plan_stage: e.plan_stage, planned_cents: b.total_planned_cents, contracted_cents: b.total_contracted_cents, actual_cents: b.total_actual_cents });
  }
  const sum = (k: "planned_cents" | "contracted_cents" | "actual_cents") => rows.reduce((n, r) => n + r[k], 0);
  return { year, events: rows, total_planned_cents: sum("planned_cents"), total_contracted_cents: sum("contracted_cents"), total_actual_cents: sum("actual_cents") };
}
