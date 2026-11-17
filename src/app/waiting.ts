/* Everything that is waiting on a person, across events, from the routes that already exist:
   pending approvals (their own list), events whose next step is a person's, paused events, and
   open data conflicts where the cases route exists. The sidebar count, the Overview and the
   Approvals screen share one load. */

import type { EventRow } from "../shared/domain";
import type { Settings } from "../shared/cost";
import { get, type CatalogEntry, type Pending, type SeatRequest } from "./api";
import { daysTo, firstName, money, plural } from "./words";

export interface NeedItem {
  id: string;
  kind: "soon" | "step" | "paused" | "case";
  holder: string;          // a full name, or "Anyone"
  eventId: string;
  eventName: string;
  what: string;            // one sentence
  fix: string;             // the button's words
  detail?: string;
  caseCount?: number;
}

export interface Needs { items: NeedItem[]; approvals: Pending[]; approvers: string[]; planners: string[]; events: EventRow[]; requests: SeatRequest[]; catalog: CatalogEntry[] }
/** Cost cards are a step on the event, not an approval; the sidebar counts seat requests only. */

export const holderWords = (approvers: string[]) => {
  const names = approvers.map(firstName);
  return names.length ? (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`) : "an approver";
};

/** The same event twice (one name, one first day) is shown once: the demo's own seed and the shared world each made Money20/20 Europe 2027. The one with a plan is kept. */
export function oneRowEach<T extends Pick<EventRow, "name" | "starts_on"> & { approval_mode?: string | null }>(events: T[]): T[] {
  const seen = new Map<string, T>();
  for (const e of events) {
    const key = `${e.name.trim().toLowerCase()}|${e.starts_on.slice(0, 10)}`, was = seen.get(key);
    if (!was || (e.approval_mode === "budget" && was.approval_mode !== "budget")) seen.set(key, e);
  }
  return events.filter((e) => [...seen.values()].includes(e));
}

export async function loadNeeds(): Promise<Needs> {
  const [ev, sr, cat, df] = await Promise.all([
    get<{ events: EventRow[] }>("/api/events"),
    get<{ requests: SeatRequest[] }>("/api/seat-requests"),
    get<{ catalog: CatalogEntry[] }>("/api/catalog"),
    get<{ settings: Settings }>("/api/settings/defaults"),
  ]);
  const events = oneRowEach(ev?.events ?? []);
  const approvers = df?.settings.approvers ?? [];
  const planners = df?.settings.planners ?? [];
  const requests = sr?.requests ?? [];
  // Each waiting seat request is one row on Seats and one in the sidebar count.
  const approvals: Pending[] = requests.filter((r) => r.status === "pending").map((r) => ({ id: r.id, kind: "seats", requested_by: r.requester, event_id: r.event_id, name: r.name, seat_count: 1, seat_price_cents: r.seat_price_cents, lines: null, credits_cap: null, llm_cap: null, est_cents: null }));
  const items: NeedItem[] = [];

  for (const e of events) {
    const n = daysTo(e.starts_on);
    if (e.stage === "approved" && n >= 0 && n <= 30) items.push({ id: `soon:${e.id}`, kind: "soon", holder: e.requested_by, eventId: e.id, eventName: e.name, what: `${e.name} is ${n === 0 ? "today" : `in ${plural(n, "day")}`} and has no attendee list.`, fix: "Add the attendee list" });
    else if (e.stage === "approved") items.push({ id: `step:${e.id}`, kind: "step", holder: e.requested_by, eventId: e.id, eventName: e.name, what: `${e.name} has no attendee list.`, fix: "Add the attendee list" });
    if (e.stage === "quoted") items.push({ id: `run:${e.id}`, kind: "step", holder: e.uploaded_by ?? e.requested_by, eventId: e.id, eventName: e.name, what: `${e.name} is ready to run.`, fix: "Review and run" });
    if (e.stage === "mapped") items.push({ id: `step:${e.id}`, kind: "step", holder: e.requested_by, eventId: e.id, eventName: e.name, what: `${e.name} has attendees in; its card is not priced yet.`, fix: "Price it" });
    if (e.stage === "paused") items.push({ id: `paused:${e.id}`, kind: "paused", holder: "Anyone", eventId: e.id, eventName: e.name, what: `${e.name} is paused. The latest activity says why.`, fix: "Resume it" });
  }
  // One read for every event's open cases (it was one read per delivered event, and the first paint waited for all of them).
  const open = (await get<{ events: { event_id: string; n: number; summary: string }[] }>("/api/cases/open"))?.events ?? [];
  for (const c of open) {
    const e = events.find((x) => x.id === c.event_id);
    if (e) items.push({ id: `case:${e.id}`, kind: "case", holder: "Anyone", eventId: e.id, eventName: e.name, caseCount: c.n, what: `${e.name} has ${c.n === 1 ? "1 conflict" : `${c.n} conflicts`} to settle.`, fix: "Settle it", detail: c.summary });
  }
  // Soonest first.
  const when = (i: NeedItem) => daysTo(events.find((e) => e.id === i.eventId)?.starts_on ?? "2099-01-01");
  items.sort((a, b) => when(a) - when(b));
  return { items, approvals, approvers, planners, events, requests, catalog: cat?.catalog ?? [] };
}

/** What a person reads after asking for a seat: who it went to. The person asking is not one of the approvers who can decide it. */
export const sentTo = (needs: Pick<Needs, "approvers"> | null, actor: string) => {
  const who = (needs?.approvers ?? []).filter((a) => a !== actor);
  return `Sent to ${who.length ? holderWords(who) : "an approver"} for approval. Their answer shows on your page.`;
};

/** Plain words for a cost card's kind. */
export const cardWords = (kind: Pending["kind"]) => kind === "research" ? "Research card" : kind === "outreach" ? "Contacts card" : "Cost card";
export const seatMath = (a: Pending) => `${plural(a.seat_count, "seat")} × ${money(a.seat_price_cents)} = ${money(a.seat_count * a.seat_price_cents)}`;

/** The five steps every event moves through. */
export const STEPS = ["Approve seats", "Add attendees", "Research companies", "Verify and find contacts", "Outreach list ready"] as const;

/** Which step an event is on, counted from 0; 5 means all are done. A paused event is on the step it paused during. Research is not over while its cases are open. */
export function stepAt(e: Pick<EventRow, "stage" | "paused_from">, openCases = 0): number {
  switch (e.stage === "paused" ? e.paused_from ?? "researching" : e.stage) {
    case "requested": case "declined": return 0;
    case "approved": return 1;
    case "ready_for_review": return openCases > 0 ? 2 : 3;
    case "finding_people": return 3;
    case "delivered": return 5;
    default: return 2;
  }
}

/** Who the event waits on and in how few words. */
export function waiting(e: EventRow, approvers: string[]): { who: string | null; initials: string; words: string; tone: "wait" | "ok" | "run" | "none" } {
  const appr = holderWords(approvers);
  const ini = (n: string) => n.trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const apprIni = approvers.length === 1 ? ini(approvers[0]) : "?";
  const owner = e.uploaded_by ?? e.requested_by;
  const req = firstName(owner);
  switch (e.stage) {
    case "requested": return { who: appr, initials: apprIni, words: `${appr}: decide ${plural(e.seat_count, "seat request")}`, tone: "wait" };
    case "approved": return { who: req, initials: ini(owner), words: `${req}: add the attendee list`, tone: "wait" };
    case "mapped": return { who: req, initials: ini(owner), words: `${req}: ask for the cost card`, tone: "wait" };
    case "quoted": return { who: req, initials: ini(owner), words: `${req}: review the cost and run`, tone: "wait" };
    case "tiering": case "enriching": case "flagging": case "researching": case "finding_people": return { who: null, initials: "…", words: "Making the outreach list", tone: "run" };
    case "ready_for_review": return { who: req, initials: ini(owner), words: `${req}: settle open cases, then verify and find contacts`, tone: "wait" };
    case "paused": return { who: "Anyone", initials: "!", words: "Anyone: resume it", tone: "wait" };
    case "delivered": return { who: null, initials: "✓", words: "Outreach list ready", tone: "ok" };
    case "declined": return { who: null, initials: "·", words: `Declined. ${e.decline_reason ?? ""}`.trim(), tone: "none" };
  }
}
