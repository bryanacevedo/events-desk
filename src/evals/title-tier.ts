/* The title-tier evals: a labeled development set and a frozen holdout (evals/title-tier.*.json, written by scripts/gen-title-evals.ts), the
   prompts, and the scoring with Wilson intervals. Every item is a job title with a hand label for its function, its seniority and its tier under
   the demo ICP. Spanish, other-language, messy and inflated titles are in both sets.

   The system is the rules in code first (`parseTitle` and the ICP's personas), then the model for what the rules cannot place. The rules were tuned on
   the development set only. A keyword baseline (the settings' title table, `titleRule`) is scored beside them; a title the table does not decide counts
   as wrong for it. The earlier title prompt's 100% was tuned on its own list and is not evidence of anything. Unknown counts as wrong. */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fill } from "../server/prompts.ts";
import { titleRule, type Settings, type Tier } from "../shared/cost.ts";
import type { Icp } from "../shared/icp.ts";
import { parseTitle, personaTier, validTitleParse, type ParsedTitle } from "../shared/titles.ts";
import { fmt, stat, type Stat } from "./company-tier.ts";

export interface TitleItem { id: string; title: string; set: "dev" | "holdout"; language: "en" | "es" | "pt" | "fr" | "de"; kind: "clean" | "messy" | "inflated" | "ambiguous"; function: string; seniority: string; non_buyer: boolean; tier: Tier }

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));
export const TITLE_DEV_PATH = "evals/title-tier.dev.json", TITLE_HOLDOUT_PATH = "evals/title-tier.holdout.json";
export const loadTitleDev = (): TitleItem[] => read(TITLE_DEV_PATH).items;
export const loadTitleHoldout = (): TitleItem[] => read(TITLE_HOLDOUT_PATH).items;
export const titlePrompt = (item: TitleItem) => fill("title_parse", { title: item.title });
export const keywordTable = (): Settings["title_keywords"] => read("config/defaults.json").title_keywords;

/** Items the rules place (or know are not buyers): the model is not asked. */
export const placedByRules = (item: TitleItem) => { const p = parseTitle(item.title); return p.placed || p.non_buyer; };

