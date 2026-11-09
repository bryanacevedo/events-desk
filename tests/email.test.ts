import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { addSuppression, putVerification } from "../src/server/caches.ts";
import { apolloReveal } from "../src/server/live-vendors.ts";
import { spendByStep } from "../src/server/ledger.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { VendorError, type Finder, type Verifier, type Vendors, type Waterfall } from "../src/server/providers.ts";
import { moveEvent } from "../src/server/events.ts";
import { applyPattern, dominantPattern, isDisposable, isRoleAddress, nameKey, patternOf } from "../src/shared/email.ts";
import { fakeClock, UNLIMITED, VendorHealth } from "../src/server/vendor-health.ts";
import { freshDb } from "./helpers.ts";
import { defaults, found, HEAD, MAYA, outreachRun, researchWith, revealed as revealedOf, row, type Run } from "./tier-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("addresses, in code", () => {
  it("spots role and disposable addresses, which never cost a verifier credit", () => {
    for (const e of ["info@acme.com", "sales@acme.com", "Support@acme.com", "no-reply@acme.com"]) expect(isRoleAddress(e), e).toBe(true);
    expect(isRoleAddress("ana.ruiz@acme.com")).toBe(false);
    expect(isDisposable("x@mailinator.com")).toBe(true);
    expect(isDisposable("x@acme.com")).toBe(false);
  });
  it("reads patterns and needs two addresses to agree before a pattern counts", () => {
    expect(patternOf("ana.ruiz@x.com", "Ana", "Ruiz")).toBe("first.last");
    expect(patternOf("aruiz@x.com", "Ana", "Ruiz")).toBe("flast");
    expect(applyPattern("first_last", "Zoë", "Müller")).toBe("zoe_muller");
    expect(dominantPattern([{ email: "ana.ruiz@x.com", first: "Ana", last: "Ruiz" }, { email: "bo.lee@x.com", first: "Bo", last: "Lee" }])).toBe("first.last");
    expect(dominantPattern([{ email: "ana.ruiz@x.com", first: "Ana", last: "Ruiz" }])).toBeNull();
    expect(nameKey("Ana María Ruiz")).toBe(nameKey("ruiz ana maria"));
  });
});

const HARBOR = "harborlogistics.example", ACME_D = "acmecloud.example";
const soft = { employees: 900, industry: "B2B software", business_model: "B2B", country: "Spain" };
const specs = { [ACME_D]: { search: soft }, [HARBOR]: { search: { ...soft, industry: "logistics technology" } } };
const CSV = HEAD + row("Acme Cloud", ACME_D, "Ana Ruiz") + "Harbor Logistics,,,,\n";

