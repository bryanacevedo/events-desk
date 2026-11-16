/* Choosing events (docs/CHOOSING.md, section 6). Next year's candidates with the evidence for each and a fixed, printed order. Code builds every figure and every
   sentence; there is no blended score and no model. The order only orders a list: a person decides which to plan. */

import type { Scorecard } from "./closeout.ts";
import { computeScorecard, MIN_HELD_TO_SCORE } from "./closeout.ts";
import { dollars, plannedTotal } from "./budget-lines.ts";
import type { Db } from "./db.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { likelyThere, seriesKeyWith, seriesLinks, type EvidenceKind } from "./overlap.ts";
import { choosingToday as todayOf } from "./plan.ts";
import { addDays } from "../shared/motion.ts";

export const CANDIDATE_LEAD_DAYS = 30;
export const CANDIDATE_DAYS = 400;
export type CostKind = "plan" | "one_pass" | "one_pass_estimate" | "unknown";
const KIND_ORDER: Record<CostKind, number> = { plan: 0, one_pass: 1, one_pass_estimate: 2, unknown: 3 };
export const COST_KIND_WORDS: Record<CostKind, string> = { plan: "the plan", one_pass: "one pass at the listed price", one_pass_estimate: "one pass at an estimated price", unknown: "not known" };

/** The order, as printed on the screen. */
export const HOW_ORDERED = [
  "Three groups, in this order: not declined and not below the median; last edition below the median; declined, kept in the list with its reason.",
  "Inside a group: the kind of cost (the plan, one pass at the listed price, one pass at an estimated price, not known). A plan's whole budget and one pass are not the same cost and are never divided into each other.",
  "Inside a kind: target accounts per $1,000 of cost, highest first. Then target accounts, then start date, then the event's id.",
];

export interface WrittenCard { event_id: string; name: string; starts_on: string; ends_on: string | null; parent_event_id: string | null; series_key: string; window_days: number; metrics: Scorecard }

/** Every past event's latest written scorecard (one row per event, the longest window). Series keys follow the planner's links. */
export async function writtenCards(db: Db): Promise<WrittenCard[]> {
  const links = await seriesLinks(db);
  const rows = await db.query<Omit<WrittenCard, "series_key">>(
    `SELECT DISTINCT ON (s.event_id) s.event_id, e.name, e.starts_on::text AS starts_on, e.ends_on::text AS ends_on, e.parent_event_id, s.window_days, s.metrics
     FROM scorecards s JOIN events e ON e.id = s.event_id ORDER BY s.event_id, s.window_days DESC`);
  return rows.map((r) => ({ ...r, series_key: seriesKeyWith(links, r.name) }));
}

export const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** The median held per $1,000 of every scored past event, each counted once by its latest written scorecard, and how many went into it. */
export function medianOf(cards: WrittenCard[]): { value: number | null; n: number } {
  const xs = cards.filter((c) => c.parent_event_id === null).map((c) => c.metrics.score?.held_per_thousand).filter((x): x is number => typeof x === "number");
  return { value: xs.length >= 2 ? median(xs) : null, n: xs.length };
}

export interface PastReturn {
  event_id: string; name: string; year: number; written: boolean; held: number; cost_cents: number;
  held_per_thousand: number | null; pipeline_per_dollar: number | null; scored: boolean;
}
export type VsMedian = "above" | "below" | "same";

const pastOf = (c: { event_id: string; name: string; starts_on: string }, m: Scorecard, written: boolean): PastReturn => ({
  event_id: c.event_id, name: c.name, year: Number(c.starts_on.slice(0, 4)), written, held: m.held_all, cost_cents: m.cost.dollars_cents,
  held_per_thousand: m.score?.held_per_thousand ?? null,
  pipeline_per_dollar: m.influence.available ? (m.score?.pipeline_per_dollar ?? m.roi.pipeline_per_dollar ?? null) : null, scored: Boolean(m.score),
});

export function vsMedian(past: PastReturn | null, med: { value: number | null; n: number }): VsMedian | null {
  if (!past || past.held_per_thousand === null || med.value === null || med.n < 2) return null;
  const d = past.held_per_thousand - med.value;
  return Math.abs(d) < 1e-9 ? "same" : d > 0 ? "above" : "below";
}

/* ------------------------------------------------------------------ the order (pure) */

export interface OrderKey { group: 0 | 1 | 2; cost: { kind: CostKind; cents: number | null }; likely: { accounts: number }; starts_on: string; catalog_id: string }

/** Pure, and a total order: the same list in any input order gives the same result, and adding or removing another row never moves two others relative to each other.
    Target accounts per dollar are compared by cross multiplication of integers (a1 * c2 against a2 * c1), never by dividing. */