export interface TitleOutcome { parsed: ParsedTitle | null; tier: Tier | null; via: "rules" | "model" | "missing" }
/** What the system gives for one title. `outputs` are recorded title_parse answers, read through the same validator production uses. */
export function titleOutcome(icp: Icp, item: TitleItem, outputs: Record<string, string> | null, modelOnly = false): TitleOutcome {
  const p = parseTitle(item.title);
  if (!modelOnly && (p.placed || p.non_buyer)) return { parsed: p, tier: personaTier(p, icp.personas), via: "rules" };
  const raw = outputs?.[item.id];
  if (raw === undefined) return { parsed: null, tier: null, via: "missing" };
  let json: unknown = null;
  try { json = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { /* unreadable */ }
  const v = validTitleParse(json);
  if (!v) return { parsed: null, tier: null, via: "model" };
  const parsed: ParsedTitle = { function: v.function, seniority: v.seniority, non_buyer: v.non_buyer, former: false, placed: true };
  return { parsed, tier: personaTier(parsed, icp.personas), via: "model" };
}

export interface TitleScore {
  n: number; tier: Stat; fn: Stat; seniority: Stat; unknown: Stat;
  /** A true tier 3 (or 2) given tier 1: the error that buys a wrong person. */
  promoted_to_1: number; tier3_as_tier1: number;
  rules_items: number; model_items: number; missing: number;
}
/** Scores the system on a set. `outputs` null scores the rules alone, counting every title they cannot place as Unknown (wrong). */
export function scoreTitles(icp: Icp, items: TitleItem[], outputs: Record<string, string> | null, modelOnly = false): TitleScore {
  let k = 0, f = 0, s = 0, unk = 0, promoted = 0, t31 = 0, rules = 0, model = 0, missing = 0, n = 0;
  for (const it of items) {
    const o = titleOutcome(icp, it, outputs, modelOnly);
    if (o.via === "missing" && outputs !== null) { missing++; continue; }
    n++;
    if (o.via === "rules") rules++; else if (o.via === "model") model++;
    if (o.tier === it.tier) k++;
    if (o.tier === null) unk++;
    if (o.parsed?.function === it.function || (it.non_buyer && o.parsed?.non_buyer)) f++;
    if (o.parsed?.seniority === it.seniority) s++;
    if (o.tier === 1 && it.tier !== 1) promoted++;
    if (o.tier === 1 && it.tier === 3) t31++;
  }
  return { n, tier: stat(k, n), fn: stat(f, n), seniority: stat(s, n), unknown: stat(unk, n), promoted_to_1: promoted, tier3_as_tier1: t31, rules_items: rules, model_items: model, missing };
}

/** The keyword table alone. A title it does not decide is wrong. */
export function scoreKeywordBaseline(items: TitleItem[], table: Settings["title_keywords"] = keywordTable()) {
  let k = 0, unk = 0, promoted = 0;
  for (const it of items) {
    const t = titleRule(it.title, table);
    if (t === it.tier) k++;
    if (t === null) unk++;
    if (t === 1 && it.tier !== 1) promoted++;
  }
  return { tier: stat(k, items.length), unknown: stat(unk, items.length), promoted_to_1: promoted };
}

export const TITLE_GATES = { tier_accuracy: 0.9, unknown_cap: 0.15, tier3_as_tier1: 0 };
export const titleFileHash = (p: string) => createHash("sha256").update(readFileSync(new URL(`../../${p}`, import.meta.url))).digest("hex");

export function titleReport(icp: Icp, recorded: { out: Record<string, string> | null; why: string }): string {
  const dev = loadTitleDev(), hold = loadTitleHoldout();
  const L: string[] = [];
  L.push("TITLE TIER EVALS (demo ICP personas). Unknown counts as wrong. Intervals are 95% Wilson. The earlier title prompt's 100% was tuned on its own list and is not cited.");
  L.push(`Sets: development ${dev.length}; frozen holdout ${hold.length} (${hold.filter((i) => i.language !== "en").length} not in English, ${hold.filter((i) => i.kind !== "clean").length} messy, inflated or ambiguous). The parser was tuned on development only.`);
  for (const [name, items] of [["DEVELOPMENT", dev], ["HOLDOUT", hold], ["HOLDOUT, Spanish", hold.filter((i) => i.language === "es")], ["HOLDOUT, not English or Spanish", hold.filter((i) => i.language !== "en" && i.language !== "es")], ["HOLDOUT, messy", hold.filter((i) => i.kind === "messy")]] as const) {
    const b = scoreKeywordBaseline(items), r = scoreTitles(icp, items, null);
    L.push("", `${name} (${items.length} titles)`);
    L.push(`  keyword baseline (settings table):  tier ${fmt(b.tier)}; undecided ${fmt(b.unknown)}; promoted to tier 1 wrongly: ${b.promoted_to_1}`);
    L.push(`  rules in code alone:                tier ${fmt(r.tier)}; function ${fmt(r.fn)}; placed by rules ${r.rules_items}, left for the model ${r.n - r.rules_items}; promoted to tier 1 wrongly: ${r.promoted_to_1}`);
    if (recorded.out) {
      const s = scoreTitles(icp, items, recorded.out);
      const m = scoreTitles(icp, items, recorded.out, true);
      L.push(`  the model alone, every title:       tier ${fmt(m.tier)}; function ${fmt(m.fn)}`);
      L.push(`  rules, then the model:              tier ${fmt(s.tier)}; function ${fmt(s.fn)}; Unknown ${fmt(s.unknown)}; promoted wrongly ${s.promoted_to_1}${s.missing ? `; NOT RECORDED ${s.missing}` : ""}`);
    } else L.push(`  rules, then the model:              NOT MEASURED. The title_parse recording is ${recorded.why}.`);
  }
  L.push("", `GATES (holdout, rules then model): tier accuracy at least ${TITLE_GATES.tier_accuracy * 100}%, Unknown at most ${TITLE_GATES.unknown_cap * 100}%, no tier 3 given tier 1, and it must beat the keyword baseline.`);
  return L.join("\n");
}

import { isFresh, recordingOf, staleManifest } from "./recordings.ts";
import { inputsHash } from "./company-tier.ts";

/** The title_parse recording, if it is fresh: template, model and every filled prompt must still match. */
export function titleRecording(items: TitleItem[] = [...loadTitleDev(), ...loadTitleHoldout()]): { out: Record<string, string> | null; why: string } {
  const r = recordingOf("title_parse");
  if (!r) return { out: null, why: "not recorded yet" };
  const byId = new Map(items.map((i) => [i.id, i]));
  const prompts = Object.fromEntries(Object.keys(r.outputs).map((id) => [id, byId.has(id) ? titlePrompt(byId.get(id)!) : ""]));
  const ok = r.inputs_hash !== undefined && inputsHash(prompts) === r.inputs_hash;
  if (!isFresh("title_parse", r, ok) || r.inputs_hash === undefined) return { out: null, why: `STALE${staleManifest().title_parse ? ` since ${staleManifest().title_parse.since}` : ""}: made for an older prompt, model or set` };
  return { out: r.outputs, why: `fresh (${r.model})` };
}
