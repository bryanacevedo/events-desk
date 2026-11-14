/* Writes evals/assessment.hand-recording.json from the labelled set in evals/assessment.dev.json: the reply a careful reader would give for each page.
   This is NOT a recording of the real model. It is labelled `hand_labelled`, carries the model name "hand-labelled", and exists so the replay path, the quote check and the
   demo can be built and tested before a real recording is made with `make evals-live`. Run again whenever the prompt changes. */

import { writeFileSync } from "node:fs";
import { assessmentDev, HAND_RECORDING } from "../src/server/assessment-sim.ts";
import { promptHash } from "../src/server/prompts.ts";

const MODEL = "hand-labelled";
const outputs = Object.fromEntries(assessmentDev().map((i) => [i.id, JSON.stringify({ answers: i.answers.map((a) => ({ question: a.question, answer: a.answer, detail: "", quote: a.quote })) })]));
writeFileSync(HAND_RECORDING, `${JSON.stringify({ step: "assessment_propose", hand_labelled: true, note: "Hand-labelled by the builder from evals/assessment.dev.json. Not the real model.", prompt_hash: promptHash("assessment_propose", MODEL), model: MODEL, outputs }, null, 1)}\n`);
console.log(`${HAND_RECORDING} written`);
