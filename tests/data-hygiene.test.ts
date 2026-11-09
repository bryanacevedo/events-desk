/* docs/DATA-HYGIENE.md, phase 1: Apollo's match then its waterfall, reuse of stored answers, and what reuse saved. Every vendor here is a script; nothing is called. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/server/db.ts";
import { apolloVerified, logReuse, putDomainState, putFinderResult, putLinkedinResult, putVerification } from "../src/server/caches.ts";
import { deleteEvent } from "../src/server/delete-event.ts";
import { moveEvent } from "../src/server/events.ts";
import { dbReveals } from "../src/server/identity.ts";
import { reserve, spendByStep } from "../src/server/ledger.ts";
import { liveVendors, waterfallResult } from "../src/server/live-vendors.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { seedSamplePools } from "../src/server/pools.ts";
import { VendorError, type Finder, type Verifier, type Vendors, type Waterfall, type WaterfallPoll, type WaterfallResult } from "../src/server/providers.ts";
import { simVendors } from "../src/server/sim-vendors.ts";
import { usageView } from "../src/server/usage.ts";
import { fakeClock, UNLIMITED, VendorHealth } from "../src/server/vendor-health.ts";
import { emailStatus } from "../src/server/workbook.ts";
import { loadWorld } from "../src/server/sim-vendors.ts";
import { nameKey } from "../src/shared/email.ts";
import type { Settings } from "../src/shared/cost.ts";
import { freshDb } from "./helpers.ts";
import { DAN, defaults, found, HEAD, MAYA, outreachRun, researchWith, row, type Run } from "./tier-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

const HARBOR = "harborlogistics.example", ACME = "acmecloud.example";
const soft = { employees: 900, industry: "B2B software", business_model: "B2B", country: "Spain" };
const specs = { [ACME]: { search: soft }, [HARBOR]: { search: { ...soft, industry: "logistics technology" } } };
const PEOPLE = { [HARBOR]: [found("p1", "Ana", "Vega", "VP Sales")] };
const CSV = HEAD + row("Acme Cloud", ACME, "Ana Ruiz") + "Acme Cloud,Bo,Lee,VP Sales,\nHarbor Logistics,,,,\n";

/** Scripted Apollo and ZeroBounce: `match` and `wf` answer by full name. They count their calls. */
function lab(o: { match?: Record<string, string>; wf?: Record<string, Partial<WaterfallResult>>; poll?: (id: string, n: number) => WaterfallPoll | null; v1?: Record<string, string>; thrower?: (n: number, email: string) => unknown; start?: () => unknown } = {}) {
  const calls = { v1: [] as string[], find: [] as string[], start: [] as string[], poll: [] as string[], reveal: [] as string[], linkedin: [] as string[] };
  const tweak = (v: Vendors, s: Settings): Vendors => {
    const verifier: Verifier = {
      name: s.verifiers[0].name, cost: s.verifiers[0].cost,
      async verify(email) {
        if (email.startsWith("zz-")) return { verdict: "undeliverable", charged: s.verifiers[0].cost };
        calls.v1.push(email);
        const err = o.thrower?.(calls.v1.length, email);
        if (err) throw err;
        return { verdict: (o.v1?.[email] ?? "deliverable") as never, charged: s.verifiers[0].cost };
      },
    };
    const finder: Finder = {
      name: s.finders[0].name, cost: s.finders[0].cost,
      async find(p) { calls.find.push(p.full_name ?? ""); const e = o.match?.[p.full_name ?? ""] ?? null; return { value: e, charged: s.finders[0].cost, linkedin: null, apollo_verified: e !== null }; },
    };
    const waterfall: Waterfall = {
      name: s.waterfall.name, reserve: s.waterfall.reserve,
      async start(p) { const err = o.start?.(); if (err) throw err; calls.start.push(p.full_name); return { request_id: `r:${p.full_name}` }; },
      async poll(id) {
        calls.poll.push(id);
        const custom = o.poll?.(id, calls.poll.filter((x) => x === id).length);
        if (custom) return custom;
        const name = id.slice(2);
        const r = o.wf?.[name];
        return { state: "done", result: { email: null, apollo_verified: false, zerobounce_pass: false, credits: 1, ...r } };
      },
    };
    const reveal = v.reveal!;
    return { ...v, verifiers: [verifier], finders: [finder], waterfall, reveal: { ...reveal, reveal: async (q) => { calls.reveal.push(q.vendor_person_id); return reveal.reveal(q); } }, linkedin: { ...v.linkedin, find: async (p) => { calls.linkedin.push(p.full_name ?? ""); return v.linkedin.find(p); } } };
  };
  return { calls, tweak };
}
const twice = (email: string, credits = 3): Partial<WaterfallResult> => ({ email, apollo_verified: true, zerobounce_pass: true, credits });
const spent = async (id: string) => Object.fromEntries((await spendByStep(db, id)).filter((x) => x.kind === "outreach").map((x) => [x.step, x.n]));
const logged = (id: string) => db.query<{ target: string; step: string; vendor: string; unit: string; n: number; candidate: string }>("SELECT target, step, vendor, unit, n, candidate FROM reuse_log WHERE event_id = $1 ORDER BY step, candidate", [id]);
const contact = (id: string, name: string) => db.query<{ id: string; email: string | null; drop_reason: string | null; verify_1: string | null; verify_2: string | null; employer: string | null; email_loop: Record<string, any> }>("SELECT id, email, drop_reason, verify_1, verify_2, employer, email_loop FROM contacts WHERE event_id = $1 AND full_name = $2", [id, name]).then((r) => r[0]);
async function run(l: ReturnType<typeof lab>, name?: string, more: Partial<Parameters<typeof researchWith>[2]> = {}, csv = CSV) {
  const r = await researchWith(db, csv, { specs, people: PEOPLE, tweak: l.tweak, name, ...more });
  await outreachRun(db, r);
  return r;
}
const stage = async (id: string) => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;

