/* Sponsorship (docs/EVENT-PLAN.md 4.2): the package, its deliverables with due dates, and what was promised against what arrived.
   Saving the package writes the sponsorship's one budget line in the same transaction. Paying is recorded on the Cost tab ledger, never here.
   Every key that holds dollars ends in `cents`, so forRep strips it for a rep. */

import type { Db } from "./db.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { Forbidden } from "./seats.ts";
import { dollars } from "./budget-lines.ts";
import {
  DELIVERABLE_KINDS, dueGroup, dueWords, PROMISE_ITEMS, promiseWords, STANDARD_DELIVERABLES, type DeliverableKind, type DueGroup, type PromiseItem,
} from "../shared/plan.ts";

export class SponsorshipInvalid extends Error {}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const ymdOk = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const day = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (!ymdOk(v)) throw new SponsorshipInvalid(`Give ${what} as a date.`);
  return v;
};
const cents = (v: unknown, what: string): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new SponsorshipInvalid(`Give ${what} in cents, zero or more.`);
  return v;
};

export interface PackageInput {
  tier?: string; price_cents?: number; contract_signed_on?: string | null; deposit_cents?: number | null;
  deposit_due_on?: string | null; deposit_paid_on?: string | null; balance_due_on?: string | null; balance_paid_on?: string | null;
}

/** Makes the standard eight for a sponsorship, with no dates. `ids` fixes their ids, in order (a seed uses it so a rerun is the same). */
export async function standardDeliverables(q: Db["query"], sponsorshipId: string, eventId: string, ids?: string[]) {
  const made: string[] = [];
  for (const [n, d] of STANDARD_DELIVERABLES.entries()) {
    const id = ids?.[n] ?? newId("dlv");
    await q("INSERT INTO sponsorship_deliverables (id, sponsorship_id, event_id, kind, label, position) VALUES ($1, $2, $3, $4, $5, $6)", [id, sponsorshipId, eventId, d.kind, d.label, n]);
    made.push(id);
  }
  return made;
}

/** Saves the package for one sponsorship involvement, making it (and the standard eight) the first time. The sponsorship's budget line follows in the same transaction:
    unsigned, planned = the price; signed, contracted = the price. Saving twice never makes a second line. */
