/* The company-tier evals: a labeled development set and a frozen holdout, the prompts built from them, and the scoring.

   Why two sets. Tuning a prompt on the set it is scored on inflates the result (in one study a judge prompt fell from kappa 0.555 on the tuning set
   to 0.350 on held-out data). So prompts are tuned on the development set and the holdout is looked at to decide, not to tune. The holdout file is
   pinned by a hash in the tests: changing it on purpose means changing the hash on purpose.

   What the labels are. Each item carries the facts a vendor could supply (firmo) and a tier. The tier is the right answer GIVEN THOSE FACTS and the demo
   ICP (samples/orrery-icp.md), assigned by hand. The real public companies are labeled from the author's own knowledge of them: employee counts and
   industries are remembered and approximate, never checked against a filing, and may be out of date. A label stays right as long as it follows the facts shown.
   An item marked `incomplete` lacks a fact the rule needs: the right answer for a reader is Unknown, and its label is the tier the full facts would give.

   Scoring is strict by design: Unknown counts as wrong, and Unknown is capped so that abstaining cannot pass. The model reads only the items the ICP's
   hard rules do not already decide in code. */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fill } from "../server/prompts.ts";
import { documentOf, draftJson } from "../server/sim-icp.ts";
import { baselineTier, evalHardRules, renderIcp, sanitizeIcp, tierByRules, type Icp, type Tier } from "../shared/icp.ts";
import { buildFacts, firmoForRules, needsSecondLook, type FirmoRecord } from "../shared/tiering.ts";
import { validCompanyTier } from "../shared/tiers.ts";

export interface TierItem {
  id: string; name: string; set: "dev" | "holdout";
  source: "fictional" | "real_public_author_knowledge";
  firmo: FirmoRecord; tier: Tier; why: string; incomplete?: boolean;
}

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));
export const DEV_PATH = "evals/company-tier.dev.json", HOLDOUT_PATH = "evals/company-tier.holdout.json";
export const loadDev = (): TierItem[] => read(DEV_PATH).items;
export const loadHoldout = (): TierItem[] => read(HOLDOUT_PATH).items;
export const fileHash = (p: string) => createHash("sha256").update(readFileSync(new URL(`../../${p}`, import.meta.url))).digest("hex");

/** The demo seller's ICP, compiled from its document by the deterministic reader, exactly as the demo seed does. No model call. */
export function demoIcp(): Icp {
  const doc = readFileSync(new URL("../../samples/orrery-icp.md", import.meta.url), "utf8");
  const icp = sanitizeIcp(JSON.parse(draftJson(doc)));
  icp.acknowledged = [...new Set([...icp.acknowledged, "region"])];
  return icp;
}

export const factsOf = (item: TierItem) => buildFacts({ name: item.name, domain: null, firmo: item.firmo });

/** Items the hard rules decide in code (tier 3, no model call). */
export const decidedByRule = (icp: Icp, item: TierItem) => evalHardRules(icp, firmoForRules(item.firmo)).failed.length > 0;

export function promptFor(icp: Icp, item: TierItem, step: "company_tier" | "second_look") {
  return fill(step, { icp: renderIcp(icp), segments: icp.segments.map((s) => s.id).join(", ") || "none", company_types: icp.company_types.map((t) => t.id).join(", ") || "none", input: factsOf(item).text });
}

export const parse = (t: string | undefined): unknown => { if (t === undefined) return undefined; try { return JSON.parse(t.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; } };

/** What the system gives for one item: the hard rule in code, else the model's answer read through the same validator production uses. */
export function outcome(icp: Icp, item: TierItem, outputs: Record<string, string>): { got: Tier | null; via: "hard_rule" | "model" | "missing"; invalid: boolean } {
  if (decidedByRule(icp, item)) return { got: 3, via: "hard_rule", invalid: false };
  if (outputs[item.id] === undefined) return { got: null, via: "missing", invalid: false };
  const a = validCompanyTier(parse(outputs[item.id]), { citable: factsOf(item).citable, requireFact: true, segments: icp.segments.map((s) => s.id), types: icp.company_types.map((t) => t.id) });
  return { got: a?.tier ?? null, via: "model", invalid: a === null };
}

/* ----------------------------------------------------------------- stats */

/** The Wilson score interval for k successes in n trials. Better behaved than the normal interval at small n and near 0 or 1. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n, d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface Stat { n: number; k: number; rate: number; low: number; high: number }
export const stat = (k: number, n: number): Stat => ({ n, k, rate: n ? k / n : 0, ...wilson(k, n) });
export const fmt = (s: Stat) => `${s.k}/${s.n} = ${(100 * s.rate).toFixed(1)}% (95% Wilson ${(100 * s.low).toFixed(1)} to ${(100 * s.high).toFixed(1)})`;

export interface Scored {
  n: number;
  accuracy: Stat; unknown: Stat; invalid: number;
  tier3_as_tier1: number;
  /** Of the model-judged items only. */
  model_items: number; hard_rule_items: number; missing: number;
}
export const GATES = { company_accuracy: 0.85, unknown_cap: 0.25, tier3_as_tier1: 0 };