describe("Apollo's match first, then the waterfall on a miss", () => {
  it("runs the match, then starts the waterfall with the worst case reserved, and reconciles to what Apollo reported", async () => {
    const l = lab({ wf: { "Bo Lee": twice(`bo@${ACME}`, 3) } });
    const r = await run(l);
    expect(l.calls.find).toEqual(["Bo Lee"]);
    expect(l.calls.start).toEqual(["Bo Lee"]);
    expect(await contact(r.id, "Bo Lee")).toMatchObject({ email: `bo@${ACME}`, verify_1: "deliverable", verify_2: "deliverable" });
    expect((await spent(r.id)).waterfall).toBe(3);
    const [res] = await db.query<{ amount: number }>("SELECT amount FROM credit_ledger WHERE event_id = $1 AND step = 'waterfall' AND kind = 'reserve' ORDER BY created_at LIMIT 1", [r.id]);
    expect(res.amount).toBe(defaults().waterfall.reserve);
  });
  it("skips the waterfall when the match finds a verified address", async () => {
    const l = lab({ match: { "Bo Lee": `bo@${ACME}` } });
    const r = await run(l);
    expect(l.calls.start).toEqual([]);
    expect((await contact(r.id, "Bo Lee")).email).toBe(`bo@${ACME}`);
  });
  it("polls until the result arrives, waiting behind the others, and pays once", async () => {
    const l = lab({ wf: { "Bo Lee": twice(`bo@${ACME}`) }, poll: (_id, n) => (n < 3 ? { state: "pending", retry_after_ms: 0 } : null) });
    const r = await run(l);
    expect(l.calls.poll).toHaveLength(3);
    expect(l.calls.start).toHaveLength(1);
    expect((await contact(r.id, "Bo Lee")).email).toBe(`bo@${ACME}`);
  });
  it("does not keep a waterfall address missing either check", async () => {
    for (const r of [{ email: `bo@${ACME}`, apollo_verified: true, zerobounce_pass: false, credits: 2 }, { email: `bo@${ACME}`, apollo_verified: false, zerobounce_pass: true, credits: 2 }]) {
      const d = await freshDb(); const save = db; db = d;
      const res = await run(lab({ wf: { "Bo Lee": r } }));
      expect((await contact(res.id, "Bo Lee")).drop_reason).toBe("email_unconfirmed");
      db = save;
    }
  });
});

/** Puts one person back mid-loop and leaves a job whose worker died. */
async function deadJob(r: Run, name: string, loop: Record<string, unknown>) {
  const p = await contact(r.id, name);
  await db.query("UPDATE contacts SET dropped_at = NULL, drop_reason = NULL, email = NULL, verify_1 = NULL, verify_2 = NULL, email_loop = $2::jsonb WHERE id = $1", [p.id, JSON.stringify(loop)]);
  await db.query("INSERT INTO jobs (id, event_id, kind, payload, status, lease_until) VALUES ('job_dead', $1, 'find', $2::jsonb, 'running', now() - interval '1 minute')", [r.id, JSON.stringify({ contact_id: p.id, index: 0 })]);
  await db.query("UPDATE events SET stage = 'finding_people' WHERE id = $1", [r.id]);
  return p.id;
}
const FIRST = { probed: true, supp: true, uploaded: true, cand: [] };

