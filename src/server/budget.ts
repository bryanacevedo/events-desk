/* The ticket budget. Tickets only: Apollo, models, travel and sponsorship are not here.
   Spent: tickets recorded as bought, at the amount paid. Committed: approved seats not yet bought, at the event's price.
   Waiting: seats still waiting for a decision, at the event's price. A seat counts once, in the quarter its event starts.
   Declined and ended events count for nothing. The budget warns and never blocks. */

import type { Db } from "./db.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { defaultSettings } from "./approvals.ts";

export const REGION: Record<string, string> = {
  "United States": "North America", Canada: "North America", Mexico: "Latin America", Brazil: "Latin America", Argentina: "Latin America", Colombia: "Latin America",
  Netherlands: "Europe", Spain: "Europe", Portugal: "Europe", Ireland: "Europe", Germany: "Europe", France: "Europe", "United Kingdom": "Europe", Sweden: "Europe", Norway: "Europe", Poland: "Europe",
  "Saudi Arabia": "Middle East", "United Arab Emirates": "Middle East", Qatar: "Middle East",
  Thailand: "Asia Pacific", Singapore: "Asia Pacific", Japan: "Asia Pacific", Australia: "Asia Pacific", India: "Asia Pacific", Indonesia: "Asia Pacific",
};
export const regionOf = (country: string | null) => (country && REGION[country]) || "Other";

export interface SeatLine {
  request_id: string; event_id: string; name: string; starts_on: string; year: number; quarter: number; team: string; region: string;
  status: "approved" | "pending"; purchased: boolean; spent: number; committed: number; waiting: number;
  /** The event was deleted; the ticket bought for it stays counted. */
  gone?: boolean;
}

/** One line per live seat, with what it costs and which bucket it is in. The only place the buckets are decided. */
export async function seatLines(q: Db["query"]): Promise<SeatLine[]> {
  const rows = await q<{ request_id: string; event_id: string; name: string; starts_on: string; country: string | null; team: string; status: "approved" | "pending"; price: number; paid: number | null }>(
    `SELECT r.id AS request_id, e.id AS event_id, e.name, e.starts_on::text AS starts_on, e.country, r.team, r.status, e.seat_price_cents AS price, p.amount_cents AS paid
     FROM seat_requests r JOIN events e ON e.id = r.event_id LEFT JOIN ticket_purchases p ON p.seat_request_id = r.id
     WHERE r.status IN ('approved', 'pending') AND (e.stage <> 'declined' OR p.amount_cents IS NOT NULL) AND e.parent_event_id IS NULL`);
  // Tickets bought for events that were deleted, kept so the Budget does not forget money already spent.
  const kept = await q<{ id: string; event_id: string; event_name: string; starts_on: string; country: string | null; team: string; amount_cents: number }>(
    "SELECT id, event_id, event_name, starts_on::text AS starts_on, country, team, amount_cents FROM ticket_spend_kept");
  const goneLines: SeatLine[] = kept.map((k) => ({
    request_id: k.id, event_id: k.event_id, name: k.event_name, starts_on: k.starts_on, year: Number(k.starts_on.slice(0, 4)), quarter: Math.ceil(Number(k.starts_on.slice(5, 7)) / 3),
    team: k.team, region: regionOf(k.country), status: "approved", purchased: true, spent: k.amount_cents, committed: 0, waiting: 0, gone: true,
  }));
  return [...rows.map((r) => {
    const month = Number(r.starts_on.slice(5, 7));
    return {
      request_id: r.request_id, event_id: r.event_id, name: r.name, starts_on: r.starts_on, year: Number(r.starts_on.slice(0, 4)), quarter: Math.ceil(month / 3), team: r.team, region: regionOf(r.country),
      status: r.status, purchased: r.paid !== null,
      spent: r.status === "approved" && r.paid !== null ? r.paid : 0,
      committed: r.status === "approved" && r.paid === null ? r.price : 0,
      waiting: r.status === "pending" ? r.price : 0,
    };
  }), ...goneLines];
}

const sum = (xs: SeatLine[], k: "spent" | "committed" | "waiting") => xs.reduce((n, x) => n + x[k], 0);
const roll = (xs: SeatLine[], cents: number) => {
  const spent = sum(xs, "spent"), committed = sum(xs, "committed"), waiting = sum(xs, "waiting");
  return { budget_cents: cents, spent, committed, waiting, left: cents - spent - committed, left_if_all: cents - spent - committed - waiting };
};

export async function budgetQuarters(q: Db["query"], year: number): Promise<number[] | null> {
  const rows = await q<{ quarter: number; cents: number }>("SELECT quarter, cents FROM budget_quarters WHERE year = $1", [year]);
  if (!rows.length) return null;
  return [1, 2, 3, 4].map((n) => rows.find((r) => r.quarter === n)?.cents ?? 0);
}

export interface BudgetQuery { year: number; q?: string; page?: number; size?: number }

