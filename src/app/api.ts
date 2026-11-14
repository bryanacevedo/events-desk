/* Thin fetch layer. Every write carries the acting person's name; the server checks the rules. */

import type { ActivityRow, EventRow } from "../shared/domain";
import type { CardLines, Settings } from "../shared/cost";
import type { ListSummary } from "../server/uploads";
import type { DeliveredLately, LiveRow, OutreachNeed, ResultRow } from "../server/overview";
import type { DeadlineRow, YearRow } from "../server/plan";
import type { ListSource } from "../shared/plan";
import type { Spread } from "../shared/tiering";
import type { CompanyRow, PersonRow } from "../server/event-views";

/** A cost card. `kind` is "research" or "outreach" in the two-card flow; the single-card flow has no kind. Lines are read loosely: each kind has its own. */
export interface Card {
  id: string; kind?: "research" | "outreach" | null; status: "pending" | "approved" | "declined"; lines: CardLines & Record<string, number | { credits: number; llm: number; cents: number; label: string } | undefined>;
  inputs?: Record<string, unknown>; step_caps?: Record<string, { credits?: number; llm?: number }>; credits_cap: number; llm_cap: number; est_cents: number; created_at?: string;
}
export interface Spend { credits: number; llm: number }
export interface StepSpend { card_id: string; kind: string | null; step: string; unit: "credits" | "llm"; n: number; /** AI only, in cents: real tokens where a call has them, else the flat rate. */ cents?: number }
export interface EventPayload {
  event: EventRow; activity: ActivityRow[]; list: ListSummary; settings: Settings | null; card: Card | null; cards?: Card[]; spend: Spend; spend_by_step?: StepSpend[];
  open_cases?: number; uploads?: UploadItem[]; top_ups?: TopUpItem[]; spread?: Spread | null; sheet_url?: string | null; sheet_error?: string | null;
}
export type { CompanyRow, PersonRow, Spread };
/** One attendee list received, oldest first. `has_file` is false for a list uploaded before originals were kept. */
export interface UploadItem { id: string; filename: string; uploaded_by: string; created_at: string; row_count: number; has_file: boolean; file_rows: number | null; already_in: number | null; top_up_id: string | null }
/** New registrations for a delivered event: running, stopped or merged. */
export interface TopUpItem { id: string; stage: string; ended_at: string | null; ended_reason: string | null; merged_at: string | null; created_at: string; upload_id: string | null; filename: string | null; uploaded_by: string | null; file_rows: number | null; already_in: number | null; new_rows: number | null; has_file: boolean }
export interface TopUpCounts { file_rows: number; already_in: number; new_rows: number; dropped: number; top_up_id: string | null }
export interface Page<T> { total: number; offset: number; limit: number; rows: T[] }
export interface Contact {
  id: string; full_name: string | null; title: string | null; company: string | null; company_tier: 1 | 2 | 3 | null; title_tier: 1 | 2 | 3 | null;
  email: string | null; priority: "A" | "B" | "C" | null; drop_reason: string | null; source: "attendee" | "prospect"; flags: string[];
}
/** A pending approval. "card" is the single cost card; "research" and "outreach" are the two cards of the two-card flow. */
export interface Pending {
  id: string; kind: "seats" | "card" | "research" | "outreach"; requested_by: string; event_id: string; name: string; seat_count: number; seat_price_cents: number;
  lines: CardLines | null; credits_cap: number | null; llm_cap: number | null; est_cents: number | null;
}
export type { DeliveredLately, LiveRow, OutreachNeed, ResultRow, DeadlineRow, YearRow };
/** The year plan. A rep's read has no key that holds dollars, so every `*_cents` is optional. */
export interface YearPlanRead { year: number; today: string; events: (Omit<YearRow, "planned_cents" | "contracted_cents" | "actual_cents" | "goal"> & { planned_cents?: number; contracted_cents?: number; actual_cents?: number; goal: { meetings_held: number | null; accounts_met: number | null; pipeline_cents?: number | null } })[]; total_planned_cents?: number; total_contracted_cents?: number; total_actual_cents?: number }