export function compareCandidates(a: OrderKey, b: OrderKey): number {
  if (a.group !== b.group) return a.group - b.group;
  if (a.cost.kind !== b.cost.kind) return KIND_ORDER[a.cost.kind] - KIND_ORDER[b.cost.kind];
  const ca = a.cost.cents ?? 0, cb = b.cost.cents ?? 0;
  if (a.cost.kind !== "unknown" && ca > 0 && cb > 0) {
    const l = BigInt(a.likely.accounts) * BigInt(cb), r = BigInt(b.likely.accounts) * BigInt(ca);
    if (l !== r) return l > r ? -1 : 1;
  }
  if (a.likely.accounts !== b.likely.accounts) return b.likely.accounts - a.likely.accounts;
  if (a.starts_on !== b.starts_on) return a.starts_on < b.starts_on ? -1 : 1;
  return a.catalog_id < b.catalog_id ? -1 : a.catalog_id > b.catalog_id ? 1 : 0;
}
export const orderCandidates = <T extends OrderKey>(list: T[]): T[] => [...list].sort(compareCandidates);

export const groupOf = (declined: boolean, vs: VsMedian | null): 0 | 1 | 2 => (declined ? 2 : vs === "below" ? 1 : 0);

/* ------------------------------------------------------------------ the candidates */