/** Vendors that answer from a table: ZeroBounce (`v1`) by address, its probe by domain (what an unknown mailbox reads as), Apollo's match (`finderEmails[name][0]`), and Apollo's waterfall (`finderEmails[name][1]`, verified twice unless `wfOnce`). They count their calls. */
function lab(opts: { v1?: Record<string, string>; probe?: Record<string, string>; finderEmails?: Record<string, (string | null)[]>; wfOnce?: string[]; thrower?: (name: string, n: number) => unknown } = {}) {
  const calls = { v1: [] as string[], finder: [] as string[], waterfall: [] as string[], probes: [] as string[] };
  const tweak = (v: Vendors, s: ReturnType<typeof defaults>): Vendors => {
    const verifier = (i: 0): Verifier => ({
      name: s.verifiers[i].name, cost: s.verifiers[i].cost,
      async verify(email) {
        if (email.startsWith("zz-")) { calls.probes.push(email); return { verdict: ((opts.probe ?? {})[email.split("@")[1]] ?? "undeliverable") as never, charged: s.verifiers[i].cost }; }
        calls.v1.push(email);
        const err = opts.thrower?.(s.verifiers[i].name, calls.v1.length);
        if (err) throw err;
        return { verdict: (opts.v1 ?? {})[email] as never ?? "deliverable", charged: s.verifiers[i].cost };
      },
    });
    const finder = (i: number): Finder => ({
      name: s.finders[i].name, cost: s.finders[i].cost,
      async find(p) { calls.finder.push(`${s.finders[i].name}:${p.full_name}`); const list = (opts.finderEmails ?? {})[p.full_name ?? ""]; return { value: list?.[i] ?? null, charged: s.finders[i].cost, apollo_verified: true }; },
    });
    const waterfall: Waterfall = {
      name: s.waterfall.name, reserve: s.waterfall.reserve,
      async start(p) { calls.waterfall.push(p.full_name); return { request_id: p.full_name }; },
      async poll(id) { const email = (opts.finderEmails ?? {})[id]?.[1] ?? null; const once = email !== null && (opts.wfOnce ?? []).includes(email); return { state: "done", result: { email, apollo_verified: email !== null && !once, zerobounce_pass: email !== null, credits: email ? 3 : 1 } }; },
    };
    return { ...v, verifiers: [verifier(0)], finders: [finder(0)], waterfall };
  };
  return { calls, tweak };
}
const drops = async (id: string) => Object.fromEntries((await db.query<{ full_name: string; drop_reason: string | null; email: string | null }>("SELECT full_name, drop_reason, email FROM contacts WHERE event_id = $1 AND source = 'prospect' ORDER BY full_name", [id])).map((r) => [r.full_name, r.drop_reason ?? `kept:${r.email}`]));
const spent = async (id: string) => Object.fromEntries((await spendByStep(db, id)).filter((x) => x.kind === "outreach").map((x) => [x.step, x.n]));
async function harbor(people: ReturnType<typeof found>[], l: ReturnType<typeof lab>, more: Partial<Parameters<typeof researchWith>[2]> = {}) {
  const r = await researchWith(db, CSV, { specs, people: { [HARBOR]: people }, tweak: l.tweak, ...more });
  await outreachRun(db, r);
  return r;
}

describe("the catch-all probe", () => {
  it("probes each domain once, before any reveal, and stops everyone at a domain that accepts any address", async () => {
    const l = lab({ probe: { [HARBOR]: "deliverable" } });
    const r = await harbor([found("p1", "Ana", "Vega", "VP Sales"), found("p2", "Bo", "Lund", "Director of Sales")], l);
    expect(Object.values(await drops(r.id))).toEqual(["catch_all_unconfirmed", "catch_all_unconfirmed"]);
    // One probe for the domain, not one per person, and nothing was revealed or looked up.
    expect(l.calls.probes.filter((p) => p.endsWith(`@${HARBOR}`))).toHaveLength(1);
    const sp = await spent(r.id);
    expect(sp.reveal ?? 0).toBe(0);
    expect(sp.find ?? 0).toBe(0);
    expect(sp.waterfall ?? 0).toBe(0);
    expect(l.calls.v1.filter((e) => e.endsWith(`@${HARBOR}`))).toEqual([]);
  });
  it("treats a verifier that calls the probe a catch-all the same way, and a domain with no mail server as not deliverable", async () => {
    const l = lab({ probe: { [HARBOR]: "catch_all" } });
    const r = await harbor([found("p1", "Ana", "Vega", "VP Sales")], l);
    expect(Object.values(await drops(r.id))).toEqual(["catch_all_unconfirmed"]);
    await db.query("DELETE FROM domain_state");
    const noMail = lab();
    const r2 = await harbor([found("p9", "Cy", "Moss", "VP Sales")], noMail, { name: "NoMail", tweak: (v, s) => ({ ...noMail.tweak(v, s), identity: { ...v.identity!, dns: { hasMailServer: async () => false } } }) });
    expect(Object.values(await drops(r2.id))).toEqual(["not_deliverable"]);
    expect(noMail.calls.probes).toEqual([]);
  });
  it("reuses a domain's state for 30 days across events, and probes again after that", async () => {
    const l = lab();
    await harbor([found("p1", "Ana", "Vega", "VP Sales")], l);
    const first = l.calls.probes.length;
    const l2 = lab();
    await harbor([found("p2", "Bo", "Lund", "VP Sales")], l2, { name: "Second" });
    expect(l2.calls.probes.filter((p) => p.endsWith(`@${HARBOR}`))).toHaveLength(0);
    await db.query("UPDATE domain_state SET probed_at = now() - interval '31 days'");
    const l3 = lab();
    await harbor([found("p3", "Cy", "Moss", "VP Sales")], l3, { name: "Third" });
    expect(first).toBeGreaterThan(0);
    expect(l3.calls.probes.filter((p) => p.endsWith(`@${HARBOR}`))).toHaveLength(1);
  });
});

