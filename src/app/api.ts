/* Thin fetch layer. Every write carries the acting person's name; the server checks the rules. */

import type { ActivityRow, EventRow } from "../shared/domain";
import type { CardLines, Settings } from "../shared/cost";
import type { ListSummary } from "../server/uploads";
import type { DeliveredLately, LiveRow, OutreachNeed, ResultRow } from "../server/overview";
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
export type { DeliveredLately, LiveRow, OutreachNeed, ResultRow };

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
    const r = await fetch(path);
    // A route that does not exist on this server falls through to the app's HTML; that is "nothing here", not data.
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function send<T = unknown>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, actor: string, body?: unknown, raw?: { bytes: ArrayBuffer; filename: string; type: string }): Promise<Result<T>> {
  const headers: Record<string, string> = { "x-actor": encodeURIComponent(actor) };
  let payload: BodyInit | undefined;
  if (raw) { headers["x-filename"] = encodeURIComponent(raw.filename); headers["content-type"] = raw.type; payload = raw.bytes; }
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  try {
    const r = await fetch(path, { method, headers, body: payload });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: data as T } : { ok: false, error: (data as { error?: string }).error ?? "That did not go through. Try again." };
  } catch {
    return { ok: false, error: "The desk could not be reached. Check the connection and try again." };
  }
}
