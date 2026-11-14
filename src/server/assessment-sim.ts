/* The simulated model for the assessment step, used by the demo and the tests. It reads no page: it recognises the sample pages in evals/assessment.dev.json
   and answers with the recorded reply for that page, and returns no answers for anything else. It always replays the hand-labelled file
   (evals/assessment.hand-recording.json), a person's answers: the demo and the logic tests need a model that gives the same answers every time, and
   the real model does not match every label. The real model's recording is scored against those labels by src/evals/assessment.ts, not replayed here. */

import { readFileSync } from "node:fs";
import { normalizeText } from "../shared/assessment.ts";
import type { Llm } from "./providers.ts";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

export interface DevItem { id: string; file: string; source_kind: string; answers: { question: string; answer: string; quote: string }[] }
export const assessmentDev = (): DevItem[] => (JSON.parse(read("evals/assessment.dev.json")) as { items: DevItem[] }).items;
export const assessmentPage = (item: DevItem) => read(item.file);

export const REAL_RECORDING = "evals/recordings/assessment_propose.json";
export const HAND_RECORDING = "evals/assessment.hand-recording.json";
/** The recording the simulated model replays: always the hand-labelled one. */
export const assessmentRecording = (): { model: string; prompt_hash: string; outputs: Record<string, string>; hand_labelled?: boolean } =>
  JSON.parse(read(HAND_RECORDING));

/** The page between the markers in a filled prompt. */
export const pageOf = (prompt: string) => prompt.slice(prompt.lastIndexOf("\n<<<PAGE\n") + 9, prompt.lastIndexOf("\nPAGE>>>"));

export function simulatedAssessment(prompt: string): string {
  const page = normalizeText(pageOf(prompt));
  const item = assessmentDev().find((i) => normalizeText(assessmentPage(i)) === page);
  return item ? assessmentRecording().outputs[item.id] ?? '{"answers":[]}' : '{"answers":[]}';
}

/** A model that always gives the hand-labelled answers. The logic tests of the assessment (confirm, missing answers, the routes) use it, so they do not depend on the real model matching a label. */
export const handLlm: Llm = { model: "hand-labelled", simulated: true, async complete(_step, prompt) { return { text: simulatedAssessment(prompt), input_tokens: 0, output_tokens: 0 }; } };