describe("a crash cannot pay twice", () => {
  it("a replay after the request id was saved polls and never starts the waterfall again", async () => {
    const l = lab({ wf: { "Bo Lee": twice(`bo@${ACME}`) } });
    const r = await run(l);
    const before = l.calls.start.length;
    await db.query("DELETE FROM waterfall_cache");
    const res = await reserve(db, r.id, "credits", 10, "email_waterfall", "waterfall");
    await deadJob(r, "Bo Lee", { ...FIRST, finder: 1, inflight: "wf", wf: { res, request_id: "r:Bo Lee", deadline: Date.now() + 3_600_000 } });
    await processEvent(db, r.id, r.deps);
    expect(l.calls.start).toHaveLength(before);
    expect(l.calls.poll).toContain("r:Bo Lee");
    expect((await contact(r.id, "Bo Lee")).email).toBe(`bo@${ACME}`);
  });
  it("a worker that died after reserving and before an id came back never starts it again, and the reservation stays spent", async () => {
    const l = lab({ wf: { "Bo Lee": twice(`bo@${ACME}`) } });
    const r = await run(l);
    const before = l.calls.start.length;
    await db.query("DELETE FROM waterfall_cache");
    const res = await reserve(db, r.id, "credits", 10, "email_waterfall", "waterfall");
    await deadJob(r, "Bo Lee", { ...FIRST, finder: 1, inflight: "wf", wf: { res } });
    const used = (await spent(r.id)).waterfall;
    await processEvent(db, r.id, r.deps);
    expect(l.calls.start).toHaveLength(before);
    expect((await contact(r.id, "Bo Lee")).drop_reason).toBe("vendor_error");
    expect((await spent(r.id)).waterfall).toBe(used);
  });
  it("reading the same result twice settles the reservation once", async () => {
    const l = lab({ wf: { "Bo Lee": twice(`bo@${ACME}`, 4) } });
    const r = await run(l);
    const [{ res }] = await db.query<{ res: string }>("SELECT reservation_id AS res FROM credit_ledger WHERE event_id = $1 AND step = 'waterfall' AND kind = 'settle'", [r.id]);
    await db.query("DELETE FROM waterfall_cache");
    await deadJob(r, "Bo Lee", { ...FIRST, finder: 1, wf: { res, request_id: "r:Bo Lee", deadline: Date.now() + 3_600_000 } });
    await processEvent(db, r.id, r.deps);
    expect((await db.query("SELECT 1 FROM credit_ledger WHERE reservation_id = $1 AND kind = 'settle'", [res]))).toHaveLength(1);
    expect((await spent(r.id)).waterfall).toBe(4);
  });
  it("a start the vendor refused without billing pauses, and a resume starts it once", async () => {
    let refuse = true;
    const l = lab({ wf: { "Bo Lee": twice(`bo@${ACME}`) }, start: () => (refuse ? new VendorError(0) : null) });
    const r = await run(l);
    expect(await stage(r.id)).toBe("paused");
    expect((await spent(r.id)).waterfall ?? 0).toBe(0);
    refuse = false;
    await moveEvent(db, r.id, "finding_people", MAYA, { detail: "Resumed" });
    await processEvent(db, r.id, r.deps);
    expect(l.calls.start).toHaveLength(1);
    expect((await contact(r.id, "Bo Lee")).email).toBe(`bo@${ACME}`);
  });
  it("a start that may have billed is closed as a miss and never repeated", async () => {
    let calls = 0;
    const l = lab({ start: () => (++calls, new VendorError("unknown")) });
    const r = await run(l);
    expect(calls).toBe(1);
    expect((await contact(r.id, "Bo Lee")).drop_reason).toBe("vendor_error");
    expect((await spent(r.id)).waterfall).toBe(defaults().waterfall.reserve);
  });
});

