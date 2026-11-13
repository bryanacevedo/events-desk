/* The event as a plan (docs/EVENT-PLAN.md). Pure rules shared by the server and the screens. The list stage machine in domain.ts is not
   touched: the plan stage sits beside it and is decided by planStageOf, from the approval, the dates, the list stage and the motion. */

import { waitingOn, type EventRow, type Stage } from "./domain.ts";
import { addDays } from "./motion.ts";

export const PLAN_STAGES = ["planning", "confirmed", "preparing", "live", "following_up", "judged"] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

const PLAN_LABEL: Record<PlanStage, string> = { planning: "Planning", confirmed: "Confirmed", preparing: "Preparing", live: "Live", following_up: "Following up", judged: "Judged" };
export const planStageLabel = (s: PlanStage) => PLAN_LABEL[s];

/** How many days before the first day a confirmed budget-mode plan counts as preparing. The default lives in config/defaults.json (plan.prepare_days_before). */
export const PREPARE_DAYS_BEFORE = 70;

export const INVOLVEMENT_KINDS = ["passes", "sponsorship", "talk", "hosted"] as const;
export type InvolvementKind = (typeof INVOLVEMENT_KINDS)[number];
export const INVOLVEMENT_WORDS: Record<InvolvementKind, string> = { passes: "Passes", sponsorship: "Sponsorship", talk: "Talk", hosted: "Hosted" };

export const HOSTED_FORMATS = ["dinner", "side_event", "roadshow_stop", "webinar", "customer_event"] as const;
export type HostedFormat = (typeof HOSTED_FORMATS)[number];
export const HOSTED_WORDS: Record<HostedFormat, string> = { dinner: "Dinner", side_event: "Side event", roadshow_stop: "Roadshow stop", webinar: "Webinar", customer_event: "Customer event" };

export const BUDGET_CATEGORIES = ["passes", "sponsorship", "booth", "travel", "dinners", "swag", "tools", "rep_time", "other"] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];
export const BUDGET_WORDS: Record<BudgetCategory, string> = { passes: "Passes", sponsorship: "Sponsorship", booth: "Booth", travel: "Travel", dinners: "Dinners", swag: "Swag", tools: "Tools", rep_time: "Rep time", other: "Other" };

export const PERSON_ROLES = ["attend", "host", "speak"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const APPROVAL_MODES = ["per_seat", "budget"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** What the plan stage needs from an event row. Every field here is in EVENT_COLS. */
export type PlanFields = Pick<EventRow, "stage" | "starts_on"> & {
  last_day?: string | null;
  motion?: string;
  plan_stage?: PlanStage;
  approval_mode?: ApprovalMode;
  plan_approved_at?: string | null;
  judged_at?: string | null;
};

/** The plan stage, decided in one place. First match wins (docs/EVENT-PLAN.md section 5). `today` is a YYYY-MM-DD day the caller took from its clock. */
export function planStageOf(e: PlanFields, today: string, prepareDays: number = PREPARE_DAYS_BEFORE): PlanStage {
  // A declined event keeps the plan stage it had and reads "Declined" with its reason.
  if (e.stage === "declined") return e.plan_stage ?? "preparing";
  if (e.judged_at || e.motion === "scored") return "judged";
  const mode = e.approval_mode ?? "per_seat";
  if (mode === "budget" && !e.plan_approved_at) return "planning";
  const first = e.starts_on.slice(0, 10), last = (e.last_day ?? e.starts_on).slice(0, 10);
  if (today > last) return "following_up";
  if (today >= first) return "live";
  if (mode === "per_seat" || (e.stage !== "requested" && e.stage !== "approved") || today >= addDays(first, -prepareDays)) return "preparing";
  return "confirmed";
}

/** What the event waits on. Wraps waitingOn in domain.ts, which is not changed: a plan at requested waits on the planner or the approver, and a hosted event never waits on an attendee list. */
export function planWaitingOn(e: Pick<EventRow, "stage"> & { approval_mode?: ApprovalMode }, plan: { hosted: boolean; submitted: boolean }): string {
  if (e.approval_mode === "budget" && e.stage === "requested") return plan.submitted ? "Approver: the plan" : "Planner: ask for approval";
  if (plan.hosted && e.stage === "approved") return "Nobody";
  return waitingOn(e as { stage: Stage });
}