export async function budgetView(db: Db, o: BudgetQuery) {
  const lines = (await seatLines(db.query)).filter((l) => l.year === o.year);
  const quarters = await budgetQuarters(db.query, o.year);
  const per = [1, 2, 3, 4].map((n) => ({ quarter: n, ...roll(lines.filter((l) => l.quarter === n), quarters?.[n - 1] ?? 0) }));
  const year = roll(lines, quarters ? quarters.reduce((a, b) => a + b, 0) : 0);
  const events = new Map<string, { event_id: string; name: string; starts_on: string; quarter: number; seats: number; spent: number; committed: number; waiting: number; gone: boolean }>();
  for (const l of lines) {
    const e = events.get(l.event_id) ?? { event_id: l.event_id, name: l.name, starts_on: l.starts_on, quarter: l.quarter, seats: 0, spent: 0, committed: 0, waiting: 0, gone: l.gone === true };
    if (l.status === "approved") e.seats++;
    e.spent += l.spent; e.committed += l.committed; e.waiting += l.waiting;
    events.set(l.event_id, e);
  }
  const needle = (o.q ?? "").trim().toLowerCase();
  const all = [...events.values()].filter((e) => !needle || e.name.toLowerCase().includes(needle)).sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.name.localeCompare(b.name));
  const size = Math.min(100, Math.max(5, o.size ?? 15)), pages = Math.max(1, Math.ceil(all.length / size)), page = Math.min(pages, Math.max(1, o.page ?? 1));
  const by = (key: "team" | "region") => {
    const m = new Map<string, SeatLine[]>();
    for (const l of lines) m.set(l[key], [...(m.get(l[key]) ?? []), l]);
    return [...m.entries()].map(([name, xs]) => ({ name, spent: sum(xs, "spent"), committed: sum(xs, "committed"), waiting: sum(xs, "waiting") })).sort((a, b) => b.spent + b.committed + b.waiting - (a.spent + a.committed + a.waiting));
  };
  const log = await db.query<{ actor: string; detail: string; created_at: string }>("SELECT actor, detail, created_at FROM budget_log WHERE year = $1 ORDER BY created_at DESC, id LIMIT 8", [o.year]);
  const years = [...new Set([...(await db.query<{ year: number }>("SELECT DISTINCT year FROM budget_quarters")).map((r) => r.year), ...(await seatLines(db.query)).map((l) => l.year)])].sort();
  return { year: o.year, years, set: quarters !== null, quarters: per, totals: year, events: all.slice((page - 1) * size, page * size), total_events: all.length, page, pages, by_team: by("team"), by_region: by("region"), log };
}

export class NotApprover extends Error {}
const gate = (actor: string, approvers: string[] = defaultSettings().approvers) => { if (!approvers.includes(actor)) throw new NotApprover("Only approvers can change the budget or record ticket costs."); };

export async function setBudget(db: Db, actor: string, year: number, quarterDollars: number[], approvers?: string[]) {
  gate(actor, approvers);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new RuleError("Give the year.");
  if (quarterDollars.length !== 4 || quarterDollars.some((d) => !Number.isFinite(d) || d < 0)) throw new RuleError("Give four quarter amounts in dollars, none below zero.");
  const cents = quarterDollars.map((d) => Math.round(d * 100));
  await db.tx(async (q) => {
    for (const [i, c] of cents.entries()) await q("INSERT INTO budget_quarters (year, quarter, cents) VALUES ($1, $2, $3) ON CONFLICT (year, quarter) DO UPDATE SET cents = EXCLUDED.cents", [year, i + 1, c]);
    const money = (n: number) => `$${(n / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    await q("INSERT INTO budget_log (id, year, actor, detail) VALUES ($1, $2, $3, $4)", [newId("bl"), year, actor, `Set ${year} to ${money(cents.reduce((a, b) => a + b, 0))}: ${cents.map((c, i) => `Q${i + 1} ${money(c)}`).join(", ")}`]);
  });
}

/** Records what a ticket cost. One per seat; recording again replaces it, so a seat is never counted twice. */
export async function recordTicket(db: Db, actor: string, requestId: string, amountDollars: number, approvers?: string[]) {
  gate(actor, approvers);
  if (!Number.isFinite(amountDollars) || amountDollars < 0) throw new RuleError("Give the amount paid in dollars.");
  const cents = Math.round(amountDollars * 100);
  return db.tx(async (q) => {
    const [r] = await q<{ event_id: string; status: string; requester: string }>("SELECT event_id, status, requester FROM seat_requests WHERE id = $1", [requestId]);
    if (!r) throw new RuleError("That seat request does not exist.");
    if (r.status !== "approved") throw new RuleError("Only an approved seat has a ticket to record.");
    await q("INSERT INTO ticket_purchases (seat_request_id, event_id, amount_cents, recorded_by) VALUES ($1, $2, $3, $4) ON CONFLICT (seat_request_id) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, recorded_by = EXCLUDED.recorded_by, recorded_at = now()", [requestId, r.event_id, cents, actor]);
    await logActivity(q, r.event_id, actor, "ticket", `Recorded ${r.requester}'s ticket at $${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
    return { seat_request_id: requestId, amount_cents: cents };
  });
}

/** What approving each waiting seat would leave in its quarter. Negative is a warning on the screen; nothing is blocked. */
export async function approvalHeadroom(db: Db): Promise<Map<string, { quarter: number; year: number; left_after: number }>> {
  const lines = await seatLines(db.query);
  const out = new Map<string, { quarter: number; year: number; left_after: number }>();
  const years = [...new Set(lines.map((l) => l.year))];
  for (const y of years) {
    const qs = await budgetQuarters(db.query, y);
    if (!qs) continue;
    for (const l of lines.filter((x) => x.year === y && x.status === "pending")) {
      const inQ = lines.filter((x) => x.year === y && x.quarter === l.quarter);
      out.set(l.request_id, { year: y, quarter: l.quarter, left_after: qs[l.quarter - 1] - sum(inQ, "spent") - sum(inQ, "committed") - l.waiting });
    }
  }
  return out;
}