describe("a result that never arrives", () => {
  const never: WaterfallPoll = { state: "pending", retry_after_ms: 300_000 };
  it("waits for a bounded time, then drops the one person, and the reservation stays spent", async () => {
    const clock = fakeClock();
    const health = new VendorHealth({ clock, config: UNLIMITED });
    const l = lab({ poll: () => never });
    const r = await run(l, undefined, { deps: { health } });
    expect(await stage(r.id)).toBe("delivered");
    expect((await contact(r.id, "Bo Lee")).drop_reason).toBe("vendor_error");
    expect((await spent(r.id)).waterfall).toBe(defaults().waterfall.reserve);
    expect(l.calls.start).toHaveLength(1);
    expect(clock.slept).toBeGreaterThanOrEqual(30 * 60_000);
    expect(l.calls.poll.length).toBeLessThanOrEqual(8);
  });
  it("pauses when several are stuck at once, drops nobody, and picks up the results after a resume", async () => {
    const clock = fakeClock();
    const health = new VendorHealth({ clock, config: UNLIMITED });
    const stuck = ["Bo Lee", "Cy Moss", "Di Page", "Ed Wynn", "Flo Hart"];
    let down = true;
    const l = lab({ poll: (id) => (down ? never : { state: "done", result: { email: `${id.slice(2).split(" ")[0].toLowerCase()}@${ACME}`, apollo_verified: true, zerobounce_pass: true, credits: 2 } }) });
    const csv = HEAD + row("Acme Cloud", ACME, "Ana Ruiz") + stuck.map((n) => `Acme Cloud,${n.split(" ")[0]},${n.split(" ")[1]},VP Sales,\n`).join("") + "Harbor Logistics,,,,\n";
    const r = await run(l, undefined, { deps: { health } }, csv);
    expect(await stage(r.id)).toBe("paused");
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND drop_reason = 'vendor_error'", [r.id]))).toHaveLength(0);
    down = false;
    await moveEvent(db, r.id, "finding_people", MAYA, { detail: "Resumed" });
    await processEvent(db, r.id, r.deps);
    expect(await stage(r.id)).toBe("delivered");
    for (const n of stuck) expect((await contact(r.id, n)).verify_2).toBe("deliverable");
    expect(l.calls.start).toHaveLength(stuck.length);
    expect((await spent(r.id)).waterfall).toBe(stuck.length * 2);
  });
  it("closes a request Apollo no longer knows", async () => {
    const r = await run(lab({ poll: () => ({ state: "gone" }) }));
    expect((await contact(r.id, "Bo Lee")).drop_reason).toBe("vendor_error");
  });
});

describe("ZeroBounce and the two checks", () => {
  it("keeps an attendee's address on one check and says Verified once", async () => {
    const l = lab();
    const r = await run(l);
    const a = await contact(r.id, "Ana Ruiz");
    expect(a).toMatchObject({ email: `ana@${ACME}`, drop_reason: null, verify_1: "deliverable", verify_2: null });
    expect(emailStatus(a)).toBe("Verified once");
    expect(l.calls.find).not.toContain("Ana Ruiz");
    expect(l.calls.start).not.toContain("Ana Ruiz");
  });
  it("counts Apollo Verified already on file as the second check, buying nothing for it", async () => {
    await putFinderResult(db, "email_waterfall", nameKey("Someone Else"), "acme cloud", { email: `ana@${ACME}`, apollo_verified: true, zerobounce_pass: true, credits: 2 });
    const r = await run(lab());
    const a = await contact(r.id, "Ana Ruiz");
    expect(a.verify_2).toBe("deliverable");
    expect(emailStatus(a)).toBe("Verified twice");
  });
  it("a LinkedIn lookup that reports the same address Verified becomes the second check", async () => {
    const l = lab();
    const r = await researchWith(db, CSV, { specs, people: PEOPLE, tweak: (v, s) => { const b = l.tweak(v, s); return { ...b, linkedin: { ...b.linkedin, find: async (p) => ({ value: null, charged: 1, verified_email: p.email }) } }; } });
    await outreachRun(db, r);
    expect((await contact(r.id, "Ana Ruiz")).verify_2).toBe("deliverable");
  });
  it("does not pay ZeroBounce again for a verdict it already gave", async () => {
    const l = lab();
    const r = await run(l);
    const before = l.calls.v1.length;
    await deadJob(r, "Ana Ruiz", { ...FIRST, cand: [{ email: `ana@${ACME}`, source: "uploaded", state: "new", zb: "deliverable" }] });
    await db.query("UPDATE verification_cache SET checked_at = now() - interval '40 days'");
    await processEvent(db, r.id, r.deps);
    expect(l.calls.v1).toHaveLength(before);
    expect((await contact(r.id, "Ana Ruiz")).email).toBe(`ana@${ACME}`);
  });
  it("after a pause, a retried unknown costs what it should and the first answer is not bought again", async () => {
    let fail = true, ana = 0, first = true;
    const l = lab({ v1: {}, thrower: (_n, email) => { if (email !== `ana@${ACME}`) return null; ana++; if (ana === 2 && fail) return new VendorError(0); return null; } });
    const r = await researchWith(db, CSV, { specs, people: PEOPLE, tweak: (v, s) => { const b = l.tweak(v, s); const z = b.verifiers[0]; return { ...b, verifiers: [{ ...z, verify: async (e: string) => { const o = await z.verify(e); if (e === `ana@${ACME}` && first) { first = false; return { ...o, verdict: "unknown" as const }; } if (e === `ana@${ACME}` && fail && ana > 1) throw new VendorError(0); return o; } }] }; } });
    await outreachRun(db, r);
    expect(await stage(r.id)).toBe("paused");
    const paused = await contact(r.id, "Ana Ruiz");
    expect(paused.email_loop.cand[0].zb).toBe("unknown");
    expect(paused.email_loop.retries ?? 0).toBe(0);
    fail = false;
    await moveEvent(db, r.id, "finding_people", MAYA, { detail: "Resumed" });
    await processEvent(db, r.id, r.deps);
    expect((await contact(r.id, "Ana Ruiz")).verify_1).toBe("deliverable");
    // One billed unknown and one billed answer; the unbilled failures in between cost nothing.
    expect((await db.query<{ n: number }>("SELECT sum(amount)::int AS n FROM credit_ledger WHERE event_id = $1 AND step = 'verify' AND kind = 'settle'", [r.id]))[0].n).toBe(3);
  });
});

