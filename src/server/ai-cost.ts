/* What AI really cost, in cents. A call that has token counts is priced from them with src/shared/model-pricing.ts. A call with none (a simulated run, or a
   ledger count with no llm_calls row such as a call that failed after billing) is priced at the flat `llm_call_cents` and counted as flat, so the screen can say
   which part is measured and which is not. Dollars only: credits are never added here. Calls of deleted events are read from llm_calls_kept. */

import type { Db } from "./db.ts";
import { modelCostUsd } from "../shared/model-pricing.ts";

export interface RealRow { event_id: string; step: string; model: string; n: number; inp: number; out: number }
export interface LedgerLlm { event_id: string; step: string | null; note: string; n: number }
export interface AiPart { step: string; calls: number; real_calls: number; flat_calls: number; cents: number }

/** Calls that carry tokens, in a period (or for one event), grouped by event, step and model. Deleted events' calls come from llm_calls_kept. */
export function realCalls(db: Db, from: string, to: string, eventId?: string): Promise<RealRow[]> {
  const where = eventId ? "AND event_id = $3" : "";
  return db.query<RealRow>(
    `SELECT event_id, step, model, count(*)::int AS n, sum(input_tokens)::float8 AS inp, sum(output_tokens)::float8 AS out FROM
       (SELECT event_id, step, model, input_tokens, output_tokens, created_at FROM llm_calls
        UNION ALL SELECT event_id, step, model, input_tokens, output_tokens, created_at FROM llm_calls_kept) c
     WHERE created_at >= $1 AND created_at < $2 AND (input_tokens > 0 OR output_tokens > 0) ${where} GROUP BY 1, 2, 3`, eventId ? [from, to, eventId] : [from, to]);
}

/** Per event and step: the ledger's call count against the calls that carry tokens. Real cents for the priced ones, the flat rate for the rest. */
export function priceAi(ledger: LedgerLlm[], real: RealRow[], flatCents: number): Map<string, AiPart & { event_id: string }> {
  const out = new Map<string, AiPart & { event_id: string }>();
  const key = (e: string, s: string) => `${e}\u0000${s}`;
  for (const r of ledger) {
    if (!r.n) continue;
    const step = r.step ?? r.note, k = key(r.event_id, step);
    const cur = out.get(k) ?? { event_id: r.event_id, step, calls: 0, real_calls: 0, flat_calls: 0, cents: 0 };
    cur.calls += r.n; out.set(k, cur);
  }
  for (const r of real) {
    const usd = modelCostUsd(r.model, r.inp, r.out);
    if (usd === null) continue; // an unlisted model is never guessed: its calls stay at the flat rate
    const k = key(r.event_id, r.step), cur = out.get(k) ?? { event_id: r.event_id, step: r.step, calls: 0, real_calls: 0, flat_calls: 0, cents: 0 };
    cur.real_calls += r.n; cur.cents += usd * 100; out.set(k, cur);
  }
  for (const p of out.values()) {
    // A priced call the ledger does not count (a period edge) still has a real cost; the ledger count never goes below it.
    p.calls = Math.max(p.calls, p.real_calls);
    p.flat_calls = p.calls - p.real_calls;
    p.cents += p.flat_calls * flatCents;
  }
  return out;
}

/** Adds `cents` to each llm row of an event's per-card, per-step spend: the step's priced total shared across cards by the calls each used. */
export async function withAiCents<T extends { step: string; unit: string; n: number }>(db: Db, eventId: string, rows: T[], flatCents: number): Promise<(T & { cents?: number })[]> {
  const real = await realCalls(db, "1970-01-01", "9999-01-01", eventId);
  const llm = rows.filter((r) => r.unit === "llm");
  const total = new Map<string, number>();
  for (const r of llm) total.set(r.step, (total.get(r.step) ?? 0) + r.n);
  const priced = priceAi([...total].map(([step, n]) => ({ event_id: eventId, step, note: step, n })), real, flatCents);
  return rows.map((r) => {
    if (r.unit !== "llm") return r;
    const p = priced.get(`${eventId}\u0000${r.step}`), t = total.get(r.step) ?? 0;
    return { ...r, cents: p && t ? (p.cents * r.n) / t : 0 };
  });
}