/** An event people can ask for a seat at. `event_id` is the live event row, when someone has asked. */
export interface CatalogEntry {
  id: string; name: string; venue: string; city: string; country: string; starts_on: string; ends_on: string; website: string | null; brand_color?: string | null;
  seat_price_cents: number; price_is_estimate: boolean; source: "listed" | "suggested"; size: string | null;
  event_id: string | null; stage: string | null; going: number; waiting: number;
}
export type Goal = "new_pipeline" | "existing_customers" | "partners" | "speaking_sponsoring" | "market_learning";
export const GOAL_WORDS: Record<Goal, string> = { new_pipeline: "New pipeline", existing_customers: "Existing customers", partners: "Partners", speaking_sponsoring: "Speaking or sponsoring", market_learning: "Market learning" };
export interface SeatRequest {
  id: string; event_id: string; name: string; venue: string; starts_on: string; stage: string; seat_price_cents: number; price_is_estimate: boolean; is_new: boolean; website?: string | null; brand_color?: string | null;
  requester: string; team: string; role: string; goal: Goal; why_event: string; why_you: string; expected_meetings: number; known_accounts: string | null;
  travel_cents: number | null; decide_by: string | null; status: "pending" | "approved" | "declined"; decided_by: string | null; decline_reason: string | null; created_at: string;
  approved_on_event: number; ticket_cents: number | null; budget: { year: number; quarter: number; left_after: number } | null;
}

/** A data conflict the pipeline could not settle alone. Shapes are read loosely: the server owns them. */
export interface CaseOption { value: string; label: string; effect?: string }
export interface ReviewCase {
  id: string; kind: string; summary: string; blocking?: boolean; status?: string;
  facts: unknown; suggested: string | null; options: (string | Partial<CaseOption> & { id?: string; title?: string; result?: string; description?: string })[];
  decision: string | null; decided_by?: string | null; company?: string | null; company_id?: string | null; contact_id?: string | null; created_at?: string;
  person?: { id: string; full_name: string | null; title: string | null; email: string | null; priority: string | null; source: string; dropped: boolean } | null;
}

export type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export async function get<T>(path: string): Promise<T | null> {
  try {
    // Who is acting rides along on reads too, so the server can keep company money to leadership and GTM.
    let actor = ""; try { actor = localStorage.getItem("actor") ?? ""; } catch { /* private window */ }
    const r = await fetch(path, actor ? { headers: { "x-actor": encodeURIComponent(actor) } } : undefined);
    // A route that does not exist on this server falls through to the app's HTML; that is "nothing here", not data.
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function send<T = unknown>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, actor: string, body?: unknown, raw?: { bytes: ArrayBuffer; filename: string; type: string; headers?: Record<string, string> }): Promise<Result<T>> {
  const headers: Record<string, string> = { "x-actor": encodeURIComponent(actor) };
  let payload: BodyInit | undefined;
  if (raw) { headers["x-filename"] = encodeURIComponent(raw.filename); Object.assign(headers, raw.headers); headers["content-type"] = raw.type; payload = raw.bytes; }
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  try {
    const r = await fetch(path, { method, headers, body: payload });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: data as T } : { ok: false, error: (data as { error?: string }).error ?? "That did not go through. Try again." };
  } catch {
    return { ok: false, error: "The desk could not be reached. Check the connection and try again." };
  }
}