describe("a second event for the same people", () => {
  it("costs no finder, reveal or verifier credits, and each avoided call is logged at its real cost", async () => {
    const l1 = lab({ wf: { "Bo Lee": twice(`bo@${ACME}`, 3) } });
    const first = await run(l1, "First");
    expect(await logged(first.id)).toEqual([]);
    const l2 = lab({ wf: { "Bo Lee": twice(`bo@${ACME}`, 3) } });
    const second = await run(l2, "Second");
    expect(l2.calls).toMatchObject({ v1: [], find: [], start: [], poll: [], reveal: [] });
    const s = await spent(second.id);
    for (const step of ["find", "waterfall", "reveal", "verify", "catch_all_probe"]) expect(s[step] ?? 0, step).toBe(0);
    expect((await contact(second.id, "Bo Lee")).email).toBe(`bo@${ACME}`);
    const rows = await logged(second.id);
    const by = (step: string) => rows.filter((x) => x.step === step);
    expect(by("waterfall")).toEqual([expect.objectContaining({ n: 3, unit: "credits" })]);
    expect(by("reveal")).toEqual([expect.objectContaining({ n: 1, vendor: "reveal_scripted" })]);
    expect(by("verify").map((x) => x.n)).toEqual([1, 1]);
    expect(by("catch_all_probe").map((x) => x.target).sort()).toEqual([ACME, HARBOR]);
    // Bo's match was a stored miss, and a miss is free on Apollo.
    expect(by("find")).toEqual([]);
  });
  it("a stale reveal is bought again, once", async () => {
    const l = lab();
    await run(l, "First");
    await db.query("UPDATE reveals SET fetched_at = now() - interval '200 days'");
    await db.query("DELETE FROM verification_cache"); await db.query("DELETE FROM domain_state");
    const l2 = lab();
    const second = await run(l2, "Second");
    expect(l2.calls.reveal).toEqual(["p1"]);
    expect((await logged(second.id)).filter((x) => x.step === "reveal")).toEqual([]);
  });
  it("a reused record that fails the employment check is bought once and the person is not dropped", async () => {
    await run(lab(), "First");
    await db.query(`UPDATE reveals SET fetched_at = now() - interval '60 days', data = data || '{"employer":"Old Corp","employer_domain":"oldcorp.example"}'::jsonb`);
    const l2 = lab();
    const second = await run(l2, "Second");
    expect(l2.calls.reveal).toEqual(["p1"]);
    const p = await contact(second.id, "Ana Vega");
    expect(p).toMatchObject({ drop_reason: null, employer: "Harbor Logistics" });
    expect(p.email_loop.rebought).toBe(true);
    expect((await spent(second.id)).reveal).toBe(1);
    expect((await logged(second.id)).filter((x) => x.step === "reveal")).toEqual([]);
  });
  it("a reused record under 30 days old that fails is dropped, with no re-buy", async () => {
    await run(lab(), "First");
    await db.query(`UPDATE reveals SET fetched_at = now() - interval '10 days', data = data || '{"employer":"Old Corp","employer_domain":"oldcorp.example"}'::jsonb`);
    const l2 = lab();
    const second = await run(l2, "Second");
    expect(l2.calls.reveal).toEqual([]);
    expect(await contact(second.id, "Ana Vega")).toMatchObject({ drop_reason: "employment_unconfirmed", employer: "Old Corp" });
  });
  it("a replay cannot buy the re-reveal twice", async () => {
    const l = lab();
    const r = await run(l);
    await db.query(`UPDATE reveals SET fetched_at = now() - interval '60 days', data = data || '{"employer":"Old Corp","employer_domain":"oldcorp.example"}'::jsonb`);
    const before = l.calls.reveal.length;
    await deadJob(r, "Ana Vega", { probed: true, supp: true, uploaded: true, cand: [], rebought: true, inflight: "rebuy" });
    await processEvent(db, r.id, r.deps);
    expect(l.calls.reveal).toHaveLength(before);
    expect((await contact(r.id, "Ana Vega")).drop_reason).toBe("employment_unconfirmed");
  });
  it("a fresh record just bought that fails is dropped as before", async () => {
    const l = lab();
    const r = await researchWith(db, CSV, { specs, people: PEOPLE, tweak: (v, s) => { const b = l.tweak(v, s); const rv = b.reveal!; return { ...b, reveal: { ...rv, reveal: async (q) => { const o = await rv.reveal(q); return { ...o, person: o.person && { ...o.person, employer: "Old Corp", employer_domain: "oldcorp.example" } }; } } }; } });
    await outreachRun(db, r);
    expect(l.calls.reveal).toEqual(["p1"]);
    expect((await contact(r.id, "Ana Vega")).drop_reason).toBe("employment_unconfirmed");
  });
  it("re-checks a stored waterfall pass older than the reuse window with ZeroBounce", async () => {
    await run(lab({ wf: { "Bo Lee": twice(`bo@${ACME}`) } }), "First");
    await db.query("UPDATE waterfall_cache SET fetched_at = now() - interval '45 days'");
    await db.query("UPDATE verification_cache SET checked_at = now() - interval '45 days'");
    const l2 = lab();
    const second = await run(l2, "Second");
    expect(l2.calls.start).toEqual([]);
    expect(l2.calls.v1).toContain(`bo@${ACME}`);
    expect((await contact(second.id, "Bo Lee")).verify_2).toBe("deliverable");
  });
  it("stores a waterfall result only when one really came back", async () => {
    const r = await run(lab({ start: () => new VendorError("unknown") }));
    expect((await contact(r.id, "Bo Lee")).drop_reason).toBe("vendor_error");
    expect(await db.query("SELECT 1 FROM waterfall_cache WHERE vendor = 'email_waterfall'")).toEqual([]);
  });
  it("reuses a LinkedIn lookup across events, a found one logged and a miss not", async () => {
    await putLinkedinResult(db, nameKey("Ana Ruiz"), "acme cloud", "https://www.linkedin.com/in/ana-ruiz", null);
    await putLinkedinResult(db, nameKey("Bo Lee"), "acme cloud", null, null);
    const l = lab({ match: { "Bo Lee": `bo@${ACME}` } });
    const r = await run(l);
    expect(l.calls.linkedin).not.toContain("Ana Ruiz");
    expect(l.calls.linkedin).not.toContain("Bo Lee");
    const rows = (await logged(r.id)).filter((x) => x.step === "linkedin");
    expect(rows).toEqual([expect.objectContaining({ n: 1, target: (await contact(r.id, "Ana Ruiz")).id })]);
  });
});

