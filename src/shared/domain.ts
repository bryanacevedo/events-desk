/* The event rules, written once. The server checks them on every write; the
   screens use them to say what an event is waiting on. Postgres separately
   enforces only the CHECK constraints in migrations/0001_init.sql. Stage
   transitions are not checked in SQL. */

export const STAGES = [
  "requested", "approved", "mapped", "quoted", "tiering",
  "enriching", "flagging", "delivered", "declined", "paused",
  // The two-card flow adds these three (docs/TIERING-AND-ENRICHMENT.md). The single-card flow never uses them.
  "researching", "ready_for_review", "finding_people",
] as const;
export type Stage = (typeof STAGES)[number];

const NEXT: Record<Stage, readonly Stage[]> = {
  requested: ["approved", "declined"],
  approved: ["mapped", "declined"],
  mapped: ["quoted", "declined"],
  // quoted: single-card approval goes to tiering, Research-card approval goes to researching.
  quoted: ["tiering", "researching", "mapped", "declined"],
  tiering: ["enriching", "paused"],
  enriching: ["flagging", "paused"],
  flagging: ["delivered", "paused"],
  delivered: [],
  declined: [],
  paused: ["tiering", "enriching", "flagging", "researching", "ready_for_review", "finding_people"],
  researching: ["ready_for_review", "paused"],
  // Review cases are settled here, and the Outreach card is asked for and decided here. A declined Outreach card stays here.
  ready_for_review: ["finding_people", "declined", "paused"],
  finding_people: ["flagging", "paused"],
};

/** Which approval flow an event uses. New events run the two-card flow (a Research card, then an Outreach card). Single-card is kept for events already running it and for tests of that flow. */
export const FLOWS = ["single_card", "two_card"] as const;
export type Flow = (typeof FLOWS)[number];
export const DEFAULT_FLOW: Flow = "two_card";

export interface EventRow {
  /** Where the event is after delivery. */
  motion?: string;
  id: string;
  name: string;
  venue: string;
  starts_on: string;
  seat_count: number;
  seat_price_cents: number;
  /** The country the event is held in. Ranking and company search use it. Null when not given. */
  country?: string | null;
  /** Which approval flow this event uses. */
  flow?: Flow;
  /** Set by GET /api/events: the catalog entry the event came from, and who uploaded the current attendee list. */
  catalog_id?: string | null;
  uploaded_by?: string | null;
  /** The organizer's website, from the catalog entry. Screens read the logo domain from it. */
  website?: string | null;
  brand_color?: string | null;
  /** Set only by GET /api/events/:id. Null until a Google Sheet is shared. */
  sheet_url?: string | null;
  sheet_error?: string | null;
  stage: Stage;
  paused_from: Stage | null;
  decline_reason: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
  stage_changed_at: string;
  /** Set on a top-up: the delivered event its new registrations belong to. A top-up is never shown as an event. */
  parent_event_id?: string | null;
  ended_at?: string | null;
  merged_at?: string | null;
}

export interface ActivityRow {
  id: string;
  event_id: string;
  actor: string;
  kind: string;
  detail: string;
  created_at: string;
}

/** Returns why a move is not allowed, or null when it is. */
export function moveError(
  e: Pick<EventRow, "stage" | "paused_from">,
  to: Stage,
  reason?: string | null,
): string | null {
  if (!NEXT[e.stage].includes(to)) return `An event cannot go from ${e.stage} to ${to}.`;
  if (e.stage === "paused" && to !== e.paused_from) return `This event paused during ${e.paused_from}, so it can only resume there.`;
  if (to === "declined" && !reason?.trim()) return "Say why before declining.";
  return null;
}

/** What an event says when its Sheet predates the hidden contact id column: nothing there can be matched to a person, so it is left alone until someone chooses to rebuild it. */
export const OLD_SHEET_ERROR = "This sheet has no contact ids, so it was left as it is.";

export const seatBudgetCents = (e: Pick<EventRow, "seat_count" | "seat_price_cents">) => e.seat_count * e.seat_price_cents;

const WAITING: Record<Stage, string> = {
  requested: "Approver: seats",
  approved: "Requester: attendee list",
  mapped: "Requester: cost card",
  quoted: "Approver: cost card",
  tiering: "Running",
  enriching: "Running",
  flagging: "Running",
  researching: "Running",
  ready_for_review: "Approver: settle open cases, then the outreach card",
  finding_people: "Running",
  delivered: "Nobody",
  declined: "Nobody",
  paused: "Someone to resume it",
};
export const waitingOn = (e: Pick<EventRow, "stage">) => WAITING[e.stage];

const LABEL: Record<Stage, string> = {
  requested: "Requested", approved: "Approved", mapped: "Mapped", quoted: "Quoted", tiering: "Tiering",
  enriching: "Enriching", flagging: "Flagging", delivered: "Delivered", declined: "Declined", paused: "Paused",
  researching: "Researching", ready_for_review: "Ready for review", finding_people: "Finding people",
};
export const stageLabel = (s: Stage) => LABEL[s];

export function validateRequest(b: Record<string, unknown>): string | null {
  if (typeof b.name !== "string" || !b.name.trim()) return "Name the event.";
  if (typeof b.starts_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.starts_on)) return "Give the event's start date.";
  if (!Number.isInteger(b.seat_count) || (b.seat_count as number) < 1) return "Ask for at least 1 seat.";
  if (!Number.isInteger(b.seat_price_cents) || (b.seat_price_cents as number) < 0) return "Give the price per seat.";
  if (b.country !== undefined && b.country !== null && (typeof b.country !== "string" || b.country.length > 80)) return "Give the country as text.";
  if (b.flow !== undefined && !(FLOWS as readonly unknown[]).includes(b.flow)) return "The flow is single_card or two_card.";
  return null;
}

/** The design's list of drop reasons, in full (docs/TIERING-AND-ENRICHMENT.md, "All drop reasons"). */
export const DROP_REASONS = [
  "duplicate", "no_company", "junk_row", "not_a_company", "company_not_found", "excluded_company", "existing_customer", "low_tier", "tiering_failed",
  "no_people_found", "no_email_found", "not_deliverable", "email_unconfirmed", "catch_all_unconfirmed", "employment_unconfirmed", "vendor_error", "budget_cap", "rejected_in_review", "opted_out", "crm_unsubscribed", "crm_do_not_contact",
] as const;
export type DropReasonCode = (typeof DROP_REASONS)[number];

const DROP: Record<string, string> = {
  duplicate: "Duplicate", no_company: "No company", junk_row: "Nothing usable in the row", not_a_company: "Not a company (student, press or self-employed)",
  company_not_found: "Company not found", excluded_company: "Excluded company", existing_customer: "Existing customer",
  low_tier: "Low tier", tiering_failed: "Could not be tiered", no_people_found: "No people found", no_contacts_found: "No contacts found", no_email_found: "No email found",
  not_deliverable: "Email not deliverable", email_unconfirmed: "Email could not be confirmed", catch_all_unconfirmed: "Company accepts every address, so no one there could be confirmed",
  employment_unconfirmed: "Employer could not be confirmed", vendor_error: "Vendor error", budget_cap: "Cost card cap reached", rejected_in_review: "Rejected in review", opted_out: "Opted out",
  crm_unsubscribed: "Unsubscribed in Salesforce", crm_do_not_contact: "Do not contact in Salesforce",
};
export const dropLabel = (reason: string) => DROP[reason] ?? reason;