describe("the verification loop", () => {
  const revealed = (first: string, id: string) => revealedOf(first, id, HARBOR).email;
  const nm = (first: string, id: string) => revealedOf(first, id, HARBOR).name;
  it("keeps a found address with Apollo Verified and a ZeroBounce pass, and shows both checks", async () => {
    const e = revealed("Ana", "p1");
    const l = lab();
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l);
    expect(await drops(r.id)).toEqual({ [nm("Ana", "p1")]: `kept:${e}` });
    expect(l.calls.v1).toContain(e);
    expect(l.calls.waterfall).toEqual([]);
    expect(await db.query("SELECT verify_1, verify_2 FROM contacts WHERE email = $1", [e])).toEqual([{ verify_1: "deliverable", verify_2: "deliverable" }]);
  });
  it("moves to the waterfall when ZeroBounce says undeliverable, and keeps what it verified", async () => {
    const e0 = revealed("Ana", "p1");
    const l = lab({ v1: { [e0]: "undeliverable" }, finderEmails: { [nm("Ana", "p1")]: [null, `ana2@${HARBOR}`] } });
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l);
    // A revealed person is not matched again; the waterfall's address needs no further call.
    expect(Object.values(await drops(r.id))[0]).toBe(`kept:ana2@${HARBOR}`);
    expect(l.calls.finder).toHaveLength(0);
    expect(l.calls.waterfall).toEqual([nm("Ana", "p1")]);
    expect(l.calls.v1.filter((e) => e === `ana2@${HARBOR}`)).toEqual([]);
  });
  it("does not keep a waterfall address without both checks", async () => {
    const e0 = revealed("Ana", "p1");
    const l = lab({ v1: { [e0]: "undeliverable" }, finderEmails: { [nm("Ana", "p1")]: [null, `ana2@${HARBOR}`] }, wfOnce: [`ana2@${HARBOR}`] });
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l);
    expect(Object.values(await drops(r.id))[0]).toBe("email_unconfirmed");
  });
  it("spends no ZeroBounce credit on a found address Apollo did not mark Verified", async () => {
    const e0 = revealed("Ana", "p1");
    const l = lab({ finderEmails: { [nm("Ana", "p1")]: [null, e0] } });
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l, { tweak: (v, s) => { const b = l.tweak(v, s); return { ...b, reveal: { ...b.reveal!, reveal: async (q) => { const o = await b.reveal!.reveal(q); return { ...o, person: o.person && { ...o.person, email_verified: false } }; } } }; } });
    expect(l.calls.v1.filter((x) => x === e0)).toEqual([]);
    // The same address coming back from the waterfall, verified twice, is kept.
    expect(Object.values(await drops(r.id))[0]).toBe(`kept:${e0}`);
  });
  it("drops with the most specific reason when nothing is left", async () => {
    let seq = 0;
    const mk = async (v1: Record<string, string>) => {
      const id = `p${++seq}`;
      const e0 = revealed("Ana", id);
      const l = lab({ v1: Object.fromEntries(Object.entries(v1).map(([k, v]) => [k === "e0" ? e0 : k, v])) });
      return Object.values(await drops((await harbor([found(id, "Ana", null, "VP Sales")], l, { name: `E${seq}` })).id))[0];
    };
    expect(await mk({ e0: "undeliverable" })).toBe("not_deliverable");
    expect(await mk({ e0: "unknown" })).toBe("email_unconfirmed");
    expect(await mk({ e0: "catch_all" })).toBe("catch_all_unconfirmed");
  });
  it("retries an unknown once for the person, not once per candidate", async () => {
    const e0 = revealed("Ana", "p1");
    let n = 0;
    const l = lab({ finderEmails: { [nm("Ana", "p1")]: [null, `ana2@${HARBOR}`] } });
    const unknownTwice = (v: Vendors, s: ReturnType<typeof defaults>) => { const b = l.tweak(v, s); const v1 = b.verifiers[0]; return { ...b, verifiers: [{ ...v1, verify: async (e: string) => (e === e0 ? (++n, { verdict: "unknown" as const, charged: v1.cost }) : v1.verify(e)) }] }; };
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l, { tweak: unknownTwice });
    // Two calls on the first candidate (the one retry), then the next candidate.
    expect(n).toBe(2);
    expect(Object.values(await drops(r.id))[0]).toMatch(/^kept:/);
  });
  it("skips a role or disposable address and an address at another domain without a call", async () => {
    const l = lab({ finderEmails: { [nm("Ana", "p1")]: [null, "info@" + HARBOR] } });
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l, { tweak: (v, s) => { const b = l.tweak(v, s); const w = b.waterfall!; return { ...b, waterfall: { ...w, poll: async () => ({ state: "done", result: { email: "ana@mailinator.com", apollo_verified: true, zerobounce_pass: true, credits: 1 } }) } }; } });
    expect(l.calls.v1).not.toContain("info@" + HARBOR);
    expect(l.calls.v1).not.toContain("ana@mailinator.com");
    expect(Object.values(await drops(r.id))[0]).toMatch(/^kept:/);
  });
  it("reuses a verification result for 30 days, positive and negative, and verifies again after that", async () => {
    const e0 = revealed("Ana", "p1");
    await putVerification(db, e0, "undeliverable", "verifier_one");
    const l = lab({ finderEmails: { [nm("Ana", "p1")]: [null, `ana2@${HARBOR}`] } });
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l);
    expect(l.calls.v1).not.toContain(e0);
    expect(Object.values(await drops(r.id))[0]).toBe(`kept:ana2@${HARBOR}`);
    // The kept address is cached too, so the next event does not pay for it.
    const l2 = lab({ finderEmails: { [nm("Ana", "p1")]: [null, `ana2@${HARBOR}`] } });
    await db.query("UPDATE verification_cache SET checked_at = now() - interval '2 days' WHERE email = $1", [e0]);
    await putVerification(db, e0, "deliverable", "verifier_one");
    const r2 = await harbor([found("p1", "Ana", null, "VP Sales")], l2, { name: "Second" });
    expect(l2.calls.v1).toEqual([]);
    expect(Object.values(await drops(r2.id))[0]).toBe(`kept:${e0}`);
    await db.query("UPDATE verification_cache SET checked_at = now() - interval '31 days'");
    const l3 = lab();
    await harbor([found("p1", "Ana", null, "VP Sales")], l3, { name: "Third" });
    expect(l3.calls.v1).toContain(e0);
  });
});

