/* The company-tier eval report: the baseline and the ICP's own rules on both sets always (they need no model), and the model and the second look
   only when a fresh recording exists. Every rate carries a 95% Wilson interval. Nothing here calls a model. */

import { demoIcp, fmt, GATES, loadDev, loadHoldout, scoreBaseline, scoreRules, scoreSecondLook, scoreSystem, type TierItem } from "./company-tier.ts";
import { isFresh, recordingOf, staleManifest, type Recording } from "./recordings.ts";
import { inputsHash, promptFor, secondLookItems, decidedByRule } from "./company-tier.ts";
import type { Icp } from "../shared/icp.ts";

export interface TierRecordings { first: Record<string, string> | null; second: Record<string, string> | null; why: { first: string; second: string } }

/** Is this recording scoreable? Its template, model and filled prompts must all still match. One with no inputs_hash predates the check and cannot be tied to these sets or this ICP. */
export function judgeRecording(step: "company_tier" | "second_look", r: Recording | null, icp: Icp, items: TierItem[], sinceNote = ""): { out: Record<string, string> | null; why: string } {
  if (!r) return { out: null, why: "not recorded yet" };
  const byId = new Map(items.map((i) => [i.id, i]));
  const prompts = Object.fromEntries(Object.keys(r.outputs).map((id) => [id, byId.has(id) ? promptFor(icp, byId.get(id)!, step) : ""]));
  const inputsOk = r.inputs_hash !== undefined && inputsHash(prompts) === r.inputs_hash;
  if (!isFresh(step, r, inputsOk) || r.inputs_hash === undefined) return { out: null, why: `STALE${sinceNote}: made for an older prompt, model, ICP or set` };
  return { out: r.outputs, why: `fresh (${r.model}, recorded ${r.recorded_at ?? "unknown"})` };
}

/** Reads the recordings and says whether each can be scored. */
export function tierRecordings(icp: Icp = demoIcp(), items: TierItem[] = [...loadDev(), ...loadHoldout()]): TierRecordings {
  const manifest = staleManifest();
  const a = judgeRecording("company_tier", recordingOf("company_tier"), icp, items, manifest.company_tier ? ` since ${manifest.company_tier.since}` : "");
  const b = judgeRecording("second_look", recordingOf("second_look"), icp, items, manifest.second_look ? ` since ${manifest.second_look.since}` : "");
  return { first: a.out, second: b.out, why: { first: a.why, second: b.why } };
}

export function companyTierReport(icp: Icp = demoIcp(), rec: TierRecordings = tierRecordings(icp)): string {
  const dev = loadDev(), hold = loadHoldout();
  const real = hold.filter((i) => i.source !== "fictional"), fict = hold.filter((i) => i.source === "fictional");
  const L: string[] = [];
  L.push("COMPANY TIER EVALS (demo ICP: Orrery Revenue Software). Unknown counts as wrong. Intervals are 95% Wilson.");
  L.push(`Sets: development ${dev.length} (fictional); frozen holdout ${hold.length} (${fict.length} fictional hard cases, ${real.length} real public companies labeled by hand from the author's own knowledge, approximate and unverified).`);
  L.push("");
  const block = (name: string, items: TierItem[]) => {
    const b = scoreBaseline(icp, items), r = scoreRules(icp, items);
    L.push(`${name} (${items.length} items; ${items.filter((i) => decidedByRule(icp, i)).length} decided by a hard rule in code, ${items.filter((i) => i.incomplete).length} with a deciding fact missing)`);
    L.push(`  baseline, size band plus keywords:    ${fmt(b.accuracy)}; tier 3 called tier 1: ${b.tier3_as_tier1}`);
    L.push(`  ICP tier definitions applied in code: ${fmt(r.accuracy)}; Unknown ${fmt(r.unknown)}`);
    if (rec.first) {
      const s = scoreSystem(icp, items, rec.first);
      L.push(`  system (hard rules, then the model):  ${fmt(s.accuracy)}; Unknown ${fmt(s.unknown)}; tier 3 called tier 1: ${s.tier3_as_tier1}; unreadable answers ${s.invalid}${s.missing ? `; NOT RECORDED ${s.missing}` : ""}`);
      L.push(`  model beats the baseline: ${s.accuracy.rate > b.accuracy.rate ? "yes" : "NO"} (${(100 * s.accuracy.rate).toFixed(1)}% against ${(100 * b.accuracy.rate).toFixed(1)}%${s.accuracy.low > b.accuracy.high ? ", intervals do not overlap" : ", intervals overlap"})`);
    } else L.push(`  system (hard rules, then the model):  NOT MEASURED. The company_tier recording is ${rec.why.first}.`);
  };
  block("DEVELOPMENT", dev);
  block("HOLDOUT, all", hold);
  block("HOLDOUT, fictional hard cases", fict);
  block("HOLDOUT, real public companies", real);
  L.push("");
  if (rec.first && rec.second) {
    const s = scoreSecondLook(icp, hold, rec.first, rec.second);
    L.push(`SECOND LOOK on the holdout: looked at ${s.looked}; disagreed on ${s.flagged} (caught a wrong tier ${s.caught}, false alarm ${s.false_alarm}); wrong tiers it missed ${s.missed_wrong}.`);
    L.push(`  tier 1 precision before ${fmt(s.tier1_precision_before)}, after dropping the flagged ${fmt(s.tier1_precision_after)}. It stayed only if it helped: ${s.helps ? "it helped" : "IT DID NOT HELP"}. CUT from production on 2026-11-09 (docs/DECISIONS.md, 24); this line keeps the evidence.`);
  } else L.push(`SECOND LOOK: NOT MEASURED. The second_look recording is ${rec.why.second}. It is cut from production (docs/DECISIONS.md, 24).`);
  L.push(`GATES (apply to the holdout): accuracy at least ${GATES.company_accuracy * 100}%, Unknown at most ${GATES.unknown_cap * 100}%, tier 3 called tier 1 exactly ${GATES.tier3_as_tier1}, and the model must beat the baseline.`);
  return L.join("\n");
}

export { secondLookItems };
