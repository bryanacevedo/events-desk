/* Company money (event cost, pipeline, deals, the return, AI spend) is leadership's and GTM Engineering's, on every screen and every read.
   Acting as is not a login, so this keeps the desk consistent, not secure; a real login would put the same check behind it. */

import { isGtm } from "../shared/roles.ts";
import { defaultSettings } from "./approvals.ts";
import type { Scorecard } from "./closeout.ts";

export const MONEY_REFUSAL = "Company money is for leadership and GTM Engineering.";
export const isLead = (actor: string, approvers: string[] = (defaultSettings().approvers ?? []) as string[]) => Boolean(actor) && (isGtm(actor) || approvers.includes(actor));

/** The same reading with every dollar taken out: meetings, reach, replies and the comparison stay. */
export function withoutMoney<T extends Scorecard | null | undefined>(m: T): T {
  if (!m) return m;
  const none = { n: 0, cents: 0 };
  return {
    ...m,
    cost: { tickets_cents: 0, travel_cents: 0, ai_cents: 0, other_cents: 0, dollars_cents: 0, credits_by_step: {} },
    cost_per_held_cents: null,
    influence: { available: m.influence.available, opportunities: 0, pipeline_cents: 0, sourced: none, influenced: none, won: none, stale: 0, deals: [] },
    roi: { pipeline_per_dollar: null, won_per_dollar: null, cost_missing: [] },
    score: null,
    past: { held_per_thousand: null, pipeline_per_dollar: null },
  } as T;
}