describe("reveal and the employment check", () => {
  it("pays for a reveal once, stores it, and never buys the same person twice", async () => {
    const l = lab();
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l);
    expect((await spent(r.id)).reveal).toBe(1);
    const l2 = lab();
    const r2 = await harbor([found("p1", "Ana", null, "VP Sales")], l2, { name: "Second" });
    expect((await spent(r2.id)).reveal ?? 0).toBe(0);
    expect(Object.values(await drops(r2.id))[0]).toMatch(/^kept:/);
  });
  it("drops a discovered person whose reveal names another employer, before any verifier is paid", async () => {
    const l = lab();
    const r = await harbor([found("p1", "Ana", "Vega", "VP Sales")], l, { tweak: (v, s) => { const b = l.tweak(v, s); return { ...b, reveal: { ...b.reveal!, reveal: async (q) => { const o = await b.reveal!.reveal(q); return { ...o, person: o.person && { ...o.person, employer: "Other Corp", employer_domain: "othercorp.example" } }; } } }; } });
    expect(Object.values(await drops(r.id))).toEqual(["employment_unconfirmed"]);
    expect(l.calls.v1.filter((e) => e.endsWith(`@${HARBOR}`))).toEqual([]);
  });
  it("accepts an employer named by the company's parent domain", async () => {
    const l = lab();
    await db.query("SELECT 1");
    const r = await harbor([found("p1", "Ana", "Vega", "VP Sales")], l, { tweak: (v, s) => { const b = l.tweak(v, s); return { ...b, reveal: { ...b.reveal!, reveal: async (q) => { const o = await b.reveal!.reveal(q); return { ...o, person: o.person && { ...o.person, employer: "Harbor Logistics GmbH", employer_domain: HARBOR } }; } } }; } });
    expect(Object.values(await drops(r.id))[0]).toMatch(/^kept:/);
  });
  it("leaves a person with a hidden name and a missed reveal without finders, and says no email was found", async () => {
    const l = lab();
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l, { tweak: (v, s) => { const b = l.tweak(v, s); return { ...b, reveal: { ...b.reveal!, reveal: async () => ({ person: null, charged: 1 }) } }; } });
    expect(Object.values(await drops(r.id))).toEqual(["no_email_found"]);
    expect(l.calls.finder).toEqual([]);
  });
});

