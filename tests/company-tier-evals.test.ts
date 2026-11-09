/* The company-tier evals: sets, labels, scoring, Wilson intervals, the baseline comparison, and the gates on the holdout.

   Measured with no model call: the baseline (size band plus keywords) and the ICP's own tier definitions applied in code, on both sets.
   Measured from committed recordings (replayed, scored only while fresh): the real model on company_tier. The second_look prompt was recorded and then CUT
   (decision 24): it disagreed on none of the 22 holdout companies it read. A stale recording turns its tests into visible skips. Simulated results are authored
   and live in tests/tiering-world.test.ts, not here. */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RESEARCH_STEPS } from "../src/shared/cost.ts";
import { decidedByRule, demoIcp, factsOf, fileHash, fmt, GATES, HOLDOUT_PATH, inputsHash, loadDev, loadHoldout, outcome, promptFor, scoreBaseline, scoreRules, scoreSecondLook, scoreSystem, secondLookItems, stat, wilson, type TierItem } from "../src/evals/company-tier.ts";
import { companyTierReport, judgeRecording, tierRecordings } from "../src/evals/report.ts";
import { promptHash } from "../src/server/prompts.ts";
import type { Recording } from "../src/evals/recordings.ts";
import { baselineTier, tierByRules } from "../src/shared/icp.ts";
import { firmoForRules } from "../src/shared/tiering.ts";
import { TEMPLATES } from "../src/server/prompts.ts";

const icp = demoIcp();
const dev = loadDev(), hold = loadHoldout();
const all = [...dev, ...hold];
const j = JSON.stringify;

/** A model that tiers from the labels and cites the first supplied line, so the scorer can be checked end to end. */
function labelModel(items: TierItem[], f: (it: TierItem) => number | "unknown" = (it) => (it.incomplete ? "unknown" : it.tier)): Record<string, string> {
  return Object.fromEntries(items.filter((it) => !decidedByRule(icp, it)).map((it) => {
    const t = f(it);
    return [it.id, j(t === "unknown" ? { tier: "unknown", segment: null, company_type: null, reason: "insufficient_information", fact: null } : { tier: t, segment: null, company_type: null, reason: t === 1 ? "icp_match" : t === 2 ? "partial_icp_match" : "outside_icp", fact: factsOf(it).citable[0] ?? null })];
  }));
}

describe("the sets", () => {
  it("are the sizes described, with unique ids, and the real companies marked as the author's own knowledge", () => {
    expect([dev.length, hold.length]).toEqual([120, 68]);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    expect(dev.every((i) => i.set === "dev" && i.source === "fictional")).toBe(true);
    expect(hold.every((i) => i.set === "holdout")).toBe(true);
    const real = hold.filter((i) => i.source === "real_public_author_knowledge");
    expect(real.length).toBe(38);
    expect(hold.filter((i) => i.source === "fictional").length).toBe(30);
    // Every tier is represented in each set, so no score can be earned by saying one number.
    for (const set of [dev, hold, real]) for (const t of [1, 2, 3]) expect(set.some((i) => i.tier === t), `tier ${t}`).toBe(true);
  });
  it("share no company between development and holdout", () => {
    const names = new Set(dev.map((i) => i.name.toLowerCase()));
    expect(hold.filter((i) => names.has(i.name.toLowerCase()))).toEqual([]);
  });
  it("freeze the holdout: its hash is pinned, and changing it on purpose means changing the pin", () => {
    expect(fileHash(HOLDOUT_PATH)).toBe("dd77eff352e5a46efecc01105c9a4847d534ad1985a24bd2dd596c79f6483091");
  });
  it("carry labels that agree with the ICP rules in code, except where the keyword reader is known to misread a lookalike", () => {
    // The rules in code read segments by keyword, so a name or industry that sounds like a strong vertical but is a consultancy or an agency fools them.
    // Those five are the hand-labeled traps: the label is right and the code is wrong, which is what the model is for.
    const KNOWN_ENGINE_MISSES = new Set(["dev_x06", "dev_x12", "hold_f11", "hold_f12", "hold_f26"]);
    const disagree = all.filter((it) => !it.incomplete && tierByRules(icp, firmoForRules(it.firmo)).tier !== it.tier).map((it) => it.id);
    expect(new Set(disagree)).toEqual(KNOWN_ENGINE_MISSES);
    // An incomplete item lacks a deciding fact; a careful reader says Unknown or the careful middle, never a confident extreme.
    expect(all.filter((i) => i.incomplete).length).toBe(6);
  });
});

