/* The event as a plan (docs/EVENT-PLAN.md). Pure rules shared by the server and the screens. The list stage machine in domain.ts is not
   touched: the plan stage sits beside it and is decided by planStageOf, from the approval, the dates, the list stage and the motion. */

import { waitingOn, type EventRow, type Stage } from "./domain.ts";
import { addDays } from "./motion.ts";

export const PLAN_STAGES = ["planning", "confirmed", "preparing", "live", "following_up", "judged"] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

const PLAN_LABEL: Record<PlanStage, string> = { planning: "Planning", confirmed: "Confirmed", preparing: "Preparing", live: "Live", following_up: "Following up", judged: "Scored" };
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
export function planWaitingOn(e: Pick<EventRow, "stage"> & { approval_mode?: ApprovalMode }, plan: { hosted: boolean; submitted: boolean; /** A hosted event's list: who has not been invited yet. */ guests?: { total: number; listed: number } }): string {
  if (e.approval_mode === "budget" && e.stage === "requested") return plan.submitted ? "Approver: the plan" : "Planner: ask for approval";
  if (plan.hosted && e.stage === "approved") return plan.guests && plan.guests.listed > 0 ? `Host: invite ${plan.guests.listed} ${plan.guests.listed === 1 ? "guest" : "guests"}` : "Nobody";
  return waitingOn(e as { stage: Stage });
}

/* ------------------------------------------------------------------ where a list came from (4.3) */

/** The five a person can name on an upload (x-list-source). The other two come only from Bring in (docs/DIRECTORY.md 4). */
export const UPLOAD_SOURCES = ["web_app_download", "app_download", "emailed_by_organizer", "sponsor_export", "other"] as const;
export const LIST_SOURCES = [...UPLOAD_SOURCES, "directory_extension", "screen_recording"] as const;
export type ListSource = (typeof LIST_SOURCES)[number];
export const LIST_SOURCE_WORDS: Record<ListSource, string> = {
  web_app_download: "Downloaded from the web app", app_download: "Downloaded from the app", emailed_by_organizer: "Emailed by the organizer", sponsor_export: "Sponsor export", other: "Other",
  directory_extension: "Read from the directory with the extension", screen_recording: "Read from a screen recording",
};
export interface ListSourceInput { kind: ListSource; note: string }
export const isUploadSource = (v: unknown): v is (typeof UPLOAD_SOURCES)[number] => typeof v === "string" && (UPLOAD_SOURCES as readonly string[]).includes(v);
export const isListSource = (v: unknown): v is ListSource => typeof v === "string" && (LIST_SOURCES as readonly string[]).includes(v);

/* ------------------------------------------------------------------ sponsorship, deliverables and the week (4.2) */

export const DELIVERABLE_KINDS = ["logo_copy", "booth_graphics", "staff_badges", "sponsor_session", "freight", "electrical", "internet", "lead_retrieval", "other"] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];
/** The standard eight, made with every sponsorship, with no dates: the dates come from the exhibitor manual and a person types them. */
export const STANDARD_DELIVERABLES: readonly { kind: DeliverableKind; label: string }[] = [
  { kind: "logo_copy", label: "Logo and copy" }, { kind: "booth_graphics", label: "Booth graphics" }, { kind: "staff_badges", label: "Staff badges" },
  { kind: "sponsor_session", label: "Sponsor session or side event" }, { kind: "freight", label: "Freight" }, { kind: "electrical", label: "Electrical" },
  { kind: "internet", label: "Internet" }, { kind: "lead_retrieval", label: "Lead retrieval" },
];

export const PROMISE_ITEMS = ["passes", "booth", "talk", "logo", "lead_retrieval", "attendee_list", "meeting_rooms", "side_event", "other"] as const;
export type PromiseItem = (typeof PROMISE_ITEMS)[number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayOf = (ymd: string) => ymd.slice(0, 10);
const utc = (ymd: string) => Date.parse(`${dayOf(ymd)}T00:00:00Z`);
/** Whole days from `a` to `b` (b minus a). */
export const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 86_400_000);
/** "14 Oct": a day as the desk writes it, with no year. */
export const shortDay = (ymd: string) => { const [, m, d] = dayOf(ymd).split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };

/** The words for a promise. Counted: "10 passes: 8 issued". Not counted and not received: "Attendee list: not received". Received: "Attendee list: received 14 Oct". */
export function promiseWords(p: { label: string; promised_qty: number | null; received_qty: number | null; received_on: string | null }): string {
  if (p.promised_qty !== null) return `${p.promised_qty} ${p.label.replace(/^\d+\s+/, "").toLowerCase()}: ${p.received_qty ?? 0} issued`;
  return p.received_on ? `${p.label}: received ${shortDay(p.received_on)}` : `${p.label}: not received`;
}

/** When something is due, in words: "3 days late", "Today", "Tomorrow", "Due Thursday" inside the week, "Due 14 Oct" beyond it, "No date yet" with none. Status is a word in ink. */
export function dueWords(due: string | null, today: string): string {
  if (!due) return "No date yet";
  const n = daysBetween(today, due);
  if (n < 0) return n === -1 ? "1 day late" : `${-n} days late`;
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n <= 6) return `Due ${WEEKDAYS[new Date(utc(due)).getUTCDay()]}`;
  return `Due ${shortDay(due)}`;
}

/** The week's window: today to six days out. Anything before today is late and always shows. */
export function weekWindow(today: string): { from: string; to: string } { return { from: dayOf(today), to: addDays(dayOf(today), 6) }; }
export type DueGroup = "late" | "today" | "week";
export const dueGroup = (due: string, today: string): DueGroup | null => { const n = daysBetween(today, due); return n < 0 ? "late" : n === 0 ? "today" : n <= 6 ? "week" : null; };