describe("pattern guessing and suppression", () => {
  it("does not guess an address by default, even when a pattern is plain", async () => {
    const l = lab({ v1: { [`ana.vega@${HARBOR}`]: "undeliverable" } });
    const r = await harbor([found("p1", "Ana", "Vega", "VP Sales")], l);
    expect(Object.values(await drops(r.id))).toEqual(["not_deliverable"]);
    // Only the vendor's own address was tested; no address was made up.
    expect(l.calls.v1.filter((e) => e.endsWith(`@${HARBOR}`))).toEqual([`ana.vega@${HARBOR}`]);
  });
  it("guesses from the pattern of verified addresses at the domain only when switched on", async () => {
    const attendees = HEAD + row("Acme Cloud", ACME_D, "Ana Ruiz") + row("Acme Cloud", ACME_D, "Bo Lee");
    const cyBad = `c.moss@${ACME_D}`;
    const run = async (on: boolean, name: string) => {
      const l = lab({ v1: { [cyBad]: "undeliverable" } });
      // The vendor's address for Cy is a first-initial style that fails; the domain's verified addresses are first.last.
      const withBad = (v: Vendors, st: ReturnType<typeof defaults>): Vendors => { const b = l.tweak(v, st); return { ...b, reveal: { ...b.reveal!, reveal: async (q) => { const o = await b.reveal!.reveal(q); return { ...o, person: o.person && { ...o.person, email: cyBad } }; } } }; };
      const r = await researchWith(db, attendees, { specs, name, people: { [ACME_D]: [found("c1", "Cy", "Moss", "VP Sales")] }, tweak: withBad });
      await db.query("UPDATE event_settings SET settings = jsonb_set(jsonb_set(settings, '{add_prospects}', 'true'), '{outreach,pattern_guess}', $2::jsonb) WHERE event_id = $1", [r.id, JSON.stringify(on)]);
      await outreachRun(db, r);
      return { r, l };
    };
    const off = await run(false, "Off");
    expect(Object.values(await drops(off.r.id))).toEqual(["not_deliverable"]);
    expect(off.l.calls.v1.every((e) => e !== `cy@${ACME_D}`)).toBe(true);
    const on = await run(true, "On");
    // The attendees' verified addresses are first-name only (ana@, bo@), so that is the pattern.
    expect(Object.values(await drops(on.r.id))).toEqual([`kept:cy@${ACME_D}`]);
  });
  it("drops an opted-out person before any money is spent, and rejects a known wrong-person address", async () => {
    await addSuppression(db, { kind: "opt_out", name_key: nameKey("Ana Vega"), company_key: "harbor logistics" });
    const l = lab();
    const r = await harbor([found("p1", "Ana", "Vega", "VP Sales"), found("p2", "Bo", "Lund", "VP Sales")], l);
    const d = await drops(r.id);
    expect(d["Ana Vega"]).toBe("opted_out");
    expect(d["Bo Lund"]).toMatch(/^kept:/);
    expect((await spent(r.id)).reveal).toBe(1);
    const wrong = `bo.revealp2@${HARBOR}`;
    await addSuppression(db, { kind: "wrong_person", email: wrong, name_key: nameKey("Cy Moss") });
    const l2 = lab({ finderEmails: { "Cy Moss": [null, `cy2@${HARBOR}`] } });
    const r2 = await harbor([found("p5", "Cy", "Moss", "VP Sales")], l2, { name: "Second" });
    expect(Object.values(await drops(r2.id))[0]).toMatch(/^kept:/);
    await expect(addSuppression(db, { kind: "opt_out" })).rejects.toThrow(/needs an address/);
  });
});

