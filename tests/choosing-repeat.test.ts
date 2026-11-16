/* Which events to repeat: the exact test, the correction, "too few to say", the wording check, the decision (docs/CHOOSING.md section 8). */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { fisherGreater } from "../src/server/stats.ts";
import { analyze, checkWording, decide, REPEAT_RULE, readingHash, repeatView, templateWords, wordPatterns, type Pattern, type Unit } from "../src/server/repeat.ts";
import type { Llm } from "../src/server/providers.ts";
import { mockLlm } from "../src/server/providers.ts";
import { Forbidden } from "../src/server/seats.ts";
import { Invalid } from "../src/server/overlap.ts";
import { freshDb } from "./helpers.ts";
import { addPassingTable, addPast, clockOnly } from "./choosing-helpers.ts";
import { as, CAMILLE, DAN, MAYA } from "./plan-helpers.ts";

let n = 0;
const unit = (o: Partial<Unit> & { met: boolean }): Unit => { const { met, ...rest } = o; return { id: `u${++n}`, name: `U${n} 2025`, year: 2025, series_key: `s${n}`, size: "flagship", region: "North America", involvement: [], held: met ? 12 : 4, goal: 10, cost_cents: 100, held_per_thousand: null, ...rest }; };
const make = (spec: Array<[number, number, Partial<Unit>]>): Unit[] => spec.flatMap(([count, metCount, over]) => Array.from({ length: count }, (_, i) => unit({ ...over, met: i < metCount })));

describe("the exact test", () => {
  it("matches known values of the one-sided Fisher test", () => {
    expect(fisherGreater(3, 3, 3, 6)).toBeCloseTo(0.05, 12);          // 1 / C(6,3)
    expect(fisherGreater(3, 4, 4, 8)).toBeCloseTo(17 / 70, 12);       // the tea-tasting table
    expect(fisherGreater(4, 4, 4, 8)).toBeCloseTo(1 / 70, 12);
    expect(fisherGreater(0, 5, 3, 10)).toBe(1);
    expect(fisherGreater(5, 6, 6, 14)).toBeCloseTo(49 / 3003, 12);
    expect(() => fisherGreater(4, 3, 4, 8)).toThrow();
  });
});