/** The plan read (GET /api/events/:id/plan). A rep's read has no money keys and no `budget`; every key ending in `cents` is leadership's and planners'. */
export interface PlanInvolvement { id: string; kind: "passes" | "sponsorship" | "talk" | "hosted"; label: string; status: "planned" | "confirmed" | "dropped"; dropped_reason: string | null; conference_event_id: string | null; pass_count: number | null; hosted_format: string | null; headcount: number | null; talk_title: string | null; speaker: string | null }
export interface PlanPerson { id: string; person: string; roles: string[]; team: string; involvement_id: string | null; seat_request_id: string | null; seat_status: "pending" | "approved" | "declined" | null }
export interface PlanBudgetCategory { category: string; label: string; line_ids: string[]; planned_cents: number; contracted_cents: number | null; actual_cents: number | null }
export interface GoalLine { goal: number; actual: number; short_by: number }
export interface PlanDeliverable { id: string; kind: string; label: string; due_on: string | null; owner: string; done: boolean; done_by: string | null; note: string; due_words: string; group: "late" | "today" | "week" | null }
export interface PlanPromise { id: string; item: string; label: string; promised_qty: number | null; received_qty: number | null; received_on: string | null; note: string; words: string }
/** The assessment and the request to the organizer (GET /api/events/:id/assessment, and carried on the plan read). No money is in either. */
export interface AssessmentAnswer { id: string; question: string; answer: string; detail: string; source_kind: string; source_id: string | null; quote: string; proposed_by: string; state: "proposed" | "confirmed"; confirmed_by: string | null; confirmed_at: string | null }
export interface AssessmentQuestion { id: string; label: string; type: "choice" | "list" | "text"; values: string[]; words: Record<string, string>; max: number; answer: AssessmentAnswer | null }
export interface OrganizerRequest { id: string; template: "ask_for_list" | "follow_up"; subject: string; body: string; organizer_name: string; status: "drafted" | "copied" | "sent" | "will_share" | "will_not_share" | "received"; copied_by: string | null; copied_at: string | null; sent_on: string | null; expected_on: string | null; follow_up_on: string | null; created_by: string }
export interface AssessmentData {
  assessment: { id: string; status: "draft" | "confirmed"; confirmed_by: string | null; confirmed_at: string | null; conference_key: string; copied_from_id: string | null } | null;
  questions: AssessmentQuestion[];
  sources: { id: string; input: "pasted" | "fetched"; source_kind: string; url: string | null; chars: number; added_by: string; created_at: string }[];
  progress: { confirmed: number; total: number; proposed: number }; reads_left: number; reads_cap: number;
  finds_networking: boolean; last_year: { event_name: string } | null;
  organizer_request: OrganizerRequest | null; request_offered: boolean; request_open: boolean;
}
export interface PlanData {
  event: { id: string; name: string; venue: string; starts_on: string; last_day: string; stage: string; decline_reason: string | null; approval_mode: "per_seat" | "budget"; hosted: boolean };
  stage_line: { plan_stage: string; plan_stage_label: string; list_stage: string; list_stage_label: string; waiting_on: string; paused: boolean };
  reason: string; reason_words: string | null;
  goal: { meetings_held: number | null; accounts_met: number | null; pipeline_cents?: number | null };
  result: { meetings: GoalLine | null; accounts: GoalLine | null; pipeline: { goal_cents?: number; actual_cents?: number; short_by_cents?: number } | null; words: string[] };
  approval: { submitted_at: string | null; approved_by: string | null; approved_at: string | null; approved_budget_cents?: number | null; requested_by: string; approvers: string[]; over_budget: boolean; over_plan: boolean; waiting_seats: number };
  involvements: PlanInvolvement[]; side_events: { id: string; name: string; starts_on: string; hosted_format: string; plan_stage: string }[]; who_goes: PlanPerson[];
  notes: string[]; judged_at: string | null; can_plan: boolean;
  /** The package. Prices (`*_cents`) are leadership's and planners'. `tier_name` is the tier, read under another key because db.ts turns a key named tier into a number. */
  sponsorship: { id: string; involvement_id: string; tier_name: string; price_cents?: number; contract_signed_on: string | null; deposit_cents?: number | null; deposit_due_on: string | null; deposit_paid_on: string | null; balance_due_on: string | null; balance_paid_on: string | null } | null;
  deliverables: PlanDeliverable[]; promises: PlanPromise[]; deadlines: { kind: string; ref_id: string; label: string; due_on: string; owner: string; due_words: string; group: "late" | "today" | "week" | null }[];
  list_source: { list_source: ListSource; source_note: string } | null;
  assessment: AssessmentData; organizer_request: OrganizerRequest | null;
  budget?: { lines: { id: string; category: string; label: string; planned_cents: number; contracted_cents: number | null }[]; categories: PlanBudgetCategory[]; ai_actual_cents: number; total_planned_cents: number; total_contracted_cents: number; total_actual_cents: number; approved_budget_cents: number | null };
}