describe("Wilson intervals", () => {
  it("match known values", () => {
    const a = wilson(8, 10); expect(a.low).toBeCloseTo(0.49, 2); expect(a.high).toBeCloseTo(0.943, 2);
    const b = wilson(0, 10); expect(b.low).toBe(0); expect(b.high).toBeCloseTo(0.278, 2);
    const c = wilson(10, 10); expect(c.low).toBeCloseTo(0.722, 2); expect(c.high).toBe(1);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
  it("widen when the sample is small, which is why a 68-item holdout cannot prove 85%", () => {
    const small = stat(58, 68), big = stat(850, 1000);
    expect(small.high - small.low).toBeGreaterThan(big.high - big.low);
    // 58 of 68 is 85.3% and its interval reaches well below 85%.
    expect(small.rate).toBeGreaterThan(0.85);
    expect(small.low).toBeLessThan(0.76);
    expect(fmt(small)).toMatch(/58\/68 = 85\.3% \(95% Wilson/);
  });
});

describe("scoring", () => {
  it("gives full marks to a model that follows the labels on every item that is not incomplete, and counts the incomplete as Unknown", () => {
    const s = scoreSystem(icp, hold, labelModel(hold));
    const incomplete = hold.filter((i) => i.incomplete).length;
    expect(s.accuracy.k).toBe(hold.length - incomplete);
    expect(s.unknown.k).toBe(incomplete);
    expect(s.tier3_as_tier1).toBe(0);
    expect(s.hard_rule_items).toBe(hold.filter((i) => decidedByRule(icp, i)).length);
    expect(s.missing).toBe(0);
  });
  it("counts Unknown as wrong, an unreadable answer as wrong, and a tier citing no supplied fact as Unknown", () => {
    const it = hold.find((i) => i.id === "hold_f01")!;
    const mk = (o: unknown) => scoreSystem(icp, [it], { [it.id]: typeof o === "string" ? o : j(o) });
    expect(mk({ tier: 1, reason: "icp_match", fact: "Employees: 3100" }).accuracy.k).toBe(1);
    expect(mk({ tier: "unknown", reason: "insufficient_information", fact: null })).toMatchObject({ accuracy: { k: 0 }, unknown: { k: 1 } });
    expect(mk("nonsense")).toMatchObject({ accuracy: { k: 0 }, invalid: 1 });
    expect(mk({ tier: 1, reason: "icp_match", fact: "A strong team and great momentum" })).toMatchObject({ accuracy: { k: 0 }, unknown: { k: 1 } });
    expect(mk({ tier: 1, reason: "icp_match", fact: "Freight software" }).accuracy.k).toBe(1);
    expect(mk({ tier: 1, reason: "icp_match", fact: "Pellam Freight Systems" }).accuracy.k).toBe(0);
  });
  it("counts a tier 3 labeled tier 1 separately, and needs no output for an item a hard rule decides", () => {
    const sets = hold.filter((i) => i.tier === 3 && !decidedByRule(icp, i)).slice(0, 3);
    const wrong = scoreSystem(icp, sets, labelModel(sets, () => 1));
    expect(wrong.tier3_as_tier1).toBe(3);
    const ruled = hold.filter((i) => decidedByRule(icp, i));
    expect(ruled.length).toBeGreaterThan(0);
    expect(scoreSystem(icp, ruled, {}).accuracy.k).toBe(ruled.length);
  });
  it("leaves unrecorded items out instead of scoring them as wrong", () => {
    const s = scoreSystem(icp, hold, {});
    expect(s.missing).toBe(hold.filter((i) => !decidedByRule(icp, i)).length);
    expect(s.n).toBe(hold.length - s.missing);
  });
  it("fails a lazy model on every gate: all tier 1 is wrong on accuracy and on tier 3 called tier 1", () => {
    const s = scoreSystem(icp, hold, labelModel(hold, () => 1));
    expect(s.accuracy.rate).toBeLessThan(GATES.company_accuracy);
    expect(s.tier3_as_tier1).toBeGreaterThan(GATES.tier3_as_tier1);
    const never = scoreSystem(icp, hold, labelModel(hold, () => "unknown"));
    expect(never.unknown.rate).toBeGreaterThan(GATES.unknown_cap);
  });
  it("compares with the baseline, which sees the same facts and is wrong in known ways", () => {
    const b = scoreBaseline(icp, hold);
    const duo = hold.find((i) => i.name === "Duolingo")!;
    // Software, in range: the baseline says tier 1 for a consumer app.
    expect(baselineTier(icp, firmoForRules(duo.firmo))).toBe(1);
    expect(b.tier3_as_tier1).toBeGreaterThanOrEqual(1);
    expect(scoreRules(icp, hold).accuracy.rate).toBeGreaterThan(b.accuracy.rate);
  });
  it("picks the items that get a second look: the model's tier 1s and its gaps of two levels to the baseline", () => {
    const first = labelModel(hold);
    const looked = secondLookItems(icp, hold, first);
    expect(looked.length).toBeGreaterThan(10);
    for (const it of looked) { const got = outcome(icp, it, first).got!; expect(got === 1 || Math.abs(got - baselineTier(icp, firmoForRules(it.firmo))) > 1).toBe(true); }
    // A perfect second look agrees everywhere: nothing flagged.
    const second = labelModel(looked);
    const s = scoreSecondLook(icp, hold, first, second);
    expect(s).toMatchObject({ flagged: 0, caught: 0, false_alarm: 0 });
    // A second look that disagrees with a wrong first tier 1 catches it and raises the precision of what is left.
    const wrongFirst = labelModel(hold, (it) => (it.id === "hold_f04" ? 1 : it.incomplete ? "unknown" : it.tier));
    const twice = labelModel(secondLookItems(icp, hold, wrongFirst));
    const caught = scoreSecondLook(icp, hold, wrongFirst, twice);
    expect(caught).toMatchObject({ caught: 1, false_alarm: 0, helps: true });
    expect(caught.tier1_precision_after.rate).toBeGreaterThan(caught.tier1_precision_before.rate);
  });
  it("builds prompts from the ICP and the supplied facts only, with no confidence anywhere", () => {
    const it = hold.find((i) => i.name === "Gong")!;
    const p = promptFor(icp, it, "company_tier");
    expect(p).toContain("Sells software that records");
    expect(p).toContain("Sells to: businesses (B2B)");
    expect(p).toContain("Tier 1 for software");
    expect(p).not.toMatch(/confidence/i);
    expect(TEMPLATES.company_tier + TEMPLATES.second_look).not.toMatch(/confidence/i);
    expect(inputsHash({ a: p })).toBe(inputsHash({ a: p }));
    expect(inputsHash({ a: p })).not.toBe(inputsHash({ a: `${p} ` }));
  });
});

describe("a recording is scored only while it is fresh", () => {
  const outputs = labelModel(all);
  const made = (over: Partial<Recording> = {}, model = "test-model", prompts = Object.fromEntries(all.filter((i) => outputs[i.id] !== undefined).map((i) => [i.id, promptFor(icp, i, "company_tier")]))): Recording =>
    ({ step: "company_tier", prompt_hash: promptHash("company_tier", model), inputs_hash: inputsHash(prompts), model, outputs, ...over });
  it("scores a recording whose template, model and filled prompts all match", () => {
    expect(judgeRecording("company_tier", made(), icp, all).out).toBe(outputs);
  });
  it("calls it stale when the prompt template changed", () => {
    const r = made({ prompt_hash: "0000000000000000" });
    expect(judgeRecording("company_tier", r, icp, all)).toMatchObject({ out: null, why: expect.stringMatching(/^STALE/) });
  });
  it("calls it stale when the model changed, because the hash covers it", () => {
    const r = made({ model: "another-model" });
    expect(r.prompt_hash).not.toBe(promptHash("company_tier", "another-model"));
    const wrong = made({ prompt_hash: promptHash("company_tier", "test-model"), model: "another-model" });
    expect(judgeRecording("company_tier", wrong, icp, all).out).toBeNull();
  });
  it("calls it stale when the ICP, the facts or an eval item changed, even if the template did not", () => {
    const changed = structuredClone(icp);
    changed.summary += " It also sells to governments.";
    expect(judgeRecording("company_tier", made(), changed, all).out).toBeNull();
    const edited = all.map((i, n) => (n === 0 ? { ...i, firmo: { ...i.firmo, employees: 1 } } : i));
    expect(judgeRecording("company_tier", made(), icp, edited).out).toBeNull();
  });
  it("does not score a recording that carries no inputs_hash, or no recording at all", () => {
    const old = made(); delete old.inputs_hash;
    expect(judgeRecording("company_tier", old, icp, all).out).toBeNull();
    expect(judgeRecording("company_tier", null, icp, all)).toMatchObject({ out: null, why: "not recorded yet" });
  });
  it("turns the gates on: a fresh recording that follows the labels passes them on the holdout, and a model that only copies the baseline does not beat it", () => {
    const s = scoreSystem(icp, hold, outputs);
    expect(s.accuracy.rate).toBeGreaterThanOrEqual(GATES.company_accuracy);
    expect(s.accuracy.rate).toBeGreaterThan(scoreBaseline(icp, hold).accuracy.rate);
    // A model that returns the baseline's tier for everything the hard rules leave to it scores about the baseline: not above it.
    const asBaseline = labelModel(hold, (it) => baselineTier(icp, firmoForRules(it.firmo)));
    expect(scoreSystem(icp, hold, asBaseline).accuracy.rate).toBeLessThan(s.accuracy.rate);
  });
});

describe("the report and the gates", () => {
  const rec = tierRecordings(icp, all);
  // eslint-disable-next-line no-console
  console.log(`\n${companyTierReport(icp, rec)}\n`);

  it("always reports the baseline and the rules, and says plainly when the model is not measured", () => {
    const text = companyTierReport(icp, rec);
    expect(text).toMatch(/baseline, size band plus keywords/);
    expect(text).toMatch(/95% Wilson/);
    if (!rec.first) expect(text).toMatch(/NOT MEASURED/);
  });

  // These turn on when a fresh company_tier recording is committed. Until then they are skipped, visibly: the model's accuracy is not a number we have.
  const measured = rec.first !== null;
  it.skipIf(!measured)("holdout: accuracy at least the gate, Unknown under the cap, no tier 3 called tier 1", () => {
    const s = scoreSystem(icp, hold, rec.first!);
    expect(s.missing).toBe(0);
    expect(s.accuracy.rate).toBeGreaterThanOrEqual(GATES.company_accuracy);
    expect(s.unknown.rate).toBeLessThanOrEqual(GATES.unknown_cap);
    expect(s.tier3_as_tier1).toBe(GATES.tier3_as_tier1);
  });
  it.skipIf(!measured)("holdout: the model beats the baseline, or it is not earning its cost", () => {
    expect(scoreSystem(icp, hold, rec.first!).accuracy.rate).toBeGreaterThan(scoreBaseline(icp, hold).accuracy.rate);
  });
  it.skipIf(!measured)("holdout, real public companies alone: no tier 3 called tier 1", () => {
    expect(scoreSystem(icp, hold.filter((i) => i.source !== "fictional"), rec.first!).tier3_as_tier1).toBe(0);
  });
  // The rule was "improves tier 1 precision, or it is cut". On the real recording (Opus 5.5) it looked at 22 holdout companies and disagreed on none, so it did not help and was cut
  // (docs/DECISIONS.md, 24). The recording and the scorer stay as evidence. If a later recording ever shows it helping, this test is where the decision is reopened.
  it.skipIf(!(measured && rec.second))("holdout: the second look did not improve tier 1 precision, so it was cut, and production no longer calls it", () => {
    const s = scoreSecondLook(icp, hold, rec.first!, rec.second!);
    expect(s).toMatchObject({ looked: 22, flagged: 0, caught: 0, false_alarm: 0, helps: false });
    expect(s.tier1_precision_after.k).toBe(s.tier1_precision_before.k);
    expect(companyTierReport(icp, rec)).toMatch(/CUT from production/);
    // The cut itself: no step on the card, no setting, no call, no cases made, no Settings row.
    const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    expect(RESEARCH_STEPS as readonly string[]).not.toContain("second_look");
    expect(read("config/defaults.json")).not.toMatch(/second_look/);
    expect(read("src/server/tiering.ts")).not.toMatch(/tierPass\(c, pin, "second_look"|needsSecondLook\(|kind: "second_look_disagreement"/);
    expect(read("src/server/settings-view.ts")).not.toMatch(/second_look|Second look/i);
    expect(read("src/app/Settings.tsx")).not.toMatch(/second look/i);
  });
  it.runIf(!measured)("NOT MEASURED: the company_tier recording is stale or missing, so no model gate ran", () => {
    expect(rec.first).toBeNull();
  });
});