describe("the patterns", () => {
  // Flagship 6 (5 met) against regional 8 (1 met): two groups looked at, so each is held to 0.05 / 2.
  const passing = () => make([[6, 5, { size: "flagship" }], [8, 1, { size: "regional" }]]);

  it("passes a constructed table, and divides the allowance by the pairs looked at", () => {
    const a = analyze(passing());
    expect(a.total).toBe(14);
    expect(a.met).toBe(6);
    expect(a.pairs).toBe(2);
    expect(a.alpha_each).toBeCloseTo(0.025, 12);
    const f = a.patterns.find((p) => p.key === "size:flagship")!;
    expect(f).toMatchObject({ n_in: 6, k: 5, m: 6, total: 14, looked_at: true, passes: true, status: "passes", counts: "5 of 6 met their goal; 1 of 8 elsewhere" });
    expect(f.p).toBeCloseTo(49 / 3003, 12);
    expect(a.patterns.find((p) => p.key === "size:regional")!.passes).toBe(false);
    expect(templateWords(f)).toBe("Flagship events met their goal 5 of 6 times, the others 1 of 8.");
  });

  it("holds the same pattern to a smaller allowance once more pairs are looked at", () => {
    // The same sizes, now also split into two regions of seven: four pairs, 0.05 / 4 = 0.0125 < 0.0163.
    const units = passing().map((u, i) => ({ ...u, region: i % 2 ? "Europe" : "North America" }));
    const a = analyze(units);
    expect(a.pairs).toBe(4);
    expect(a.alpha_each).toBeCloseTo(0.0125, 12);
    const f = a.patterns.find((p) => p.key === "size:flagship")!;
    expect(f.p!).toBeLessThan(0.025);
    expect(f.p!).toBeGreaterThan(0.0125);
    expect(f).toMatchObject({ looked_at: true, passes: false, status: "no_clear_difference" });
  });

  it("reads a group of 4 as too few to say, with its counts, and leaves it out of the pairs", () => {
    const a = analyze(make([[4, 4, { size: "flagship" }], [10, 2, { size: "regional" }]]));
    const f = a.patterns.find((p) => p.key === "size:flagship")!;
    expect(f).toMatchObject({ n_in: 4, looked_at: false, passes: false, status: "too_few", p: null, alpha_each: null, counts: "4 of 4 met their goal; 2 of 10 elsewhere" });
    // The regional group has 10 and the rest 4: also not looked at, so nothing is compared.
    expect(a.pairs).toBe(0);
    expect(a.alpha_each).toBeNull();
  });

  it("does not pass a group with enough events when the difference is not clear", () => {
    const a = analyze(make([[6, 3, { size: "flagship" }], [8, 3, { size: "regional" }]]));
    const f = a.patterns.find((p) => p.key === "size:flagship")!;
    expect(f).toMatchObject({ looked_at: true, k: 3, passes: false, status: "no_clear_difference" });
    expect(f.p!).toBeGreaterThan(f.alpha_each!);
  });

  it("needs at least 3 events in the group that met their goal, and a better rate than the rest", () => {
    // 2 of 5 in the group against 0 of 9: clear, but only 2 met.
    const few = analyze(make([[5, 2, { size: "flagship" }], [9, 0, { size: "regional" }]]));
    expect(few.patterns.find((p) => p.key === "size:flagship")!).toMatchObject({ looked_at: true, passes: false });
    // A group doing worse than the rest never passes.
    const worse = analyze(make([[6, 0, { size: "flagship" }], [8, 6, { size: "regional" }]]));
    expect(worse.patterns.find((p) => p.key === "size:flagship")!.passes).toBe(false);
  });

  it("counts past events with no goal and leaves them out of the patterns", () => {
    const a = analyze([...passing(), unit({ met: true, goal: null }), unit({ met: false, goal: null })]);
    expect(a.no_goal).toBe(2);
    expect(a.total).toBe(14);
  });

  it("compares involvement, with an event in each group it has, and skips a group that is the whole table", () => {
    const units = [...make([[6, 5, { size: "flagship", involvement: ["sponsorship", "talk"] }], [8, 1, { size: "flagship", involvement: [] }]])];
    const a = analyze(units);
    expect(a.patterns.find((p) => p.key === "size:flagship")).toBeUndefined(); // everyone is flagship: nothing to compare against
    expect(a.patterns.find((p) => p.key === "involvement:sponsorship")).toMatchObject({ n_in: 6, k: 5, passes: true });
    expect(a.patterns.find((p) => p.key === "involvement:talk")).toMatchObject({ n_in: 6, passes: true });
    expect(a.patterns.find((p) => p.key === "involvement:side_event")).toBeUndefined();
    expect(a.pairs).toBe(2);
  });

  it("does not depend on the order of the units", () => {
    const a = analyze(passing()), b = analyze([...passing()].reverse());
    expect(b).toEqual(a);
  });

  it("exposes its rule in one constant", () => {
    expect(REPEAT_RULE).toMatchObject({ min_events: 5, min_goal_met: 3, alpha: 0.05, max_wordings: 6 });
  });
});

describe("the wording check", () => {
  const p = analyze(make([[6, 5, { size: "flagship" }], [8, 1, { size: "regional" }]])).patterns.find((x) => x.key === "size:flagship") as Pattern;
  const text = (t: string) => JSON.stringify({ text: t });

  it("accepts the code-written sentence and a plain restatement", () => {
    expect(checkWording(text(templateWords(p)), p)).toEqual({ ok: true, text: templateWords(p) });
    expect(checkWording(text("Flagship events met their goal 5 of 6 times. The others did 1 of 8."), p).ok).toBe(true);
  });

  it("rejects a number that is not one of the pattern's, a name outside the facts, advice, a dash, markup, three sentences and a wrong shape", () => {
    const why = (raw: string) => { const v = checkWording(raw, p); return v.ok ? "ok" : v.why; };
    expect(why(text("Flagship events met their goal 6 of 7 times, the others 1 of 8."))).toMatch(/not a pair of counts/);
    expect(why(text("Flagship events met their goal 5 of 6 times, 83 percent."))).toMatch(/not one of the counts/);
    expect(why(text("Flagship events met their goal 6 of 6 times, the others 1 of 8."))).toMatch(/not a pair of counts/);
    expect(why(text("Flagship events met their goal 5 of 6 times, and Money20/20 did best."))).toMatch(/not in the facts|not one of the counts/);
    expect(why(text("Flagship events met their goal 5 of 6 times, so we should go back."))).toMatch(/advice/);
    expect(why(text("We recommend flagship events, 5 of 6."))).toMatch(/advice/);
    expect(why(text(`Flagship events met their goal 5 of 6 times${String.fromCharCode(0x2014)} the others 1 of 8.`))).toMatch(/dash/);
    expect(why(text("Flagship events met their goal 5 of 6 times - the others 1 of 8. See https://x.example"))).toMatch(/markup/);
    expect(why(text("Flagship events met their goal. They did well. The others 1 of 8."))).toMatch(/sentences/);
    expect(why("not json")).toMatch(/JSON/);
    expect(why(JSON.stringify({ text: "x", extra: 1 }))).toMatch(/exactly/);
    expect(why(text(""))).toMatch(/empty/);
  });
});

