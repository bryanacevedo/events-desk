/* Plain words for the screens. Stage names stay inside the server; a person who
   joined this week reads sentences about what happens next. */

import type { EventRow, Stage } from "../shared/domain";
import type { Settings } from "../shared/cost";

export const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
/** Small AI amounts keep their cents ($0.27); from $10 up they round like the rest. */
export const moneyFine = (cents: number) => (Math.abs(cents) < 1000 ? `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}` : money(cents));
export const seatBudget = (e: Pick<EventRow, "seat_count" | "seat_price_cents">) => money(e.seat_count * e.seat_price_cents);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const noon = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00`);
export const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const daysTo = (ymd: string) => Math.round((noon(ymd).getTime() - noon(todayYmd()).getTime()) / 86_400_000);
export const shortDate = (ymd: string) => noon(ymd).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
export const longDate = (ymd: string) => noon(ymd).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const city = (venue: string) => venue.split(",").pop()?.trim() || venue;
export const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;
export const initials = (name: string | null) => (name ?? "?").split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

/** How far away the doors are, in words. */
export function countdown(ymd: string) {
  const n = daysTo(ymd);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n < 0) return `${plural(-n, "day")} ago`;
  return `in ${plural(n, "day")}`;
}

export const RUNNING: Stage[] = ["tiering", "enriching", "flagging", "researching", "finding_people"];
export const isRunning = (s: Stage) => RUNNING.includes(s);
export const canEnd = (s: Stage) => ["requested", "approved", "mapped", "quoted"].includes(s);

const approverWords = (s: Settings | null) => {
  const names = (s?.approvers ?? []).map(firstName);
  if (!names.length) return "an approver";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
};

/** One line of what happens next. */
export function nextLine(e: EventRow): string {
  switch (e.stage) {
    case "requested": return `Waiting on a decision: ${plural(e.seat_count, "seat request")}.`;
    case "approved": return "Seats approved. Add the attendee list.";
    case "mapped": return "Attendee list in. Pricing the cost card.";
    case "quoted": return "Ready to run.";
    case "tiering": case "enriching": case "flagging": case "researching": case "finding_people": return "Making the outreach list.";
    case "ready_for_review": return "Settle open cases, then verify and find contacts.";
    case "paused": return "Paused.";
    case "delivered": return "Outreach list ready.";
    case "declined": return `Ended. ${e.decline_reason ?? ""}`.trim();
  }
}

/** The line under the event's name. */
export function stageSentence(e: EventRow, s: Settings | null): string {
  const who = approverWords(s);
  switch (e.stage) {
    case "requested": return `Waiting on ${who} to decide ${plural(e.seat_count, "seat request")}.`;
    case "approved": return "Add the attendee list.";
    case "mapped": return "Attendees in";
    case "quoted": return e.flow === "two_card" ? "Ready to run research." : "Ready to run.";
    case "tiering": return "Sorting companies and titles.";
    case "enriching": return "Finding and checking emails.";
    case "flagging": return "Checking doubtful matches.";
    case "researching": return "Researching the companies.";
    case "ready_for_review": return "Research done.";
    case "finding_people": return "Finding people at the companies that fit.";
    case "paused": return "Paused. The latest activity says why.";
    case "delivered": return "Outreach list ready.";
    case "declined": return `Ended. ${e.decline_reason ?? ""}`.trim();
  }
}

export const runningStep = (s: Stage) => (s === "tiering" ? 1 : s === "enriching" ? 2 : s === "flagging" ? 3 : 0);

export const DROP_WORDS: Record<string, string> = {
  duplicate: "Same person twice on the attendee list",
  no_company: "No company on the row",
  excluded_company: "On the never-contact companies",
  existing_customer: "Already a customer",
  low_tier: "Low priority",
  tiering_failed: "Could not be sorted into a tier",
  no_contacts_found: "Nobody found at the company",
  no_people_found: "Nobody found at the company",
  no_email_found: "No email found",
  not_deliverable: "Email does not deliver",
  email_unconfirmed: "Email could not be confirmed",
  catch_all_unconfirmed: "Catch-all domain",
  employment_unconfirmed: "Employer not confirmed",
  opted_out: "Opted out",
  crm_unsubscribed: "Unsubscribed in Salesforce",
  crm_do_not_contact: "Do not contact in Salesforce",
  junk_row: "Junk row",
  not_a_company: "Not a company",
  company_not_found: "Company not found",
  vendor_error: "A data source kept failing",
  budget_cap: "The cost card cap was reached",
  rejected_in_review: "Dropped in review",
};
export const dropWords = (r: string) => DROP_WORDS[r] ?? r.replace(/_/g, " ");

/** The kinds of case, as a group heading. Blocking kinds hold up the Outreach card; the rest can wait until the list is out. */
export const CASE_WORDS: Record<string, string> = {
  ambiguous_identity: "Which company",
  owner_unreachable: "Owner couldn't be asked",
  reply_doubtful: "Reply to read",
  company_not_found: "Company not found",
  unknown_tier: "Which tier",
  second_look_disagreement: "Two looks, two tiers",
  fuzzy_list_match: "Close to a listed name",
  crm_customer_mismatch: "Customer or not",
  subsidiary_inheritance: "Part of a listed company",
  name_email_mismatch: "Name and address differ",
  attendee_vendor_mismatch: "Registered elsewhere",
  model_flag: "Doubt about the person",
  same_person_two_companies: "Two companies",
  free_webmail: "Personal address",
  late_stage_deal: "Late-stage deal",
};
export const caseWords = (k: string) => CASE_WORDS[k] ?? k.replace(/_/g, " ");

export const num = (n: number) => n.toLocaleString("en-US");