describe("what counts as saved", () => {
  const event = async () => (await researchWith(db, CSV, { specs, people: PEOPLE, tweak: lab().tweak })).id;
  it("counts another event's answer even when it landed during this run, but never this run's own", async () => {
    const id = await event();
    const later = "2099-01-01T00:00:00Z";
    await logReuse(db.query, id, { target: "c9", step: "verify", vendor: "zerobounce", unit: "credits", n: 1, answered_at: later, answered_by: id });
    expect(await logged(id)).toEqual([]);
    await logReuse(db.query, id, { target: "c9", step: "verify", vendor: "zerobounce", unit: "credits", n: 1, answered_at: later, answered_by: "another_event" });
    expect(await logged(id)).toHaveLength(1);
  });
  it("counts only an answer from before this event's run, and a replay once", async () => {
    const id = await event();
    const before = "2020-01-01T00:00:00Z";
    await logReuse(db.query, id, { target: "c1", step: "verify", vendor: "zerobounce", unit: "credits", n: 1, answered_at: "2099-01-01T00:00:00Z" });
    expect(await logged(id)).toEqual([]);
    await logReuse(db.query, id, { target: "c1", step: "verify", vendor: "zerobounce", unit: "credits", n: 1, answered_at: before });
    await logReuse(db.query, id, { target: "c1", step: "verify", vendor: "zerobounce", unit: "credits", n: 1, answered_at: before });
    expect((await logged(id)).length).toBe(1);
    await logReuse(db.query, id, { target: "c1", step: "verify", vendor: "zerobounce", unit: "credits", n: 1, candidate: "other@x.example", answered_at: before });
    expect((await logged(id)).length).toBe(2);
    await logReuse(db.query, id, { target: "c2", step: "verify", vendor: "zerobounce", unit: "credits", n: 0, answered_at: before });
    expect((await logged(id)).length).toBe(2);
  });
  it("does not count a free miss, a free DNS result, or a waterfall that would not have run", async () => {
    await putDomainState(db, HARBOR, { catch_all: null, mail_server: false });
    await putFinderResult(db, "finder_one", nameKey("Bo Lee"), "acme cloud", { email: `bo@${ACME}`, apollo_verified: true, credits: 1 });
    const store = dbReveals(db);
    await store.put("reveal_scripted", "pid:p1", null);
    const l = lab();
    const r = await run(l);
    const rows = await logged(r.id);
    expect(rows.filter((x) => x.step === "catch_all_probe" && x.target === HARBOR)).toEqual([]);
    expect(rows.filter((x) => x.step === "reveal")).toEqual([]);
    // The stored match answered, so the waterfall never ran and is not counted.
    expect(rows.filter((x) => x.step === "find")).toEqual([expect.objectContaining({ n: 1, vendor: "finder_one" })]);
    expect(rows.filter((x) => x.step === "waterfall")).toEqual([]);
    expect(l.calls.start).toEqual([]);
  });
  it("a verifier reuse is a saving even when the stored verdict was undeliverable, once", async () => {
    await putVerification(db, `ana@${ACME}`, "undeliverable", "verifier_one");
    const r = await run(lab());
    const rows = (await logged(r.id)).filter((x) => x.step === "verify" && x.candidate === `ana@${ACME}`);
    expect(rows).toEqual([expect.objectContaining({ n: 1 })]);
  });
});

