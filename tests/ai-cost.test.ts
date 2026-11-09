/* AI dollars in the app: real tokens where a call has them (src/server/ai-cost.ts, priced by src/shared/model-pricing.ts), the flat rate where it has none,
   the same figure after the event is deleted, and credits never mixed in. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { priceAi } from "../src/server/ai-cost.ts";
import { usageView } from "../src/server/usage.ts";
import { modelCostUsd } from "../src/shared/model-pricing.ts";
import { defaultSettings } from "../src/server/approvals.ts";
import { deliverEvent, freshDb } from "./helpers.ts";

const GTM = "GTM Team";
const LIST = "Company,Name,Title,Email\nAcme,Ada Lovelace,VP Sales,ada@acme.com\n";
let db: Db;
const now = new Date();
const usage = () => usageView(db, { year: now.getFullYear(), month: now.getMonth() + 1, simulated: false });

beforeEach(async () => { db = await freshDb(); });

describe("pricing", () => {
  it("prices a call from its tokens, and an unlisted model is never guessed", () => {
    // 4,000 in and 600 out on Opus 5.5 at $4 and $20 per million: 1.6 + 1.2 cents.
    expect(modelCostUsd("claude-opus-5-5", 4000, 600)).toBeCloseTo(0.028, 6);
    expect(modelCostUsd("claude-nobody-9", 4000, 600)).toBeNull();
    const ledger = [{ event_id: "e", step: "perspective", note: "perspective", n: 2 }];
    const real = [{ event_id: "e", step: "perspective", model: "claude-opus-5-5", n: 1, inp: 4000, out: 600 }];
    const p = [...priceAi(ledger, real, 1).values()][0];
    // One call priced from tokens (2.8 cents), one with no token count at the flat 1 cent.
    expect(p).toMatchObject({ calls: 2, real_calls: 1, flat_calls: 1 });
    expect(p.cents).toBeCloseTo(3.8, 6);
    const unpriced = [...priceAi(ledger, [{ ...real[0], model: "claude-nobody-9" }], 1).values()][0];
    expect(unpriced).toMatchObject({ real_calls: 0, flat_calls: 2, cents: 2 });
  });
});

describe("Usage and the event page", () => {
  const llmRows = (id: string) => db.query<{ id: string }>("SELECT id FROM llm_calls WHERE event_id = $1", [id]);

  it("keeps the flat rate for a simulated run and says so", async () => {
    const id = await deliverEvent(db, LIST, {}, "Sim Summit");
    const u = await usage();
    const calls = (await db.query<{ n: number }>("SELECT coalesce(sum(CASE kind WHEN 'reserve' THEN amount WHEN 'release' THEN -amount END), 0)::int AS n FROM credit_ledger WHERE event_id = $1 AND unit = 'llm'", [id]))[0].n;
    expect(calls).toBeGreaterThan(0);
    expect(u.ai.real_calls).toBe(0);
    expect(u.ai.flat_calls).toBe(calls);
    expect(u.ai.month_cents).toBeCloseTo(calls * defaultSettings().llm_call_cents, 6);
  });

  it("prices calls that carry tokens from the tokens, in Usage and on the event page, apart from credits", async () => {
    const id = await deliverEvent(db, LIST, {}, "Real Summit");
    const before = await usage();
    const rows = await llmRows(id);
    expect(rows.length).toBeGreaterThan(0);
    // Pretend every recorded call was real: 5,000 in, 700 out on Opus 5.5.
    await db.query("UPDATE llm_calls SET model = 'claude-opus-5-5', input_tokens = 5000, output_tokens = 700 WHERE event_id = $1", [id]);
    const real = rows.length * modelCostUsd("claude-opus-5-5", 5000, 700)! * 100;
    const after = await usage();
    expect(after.ai.real_calls).toBe(rows.length);
    // Real cents for the priced calls, the flat rate for any ledger call without a row.
    const flat = after.ai.flat_calls * defaultSettings().llm_call_cents;
    expect(after.ai.month_cents).toBeCloseTo(real + flat, 1);
    expect(after.ai.month_cents).not.toBeCloseTo(before.ai.month_cents, 1);
    // Credits are untouched by it.
    expect(after.vendors.map((v) => [v.vendor, v.used])).toEqual(before.vendors.map((v) => [v.vendor, v.used]));
    const ev = after.events.find((e) => e.name === "Real Summit")!;
    expect(ev.ai.cents).toBeCloseTo(after.ai.month_cents, 1);
    // The event page gets the same dollars per step.
    const page = await (await createApp(db, { demo: true }).request(`/api/events/${id}`)).json() as { spend_by_step: { unit: string; n: number; cents?: number }[] };
    const llmSteps = page.spend_by_step.filter((s) => s.unit === "llm");
    expect(llmSteps.every((s) => typeof s.cents === "number")).toBe(true);
    expect(llmSteps.reduce((n, s) => n + s.cents!, 0)).toBeCloseTo(after.ai.month_cents, 1);
    expect(page.spend_by_step.filter((s) => s.unit === "credits").every((s) => s.cents === undefined)).toBe(true);
  });

  it("keeps the same AI dollars after the event is deleted", async () => {
    const id = await deliverEvent(db, LIST, {}, "Gone Summit");
    await db.query("UPDATE llm_calls SET model = 'claude-opus-5-5', input_tokens = 5000, output_tokens = 700 WHERE event_id = $1", [id]);
    const before = await usage();
    expect(before.ai.real_calls).toBeGreaterThan(0);
    expect((await createApp(db, { demo: true }).request(`/api/events/${id}`, { method: "DELETE", headers: { "x-actor": encodeURIComponent(GTM) } })).status).toBe(200);
    expect(await llmRows(id)).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM llm_calls_kept WHERE event_id = $1", [id])).length).toBe(before.ai.real_calls);
    const after = await usage();
    expect(after.ai).toEqual(before.ai);
    // What is kept is what prices a call, not what the model said.
    expect(Object.keys((await db.query("SELECT * FROM llm_calls_kept LIMIT 1"))[0]).sort()).toEqual(["created_at", "event_id", "id", "input_tokens", "kept_at", "model", "output_tokens", "step"]);
  });
});