export interface Candidate {
  catalog_id: string; name: string; starts_on: string; ends_on: string; city: string; country: string; website: string | null; size: string | null; source: string; suggested_by: string | null; series_key: string;
  event: { id: string; stage: string; plan_stage: string; decline_reason: string | null } | null;
  likely: { accounts: number; by_kind: Record<EvidenceKind, number>; past_lists: number; list: Array<{ account_id: string; name: string; owner: string | null; deal_stage: string | null; kinds: EvidenceKind[] }> };
  cost: { kind: CostKind; cents: number | null; words: string; per_thousand: number | null };
  past: PastReturn | null;
  vs_median: VsMedian | null;
  ours_last: { decision: string; reason: string | null; decided_by: string; decided_at: string } | null;
  group: 0 | 1 | 2;
  reasons: string[];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const decisionWords = (d: { decision: string; decided_by: string }) => `${d.decision === "repeat" ? "Repeat" : "Drop"}, said by ${d.decided_by}`;

export function reasonsFor(c: Pick<Candidate, "likely" | "cost" | "past" | "vs_median" | "ours_last" | "event">, med: { value: number | null; n: number }): string[] {
  const out: string[] = [];
  const k = c.likely.by_kind, parts: string[] = [];
  if (k.past) parts.push(`${k.past} from ${c.likely.past_lists ? "earlier lists" : "an earlier list"}`);
  if (k.page) parts.push(`${k.page} named on a page`);
  if (k.captured) parts.push(`${k.captured} with people already captured`);
  out.push(c.likely.accounts ? `${plural(c.likely.accounts, "target account")} likely there: ${parts.join(", ")}` : `No target account is known to be there yet${c.likely.past_lists ? "" : " (no list from an earlier edition)"}`);
  out.push(`Cost: ${c.cost.kind === "unknown" ? "not known" : `${c.cost.kind === "plan" ? "the plan" : c.cost.kind === "one_pass" ? "one pass" : "one pass, estimated"}, ${dollars(c.cost.cents!)}`}`);
  if (c.past) {
    const p = c.past;
    const score = p.held_per_thousand === null ? `not scored (fewer than ${MIN_HELD_TO_SCORE} held meetings, or no cost)` : `${p.held_per_thousand} per $1,000${c.vs_median && med.value !== null ? `, ${c.vs_median === "same" ? "the same as" : c.vs_median} the median of ${Math.round(med.value * 100) / 100}` : ""}`;
    out.push(`Last time (${p.name}): ${plural(p.held, "held meeting")}, ${score}${p.written ? "" : ", read so far, not yet written"}`);
  } else out.push("Last time: no earlier edition with a result");
  if (c.ours_last) out.push(`We said: ${decisionWords(c.ours_last)}`);
  if (c.event?.decline_reason) out.push(`Declined: ${c.event.decline_reason}`);
  return out;
}

/** Next year's candidates, ordered. `deps` is only used to read an edition that has no written scorecard yet; without it that reading is skipped. */
export async function candidates(db: Db, deps?: LifecycleDeps) {
  const today = todayOf(deps);
  const from = addDays(today, CANDIDATE_LEAD_DAYS), to = addDays(today, CANDIDATE_DAYS);
  const links = await seriesLinks(db);
  const cat = await db.query<{ id: string; name: string; starts_on: string; ends_on: string; city: string; country: string; website: string | null; size: string | null; source: string; suggested_by: string | null; seat_price_cents: number; price_is_estimate: boolean }>(
    "SELECT id, name, starts_on::text AS starts_on, ends_on::text AS ends_on, city, country, website, size, source, suggested_by, seat_price_cents, price_is_estimate FROM catalog_events WHERE starts_on >= $1::date AND starts_on <= $2::date ORDER BY starts_on, id", [from, to]);
  const cards = await writtenCards(db);
  const med = medianOf(cards);
  const evs = await db.query<{ catalog_id: string; id: string; stage: string; plan_stage: string; decline_reason: string | null }>(
    `SELECT DISTINCT ON (catalog_id) catalog_id, id, stage, plan_stage, decline_reason FROM events WHERE catalog_id = ANY($1::text[]) AND parent_event_id IS NULL
     ORDER BY catalog_id, (decline_reason IS NOT NULL), created_at DESC, id DESC`, [cat.map((c) => c.id)]);
  const evOf = new Map(evs.map((e) => [e.catalog_id, e]));
  const decisions = await db.query<{ series_key: string; decision: string; reason: string | null; decided_by: string; decided_at: string }>(
    "SELECT DISTINCT ON (series_key) series_key, decision, reason, decided_by, decided_at::text AS decided_at FROM repeat_decisions ORDER BY series_key, decided_at DESC, id DESC");
  const lastOf = new Map(decisions.map((d) => [d.series_key, d]));
  // Earlier editions, by series: events (not top-ups) that started before today.
  const editions = await db.query<{ id: string; name: string; starts_on: string; motion: string }>("SELECT id, name, starts_on::text AS starts_on, motion FROM events WHERE parent_event_id IS NULL AND starts_on < $1::date ORDER BY starts_on DESC, id", [today]);
  const cardOf = new Map(cards.map((c) => [c.event_id, c]));

  const out: Candidate[] = [];
  for (const c of cat) {
    const key = seriesKeyWith(links, c.name);
    const ev = evOf.get(c.id) ?? null;
    const likely = await likelyThere(db, today, c.id);
    let cost: Candidate["cost"];
    const planned = ev ? Math.round(await plannedTotal(db.query, ev.id)) : 0;
    if (planned > 0) cost = { kind: "plan", cents: planned, words: COST_KIND_WORDS.plan, per_thousand: null };
    else if (c.seat_price_cents > 0) cost = { kind: c.price_is_estimate ? "one_pass_estimate" : "one_pass", cents: c.seat_price_cents, words: COST_KIND_WORDS[c.price_is_estimate ? "one_pass_estimate" : "one_pass"], per_thousand: null };
    else cost = { kind: "unknown", cents: null, words: COST_KIND_WORDS.unknown, per_thousand: null };
    if (cost.cents) cost.per_thousand = Math.round((likely.totals.accounts * 1_000_000) / cost.cents) / 10;

    // The most recent earlier edition with a written scorecard, else a reading made without writing for one in motion closing or scored.
    const mine = editions.filter((e) => e.starts_on < c.starts_on && seriesKeyWith(links, e.name) === key);
    let past: PastReturn | null = null;
    const withCard = mine.find((e) => cardOf.has(e.id));
    if (withCard) past = pastOf({ event_id: withCard.id, name: withCard.name, starts_on: withCard.starts_on }, cardOf.get(withCard.id)!.metrics, true);
    else if (deps) {
      for (const e of mine.filter((x) => ["closing", "scored"].includes(x.motion))) {
        const m = await computeScorecard(db, deps, e.id, 30, { write: false }).catch(() => null);
        if (m) { past = pastOf({ event_id: e.id, name: e.name, starts_on: e.starts_on }, m, false); break; }
      }
    }
    const vs = vsMedian(past, med);
    const ours = lastOf.get(key) ?? null;
    const row: Candidate = {
      catalog_id: c.id, name: c.name, starts_on: c.starts_on, ends_on: c.ends_on, city: c.city, country: c.country, website: c.website, size: c.size, source: c.source, suggested_by: c.suggested_by, series_key: key,
      event: ev ? { id: ev.id, stage: ev.stage, plan_stage: ev.plan_stage, decline_reason: ev.decline_reason } : null,
      likely: { accounts: likely.totals.accounts, by_kind: likely.totals.by_kind, past_lists: likely.past_lists, list: likely.accounts.map((a) => ({ account_id: a.account_id, name: a.name, owner: a.owner, deal_stage: a.deal_stage, kinds: a.kinds })) },
      cost, past, vs_median: vs, ours_last: ours ? { decision: ours.decision, reason: ours.reason, decided_by: ours.decided_by, decided_at: ours.decided_at } : null,
      group: groupOf(Boolean(ev && (ev.stage === "declined" || ev.decline_reason)), vs), reasons: [],
    };
    row.reasons = reasonsFor(row, med);
    out.push(row);
  }
  return { today, window: { from, to }, median: med, how_ordered: HOW_ORDERED, candidates: orderCandidates(out) };
}