describe("vendors behind the guard: outages pause, nothing is repeated, caps refuse cleanly", () => {
  it("pauses the event, drops nobody, and finishes after a resume, when a verifier is down", async () => {
    let down = true;
    const l = lab({ thrower: (name) => (down && name.includes("one") ? new VendorError(0) : null) });
    const r = await researchWith(db, CSV, { specs, people: { [HARBOR]: ["p1", "p2", "p3", "p4"].map((id, i) => found(id, ["Ana", "Bo", "Cy", "Di"][i], "Vega", "VP Sales")) }, tweak: l.tweak });
    await outreachRun(db, r);
    const stage = (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [r.id]))[0].stage;
    expect(stage).toBe("paused");
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND drop_reason IN ('vendor_error', 'not_deliverable', 'email_unconfirmed')", [r.id])).length).toBe(0);
    down = false;
    await moveEvent(db, r.id, "finding_people", MAYA, { detail: "Resumed" });
    await processEvent(db, r.id, r.deps);
    expect((await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [r.id]))[0].stage).toBe("delivered");
    expect(Object.values(await drops(r.id)).every((x) => x.startsWith("kept:"))).toBe(true);
  });
  it("never repeats a paid call whose outcome is unknown: one verifier error closes that candidate", async () => {
    const nm = (first: string, id: string) => revealedOf(first, id, HARBOR).name;
    const l = lab({ thrower: (name, n) => (name.includes("one") && n === 2 ? new VendorError("unknown") : null), finderEmails: { [nm("Ana", "p1")]: [null, `ana2@${HARBOR}`] } });
    const r = await harbor([found("p1", "Ana", null, "VP Sales")], l);
    // The first candidate's verifier call errored with an unknown charge: it is not repeated, the next candidate is tried.
    expect(l.calls.v1.filter((e) => e.startsWith("ana.reveal"))).toHaveLength(1);
    expect(Object.values(await drops(r.id))[0]).toBe(`kept:ana2@${HARBOR}`);
  });
  it("closes a call in flight when its worker died, without repeating it", async () => {
    const l = lab();
    const r: Run = await researchWith(db, CSV, { specs, people: { [HARBOR]: [found("p1", "Ana", "Vega", "VP Sales")] }, tweak: l.tweak });
    const { requestOutreachCard } = await import("../src/server/research.ts");
    const { decideApproval } = await import("../src/server/approvals.ts");
    await requestOutreachCard(db, r.id, MAYA);
    await decideApproval(db, { approvalId: (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [r.id]))[0].id, actor: MAYA, decision: "approve" });
    await processEvent(db, r.id, { ...r.deps, vendorsFor: (s) => ({ ...r.deps.vendorsFor(s), finders: [] }) }).catch(() => {});
    // Whatever stage it reached, put one person's loop mid-call and let the lease expire.
    const [p] = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND source = 'prospect' LIMIT 1", [r.id]);
    await db.query("UPDATE contacts SET dropped_at = NULL, drop_reason = NULL, email = NULL, email_loop = $2::jsonb WHERE id = $1", [p.id, JSON.stringify({ probed: true, supp: true, uploaded: true, revealed: true, cand: [{ email: `ana.vega@${HARBOR}`, source: "reveal", state: "new" }], inflight: "v1:0" })]);
    await db.query("INSERT INTO jobs (id, event_id, kind, payload, status, lease_until) VALUES ('job_dead', $1, 'find', $2::jsonb, 'running', now() - interval '1 minute')", [r.id, JSON.stringify({ contact_id: p.id, index: 0 })]);
    await db.query("UPDATE events SET stage = 'finding_people', paused_from = NULL WHERE id = $1", [r.id]);
    const before = l.calls.v1.length;
    await processEvent(db, r.id, r.deps);
    expect(l.calls.v1.slice(before)).not.toContain(`ana.vega@${HARBOR}`);
    expect((await db.query<{ drop_reason: string | null }>("SELECT drop_reason FROM contacts WHERE id = $1", [p.id]))[0].drop_reason).toBe("vendor_error");
  });
  it("refuses cleanly at a step cap: the person drops as budget_cap and nobody else is touched", async () => {
    const l = lab();
    const r = await researchWith(db, CSV, { specs, people: { [HARBOR]: [found("p1", "Ana", "Vega", "VP Sales"), found("p2", "Bo", "Lund", "VP Sales")] }, tweak: l.tweak });
    const { requestOutreachCard } = await import("../src/server/research.ts");
    const { decideApproval } = await import("../src/server/approvals.ts");
    await requestOutreachCard(db, r.id, MAYA);
    // Room for two people's verifications: the registered attendee at Acme goes first, then one of the two discovered people. The probes have their own cap.
    await db.query("UPDATE cost_cards SET step_caps = jsonb_set(step_caps, '{verify,credits}', '2') WHERE event_id = $1 AND kind = 'outreach'", [r.id]);
    await decideApproval(db, { approvalId: (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [r.id]))[0].id, actor: MAYA, decision: "approve" });
    await processEvent(db, r.id, r.deps);
    const d = Object.values(await drops(r.id));
    expect(d.filter((x) => x.startsWith("kept:"))).toHaveLength(1);
    expect(d.filter((x) => x === "budget_cap")).toHaveLength(1);
    expect((await spent(r.id)).verify).toBeLessThanOrEqual(2);
  });
});