export async function saveSponsorship(db: Db, actor: string, eventId: string, involvementId: string, input: PackageInput, opts: { id?: string; deliverable_ids?: string[] } = {}) {
  const price = input.price_cents === undefined ? undefined : cents(input.price_cents, "the price");
  return db.tx(async (q) => {
    const [e] = await q<{ stage: string; parent_event_id: string | null }>("SELECT stage, parent_event_id FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (!e) throw new RuleError("That event does not exist.");
    if (e.parent_event_id) throw new RuleError("New registrations have no plan of their own.");
    if (e.stage === "declined") throw new RuleError("This event was declined, so its plan is closed.");
    const [inv] = await q<{ kind: string; status: string }>("SELECT kind, status FROM involvements WHERE id = $1 AND event_id = $2 FOR UPDATE", [involvementId, eventId]);
    if (!inv) throw new RuleError("That involvement is not on this event.");
    if (inv.kind !== "sponsorship") throw new RuleError("Only a sponsorship has a package.");
    if (inv.status === "dropped") throw new RuleError("That sponsorship was dropped.");
    const [old] = await q<{ id: string; tier_name: string; price_cents: number; contract_signed_on: string | null; deposit_cents: number | null; deposit_due_on: string | null; deposit_paid_on: string | null; balance_due_on: string | null; balance_paid_on: string | null }>(
      `SELECT id, tier AS tier_name, price_cents::float8 AS price_cents, contract_signed_on::text AS contract_signed_on, deposit_cents::float8 AS deposit_cents, deposit_due_on::text AS deposit_due_on,
              deposit_paid_on::text AS deposit_paid_on, balance_due_on::text AS balance_due_on, balance_paid_on::text AS balance_paid_on FROM sponsorships WHERE involvement_id = $1 FOR UPDATE`, [involvementId]);
    const has = (k: keyof PackageInput) => input[k] !== undefined;
    const next = {
      tier: has("tier") ? text(input.tier).slice(0, 60) : old?.tier_name ?? "",
      price_cents: price ?? (old ? Number(old.price_cents) : 0),
      contract_signed_on: has("contract_signed_on") ? day(input.contract_signed_on, "the day the contract was signed") : old?.contract_signed_on ?? null,
      deposit_cents: has("deposit_cents") ? cents(input.deposit_cents, "the deposit") : old?.deposit_cents === null || old?.deposit_cents === undefined ? null : Number(old.deposit_cents),
      deposit_due_on: has("deposit_due_on") ? day(input.deposit_due_on, "the deposit due day") : old?.deposit_due_on ?? null,
      deposit_paid_on: has("deposit_paid_on") ? day(input.deposit_paid_on, "the day the deposit was paid") : old?.deposit_paid_on ?? null,
      balance_due_on: has("balance_due_on") ? day(input.balance_due_on, "the balance due day") : old?.balance_due_on ?? null,
      balance_paid_on: has("balance_paid_on") ? day(input.balance_paid_on, "the day the balance was paid") : old?.balance_paid_on ?? null,
    };
    if (next.deposit_cents !== null && next.deposit_cents > next.price_cents) throw new SponsorshipInvalid("The deposit cannot be more than the price.");
    let id = old?.id;
    if (id) {
      await q(`UPDATE sponsorships SET tier = $2, price_cents = $3, contract_signed_on = $4, deposit_cents = $5, deposit_due_on = $6, deposit_paid_on = $7, balance_due_on = $8, balance_paid_on = $9, updated_by = $10, updated_at = now() WHERE id = $1`,
        [id, next.tier, next.price_cents, next.contract_signed_on, next.deposit_cents, next.deposit_due_on, next.deposit_paid_on, next.balance_due_on, next.balance_paid_on, actor]);
    } else {
      id = opts.id ?? newId("spo");
      await q(`INSERT INTO sponsorships (id, involvement_id, event_id, tier, price_cents, contract_signed_on, deposit_cents, deposit_due_on, deposit_paid_on, balance_due_on, balance_paid_on, updated_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, involvementId, eventId, next.tier, next.price_cents, next.contract_signed_on, next.deposit_cents, next.deposit_due_on, next.deposit_paid_on, next.balance_due_on, next.balance_paid_on, actor]);
      await standardDeliverables(q, id, eventId, opts.deliverable_ids);
    }
    // The one budget line. Unsigned: planned is the price. Signed: contracted is the price, and a planned figure already there stays.
    const signed = next.contract_signed_on !== null;
    const [line] = await q<{ id: string; planned_cents: number }>("SELECT id, planned_cents::float8 AS planned_cents FROM budget_lines WHERE involvement_id = $1 AND category = 'sponsorship' FOR UPDATE", [involvementId]);
    const label = next.tier ? `${next.tier} package` : "Sponsorship package";
    if (line) await q("UPDATE budget_lines SET planned_cents = $2, contracted_cents = $3, label = $4, updated_by = $5, updated_at = now() WHERE id = $1",
      [line.id, signed ? Number(line.planned_cents) : next.price_cents, signed ? next.price_cents : null, label, actor]);
    else await q("INSERT INTO budget_lines (id, event_id, involvement_id, category, label, planned_cents, contracted_cents, note, updated_by) VALUES ($1, $2, $3, 'sponsorship', $4, $5, $6, '', $7)",
      [newId("bln"), eventId, involvementId, label, next.price_cents, signed ? next.price_cents : null, actor]);
    await logActivity(q, eventId, actor, "budget", `Sponsorship${next.tier ? ` (${next.tier})` : ""}: ${dollars(next.price_cents)}${signed ? ", contract signed" : ""}`);
    return { id, created: !old };
  });
}

/* ------------------------------------------------------------------ deliverables */

export interface DeliverableInput { sponsorship_id?: string; kind?: string; label?: string; due_on?: string | null; owner?: string; note?: string; done?: boolean }

async function sponsorshipOf(q: Db["query"], eventId: string, sponsorshipId?: string) {
  const rows = await q<{ id: string }>("SELECT s.id FROM sponsorships s JOIN involvements i ON i.id = s.involvement_id WHERE s.event_id = $1 AND i.status <> 'dropped' AND ($2::text IS NULL OR s.id = $2) ORDER BY s.id", [eventId, sponsorshipId ?? null]);
  if (!rows.length) throw new RuleError("This event has no sponsorship package yet. Save the package first.");
  if (rows.length > 1) throw new SponsorshipInvalid("This event has more than one sponsorship. Say which.");
  return rows[0].id;
}

export async function addDeliverable(db: Db, actor: string, eventId: string, b: DeliverableInput) {
  const kind = (b.kind ?? "other") as DeliverableKind;
  if (!(DELIVERABLE_KINDS as readonly string[]).includes(kind)) throw new SponsorshipInvalid(`A deliverable is one of: ${DELIVERABLE_KINDS.join(", ")}.`);
  const label = text(b.label).slice(0, 120);
  if (!label) throw new SponsorshipInvalid("Name the deliverable.");
  const due = day(b.due_on, "the due day");
  return db.tx(async (q) => {
    const sid = await sponsorshipOf(q, eventId, b.sponsorship_id);
    const id = newId("dlv");
    await q("INSERT INTO sponsorship_deliverables (id, sponsorship_id, event_id, kind, label, due_on, owner, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [id, sid, eventId, kind, label, due, text(b.owner).slice(0, 80), text(b.note).slice(0, 300)]);
    await logActivity(q, eventId, actor, "plan", `Added deliverable: ${label}`);
    return { id };
  });
}

/** A planner changes anything on a deliverable. The person named as its owner may mark their own done, and only that. */
export async function updateDeliverable(db: Db, actor: string, eventId: string, did: string, patch: DeliverableInput, opts: { planner: boolean }) {
  return db.tx(async (q) => {
    const [d] = await q<{ label: string; owner: string; done_at: string | null }>("SELECT label, owner, done_at::text AS done_at FROM sponsorship_deliverables WHERE id = $1 AND event_id = $2 FOR UPDATE", [did, eventId]);
    if (!d) throw new RuleError("That deliverable is not on this event.");
    const onlyDone = Object.keys(patch).every((k) => k === "done");
    if (!opts.planner && !(onlyDone && d.owner !== "" && d.owner === actor)) throw new Forbidden("A deliverable is changed by the planner, or marked done by the person it is assigned to.");
    const sets: string[] = [], vals: unknown[] = [did];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.label !== undefined) { const l = text(patch.label).slice(0, 120); if (!l) throw new SponsorshipInvalid("Name the deliverable."); put("label", l); }
    if (patch.kind !== undefined) { if (!(DELIVERABLE_KINDS as readonly string[]).includes(patch.kind)) throw new SponsorshipInvalid(`A deliverable is one of: ${DELIVERABLE_KINDS.join(", ")}.`); put("kind", patch.kind); }
    if (patch.due_on !== undefined) put("due_on", day(patch.due_on, "the due day"));
    if (patch.owner !== undefined) put("owner", text(patch.owner).slice(0, 80));
    if (patch.note !== undefined) put("note", text(patch.note).slice(0, 300));
    if (patch.done !== undefined) {
      if (patch.done && !d.done_at) { sets.push("done_at = now()"); put("done_by", actor); }
      if (!patch.done && d.done_at) { sets.push("done_at = NULL"); sets.push("done_by = NULL"); }
    }
    if (!sets.length) throw new SponsorshipInvalid("Say what to change.");
    await q(`UPDATE sponsorship_deliverables SET ${sets.join(", ")} WHERE id = $1`, vals);
    await logActivity(q, eventId, actor, "plan", patch.done !== undefined ? `${patch.done ? "Marked done" : "Reopened"}: ${d.label}` : `Changed deliverable: ${d.label}`);
    return { id: did };
  });
}

/* ------------------------------------------------------------------ promised against received */

export interface PromiseInput { sponsorship_id?: string; item?: string; label?: string; promised_qty?: number | null; received_qty?: number | null; received_on?: string | null; note?: string }

const count = (v: unknown, what: string): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new SponsorshipInvalid(`Give ${what} as a whole number, zero or more.`);
  return v;
};

export async function addPromise(db: Db, actor: string, eventId: string, b: PromiseInput) {
  const item = (b.item ?? "other") as PromiseItem;
  if (!(PROMISE_ITEMS as readonly string[]).includes(item)) throw new SponsorshipInvalid(`A promise is one of: ${PROMISE_ITEMS.join(", ")}.`);
  const label = text(b.label).slice(0, 120);
  if (!label) throw new SponsorshipInvalid("Say what was promised.");
  const promised = count(b.promised_qty, "the number promised"), received = count(b.received_qty, "the number received");
  if (received !== null && promised === null) throw new SponsorshipInvalid("Say how many were promised before saying how many arrived.");
  return db.tx(async (q) => {
    const sid = await sponsorshipOf(q, eventId, b.sponsorship_id);
    const id = newId("prm");
    await q("INSERT INTO sponsorship_promises (id, sponsorship_id, item, label, promised_qty, received_qty, received_on, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [id, sid, item, label, promised, received, day(b.received_on, "the day it arrived"), text(b.note).slice(0, 300)]);
    await logActivity(q, eventId, actor, "plan", `Promised: ${label}`);
    return { id };
  });
}

export async function updatePromise(db: Db, actor: string, eventId: string, pid: string, patch: PromiseInput) {
  return db.tx(async (q) => {
    const [p] = await q<{ label: string; promised_qty: number | null; received_qty: number | null }>("SELECT p.label, p.promised_qty, p.received_qty FROM sponsorship_promises p JOIN sponsorships s ON s.id = p.sponsorship_id WHERE p.id = $1 AND s.event_id = $2 FOR UPDATE OF p", [pid, eventId]);
    if (!p) throw new RuleError("That promise is not on this event.");
    const sets: string[] = [], vals: unknown[] = [pid];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.label !== undefined) { const l = text(patch.label).slice(0, 120); if (!l) throw new SponsorshipInvalid("Say what was promised."); put("label", l); }
    if (patch.item !== undefined) { if (!(PROMISE_ITEMS as readonly string[]).includes(patch.item)) throw new SponsorshipInvalid(`A promise is one of: ${PROMISE_ITEMS.join(", ")}.`); put("item", patch.item); }
    const promised = patch.promised_qty === undefined ? p.promised_qty : count(patch.promised_qty, "the number promised");
    const received = patch.received_qty === undefined ? p.received_qty : count(patch.received_qty, "the number received");
    if (received !== null && promised === null) throw new SponsorshipInvalid("Say how many were promised before saying how many arrived.");
    if (patch.promised_qty !== undefined) put("promised_qty", promised);
    if (patch.received_qty !== undefined) put("received_qty", received);
    if (patch.received_on !== undefined) put("received_on", day(patch.received_on, "the day it arrived"));
    if (patch.note !== undefined) put("note", text(patch.note).slice(0, 300));
    if (!sets.length) throw new SponsorshipInvalid("Say what to change.");
    await q(`UPDATE sponsorship_promises SET ${sets.join(", ")} WHERE id = $1`, vals);
    await logActivity(q, eventId, actor, "plan", `Changed promise: ${patch.label ?? p.label}`);
    return { id: pid };
  });
}

/* ------------------------------------------------------------------ reads */

export interface DeliverableRow { id: string; kind: DeliverableKind; label: string; due_on: string | null; owner: string; done: boolean; done_by: string | null; note: string; due_words: string; group: DueGroup | null }

/** The package, its deliverables by due date (no date last), and promised against received, with the words made in code. Prices sit under `*_cents` keys. */
export async function sponsorshipView(db: Db, eventId: string, today: string) {
  /* `tier` is read as `tier_name`: db.ts turns any value under a key named tier into a number (the title tier), which would make "Gold" NaN. */
  const [pkg] = await db.query<{ id: string; involvement_id: string; tier_name: string; price_cents: number; contract_signed_on: string | null; deposit_cents: number | null; deposit_due_on: string | null; deposit_paid_on: string | null; balance_due_on: string | null; balance_paid_on: string | null }>(
    `SELECT s.id, s.involvement_id, s.tier AS tier_name, s.price_cents::float8 AS price_cents, s.contract_signed_on::text AS contract_signed_on, s.deposit_cents::float8 AS deposit_cents, s.deposit_due_on::text AS deposit_due_on,
            s.deposit_paid_on::text AS deposit_paid_on, s.balance_due_on::text AS balance_due_on, s.balance_paid_on::text AS balance_paid_on
     FROM sponsorships s JOIN involvements i ON i.id = s.involvement_id WHERE s.event_id = $1 AND i.status <> 'dropped' ORDER BY s.id LIMIT 1`, [eventId]);
  if (!pkg) return { sponsorship: null, deliverables: [] as DeliverableRow[], promises: [] };
  const deliverables = (await db.query<{ id: string; kind: DeliverableKind; label: string; due_on: string | null; owner: string; done_at: string | null; done_by: string | null; note: string }>(
    "SELECT id, kind, label, due_on::text AS due_on, owner, done_at::text AS done_at, done_by, note FROM sponsorship_deliverables WHERE sponsorship_id = $1 ORDER BY (due_on IS NULL), due_on, position, created_at, id", [pkg.id]))
    .map((d): DeliverableRow => ({ id: d.id, kind: d.kind, label: d.label, due_on: d.due_on, owner: d.owner, done: d.done_at !== null, done_by: d.done_by, note: d.note,
      due_words: d.done_at ? "Done" : dueWords(d.due_on, today), group: d.due_on && !d.done_at ? dueGroup(d.due_on, today) : null }));
  const promises = (await db.query<{ id: string; item: string; label: string; promised_qty: number | null; received_qty: number | null; received_on: string | null; note: string }>(
    "SELECT id, item, label, promised_qty, received_qty, received_on::text AS received_on, note FROM sponsorship_promises WHERE sponsorship_id = $1 ORDER BY created_at, (promised_qty IS NULL), id", [pkg.id]))
    .map((p) => ({ ...p, words: promiseWords(p) }));
  return { sponsorship: pkg, deliverables, promises };
}
