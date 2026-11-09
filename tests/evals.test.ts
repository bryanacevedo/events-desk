import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GATES, scoreCompanies, scoreConcierge, scoreReview, scoreTitles } from "../src/evals/score.ts";
import { isFresh, recordingOf, staleManifest, strictMode } from "../src/evals/recordings.ts";
import { promptHash, type Step } from "../src/server/prompts.ts";
import { titleRule, type Settings } from "../src/shared/cost.ts";

const list = JSON.parse(readFileSync("evals/list.json", "utf8"));
const defaults: Settings = JSON.parse(readFileSync("config/defaults.json", "utf8"));
const j = (o: unknown) => JSON.stringify(o);

describe("the eval list", () => {
  it("has about 300 labeled rows plus the agent questions", () => {
    expect(list.companies.length + list.titles.length + list.contacts.length).toBeGreaterThanOrEqual(290);
    expect(list.questions.filter((q: { money: boolean }) => q.money)).toHaveLength(10);
  });
  it("only tests titles the keyword table does not decide", () => {
    expect(list.titles.filter((t: { title: string }) => titleRule(t.title, defaults.title_keywords) !== null).map((t: { title: string }) => t.title)).toEqual([]);
  });
});

describe("scoring", () => {
  it("counts a tier 3 labeled tier 1 separately", () => {
    const r = scoreCompanies([{ id: "a", tier: 3 }, { id: "b", tier: 1 }], { a: j({ tier: 1, reason: "icp_match" }), b: j({ tier: 1, reason: "icp_match" }) });
    expect(r).toEqual({ accuracy: 0.5, tier3_as_tier1: 1 });
  });
  it("treats an invalid answer as wrong", () => {
    expect(scoreTitles([{ id: "a", tier: 1 }], { a: "nonsense" }).accuracy).toBe(0);
  });
  it("fails a model that flags everything on precision", () => {
    const items = [{ id: "a", flags: ["name_looks_wrong"] }, { id: "b", flags: [] }, { id: "c", flags: [] }];
    const all = j({ flags: ["name_looks_wrong"] });
    const r = scoreReview(items, { a: all, b: all, c: all });
    expect(r.recall).toBe(1);
    expect(r.precision).toBeLessThan(GATES.review_precision);
  });
  it("does not count a money answer containing a number as refused", () => {
    const items = [{ id: "m", money: true, tool: null }, { id: "c", money: false, tool: "drop_counts" }];
    expect(scoreConcierge(items, { m: j({ answer: "It was 400" }), c: j({ tool: "drop_counts", args: {} }) })).toEqual({ money_refused: 0, right_tool: 1 });
  });
});

// Company tier and the second look are scored in tests/company-tier-evals.test.ts, on the development set and the frozen holdout.
const checks: [Step, (o: Record<string, string>) => void][] = [
  ["title_tier", (o) => expect(scoreTitles(list.titles, o).accuracy).toBeGreaterThanOrEqual(GATES.title_accuracy)],
  ["review", (o) => { const r = scoreReview(list.contacts, o); expect(r.recall).toBeGreaterThanOrEqual(GATES.review_recall); expect(r.precision).toBeGreaterThanOrEqual(GATES.review_precision); }],
  ["concierge", (o) => { const r = scoreConcierge(list.questions, o); expect(r.money_refused).toBe(1); expect(r.right_tool).toBe(1); }],
];

describe("recorded model runs", () => {
  for (const [step, check] of checks) {
    const r = recordingOf(step);
    it.skipIf(!r)(`${step}: recording matches the current prompt and model`, () => { expect(r!.prompt_hash).toBe(promptHash(step, r!.model)); });
    it.skipIf(!r)(`${step}: passes its gates`, () => check(r!.outputs));
  }
});

/* A recording describes the prompt it was made with. When the prompt changes, the recording is stale: it is never scored, it must be declared in
   evals/recordings/stale.json with what to re-run, and CI (EVALS_STRICT=1) fails until it is re-recorded. */
describe("stale recordings are declared, never passed quietly", () => {
  const manifest = staleManifest();
  const steps = ["company_tier", "second_look", "website_read", "title_parse", "perspective", "title_tier", "review", "concierge"] as const;
  for (const step of steps) {
    const r = recordingOf(step);
    const declared = manifest[step];
    it(`${step}: ${r ? (isFresh(step, r, step === "company_tier" || step === "second_look" ? true : null) ? "fresh" : declared ? "STALE (declared)" : "STALE (undeclared)") : declared ? "not recorded (declared)" : "not recorded"}`, () => {
      const fresh = r ? isFresh(step, r) : false;
      if (r && fresh && declared && step !== "company_tier" && step !== "second_look") throw new Error(`${step} is fresh but evals/recordings/stale.json still lists it. Remove the entry.`);
      if (r && !fresh) {
        // eslint-disable-next-line no-console
        console.warn(`STALE RECORDING ${step}: made for an older prompt or model. ${declared ? `Declared since ${declared.since}. Re-run: ${declared.rerun} (about ${declared.calls_estimate} calls).` : "NOT DECLARED in evals/recordings/stale.json."}`);
        if (!declared) throw new Error(`${step}: the recording is stale and not declared in evals/recordings/stale.json.`);
        if (strictMode()) throw new Error(`${step}: the recording is stale (EVALS_STRICT=1). Re-run: ${declared.rerun}`);
      }
      if (!r && declared && strictMode() && declared.calls_estimate > 0) throw new Error(`${step}: no recording yet (EVALS_STRICT=1). Run: ${declared.rerun}`);
    });
  }
});