describe("the Outreach card is a true worst case for the email loop", () => {
  it("covers every discovered person taking the longest path: reveal, a retry on an unknown, the waterfall at its reserve, and a LinkedIn lookup", async () => {
    const names = ["Ana", "Bo", "Cy", "Di"];
    const people = names.map((n, i) => found(`w${i}`, n, null, "VP Sales"));
    const second = (n: string) => `${n.toLowerCase()}2@${HARBOR}`;
    const rev = (n: string, i: number) => revealedOf(n, `w${i}`, HARBOR).email;
    const v1 = Object.fromEntries(names.map((n, i) => [rev(n, i), "unknown"]));
    const finderEmails = Object.fromEntries(names.map((n, i) => [revealedOf(n, `w${i}`, HARBOR).name, [null, second(n)]]));
    const l = lab({ v1, finderEmails });
    const r = await harbor(people, l);
    expect(Object.values(await drops(r.id)).every((x) => x.startsWith("kept:"))).toBe(true);
    const [card] = await db.query<{ lines: Record<string, number>; step_caps: Record<string, { credits?: number }> }>("SELECT lines, step_caps FROM cost_cards WHERE event_id = $1 AND kind = 'outreach'", [r.id]);
    const sp = await spent(r.id);
    const s = defaults();
    const c1 = s.verifiers[0].cost;
    expect(sp.reveal).toBe(4 * 1);
    // The waterfall's reservation is reconciled to what it reported: 3 credits each.
    expect(sp.waterfall).toBe(4 * 3);
    // Two calls on the revealed address (the one retry), plus the one registered attendee at Acme.
    expect(sp.verify).toBe(4 * 2 * c1 + c1);
    expect(sp.linkedin).toBeGreaterThan(0);
    for (const [step, cap] of Object.entries(card.step_caps)) if (cap.credits !== undefined) expect(sp[step] ?? 0, step).toBeLessThanOrEqual(cap.credits);
    // The card allows at least one such person's worst case for every person it covers.
    const perPerson = s.outreach.reveal_cost! + s.waterfall.reserve + (s.outreach.candidates_per_person + s.outreach.verifier_retries) * c1 + s.linkedin.cost;
    expect(card.lines.discovered_people * perPerson).toBeLessThanOrEqual(card.lines.reveal_credits + card.lines.waterfall_credits + card.lines.verifier_credits + card.lines.linkedin_credits);
  });
});

