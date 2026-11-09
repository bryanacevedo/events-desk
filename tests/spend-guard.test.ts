import { describe, expect, it, vi } from "vitest";
import { planEvalRun, DEFAULT_EVALS_MAX_ITEMS } from "../src/evals/limits.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors } from "../src/server/providers.ts";
import { checkRealRun, DEFAULT_REAL_RUN_MAX_ROWS, realRunMaxRows, SpendGuardError } from "../src/server/spend-guard.ts";
import { decideApproval, requestCard } from "../src/server/approvals.ts";
import { createEvent } from "../src/server/events.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { freshDb } from "./helpers.ts";

const csv = (n: number) => `Company,Name,Email\n${Array.from({ length: n }, (_, i) => `Co${String.fromCharCode(97 + i)} Labs,Pat Q${String.fromCharCode(97 + i)},pat${i}@co${String.fromCharCode(97 + i)}.example`).join("\n")}\n`;

async function approvedEvent(n: number) {
  const db = await freshDb();
  const id = (await createEvent(db, "Maya Ortiz", { name: "T", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100, flow: "single_card" })).id;
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  await decideApproval(db, { approvalId: await pending(), actor: "Dan Whitlock", decision: "approve" });
  await ingestUpload(db, id, "Maya Ortiz", "a.csv", csv(n));
  await requestCard(db, id, "Maya Ortiz");
  await decideApproval(db, { approvalId: await pending(), actor: "Maya Ortiz", decision: "approve" });
  return { db, id };
}

describe("the real-run row limit", () => {
  it("defaults to 4 and needs an explicit value to change", () => {
    expect(DEFAULT_REAL_RUN_MAX_ROWS).toBe(4);
    expect(realRunMaxRows({})).toBe(4);
    expect(realRunMaxRows({ REAL_RUN_MAX_ROWS: "25" })).toBe(25);
    expect(() => realRunMaxRows({ REAL_RUN_MAX_ROWS: "lots" })).toThrow(SpendGuardError);
    expect(() => realRunMaxRows({ REAL_RUN_MAX_ROWS: "0" })).toThrow(/whole number/);
  });
  it("refuses more rows than the limit with a message that says how to raise it", () => {
    expect(() => checkRealRun(4, {})).not.toThrow();
    expect(() => checkRealRun(5, {})).toThrow(/at most 4.*REAL_RUN_MAX_ROWS.*before any paid call/s);
    expect(() => checkRealRun(1650, {})).toThrow(/REAL_RUN_MAX_ROWS=1650/);
    expect(() => checkRealRun(1650, { REAL_RUN_MAX_ROWS: "2000" })).not.toThrow();
  });
  it("stops a live run before the model or any vendor is touched", async () => {
    const { db, id } = await approvedEvent(6);
    const llm = { model: "x", complete: vi.fn(mockLlm.complete) };
    const vendorsFor = vi.fn(mockVendors);
    const deps: Deps = { live: true, llm, vendorsFor };
    // The refusal pauses the event with the reason, where a person looks, instead of leaving it stuck in a running stage.
    expect(await processEvent(db, id, deps)).toBe("paused");
    expect(llm.complete).not.toHaveBeenCalled();
    expect(vendorsFor).not.toHaveBeenCalled();
    expect(await db.query("SELECT 1 FROM credit_ledger WHERE event_id = $1", [id])).toHaveLength(0);
    const [ev] = await db.query<{ stage: string; paused_from: string }>("SELECT stage, paused_from FROM events WHERE id = $1", [id]);
    expect(ev).toEqual({ stage: "paused", paused_from: "tiering" });
    const log = await db.query<{ detail: string }>("SELECT detail FROM activity_log WHERE event_id = $1 AND kind = 'stage' ORDER BY created_at DESC LIMIT 1", [id]);
    expect(log[0].detail).toMatch(/Paused before any paid call: .*6 source rows.*REAL_RUN_MAX_ROWS/s);
  });
  it("lets a live run of 4 rows start, and does not limit mocked runs", async () => {
    const small = await approvedEvent(4);
    expect(await processEvent(small.db, small.id, { live: true, llm: mockLlm, vendorsFor: mockVendors })).toBe("delivered");
    const big = await approvedEvent(9);
    expect(await processEvent(big.db, big.id, { llm: mockLlm, vendorsFor: mockVendors })).toBe("delivered");
  });
});

describe("the eval item limit", () => {
  const sizes = { company_tier: 100, title_tier: 100, review: 150, concierge: 20 };
  it("defaults to a small number and leaves the recordings alone", () => {
    const p = planEvalRun(sizes, {});
    expect(p.limit).toBe(DEFAULT_EVALS_MAX_ITEMS);
    expect(p.explicit).toBe(false);
    expect(p.run).toBe(DEFAULT_EVALS_MAX_ITEMS);
    expect(p.run).toBeLessThan(p.total);
    expect(p.full).toBe(false);
  });
  it("spreads the limit in order and never exceeds it", () => {
    const p = planEvalRun(sizes, { EVALS_MAX_ITEMS: "120" });
    expect(p.take).toEqual({ company_tier: 100, title_tier: 20, review: 0, concierge: 0 });
    expect(p.run).toBe(120);
  });
  it("runs everything only when told to", () => {
    expect(planEvalRun(sizes, { EVALS_MAX_ITEMS: "370" }).full).toBe(true);
    expect(planEvalRun(sizes, { EVALS_MAX_ITEMS: "500" }).run).toBe(370);
  });
  it("rejects a limit that is not a whole number", () => {
    expect(() => planEvalRun(sizes, { EVALS_MAX_ITEMS: "all" })).toThrow(/EVALS_MAX_ITEMS/);
  });
});
