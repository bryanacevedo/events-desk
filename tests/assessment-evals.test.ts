/* The assessment eval: the real model's recording scored against the hand labels. The logic tests in tests/assessment.test.ts do not use it, because the real
   model does not match every label; they use the hand-labelled recording. Here the recording is scored, with a floor per question. Nothing calls a model. */

import { describe, expect, it } from "vitest";
import { assessmentDev } from "../src/server/assessment-sim.ts";
import { ASSESSMENT_FLOORS, ASSESSMENT_GATES, answersMatch, assessmentRecording, assessmentReport, scoreAssessment } from "../src/evals/assessment.ts";
import { QUESTION_IDS } from "../src/shared/assessment.ts";
import { staleManifest } from "../src/evals/recordings.ts";

const items = assessmentDev();
const rec = assessmentRecording();
// eslint-disable-next-line no-console
console.log(`\n${assessmentReport(rec)}\n`);

describe("the scorer", () => {
  it("scores the hand labels against themselves as every labelled answer matched, nothing missed, nothing extra", () => {
    const outputs = Object.fromEntries(items.map((i) => [i.id, JSON.stringify({ answers: i.answers.map((a) => ({ ...a, detail: "" })) })]));
    const s = scoreAssessment(items, outputs);
    expect(s.dropped).toEqual([]);
    for (const p of s.perQuestion) expect([p.question, p.matched.k, p.matched.n, p.wrong, p.missed, p.extra]).toEqual([p.question, p.labelled, p.labelled, 0, 0, 0]);
  });
  it("counts a wrong answer, a missed one, an extra one and an invented quote", () => {
    const f = items.find((i) => i.id === "faq_browse_only")!;
    const q = (n: string) => f.answers.find((a) => a.question === n)!;
    const out = { faq_browse_only: JSON.stringify({ answers: [
      { ...q("download"), answer: "app", detail: "" },
      { ...q("can_hide"), detail: "" },
      { question: "sponsor_adds", answer: "lead_retrieval", detail: "", quote: "Sponsors get everything they can imagine." },
    ] }) };
    const s = scoreAssessment([f], out);
    const by = (n: string) => s.perQuestion.find((p) => p.question === n)!;
    expect(by("download")).toMatchObject({ wrong: 1 });
    expect(by("can_hide").matched.k).toBe(1);
    expect(by("sponsor_adds")).toMatchObject({ missed: 1 });
    expect(by("terms")).toMatchObject({ missed: 1 });
    expect(s.dropped.map((d) => d.why)).toEqual(["quote_missing"]);
  });
  it("matches a list in any order and free text by containment or by the same quote", () => {
    expect(answersMatch("sponsor_adds", { question: "sponsor_adds", answer: "a, b", quote: "x" }, { question: "sponsor_adds", answer: "b,a", quote: "y" })).toBe(true);
    expect(answersMatch("directory_tickets", { question: "directory_tickets", answer: "Full Conference pass", quote: "q one" }, { question: "directory_tickets", answer: "Full Conference pass holders; Expo-only excluded", quote: "q two" })).toBe(true);
    expect(answersMatch("terms", { question: "terms", answer: "One thing.", quote: "Same sentence here" }, { question: "terms", answer: "Another wording", quote: "Same sentence here" })).toBe(true);
    expect(answersMatch("download", { question: "download", answer: "browse_only", quote: "x" }, { question: "download", answer: "app", quote: "x" })).toBe(false);
  });
});

describe("the real model's recording", () => {
  it("is declared and says NOT MEASURED when there is none, and is fresh when there is one", () => {
    if (rec.out) { expect(rec.why).toMatch(/^fresh/); expect(staleManifest().assessment_propose).toBeUndefined(); expect(assessmentReport(rec)).toMatch(/PER QUESTION/); }
    else { expect(assessmentReport(rec)).toMatch(/NOT MEASURED/); expect(staleManifest().assessment_propose.calls_estimate).toBeGreaterThan(0); }
  });
  it.skipIf(rec.out === null)("matches at least the floor of the labelled answers on every question", () => {
    const s = scoreAssessment(items, rec.out!);
    for (const p of s.perQuestion) expect(p.matched.rate, `${p.question}: ${p.matched.k} of ${p.labelled}`).toBeGreaterThanOrEqual(ASSESSMENT_FLOORS[p.question]);
    expect(Object.keys(ASSESSMENT_FLOORS).sort()).toEqual([...QUESTION_IDS].sort());
  });
  it.skipIf(rec.out === null)("invents no quote, and the page carrying an instruction yields no download answer", () => {
    const s = scoreAssessment(items, rec.out!);
    expect(s.dropped.length).toBe(ASSESSMENT_GATES.dropped_quotes);
    expect(s.injection_download_answers).toBe(ASSESSMENT_GATES.injection_download_answers);
  });
  it.skipIf(rec.out === null)("every disagreement with the labels has a written reason, so none is left unexplained", async () => {
    const { CELL_NOTES } = await import("../src/evals/assessment.ts");
    const s = scoreAssessment(items, rec.out!);
    const off = s.cells.filter((c) => ["wrong", "missed", "extra"].includes(c.kind)).map((c) => `${c.page}/${c.question}`).sort();
    expect(Object.keys(CELL_NOTES).sort()).toEqual(off);
  });
});