describe("the Apollo reveal, on a faked response", () => {
  it("asks for one person by id, never for personal emails, and bills the attempt", async () => {
    const seen: { path: string; payload: any }[] = [];
    const rv = apolloReveal(defaults(), async (path, payload) => { seen.push({ path, payload }); return { person: { id: "a1", name: "Ana Vega", email: "Ana@Acme.com", linkedin_url: "https://www.linkedin.com/in/ana-vega", organization: { name: "Acme", primary_domain: "acme.com" }, title: "VP Sales" } }; });
    const out = await rv.reveal({ vendor_person_id: "a1", first_name: "Ana", company: "Acme", domain: "acme.com" });
    expect(seen).toEqual([{ path: "people/match", payload: { id: "a1", reveal_personal_emails: false } }]);
    expect(out.charged).toBe(rv.cost);
    expect(out.person).toMatchObject({ full_name: "Ana Vega", email: "ana@acme.com", employer: "Acme", employer_domain: "acme.com" });
    const miss = await apolloReveal(defaults(), async () => ({})).reveal({ vendor_person_id: "x", first_name: "X", company: "Y", domain: "y.com" });
    expect(miss).toEqual({ person: null, charged: 1 });
  });
});

describe("an empty people search under silent throttling", () => {
  const throttled = (clock: ReturnType<typeof fakeClock>, until: number, withProbe: boolean) => (v: Vendors): Vendors => ({
    ...v,
    peopleSearch: {
      name: "people_throttled", ...(withProbe ? { probe: { domain: "probeknownco.example", company: "Probe Known Co" } } : {}),
      async search(q) {
        // Until `until`, everything, the known-good lookup included, is an empty success.
        if (clock.now() < until) return { people: [], charged: 0 };
        return { people: q.domain === "probeknownco.example" ? [found("pr", "Pro", "Be", "VP Sales")] : [found("p1", "Ana", "Vega", "VP Sales")], charged: 0 };
      },
    },
  });
  const run = async (withProbe: boolean) => {
    const clock = fakeClock();
    const health = new VendorHealth({ clock, config: UNLIMITED });
    const l = lab();
    const r = await researchWith(db, CSV, { specs, people: { [HARBOR]: [found("p1", "Ana", "Vega", "VP Sales")] }, tweak: (v, s) => throttled(clock, clock.now() + 5_000, withProbe)(l.tweak(v, s)), deps: { health }, process: true });
    // The throttle starts after research; restart the clock window for the people step.
    return { r, clock, l };
  };
  it("waits for the vendor and finds the people, instead of calling the company empty", async () => {
    const { r } = await run(true);
    await outreachRun(db, r);
    expect((await db.query("SELECT 1 FROM source_rows WHERE event_id = $1 AND drop_reason = 'no_people_found'", [r.id])).length).toBe(0);
    expect(Object.values(await drops(r.id))[0]).toMatch(/^kept:/);
  });
  it("would have called the company empty without the probe", async () => {
    const { r } = await run(false);
    await outreachRun(db, r);
    expect((await db.query("SELECT 1 FROM source_rows WHERE event_id = $1 AND drop_reason = 'no_people_found'", [r.id])).length).toBe(1);
  });
});