describe("saved credits on Usage", () => {
  const now = new Date();
  const q = { year: now.getFullYear(), month: now.getMonth() + 1, simulated: true };
  const add = (id: string, vendor: string, step: string, unit: string, n: number, at = "now()") => db.query(`INSERT INTO reuse_log (id, event_id, target, step, vendor, unit, n, created_at) VALUES ($1, 'ev', $2, $3, $4, $5, $6, ${at})`, [id, id, step, vendor, unit, n]);
  it("shows each vendor's saving over its own period, and AI apart in dollars, and is absent at zero", async () => {
    await seedSamplePools(db);
    let u = await usageView(db, q);
    expect(u.vendors.map((v) => v.saved)).toEqual([0, 0]);
    expect(u.ai.saved_cents).toBe(0);
    await add("a", "reveal_scripted", "reveal", "credits", 400);
    await add("b", "apollo_waterfall", "waterfall", "credits", 12);
    await add("c", "zerobounce", "verify", "credits", 5);
    await add("d", "company_tier", "company_tier", "llm", 7);
    // Outside the month: Apollo's pool is monthly, ZeroBounce's yearly.
    await add("e", "reveal_scripted", "reveal", "credits", 100, `make_timestamptz(${q.year}, ${q.month === 1 ? 2 : 1}, 2, 0, 0, 0)`);
    await add("f", "zerobounce", "verify", "credits", 9, `make_timestamptz(${q.year}, ${q.month === 1 ? 2 : 1}, 2, 0, 0, 0)`);
    u = await usageView(db, q);
    expect(u.vendors.find((v) => v.vendor === "Apollo")!.saved).toBe(412);
    expect(u.vendors.find((v) => v.vendor === "ZeroBounce")!.saved).toBe(14);
    expect(u.ai.saved_cents).toBe(7 * defaults().llm_call_cents);
    const body = JSON.stringify(u);
    expect(body).not.toMatch(/saved_credits_total|total_saved/);
  });
  it("keeps a deleted event's savings", async () => {
    const r = await run(lab(), "First");
    await run(lab(), "Second");
    const [{ event_id: id }] = await db.query<{ event_id: string }>("SELECT event_id FROM reuse_log WHERE event_id <> $1 LIMIT 1", [r.id]);
    const before = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM reuse_log", []))[0].n;
    expect(before).toBeGreaterThan(0);
    await deleteEvent(db, DAN, id, [DAN]);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM reuse_log", []))[0].n).toBe(before);
  });
});

