/* Which recordings are fresh. A recording is bound to the prompt template and the model (prompt_hash) and, for the company-tier steps, to the filled prompts
   of every item (inputs_hash). When either changes the recording is STALE: it describes a prompt that no longer runs. A stale recording is never scored.
   It must be declared in evals/recordings/stale.json with what to re-run; an undeclared stale recording fails CI, and with EVALS_STRICT=1 (CI sets it)
   every stale recording fails, so a changed prompt cannot hide behind an old pass. */

import { existsSync, readFileSync } from "node:fs";
import { promptHash, type Step } from "../server/prompts.ts";

export interface Recording { step: string; prompt_hash: string; inputs_hash?: string; model: string; recorded_at?: string; outputs: Record<string, string> }
export interface StaleEntry { since: string; reason: string; rerun: string; calls_estimate: number }

export const RECORDINGS_DIR = "evals/recordings";
export const recordingOf = (step: string): Recording | null => {
  const p = `${RECORDINGS_DIR}/${step}.json`;
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Recording) : null;
};
export const staleManifest = (): Record<string, StaleEntry> => {
  const p = `${RECORDINGS_DIR}/stale.json`;
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, StaleEntry>) : {};
};
/** Fresh means the template and model still hash to what was recorded. `inputsOk` adds the check of the filled prompts when the recording carries one. */
export const isFresh = (step: Step, r: Recording, inputsOk: boolean | null = null) => r.prompt_hash === promptHash(step, r.model) && (inputsOk === null || r.inputs_hash === undefined || inputsOk);
export const strictMode = () => process.env.EVALS_STRICT === "1";
