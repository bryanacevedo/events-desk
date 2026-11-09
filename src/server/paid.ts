/* The paid-call machinery the job handlers share: reserve, call, settle for vendors and for the model, the pause
   signal, and the wait on a vendor that is down. Moved out of pipeline.ts so the company-tiering flow can use the
   same rules without importing the loop that runs it. */

import type { Db } from "./db.ts";
import { newId } from "./events.ts";
import { reserve, settle, type Unit } from "./ledger.ts";
import { promptHash, type Step } from "./prompts.ts";
import { VendorError, type Llm, type Vendors } from "./providers.ts";
import { VendorDown, type VendorHealth } from "./vendor-health.ts";
import type { Settings } from "../shared/cost.ts";
import type { Flow } from "../shared/domain.ts";
import type { Deps } from "./pipeline.ts";

/** How long a job waits on a down or throttling vendor before the event pauses instead. */
export const WAIT_MAX_MS = 20_000;
export const PAUSE_AFTER = 5;

export interface Job { id: string; event_id: string; kind: string; payload: Record<string, any> }
export class PauseSignal extends Error {
  repeatable: boolean;
  constructor(vendor: string, repeatable: boolean) { super(vendor); this.repeatable = repeatable; }
}

export interface Ctx { db: Db; deps: Deps; eventId: string; settings: Settings; vendors: Vendors; errors: Map<string, number>; flow: Flow; health: VendorHealth; country: string | null }

/** `unbilled`: the vendor failed every attempt and said none of them billed. That is an outage, not an answer, and a caller that has no other vendor to try should pause. */
export type Paid<T> = { kind: "ok"; value: T } | { kind: "refused" } | { kind: "error"; why?: "invalid" | "vendor"; unbilled?: boolean };

function noteError(c: Ctx, vendor: string, repeatable: boolean) {
  const key = `${c.eventId}:${vendor}`;
  const n = (c.errors.get(key) ?? 0) + 1;
  c.errors.set(key, n);
  if (n >= PAUSE_AFTER) { c.errors.delete(key); throw new PauseSignal(vendor, repeatable); }
}

/** `step` names what is being paid for. A two-card event pays it from whichever approved card lists that step, and holds it to the step's own cap. */
export async function paidVendor<T>(c: Ctx, step: string, vendor: string, cost: number, unit: Unit, run: () => Promise<{ value: T; charged: number }>): Promise<Paid<T>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await reserve(c.db, c.eventId, unit, cost, vendor, step);
    if (!res) return { kind: "refused" };
    try {
      const { value, charged } = await run();
      await settle(c.db, res, charged);
      c.errors.delete(`${c.eventId}:${vendor}`);
      return { kind: "ok", value };
    } catch (e) {
      // The guard refused the call before it was made: nothing was billed, and the caller waits or pauses.
      if (e instanceof VendorDown) { await settle(c.db, res, 0); throw e; }
      // Retry only when the vendor says it did not bill. An unknown charge is money gone.
      const charged = e instanceof VendorError ? e.charged : "unknown";
      await settle(c.db, res, charged === 0 ? 0 : cost);
      noteError(c, vendor, charged === 0);
      if (charged !== 0) return { kind: "error", why: "vendor" };
    }
  }
  return { kind: "error", why: "vendor", unbilled: true };
}

/** The paying half of an asynchronous call: reserve, say so, call. On success the reservation stays open until the result settles it; if the result never comes it stays counted as spent.
    `noted` records the reservation before the call is made. Failures follow paidVendor's rules. */
export async function holdVendor<T>(c: Ctx, step: string, vendor: string, cost: number, unit: Unit, noted: (reservation: string) => Promise<void>, run: () => Promise<{ value: T }>): Promise<Paid<T>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await reserve(c.db, c.eventId, unit, cost, vendor, step);
    if (!res) return { kind: "refused" };
    await noted(res);
    try {
      const { value } = await run();
      c.errors.delete(`${c.eventId}:${vendor}`);
      return { kind: "ok", value };
    } catch (e) {
      if (e instanceof VendorDown) { await settle(c.db, res, 0); throw e; }
      const charged = e instanceof VendorError ? e.charged : "unknown";
      await settle(c.db, res, charged === 0 ? 0 : cost);
      noteError(c, vendor, charged === 0);
      if (charged !== 0) return { kind: "error", why: "vendor" };
    }
  }
  return { kind: "error", why: "vendor", unbilled: true };
}

/** Reads the JSON a model returned. A fence is dropped, and so is prose before the first brace or after the last, which a model adds on its own. Anything else is null. */
export function parseJson(text: string): unknown {
  const bare = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(bare); } catch { /* fall through to the braces */ }
  const open = bare.indexOf("{"), close = bare.lastIndexOf("}");
  if (open < 0 || close <= open) return null;
  try { return JSON.parse(bare.slice(open, close + 1)); } catch { return null; }
}

/** One retry on an invalid answer, which the card pays for. `attempts: 1` is for steps the card prices at one call (the website read, the second look).
    `llm` lets a step use another model than the default. An answer that could not be read is `error` with why "invalid"; a provider failure is why "vendor". */
export async function decide<T>(c: Ctx, step: Step, prompt: string, valid: (v: unknown) => T | null, opts: { llm?: Llm; attempts?: number; hint?: unknown } = {}): Promise<Paid<T>> {
  const llm = opts.llm ?? c.deps.llm;
  let why: "invalid" | "vendor" = "invalid";
  for (let attempt = 0; attempt < (opts.attempts ?? 2); attempt++) {
    const res = await reserve(c.db, c.eventId, "llm", 1, step);
    if (!res) return { kind: "refused" };
    try {
      const out = await llm.complete(step, prompt, opts.hint);
      await settle(c.db, res, 1);
      c.errors.delete(`${c.eventId}:${llm.model}`);
      await c.db.query("INSERT INTO llm_calls (id, event_id, step, prompt_hash, model, input_tokens, output_tokens, output) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [newId("llm"), c.eventId, step, promptHash(step, llm.model), out.model ?? llm.model, out.input_tokens, out.output_tokens, out.text]);
      why = "invalid";
      const value = valid(parseJson(out.text));
      if (value) return { kind: "ok", value };
    } catch (e) {
      if (e instanceof PauseSignal) throw e;
      // Only a call the provider says it did not bill may run again.
      // An outage has to stop the event, or every item fails and an empty list ships.
      if (e instanceof VendorError && e.charged === 0) { await settle(c.db, res, 0); noteError(c, llm.model, true); why = "vendor"; continue; }
      await settle(c.db, res, 1);
      noteError(c, llm.model, false);
      return { kind: "error", why: "vendor" };
    }
  }
  return { kind: "error", why };
}

/** Runs a step that talks to a vendor behind a guard. A vendor that is down or throttling is waited on for a short while and then the event pauses; it is never a reason to say a company was not found. */
export async function withVendorWait<T>(c: Ctx, run: () => Promise<T>): Promise<T> {
  for (let waits = 0; ; waits++) {
    try { return await run(); }
    catch (e) {
      if (!(e instanceof VendorDown)) throw e;
      if (e.retry_after_ms <= WAIT_MAX_MS && waits < 4) { await c.health.clock.sleep(e.retry_after_ms); continue; }
      throw new PauseSignal(e.vendor, true);
    }
  }
}

export const attempt = (c: Ctx, target: string, vendor: string, step: string, result: string) =>
  c.db.query("INSERT INTO enrichment_attempts (id, event_id, target_id, vendor, step, result) VALUES ($1, $2, $3, $4, $5, $6)", [newId("att"), c.eventId, target, vendor, step, result]);