describe("Apollo's waterfall adapter, on faked responses", () => {
  const s = defaults();
  const v = (handler: (url: string, init?: RequestInit) => Response) => liveVendors(s, { apollo: "a", zerobounce: "z" }, { paceMs: 0, fetch: (async (u: string, i?: RequestInit) => handler(String(u), i)) as typeof fetch });
  const P = { full_name: "Maya Ortiz", company: "Brightwater", domain: "brightwater.example" };
  it("asks for poll_only with no webhook, by query string, and keeps a 64-bit request id exact", async () => {
    let url = "";
    const out = await v((u) => { url = u; return new Response(`{"request_id": 1039995589705121900, "waterfall": {"status": "accepted"}, "person": {"linkedin_url": "https://linkedin.com/in/maya", "organization": {"name": "Brightwater"}}}`); }).waterfall!.start(P);
    expect(out.request_id).toBe("1039995589705121900");
    expect(out.linkedin).toBe("https://www.linkedin.com/in/maya");
    expect(url).toContain("/people/match?");
    expect(url).toContain("run_waterfall_email=true");
    expect(url).toContain("poll_only=true");
    expect(url).not.toContain("webhook_url");
  });
  it("treats a start Apollo refuses as unbilled, and a malformed accept as unknown", async () => {
    await expect(v(() => new Response(JSON.stringify({ request_id: 1, waterfall: { status: "failed", message: "no permission" } }))).waterfall!.start(P)).rejects.toMatchObject({ charged: 0 });
    await expect(v(() => new Response(JSON.stringify({ waterfall: { status: "accepted" } }))).waterfall!.start(P)).rejects.toMatchObject({ charged: "unknown" });
  });
  it("reads pending, gone and finished results from the polling route", async () => {
    const pending = await v(() => new Response(JSON.stringify({ error_code: "result_pending", retry_after_seconds: 10 }), { status: 404 })).waterfall!.poll("5");
    expect(pending).toEqual({ state: "pending", retry_after_ms: 10_000 });
    expect(await v(() => new Response(JSON.stringify({ error_code: "request_id_unknown" }), { status: 404 })).waterfall!.poll("5")).toEqual({ state: "gone" });
    expect(await v(() => new Response("{}", { status: 410 })).waterfall!.poll("5")).toEqual({ state: "gone" });
    expect(await v(() => new Response(JSON.stringify({ webhook_status: "in_progress", webhook_result: null }))).waterfall!.poll("5")).toMatchObject({ state: "pending" });
    let url = "";
    const done = await v((u) => { url = u; return new Response(JSON.stringify({ webhook_status: "skipped", webhook_result: wf() })); }).waterfall!.poll("1039995589705121900");
    expect(url).toContain("/webhook_result/1039995589705121900");
    expect(done).toEqual({ state: "done", result: { email: "ana@brightwater.example", apollo_verified: true, zerobounce_pass: true, credits: 4 } });
  });
  const wf = (over: Record<string, unknown> = {}): any => ({ credits_consumed: 4, people: [{ id: "x", emails: [{ email: "Ana@Brightwater.example", position: 0, email_status_cd: "Verified" }], waterfall: { emails: [{ vendors: [{ name: "ZeroBounce", status: "VERIFIED", usedForVerification: true, emails: ["ana@brightwater.example"] }, { name: "Email Provider", status: "VERIFIED", usedForVerification: false, emails: ["ana@brightwater.example"] }, ...(over.extra as object[] ?? [])] }] } }] });
  it("counts ZeroBounce only when it was used for verification on that address", () => {
    expect(waterfallResult(wf(), 10)).toMatchObject({ zerobounce_pass: true, apollo_verified: true });
    const noFlag = wf(); noFlag.people[0].waterfall.emails[0].vendors[0].usedForVerification = false;
    expect(waterfallResult(noFlag, 10).zerobounce_pass).toBe(false);
    const other = wf(); other.people[0].waterfall.emails[0].vendors[0].emails = ["someone@else.example"];
    expect(waterfallResult(other, 10).zerobounce_pass).toBe(false);
    const notVerified = wf(); (notVerified.people[0].emails[0] as { email_status_cd: string }).email_status_cd = "Unverified";
    expect(waterfallResult(notVerified, 10).apollo_verified).toBe(false);
    expect(waterfallResult({ people: [] }, 10)).toEqual({ email: null, apollo_verified: false, zerobounce_pass: false, credits: 10 });
  });
  it("calls no vendor but Apollo and ZeroBounce", () => {
    const b = v(() => new Response("{}"));
    expect(b.finders.map((f) => f.name)).toEqual(["apollo_match"]);
    expect(b.verifiers.map((f) => f.name)).toEqual(["zerobounce"]);
    expect(b.waterfall!.name).toBe("apollo_waterfall");
  });
});

describe("the simulated waterfall", () => {
  it("answers from the world, is pending first, reads the same after a replay, and makes no network call", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const world = loadWorld();
    const s = defaults();
    const p = world.people.find((x) => x.company_id && world.companies.find((c) => c.id === x.company_id)?.email_pattern && x.kind === "employee")!;
    const c = world.companies.find((x) => x.id === p.company_id)!;
    const v = simVendors(world, s), v2 = simVendors(world, s);
    let start = await v.waterfall!.start({ full_name: p.full_name, company: c.name, domain: c.domain }).catch(() => null);
    start ??= await v.waterfall!.start({ full_name: p.full_name, company: c.name, domain: c.domain });
    expect((await v.waterfall!.poll(start.request_id)).state).toBe("pending");
    const one = await v.waterfall!.poll(start.request_id);
    await v2.waterfall!.poll(start.request_id);
    const two = await v2.waterfall!.poll(start.request_id);
    expect(one).toEqual(two);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("apolloVerified", () => {
  it("reads only fresh answers", async () => {
    await putFinderResult(db, "finder_one", "x y", "co", { email: "a@b.example", apollo_verified: true, credits: 1 });
    expect(await apolloVerified(db, "A@b.example", { freshness_days: 180 })).toBe(true);
    await db.query("UPDATE waterfall_cache SET fetched_at = now() - interval '200 days'");
    expect(await apolloVerified(db, "a@b.example", { freshness_days: 180 })).toBe(false);
  });
});