/** The system: hard rules in code, then the model. Unknown is wrong. `missing` outputs (not recorded) make the score unusable, which the caller checks. */
export function scoreSystem(icp: Icp, items: TierItem[], outputs: Record<string, string>): Scored {
  let k = 0, unk = 0, inv = 0, t31 = 0, model = 0, rule = 0, missing = 0;
  for (const it of items) {
    const o = outcome(icp, it, outputs);
    if (o.via === "missing") { missing++; continue; }
    if (o.via === "hard_rule") rule++; else model++;
    if (o.got === it.tier) k++;
    if (o.got === null) unk++;
    if (o.invalid) inv++;
    if (it.tier === 3 && o.got === 1) t31++;
  }
  const n = items.length - missing;
  return { n, accuracy: stat(k, n), unknown: stat(unk, n), invalid: inv, tier3_as_tier1: t31, model_items: model, hard_rule_items: rule, missing };
}

/** The trivial benchmark: size band plus keywords. It sees the same facts. */
export function scoreBaseline(icp: Icp, items: TierItem[]) {
  let k = 0, t31 = 0;
  for (const it of items) { const b = baselineTier(icp, firmoForRules(it.firmo)); if (b === it.tier) k++; if (it.tier === 3 && b === 1) t31++; }
  return { accuracy: stat(k, items.length), tier3_as_tier1: t31 };
}

/** The ICP's own tier definitions applied in code (step 4's `tierByRules`). A second comparator: where it decides, it needs no model. Unknown counts as wrong. */
export function scoreRules(icp: Icp, items: TierItem[]) {
  let k = 0, unk = 0;
  for (const it of items) { const r = tierByRules(icp, firmoForRules(it.firmo)).tier; if (r === it.tier) k++; if (r === null) unk++; }
  return { accuracy: stat(k, items.length), unknown: stat(unk, items.length) };
}

/** Which items would get a second look in production: the model's tier 1s, and its tiers more than one level from the baseline. */
export function secondLookItems(icp: Icp, items: TierItem[], first: Record<string, string>): TierItem[] {
  return items.filter((it) => {
    const o = outcome(icp, it, first);
    return o.via === "model" && o.got !== null && needsSecondLook(o.got, baselineTier(icp, firmoForRules(it.firmo)));
  });
}

/** Does the second look help? Among the items it looked at, a disagreement is a case a person settles. It helps if the tier 1s left unflagged are more often right than the tier 1s before. */
export function scoreSecondLook(icp: Icp, items: TierItem[], first: Record<string, string>, second: Record<string, string>) {
  const looked = secondLookItems(icp, items, first).filter((it) => second[it.id] !== undefined);
  let flagged = 0, caught = 0, falseAlarm = 0, missed = 0;
  for (const it of looked) {
    const f = outcome(icp, it, first).got, s = outcome(icp, it, second).got;
    const wrong = f !== it.tier, disagree = s !== f;
    if (disagree) { flagged++; if (wrong) caught++; else falseAlarm++; } else if (wrong) missed++;
  }
  const tier1 = looked.filter((it) => outcome(icp, it, first).got === 1);
  const t1Right = tier1.filter((it) => it.tier === 1).length;
  const kept = tier1.filter((it) => outcome(icp, it, second).got === 1);
  const keptRight = kept.filter((it) => it.tier === 1).length;
  return { looked: looked.length, flagged, caught, false_alarm: falseAlarm, missed_wrong: missed, tier1_precision_before: stat(t1Right, tier1.length), tier1_precision_after: stat(keptRight, kept.length), helps: kept.length > 0 && keptRight / kept.length > t1Right / Math.max(1, tier1.length) };
}

/** The hash a recording stores over the prompts it was made from. A change to the ICP text, the facts, the sets or the template changes it, so a stale recording cannot pass quietly. */
export function inputsHash(prompts: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(Object.keys(prompts).sort().map((k) => [k, prompts[k]]))).digest("hex").slice(0, 16);
}
