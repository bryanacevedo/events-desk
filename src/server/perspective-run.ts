/* The one model call per delivered list: the Summary's perspective.

   Called by the pipeline after the cases are opened and the event is delivered, before the Sheet is built. It never fails delivery and never waits on it
   past a timeout: every way it can go wrong ends in the code-written text for the block (a refusal, a failed or slow call, an exhausted card, an answer the
   checks reject), with one activity line in plain words.

   Money: the call is reserved and settled in model calls through the ledger, under the Outreach card's own `perspective` step (one call, one retry at most).
   Credits are never touched. A single-card event has no such step and makes no call. */

import type { Ctx } from "./paid.ts";
import { decide } from "./paid.ts";
import { logActivity } from "./events.ts";
import type { Llm } from "./providers.ts";
import { allowedOf, buildPacket, packetHash, PART_TITLES, promptOf, type StoredBlock, type StoredPerspective } from "./perspective-model.ts";
import { checkPart, PARTS, shapeOf, type Part } from "./perspective-check.ts";
import { load, perspective, type Line } from "./workbook.ts";

/** How long delivery waits for the model before the code-written text is used. */
export const PERSPECTIVE_TIMEOUT_MS = 45_000;
const SYSTEM = "Events Desk";

const asText = (lines: Line[]) => lines.map(([label, text]) => (label ? `${label}: ${text}` : text)).join(" ");
const sentence = (s: string) => s.replace(/[.\s]+$/, "");

export async function writePerspective(c: Ctx, opts: { timeoutMs?: number } = {}): Promise<void> {
  // Single-card events keep the code-written Summary and make no call.
  if (c.flow !== "two_card") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const d = await load(c.db, c.eventId);
    const packet = buildPacket(d), allowed = allowedOf(packet);
    const code = perspective(d);
    const llm = c.deps.llm, simulated = llm.simulated === true;
    // The model that answered, which with server-side fallback can differ from the one asked.
    let answered = llm.model;
    const spy: Llm = { model: llm.model, simulated: llm.simulated, complete: async (s, p, h) => { const r = await llm.complete(s, p, h); answered = r.model ?? llm.model; return r; } };

    const accepted: Partial<Record<Part, string>> = {}, why: Partial<Record<Part, string>> = {};
    let unreadable = false;
    const valid = (v: unknown) => {
      const shape = shapeOf(v);
      if (!shape) { unreadable = true; return null; }
      unreadable = false;
      if (simulated) return true;
      for (const p of PARTS) {
        if (accepted[p] !== undefined) continue;
        const r = checkPart(shape[p], allowed);
        if (r.ok) { accepted[p] = r.text; delete why[p]; } else why[p] = r.why;
      }
      return PARTS.every((p) => accepted[p] !== undefined) ? true : null;
    };

    const draft = { why: asText(code.why), list: asText(code.list), stand: asText(code.stand) };
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? PERSPECTIVE_TIMEOUT_MS); });
    const outcome = await Promise.race([decide(c, "perspective", promptOf(packet), valid, { llm: spy, attempts: 2, hint: draft }).catch(() => ({ kind: "error" as const, why: "vendor" as const })), timeout]);

    let general = "";
    if (outcome === "timeout") general = "the model took too long to answer";
    else if (outcome.kind === "refused") general = "the approved Outreach card has no room left for this call";
    else if (outcome.kind === "error" && outcome.why === "vendor") general = "the model call failed";
    else if (outcome.kind === "error" && unreadable) general = "the model's answer was not the three parts in the shape asked for";
    const settled = outcome !== "timeout" && outcome.kind === "ok";

    const blocks = {} as Record<Part, StoredBlock>;
    for (const p of PARTS) {
      // After a timeout the late answer is ignored: nothing the call returns later is stored.
      if (outcome === "timeout") blocks[p] = { by: "fallback", text: null, note: general };
      else if (simulated && settled) blocks[p] = { by: "simulated", text: null, note: null };
      else if (accepted[p] !== undefined) blocks[p] = { by: "model", text: accepted[p]!, note: null };
      else blocks[p] = { by: "fallback", text: null, note: general || why[p] || "it did not pass the checks" };
    }

    const stored: StoredPerspective = { version: 1, model: answered, made_at: new Date().toISOString(), packet_hash: packetHash(packet), blocks };
    await c.db.query("UPDATE events SET perspective = $2::jsonb WHERE id = $1", [c.eventId, JSON.stringify(stored)]);

    const fell = PARTS.filter((p) => blocks[p].by === "fallback");
    if (fell.length) {
      const titles = fell.map((p) => PART_TITLES[p]).join(" and ");
      const detail = general
        ? `The Summary perspective uses the rules-composed text for ${titles}, not the model's: ${general}.`
        : `The Summary perspective uses the rules-composed text for ${titles}, because the model's text failed a check: ${fell.map((p) => `${PART_TITLES[p]}, ${sentence(blocks[p].note ?? "")}`).join("; ")}.`;
      await c.db.tx((q) => logActivity(q, c.eventId, SYSTEM, "perspective", detail.slice(0, 600)));
    }
  } catch (e) {
    // Nothing here may undo a delivery. Without a stored record the Summary is code-written.
    console.error("perspective", c.eventId, e);
    await c.db.tx((q) => logActivity(q, c.eventId, SYSTEM, "perspective", "The Summary perspective is composed by rules, not written by the model: it could not be prepared.")).catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
