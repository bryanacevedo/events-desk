/* The simulated model for the assessment step, used by the demo and the tests. It reads no page: it recognises the sample pages in evals/assessment.dev.json
   and answers with the recorded reply for that page, and returns no answers for anything else. A recording from the real model is used when it exists;
   until then the hand-labelled file stands in, and says so in its own `model` field. */

import { existsSync, readFileSync } from "node:fs";
import { normalizeText } from "../shared/assessment.ts";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

export interface DevItem { id: string; file: string; source_kind: string; answers: { question: string; answer: string; quote: string }[] }
export const assessmentDev = (): DevItem[] => (JSON.parse(read("evals/assessment.dev.json")) as { items: DevItem[] }).items;
export const assessmentPage = (item: DevItem) => read(item.file);

export const REAL_RECORDING = "evals/recordings/assessment_propose.json";
export const HAND_RECORDING = "evals/assessment.hand-recording.json";
/** The recording the simulated model replays: the real model's when it has been recorded, else the hand-labelled one. */
export const assessmentRecording = (): { model: string; prompt_hash: string; outputs: Record<string, string>; hand_labelled?: boolean } =>
  JSON.parse(read(existsSync(new URL(REAL_RECORDING, root)) ? REAL_RECORDING : HAND_RECORDING));

/** The page between the markers in a filled prompt. */
export const pageOf = (prompt: string) => prompt.slice(prompt.lastIndexOf("\n<<<PAGE\n") + 9, prompt.lastIndexOf("\nPAGE>>>"));

export function simulatedAssessment(prompt: string): string {
  const page = normalizeText(pageOf(prompt));
  const item = assessmentDev().find((i) => normalizeText(assessmentPage(i)) === page);
  return item ? assessmentRecording().outputs[item.id] ?? '{"answers":[]}' : '{"answers":[]}';
}
