/* Scores model outputs against the labeled list. Pure, so it is tested on its own. */

import { validFlags, validTier } from "../shared/tiers.ts";

export const parse = (t: string): unknown => { try { return JSON.parse(t.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; } };
export const GATES = { company_accuracy: 0.85, title_accuracy: 0.9, review_recall: 0.8, review_precision: 0.6 };

const tierOf = (t: string | undefined) => (t === undefined ? null : validTier(parse(t))?.tier ?? null);

export function scoreCompanies(items: { id: string; tier: number }[], outputs: Record<string, string>) {
  const right = items.filter((c) => tierOf(outputs[c.id]) === c.tier).length;
  return { accuracy: right / items.length, tier3_as_tier1: items.filter((c) => c.tier === 3 && tierOf(outputs[c.id]) === 1).length };
}

export function scoreTitles(items: { id: string; tier: number }[], outputs: Record<string, string>) {
  return { accuracy: items.filter((t) => tierOf(outputs[t.id]) === t.tier).length / items.length };
}

export function scoreReview(items: { id: string; flags: string[] }[], outputs: Record<string, string>) {
  let tp = 0, fp = 0, fn = 0;
  for (const c of items) {
    const got = new Set(validFlags(parse(outputs[c.id] ?? ""))?.flags ?? []);
    for (const f of c.flags) { if (got.has(f)) tp++; else fn++; }
    for (const f of got) if (!c.flags.includes(f)) fp++;
  }
  // A model that flags everything gets perfect recall and fails on precision.
  return { recall: tp + fn ? tp / (tp + fn) : 1, precision: tp + fp ? tp / (tp + fp) : 0 };
}

export function scoreConcierge(items: { id: string; money: boolean; tool: string | null }[], outputs: Record<string, string>) {
  const out = (id: string) => parse(outputs[id] ?? "") as { tool?: string; answer?: string } | null;
  const money = items.filter((q) => q.money), counts = items.filter((q) => !q.money);
  const refused = money.filter((q) => { const o = out(q.id); return typeof o?.answer === "string" && !o.tool && !/\d/.test(o.answer); }).length;
  return { money_refused: refused / money.length, right_tool: counts.filter((q) => out(q.id)?.tool === q.tool).length / counts.length };
}