describe("wording a reading", () => {
  const deps = clockOnly as never;
  const fake = (reply: () => string | Error, model = "claude-test"): Llm & { calls: number } => {
    const l = { model, calls: 0, async complete() { l.calls++; const r = reply(); if (r instanceof Error) throw r; return { text: r, input_tokens: 11, output_tokens: 7, model }; } };
    return l as never;
  };
  const setup = async () => { const db = await freshDb(); await addPassingTable(db); return db; };

  it("reads the table from the desk: units, a passing pattern, and the template while nothing is worded", async () => {
    const db = await setup();
    const v = await repeatView(db, deps);
    expect(v).toMatchObject({ units: 14, total: 14, met: 6, pairs: 2 });
    const f = v.patterns.find((x) => x.passes)!;
    expect(f.key).toBe("size:flagship");
    expect(v.wordings[f.key]).toMatchObject({ by: "template", text: templateWords(f), status: "none" });
    expect(v.series).toHaveLength(14);
    expect(v.series[0].words).toBe("one edition so far");
  }, 60_000);

  it("the simulated model is not a model: the row says template, and the same reading is never worded twice", async () => {
    const db = await setup();
    const first = await wordPatterns(db, mockLlm, deps);
    expect(first).toMatchObject({ made: 1, skipped: 0 });
    const [row] = await db.query<{ status: string; by: string; text: string; reading_hash: string }>("SELECT status, by, text, reading_hash FROM repeat_wordings");
    expect(row).toMatchObject({ status: "done", by: "template", text: "Flagship events met their goal 5 of 6 times, the others 1 of 8." });
    expect(first.wordings["size:flagship"]).toMatchObject({ by: "template" });
    const again = await wordPatterns(db, mockLlm, deps);
    expect(again).toMatchObject({ made: 0, skipped: 1 });
    expect(await db.query("SELECT 1 FROM repeat_wordings")).toHaveLength(1);
  }, 60_000);

  it("shows a real model's words only when the check accepts them, and never calls again for the same reading", async () => {
    const db = await setup();
    const good = fake(() => JSON.stringify({ text: "Flagship events met their goal 5 of 6 times, the others 1 of 8." }));
    await wordPatterns(db, good, deps);
    expect(good.calls).toBe(1);
    expect(await db.query("SELECT status, by, model, input_tokens, output_tokens FROM repeat_wordings")).toEqual([{ status: "done", by: "model", model: "claude-test", input_tokens: 11, output_tokens: 7 }]);
    await wordPatterns(db, good, deps);
    expect(good.calls).toBe(1);
    // A new past event is a new reading, worded once more.
    await addPast(db, { n: 20, size: "regional", goal: 10, held: 4 });
    await wordPatterns(db, good, deps);
    expect(good.calls).toBe(2);
  }, 60_000);

  it("falls back to the template when the words fail the check, and a failed call stays failed", async () => {
    const bad = await setup();
    const liar = fake(() => JSON.stringify({ text: "Flagship events met their goal 6 of 6 times, the others 1 of 8." }));
    const out = await wordPatterns(bad, liar, deps);
    expect(await bad.query("SELECT status, by, text FROM repeat_wordings")).toEqual([{ status: "done", by: "template", text: templateWords(out.patterns.find((x) => x.passes)!) }]);
    const down = await setup();
    const broken = fake(() => new Error("boom"));
    await wordPatterns(down, broken, deps);
    await wordPatterns(down, broken, deps);
    expect(broken.calls).toBe(1);
    expect(await down.query("SELECT status, by FROM repeat_wordings")).toEqual([{ status: "failed", by: "template" }]);
    expect((await repeatView(down, deps)).wordings["size:flagship"]).toMatchObject({ by: "template", status: "failed" });
  }, 60_000);

  it("the reading hash changes with a count", async () => {
    const a = analyze(make([[6, 5, { size: "flagship" }], [8, 1, { size: "regional" }]])).patterns;
    const b = analyze(make([[6, 5, { size: "flagship" }], [9, 1, { size: "regional" }]])).patterns;
    expect(readingHash(a)).not.toBe(readingHash(b));
    expect(readingHash(a)).toBe(readingHash([...a].reverse().sort((x, y) => (x.key < y.key ? -1 : 1))));
  });
});

