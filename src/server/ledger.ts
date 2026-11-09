/* The spend cap. Reserving holds the approved card FOR UPDATE, so two workers
   cannot both take the last credit. A reservation that is never settled keeps
   counting as spent: an unknown outcome is treated as money gone. */

import type { Db } from "./db.ts";
import { newId } from "./events.ts";

export type Unit = "credits" | "llm";

type StepCaps = Record<string, { credits?: number; llm?: number }>;
const SUM = `coalesce(sum(CASE kind WHEN 'reserve' THEN amount WHEN 'release' THEN -amount ELSE 0 END), 0)::int`;

/** Holds `amount` against the card that pays for `step`, or refuses with null.
    A single-card event has one card and no step caps. A two-card event has a Research card and an Outreach card, each
    paying only the steps in its `step_caps`: a step no approved card names is refused, so nothing is paid without the
    right card. Every reservation is also held to its step's own cap, in credits or in LLM calls. */
export async function reserve(db: Db, eventId: string, unit: Unit, amount: number, note: string, step: string = note): Promise<string | null> {
  return db.tx(async (q) => {
    const [card] = await q<{ id: string; credits_cap: number; llm_cap: number; step_caps: StepCaps | null }>(
      `SELECT id, credits_cap, llm_cap, step_caps FROM cost_cards
       WHERE event_id = $1 AND status = 'approved' AND (step_caps IS NULL OR jsonb_exists(step_caps, $2))
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [eventId, step],
    );
    if (!card) return null;
    const [{ n }] = await q<{ n: number }>(`SELECT ${SUM} AS n FROM credit_ledger WHERE card_id = $1 AND unit = $2`, [card.id, unit]);
    if (n + amount > (unit === "credits" ? card.credits_cap : card.llm_cap)) return null;
    if (card.step_caps) {
      const cap = card.step_caps[step]?.[unit];
      if (cap === undefined) return null;
      const [{ n: used }] = await q<{ n: number }>(`SELECT ${SUM} AS n FROM credit_ledger WHERE card_id = $1 AND unit = $2 AND step = $3`, [card.id, unit, step]);
      if (used + amount > cap) return null;
    }
    const id = newId("res");
    await q("INSERT INTO credit_ledger (id, event_id, card_id, unit, kind, amount, reservation_id, note, step) VALUES ($1, $2, $3, $4, 'reserve', $5, $1, $6, $7)", [id, eventId, card.id, unit, amount, note, step]);
    return id;
  });
}

/** Records the real charge and releases whatever was held beyond it. */
export async function settle(db: Db, reservationId: string, charged: number) {
  await db.tx(async (q) => {
    const [r] = await q<{ event_id: string; card_id: string; unit: string; amount: number; step: string | null }>("SELECT event_id, card_id, unit, amount, step FROM credit_ledger WHERE id = $1", [reservationId]);
    const add = (kind: string, amount: number) => q("INSERT INTO credit_ledger (id, event_id, card_id, unit, kind, amount, reservation_id, step) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [newId("led"), r.event_id, r.card_id, r.unit, kind, amount, reservationId, r.step]);
    await add("settle", charged);
    if (charged < r.amount) await add("release", r.amount - charged);
    // A vendor billed more than it quoted: count the excess so later reservations see it.
    if (charged > r.amount) await add("reserve", charged - r.amount);
  });
}

/** Settles a reservation that may already have been settled: an asynchronous call's result can be read twice after a crash. */
export async function settleOnce(db: Db, reservationId: string, charged: number) {
  const [done] = await db.query("SELECT 1 FROM credit_ledger WHERE reservation_id = $1 AND kind = 'settle' LIMIT 1", [reservationId]);
  if (!done) await settle(db, reservationId, charged);
}

export async function spend(db: Db, eventId: string) {
  const rows = await db.query<{ unit: Unit; n: number }>(
    `SELECT unit, sum(CASE kind WHEN 'reserve' THEN amount WHEN 'release' THEN -amount ELSE 0 END)::int AS n FROM credit_ledger WHERE event_id = $1 GROUP BY unit`, [eventId],
  );
  return { credits: rows.find((r) => r.unit === "credits")?.n ?? 0, llm: rows.find((r) => r.unit === "llm")?.n ?? 0 };
}

/** What each step has used, per card, against its cap. For the card screens and for tests. */
export async function spendByStep(db: Db, eventId: string) {
  return db.query<{ card_id: string; kind: string; step: string; unit: Unit; n: number }>(
    `SELECT l.card_id, k.kind, l.step, l.unit, ${SUM.replace("kind WHEN", "l.kind WHEN")} AS n
     FROM credit_ledger l JOIN cost_cards k ON k.id = l.card_id WHERE l.event_id = $1 GROUP BY l.card_id, k.kind, l.step, l.unit ORDER BY k.kind, l.step, l.unit`, [eventId]);
}