describe("the decision", () => {
  it("is leadership's or GTM's: a planner and a rep are refused", async () => {
    const db = await freshDb();
    await expect(decide(db, CAMILLE, { series_key: "x", decision: "repeat" })).rejects.toBeInstanceOf(Forbidden);
    await expect(decide(db, MAYA, { series_key: "x", decision: "repeat" })).rejects.toBeInstanceOf(Forbidden);
  });

  it("needs a reason to drop, may repeat without one, keeps the evidence, and the latest row is current", async () => {
    const db = await freshDb();
    await addPassingTable(db);
    await db.query("UPDATE events SET name = 'Past Conference 0 2024' WHERE id = 'evt_past_0'");
    await expect(decide(db, DAN, { series_key: "past-conference-0", decision: "drop", reason: "  " }, clockOnly as never)).rejects.toBeInstanceOf(Invalid);
    await expect(decide(db, DAN, { series_key: "past-conference-0", decision: "maybe" }, clockOnly as never)).rejects.toBeInstanceOf(Invalid);
    await decide(db, DAN, { series_key: "past-conference-0", decision: "repeat" }, clockOnly as never);
    await decide(db, DAN, { series_key: "past-conference-0", decision: "drop", reason: "Too far from the team" }, clockOnly as never);
    const rows = await db.query<{ decision: string; reason: string | null; evidence: { patterns: unknown[]; pairs: number; series: { editions: unknown[] } } }>("SELECT decision, reason, evidence FROM repeat_decisions ORDER BY decided_at, id");
    expect(rows.map((r) => r.decision)).toEqual(["repeat", "drop"]);
    expect(rows[1].reason).toBe("Too far from the team");
    expect(rows[1].evidence.pairs).toBe(2);
    expect(rows[1].evidence.patterns).toHaveLength(1);
    expect(rows[1].evidence.series.editions).toHaveLength(1);
    const v = await repeatView(db, clockOnly as never);
    expect(v.series.find((s) => s.series_key === "past-conference-0")!.current).toMatchObject({ decision: "drop", decided_by: DAN });
  }, 60_000);

  it("the database refuses a drop with a NULL, empty or blank reason", async () => {
    const db = await freshDb();
    for (const r of [null, "", "   "]) await expect(db.query("INSERT INTO repeat_decisions (id, series_key, decision, reason, decided_by) VALUES ($1, 's', 'drop', $2, 'x')", [`r${String(r)}`, r])).rejects.toThrow();
  });

  it("goes through the routes: a rep and a planner are refused, a lead records it, and the wording is a planner's", async () => {
    const db = await freshDb();
    await addPassingTable(db);
    const app = createApp(db, { demo: true, lifecycle: { connectors: {}, llm: mockLlm, now: clockOnly.now } as never });
    const post = (path: string, actor: string, body: unknown) => app.request(path, { method: "POST", headers: as(actor), body: JSON.stringify(body) });
    expect((await post("/api/choosing/repeat/decisions", MAYA, { series_key: "x", decision: "repeat" })).status).toBe(403);
    expect((await post("/api/choosing/repeat/decisions", CAMILLE, { series_key: "x", decision: "repeat" })).status).toBe(403);
    expect((await post("/api/choosing/repeat/decisions", DAN, { series_key: "past-conference-1", decision: "drop" })).status).toBe(400);
    expect((await post("/api/choosing/repeat/decisions", DAN, { series_key: "past-conference-1", decision: "drop", reason: "Cost" })).status).toBe(201);
    expect((await post("/api/choosing/repeat/word", MAYA, {})).status).toBe(403);
    const w = await post("/api/choosing/repeat/word", CAMILLE, {});
    expect(w.status).toBe(200);
    expect(((await w.json()) as { wordings: Record<string, { by: string }> }).wordings["size:flagship"].by).toBe("template");
    const view = await app.request("/api/choosing/repeat", { headers: as(CAMILLE) });
    expect(view.status).toBe(200);
    expect(((await view.json()) as { pairs: number }).pairs).toBe(2);
    expect((await app.request("/api/choosing/repeat", { headers: as(MAYA) })).status).toBe(403);
  }, 60_000);
});
