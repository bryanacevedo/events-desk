/* docs/DATA-HYGIENE.md, phase 2: Salesforce do not contact checks, the shared person record, and writing back. Every CRM here is a script; Salesforce is not connected. */

import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.ts";
import { answerCase, listCases } from "../src/server/cases.ts";
import { putVerification } from "../src/server/caches.ts";
import { CrmDown, preSendCheck } from "../src/server/crm-checks.ts";
import { drainOutbox, MAX_ATTEMPTS } from "../src/server/crm-outbox.ts";
import type { Db } from "../src/server/db.ts";
import { deleteEvent } from "../src/server/delete-event.ts";
import { moveEvent } from "../src/server/events.ts";
import { linkContact } from "../src/server/person-record.ts";
import { mockCrm, noCrm, type Crm, type CrmAccountQuery, type CrmPersonQuery, type CrmRecord, type Finder, type Verifier, type Vendors, type Waterfall, type WaterfallResult } from "../src/server/providers.ts";
import { SIM_RATES, simCrm, loadWorld } from "../src/server/sim-vendors.ts";
import { recordOptOut } from "../src/server/suppression.ts";
import { buildWorkbook } from "../src/server/workbook.ts";
import { dropLabel, DROP_REASONS } from "../src/shared/domain.ts";
import type { Settings } from "../src/shared/cost.ts";
import { DROP_WORDS } from "../src/app/words.ts";
import { deliverEvent, freshDb } from "./helpers.ts";
import { DAN, HEAD, MAYA, outreachRun, researchWith, row, found, type Run } from "./tier-helpers.ts";

// Several full runs per test, on a machine that may be busy.
vi.setConfig({ testTimeout: 30_000 });

let db: Db;
beforeEach(async () => { db = await freshDb(); });

const ACME = "acmecloud.example", HARBOR = "harborlogistics.example";
const soft = { employees: 900, industry: "B2B software", business_model: "B2B", country: "Spain" };
const specs = { [ACME]: { search: soft }, [HARBOR]: { search: { ...soft, industry: "logistics technology" } } };
const PEOPLE = { [HARBOR]: [found("p1", "Ana", "Vega", "VP Sales")] };
const CSV = HEAD + row("Acme Cloud", ACME, "Ana Ruiz") + "Acme Cloud,Bo,Lee,VP Sales,\n";

type Held = CrmRecord & { name?: string; at?: string };
const rec = (id: string, o: Partial<Held>): Held => ({ id, object: "Contact", email: null, email_opt_out: false, do_not_contact: false, do_not_call: false, bounced_at: null, ...o });

/** A CRM holding the given records. `down` decides, per call, whether it fails. */
function fake(records: Held[] = [], o: { down?: (kind: "people" | "accounts", qs: (CrmPersonQuery | CrmAccountQuery)[]) => boolean | Promise<boolean>; dnp?: string[]; partial?: boolean; writeFails?: () => boolean } = {}) {
  const asked: CrmPersonQuery[] = [], accounts: CrmAccountQuery[] = [], writes: { id: string; patch: object }[] = [];
  const crm: Crm & { asked: typeof asked; accounts: typeof accounts; writes: typeof writes; records: Held[] } = {
    name: "crm_script", connected: true, asked, accounts, writes, records,
    lookup: (c, d) => mockCrm.lookup(c, d),
    async personFlags(people) {
      if (await o.down?.("people", people)) throw new Error("down");
      asked.push(...people);
      if (o.partial) return {};
      return Object.fromEntries(people.map((p) => [p.ref, records.filter((r) => (p.email && r.email === p.email) || (p.full_name && r.name === p.full_name && r.at && (r.at === p.domain || r.at === p.company)))]));
    },
    async accountFlags(list) {
      if (await o.down?.("accounts", list)) throw new Error("down");
      accounts.push(...list);
      return Object.fromEntries(list.map((a) => [a.ref, { do_not_prospect: Boolean(o.dnp?.includes(a.domain ?? "") || o.dnp?.includes(a.name ?? "")) }]));
    },
    async write(record, patch) { if (o.writeFails?.()) throw new Error("no"); writes.push({ id: record.id, patch }); Object.assign(records.find((r) => r.id === record.id)!, patch); },
  };
  return crm;
}

/** Scripted vendors that count their calls. */
function lab(o: { match?: Record<string, string>; wf?: Record<string, Partial<WaterfallResult>>; verifyFails?: () => boolean } = {}) {
  const calls = { v1: [] as string[], find: [] as string[], start: [] as string[], reveal: [] as string[], linkedin: [] as string[] };
  const tweak = (v: Vendors, s: Settings): Vendors => {
    const verifier: Verifier = { name: s.verifiers[0].name, cost: s.verifiers[0].cost, async verify(email) { if (email.startsWith("zz-")) return { verdict: "undeliverable", charged: s.verifiers[0].cost }; calls.v1.push(email); return { verdict: "deliverable", charged: s.verifiers[0].cost }; } };
    const finder: Finder = { name: s.finders[0].name, cost: s.finders[0].cost, async find(p) { calls.find.push(p.full_name ?? ""); const e = o.match?.[p.full_name ?? ""] ?? null; return { value: e, charged: s.finders[0].cost, linkedin: null, apollo_verified: e !== null }; } };
    const waterfall: Waterfall = { name: s.waterfall.name, reserve: s.waterfall.reserve, async start(p) { calls.start.push(p.full_name); return { request_id: `r:${p.full_name}` }; }, async poll(id) { return { state: "done", result: { email: null, apollo_verified: false, zerobounce_pass: false, credits: 1, ...o.wf?.[id.slice(2)] } }; } };
    const reveal = v.reveal!;
    return { ...v, verifiers: [verifier], finders: [finder], waterfall, reveal: { ...reveal, reveal: async (q) => { calls.reveal.push(q.vendor_person_id); return reveal.reveal(q); } }, linkedin: { ...v.linkedin, find: async (p) => { calls.linkedin.push(p.full_name ?? ""); return { value: null, charged: 0 }; } } };
  };
  return { calls, tweak };
}

const research = (crm: Crm | undefined, l = lab(), csv = CSV, more: object = {}) => researchWith(db, csv, { specs, people: PEOPLE, tweak: l.tweak, deps: { crm }, ...more });
const stage = async (id: string) => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;
const who = (id: string, name: string) => db.query<{ id: string; email: string | null; drop_reason: string | null; no_calls: boolean; person_id: string | null; verify_2: string | null }>("SELECT id, email, drop_reason, no_calls, person_id, verify_2 FROM contacts WHERE event_id = $1 AND full_name = $2", [id, name]).then((r) => r[0]);
const resume = async (r: Run) => { const [e] = await db.query<{ paused_from: "researching" }>("SELECT paused_from FROM events WHERE id = $1", [r.id]); await moveEvent(db, r.id, e.paused_from, DAN); await (await import("../src/server/pipeline.ts")).processEvent(db, r.id, r.deps); };
const credits = async (id: string) => (await db.query<{ n: number }>("SELECT coalesce(sum(CASE kind WHEN 'reserve' THEN amount WHEN 'release' THEN -amount ELSE 0 END), 0)::int AS n FROM credit_ledger WHERE event_id = $1 AND unit = 'credits'", [id]))[0].n;

describe("which CRM runs a check", () => {
  it("noCrm says it is not connected, cannot write, and a run asks it nothing", async () => {
    expect(noCrm.connected).toBe(false);
    expect(noCrm.personFlags).toBeUndefined();
    expect(noCrm.write).toBeUndefined();
    const r = await research(noCrm);
    await outreachRun(db, r);
    expect(await stage(r.id)).toBe("delivered");
    expect((await db.query("SELECT 1 FROM crm_outbox")).length).toBe(0);
  });
  it("a CRM that does not say connected is never asked, even if it could answer", async () => {
    const crm = { ...fake([rec("c1", { email: `ana@${ACME}`, email_opt_out: true })]), connected: false };
    const r = await research(crm);
    await outreachRun(db, r);
    expect(crm.asked).toHaveLength(0);
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBeNull();
  });
  it("the new reasons have words on the server and the screen", () => {
    for (const [code, word] of [["crm_unsubscribed", "Unsubscribed in Salesforce"], ["crm_do_not_contact", "Do not contact in Salesforce"]]) {
      expect(DROP_REASONS as readonly string[]).toContain(code);
      expect(dropLabel(code)).toBe(word);
      expect(DROP_WORDS[code]).toBe(word);
    }
  });
  it("the simulated CRM flags a small fixed share and says it is connected", async () => {
    const world = loadWorld();
    const crm = simCrm(world);
    expect(crm.connected).toBe(true);
    const asks = world.people.slice(0, 800).map((p) => ({ ref: p.id, email: p.email.toLowerCase(), full_name: p.full_name, company: null, domain: null }));
    const a = await crm.personFlags!(asks), b = await simCrm(world).personFlags!(asks);
    expect(a).toEqual(b);
    const flagged = Object.values(a).filter((rs) => rs.some((r) => r.email_opt_out || r.do_not_contact)).length / asks.length;
    expect(flagged).toBeGreaterThan(0);
    expect(flagged).toBeLessThan(SIM_RATES.crm.on_file * (SIM_RATES.crm.email_opt_out + SIM_RATES.crm.do_not_contact) * 3);
  });
});

describe("each flag's effect", () => {
  it("Email Opt Out drops the person before anything is paid on them", async () => {
    const l = lab();
    const r = await research(fake([rec("c1", { email: `ana@${ACME}`, email_opt_out: true })]), l);
    await outreachRun(db, r);
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBe("crm_unsubscribed");
    expect(l.calls.v1).not.toContain(`ana@${ACME}`);
  });
  it("Custom Do Not Contact drops the person with its own reason", async () => {
    const r = await research(fake([rec("c1", { email: `ana@${ACME}`, do_not_contact: true })]));
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBe("crm_do_not_contact");
  });
  it("Do Not Call keeps the person and shows on the Sheet", async () => {
    const r = await research(fake([rec("c1", { email: `ana@${ACME}`, do_not_call: true })]));
    await outreachRun(db, r);
    const p = await who(r.id, "Ana Ruiz");
    expect(p.drop_reason).toBeNull();
    expect(p.no_calls).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(db, r.id)) as never);
    const ws = wb.getWorksheet("Attendees")!;
    const column = (ws.getRow(3).values as unknown[]).indexOf("No calls");
    const nameCol = (ws.getRow(3).values as unknown[]).indexOf("Name");
    expect(column).toBeGreaterThan(0);
    const cells: Record<string, unknown> = {};
    ws.eachRow((row, n) => { if (n > 3) cells[String(row.getCell(nameCol).value)] = row.getCell(column).value; });
    expect(cells["Ana Ruiz"]).toBe("No calls");
  });
  it("a bounce later than the stored check means the check is not reused, and it is not counted as saved", async () => {
    const l = lab();
    await putVerification(db, `ana@${ACME}`, "deliverable", "verifier_one", "evt_old");
    const r = await research(fake([rec("c1", { email: `ana@${ACME}`, bounced_at: new Date(Date.now() + 60_000).toISOString() })]), l);
    await outreachRun(db, r);
    expect(l.calls.v1).toContain(`ana@${ACME}`);
    expect((await db.query("SELECT 1 FROM reuse_log WHERE event_id = $1 AND step = 'verify'", [r.id])).length).toBe(0);
    const [{ crm_bounced }] = await db.query<{ crm_bounced: Record<string, string> }>("SELECT crm_bounced FROM contacts WHERE event_id = $1 AND full_name = 'Ana Ruiz'", [r.id]);
    expect(Object.keys(crm_bounced)).toEqual([`ana@${ACME}`]);
  });
  it("a bounce older than the stored check leaves it reusable, and one under another address does not touch this one", async () => {
    const l = lab();
    await putVerification(db, `ana@${ACME}`, "deliverable", "verifier_one", "evt_old");
    const r = await research(fake([rec("c1", { email: `ana@${ACME}`, bounced_at: "2020-01-01T00:00:00Z" }), rec("c2", { email: `old@${ACME}`, name: "Ana Ruiz", at: ACME, bounced_at: new Date(Date.now() + 60_000).toISOString() })]), l);
    await outreachRun(db, r);
    expect(l.calls.v1).not.toContain(`ana@${ACME}`);
  });
  it("Account do not prospect excludes the company at the domain gates: nobody there is looked up", async () => {
    const l = lab();
    const crm = fake([], { dnp: [ACME] });
    const r = await research(crm, l);
    expect(crm.accounts.some((a) => a.domain === ACME)).toBe(true);
    const [co] = await db.query<{ list_status: string; in_research: boolean }>("SELECT list_status, in_research FROM companies WHERE event_id = $1 AND primary_domain = $2", [r.id, ACME]);
    expect(co).toEqual({ list_status: "excluded", in_research: false });
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBe("excluded_company");
    expect(await listCases(db, r.id)).toHaveLength(0);
    await outreachRun(db, r);
    expect(l.calls.v1).toEqual([]);
  });
  it("is not asked about accounts at the run start of a two-card event", async () => {
    const seen: string[] = [];
    const crm = fake([], { down: (kind) => { seen.push(kind); return false; } });
    await research(crm);
    expect(seen[0]).toBe("people");
    expect(crm.accounts.every((a) => a.domain)).toBe(true);
  });
});

describe("matching", () => {
  it("any flagged record flags the person", async () => {
    const r = await research(fake([rec("clean", { email: `ana@${ACME}` }), rec("lead", { object: "Lead", email: `ana@${ACME}`, do_not_contact: true })]));
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBe("crm_do_not_contact");
  });
  it("a Contact opted out under another address is caught by name at the account, even when an address exists", async () => {
    const crm = fake([rec("c1", { email: `other@${ACME}`, name: "Ana Ruiz", at: "Acme Cloud", email_opt_out: true })]);
    const r = await research(crm);
    expect(crm.asked.find((q) => q.email === `ana@${ACME}`)?.full_name).toBe("Ana Ruiz");
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBe("crm_unsubscribed");
  });
  it("someone with no address is matched by name at the account", async () => {
    const r = await research(fake([rec("c1", { email: "x@y.example", name: "Bo Lee", at: "Acme Cloud", email_opt_out: true })]));
    expect((await who(r.id, "Bo Lee")).drop_reason).toBe("crm_unsubscribed");
  });
  it("checks an address newly found, before a verifier is paid", async () => {
    const l = lab({ match: { "Bo Lee": `bo@${ACME}` } });
    const r = await research(fake([rec("c1", { email: `bo@${ACME}`, email_opt_out: true })]), l);
    await outreachRun(db, r);
    expect((await who(r.id, "Bo Lee")).drop_reason).toBe("crm_unsubscribed");
    expect(l.calls.v1).not.toContain(`bo@${ACME}`);
  });
  it("a bounce on a newly found address sets aside the stored check on it", async () => {
    const l = lab({ match: { "Bo Lee": `bo@${ACME}` } });
    await putVerification(db, `bo@${ACME}`, "deliverable", "verifier_one", "evt_old");
    const r = await research(fake([rec("c1", { email: `bo@${ACME}`, bounced_at: new Date(Date.now() + 60_000).toISOString() })]), l);
    await outreachRun(db, r);
    expect(l.calls.v1).toContain(`bo@${ACME}`);
  });
});

describe("a CRM that cannot answer really pauses, and resuming repeats no paid work", () => {
  it("at the run start: nothing has been queued or paid, and it asks again on resume", async () => {
    let bad = true;
    const crm = fake([rec("c1", { email: `ana@${ACME}`, email_opt_out: true })], { down: () => bad });
    const r = await research(crm);
    expect(await stage(r.id)).toBe("paused");
    expect(await credits(r.id)).toBe(0);
    const [e] = await db.query<{ research_started: boolean; crm_start_checked: boolean }>("SELECT research_started, crm_start_checked FROM events WHERE id = $1", [r.id]);
    expect(e).toEqual({ research_started: false, crm_start_checked: false });
    expect((await db.query("SELECT 1 FROM jobs WHERE event_id = $1", [r.id])).length).toBe(0);
    bad = false;
    await resume(r);
    expect(await stage(r.id)).toBe("ready_for_review");
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBe("crm_unsubscribed");
  });
  it("an answer missing a person counts as no answer", async () => {
    const r = await research(fake([], { partial: true }));
    expect(await stage(r.id)).toBe("paused");
  });
  it("at the domain gates: the run pauses, and the research already paid is not repeated", async () => {
    let bad = true;
    const crm = fake([], { dnp: [ACME], down: (kind) => kind === "accounts" && bad });
    const r = await research(crm);
    expect(await stage(r.id)).toBe("paused");
    const [{ phase }] = await db.query<{ phase: string | null }>("SELECT phase FROM events WHERE id = $1", [r.id]);
    expect(phase).toBe("identity");
    const before = await credits(r.id);
    bad = false;
    await resume(r);
    expect(await stage(r.id)).toBe("ready_for_review");
    expect(await credits(r.id)).toBe(before);
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBe("excluded_company");
  });
  it("in the email loop: paid calls already made are not made again", async () => {
    let bad = true;
    const l = lab({ match: { "Bo Lee": `bo@${ACME}` } });
    const crm = fake([], { down: (kind, qs) => kind === "people" && bad && (qs as CrmPersonQuery[]).some((q) => q.email === `bo@${ACME}`) });
    const r = await research(crm, l);
    await outreachRun(db, r);
    expect(await stage(r.id)).toBe("paused");
    expect(l.calls.find).toEqual(["Bo Lee"]);
    expect(l.calls.v1).not.toContain(`bo@${ACME}`);
    expect((await who(r.id, "Bo Lee")).drop_reason).toBeNull();
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE event_id = $1 AND status = 'queued'", [r.id]);
    expect(n).toBeGreaterThan(0);
    const spent = await credits(r.id);
    bad = false;
    await resume(r);
    expect(await stage(r.id)).toBe("delivered");
    expect(l.calls.find).toEqual(["Bo Lee"]);
    expect(l.calls.v1.filter((e) => e === `bo@${ACME}`)).toHaveLength(1);
    expect(await credits(r.id)).toBeGreaterThanOrEqual(spent);
    expect((await who(r.id, "Bo Lee")).email).toBe(`bo@${ACME}`);
  });
  it("before delivery: nothing is delivered, no case is opened, and the model is not asked again", async () => {
    let bad = false;
    const crm = fake([], { down: async () => bad && (await stage(r0.id)) === "flagging" });
    const csv = HEAD + row("Acme Cloud", ACME, "Ana Ruiz").replace(`ana@${ACME}`, `zed@${ACME}`);
    const r0 = await research(crm, lab(), csv);
    bad = true;
    await outreachRun(db, r0);
    expect(await stage(r0.id)).toBe("paused");
    const [e] = await db.query<{ paused_from: string; crm_final_checked: boolean }>("SELECT paused_from, crm_final_checked FROM events WHERE id = $1", [r0.id]);
    expect(e).toEqual({ paused_from: "flagging", crm_final_checked: false });
    expect((await listCases(db, r0.id)).filter((k) => k.kind === "name_email_mismatch")).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM crm_outbox")).length).toBe(0);
    const calls = (await db.query("SELECT 1 FROM llm_calls WHERE event_id = $1 AND step = 'review'", [r0.id])).length;
    bad = false;
    await resume(r0);
    expect(await stage(r0.id)).toBe("delivered");
    expect((await db.query("SELECT 1 FROM llm_calls WHERE event_id = $1 AND step = 'review'", [r0.id])).length).toBe(calls);
    expect((await listCases(db, r0.id)).filter((k) => k.kind === "name_email_mismatch")).toHaveLength(1);
  });
  it("the pause says the CRM did not answer, and does not name Salesforce", async () => {
    const r = await research(fake([], { down: () => true }));
    const [a] = await db.query<{ detail: string }>("SELECT detail FROM activity_log WHERE event_id = $1 ORDER BY created_at DESC, id LIMIT 1", [r.id]);
    expect(a.detail).toBe("The CRM did not answer");
  });
});

describe("no override, and never delivered", () => {
  /** Flagged only once the event reaches the last stage, so it is the check before delivery that catches them. */
  const lateFlag = (name: string, email: string) => {
    let flagged = false;
    const held = rec("c1", { email, name });
    const crm = fake([held], { down: async () => { held.email_opt_out = flagged; return false; } });
    return { crm, arm: () => { flagged = true; } };
  };
  it("someone flagged only at the last check is off the list, opens no case, and is not on Review", async () => {
    const email = `zed@${ACME}`;
    const { crm, arm } = lateFlag("Ana Ruiz", email);
    const armed = { ...crm, async personFlags(p: CrmPersonQuery[]) { if ((await db.query("SELECT 1 FROM events WHERE stage = 'flagging'")).length) arm(); return crm.personFlags!(p); } };
    const csv = HEAD + row("Acme Cloud", ACME, "Ana Ruiz").replace(`ana@${ACME}`, email);
    const r = await research(armed, lab(), csv);
    await outreachRun(db, r);
    expect(await stage(r.id)).toBe("delivered");
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBe("crm_unsubscribed");
    expect(await listCases(db, r.id)).toHaveLength(0);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(db, r.id)) as never);
    for (const tab of ["Attendees", "Review"]) {
      const text: string[] = [];
      wb.getWorksheet(tab)?.eachRow((row) => text.push(JSON.stringify(row.values)));
      expect(text.join(" ")).not.toContain("Ana Ruiz");
    }
    expect((await db.query("SELECT 1 FROM crm_outbox")).length).toBe(0);
  });
  it("cannot be kept through a case or the review route", async () => {
    const r = await research(fake([rec("c1", { email: `ana@${ACME}`, email_opt_out: true })]));
    await outreachRun(db, r);
    const p = await who(r.id, "Ana Ruiz");
    expect(p.drop_reason).toBe("crm_unsubscribed");
    expect((await listCases(db, r.id)).filter((k) => k.contact_id === p.id)).toHaveLength(0);
    const res = await createApp(db, { demo: true }).request(`/api/events/${r.id}/contacts/${p.id}/review`, { method: "POST", headers: { "content-type": "application/json", "x-actor": DAN }, body: JSON.stringify({ decision: "keep" }) });
    expect(res.status).toBe(409);
    await db.query("INSERT INTO review_cases (id, event_id, kind, contact_id, blocking, summary, facts, payload, suggested, options) VALUES ('case_x', $1, 'model_flag', $2, false, 's', '[]', '{}', 'keep', '[{\"value\":\"keep\",\"label\":\"k\",\"effect\":\"e\"}]')", [r.id, p.id]);
    await answerCase(db, r.id, "case_x", DAN, "keep");
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBe("crm_unsubscribed");
  });
  it("a flagged parent raises no case for its subsidiary", async () => {
    const out = await import("../src/server/identity.ts");
    expect(typeof out.finishIdentity).toBe("function");
    const crm = fake([], { dnp: [HARBOR] });
    const csv = HEAD + row("Harbor Logistics", HARBOR, "Cy Ng") + row("Harbor Sub", "harborsub.example", "Di Oz");
    const r = await research(crm, lab(), csv, { specs: { ...specs, "harborsub.example": { search: soft } } });
    await db.query("UPDATE companies SET parent_domain = $2, parent_name = 'Harbor Logistics' WHERE event_id = $1 AND primary_domain = 'harborsub.example'", [r.id, HARBOR]);
    await db.query("UPDATE events SET phase = 'identity' WHERE id = $1", [r.id]);
    const { finishIdentity } = out;
    await finishIdentity(db, r.id, JSON.parse(readFileSync("config/defaults.json", "utf8")), crm);
    expect((await listCases(db, r.id)).filter((k) => k.kind === "subsidiary_inheritance")).toHaveLength(0);
  });
});

describe("preSendCheck", () => {
  it("blocks a flagged, dropped or locally opted-out person, changes no row, and is wired to nothing", async () => {
    const r = await research(fake([]));
    await outreachRun(db, r);
    const ana = await who(r.id, "Ana Ruiz");
    const crm = fake([rec("c1", { email: `ana@${ACME}`, do_not_contact: true })]);
    const a = await preSendCheck(db, [ana.id, "con_none"], crm);
    expect(a.send).toEqual([]);
    expect(a.blocked).toEqual(expect.arrayContaining([{ id: ana.id, reason: "crm_do_not_contact" }, { id: "con_none", reason: "not_found" }]));
    expect((await who(r.id, "Ana Ruiz")).drop_reason).toBeNull();
    expect((await preSendCheck(db, [ana.id], fake([]))).send).toEqual([ana.id]);
    expect((await preSendCheck(db, [ana.id], noCrm)).send).toEqual([ana.id]);
    await recordOptOut(db, DAN, { email: `ana@${ACME}` });
    expect((await preSendCheck(db, [ana.id], fake([]))).blocked[0].reason).toBe("opted_out");
    for (const f of ["pipeline", "email", "identity", "app"]) expect(readFileSync(`src/server/${f}.ts`, "utf8")).not.toContain("preSendCheck");
  });
  it("fails closed", async () => {
    const r = await research(fake([]));
    const ana = await who(r.id, "Ana Ruiz");
    await expect(preSendCheck(db, [ana.id], fake([], { down: () => true }))).rejects.toBeInstanceOf(CrmDown);
  });
});

describe("the single-card flow", () => {
  const SINGLE = "Company Name,First Name,Last Name,Job Title,Work Email\nAcme Cloud,Ana,Ruiz,VP Sales,ana@acmecloud.example\nAcme Cloud,Bo,Lee,VP Sales,\n";
  const singleLab = () => { const l = lab({ match: { "Bo Lee": `bo@${ACME}` } }); return { ...l, vendorsFor: (s: Settings) => l.tweak((require_mock(s)), s) }; };
  let require_mock: (s: Settings) => Vendors;
  beforeEach(async () => { require_mock = (await import("../src/server/providers.ts")).mockVendors; });
  const single = (crm: Crm | undefined, l = singleLab()) => deliverEvent(db, SINGLE, { crm, vendorsFor: l.vendorsFor }, "S", "single_card");

  it("matches the account by name, having no domains", async () => {
    const crm = fake([], { dnp: ["Acme Cloud"] });
    const l = singleLab();
    const id = await single(crm, l);
    expect(crm.accounts.some((a) => a.name === "Acme Cloud" && a.domain === null)).toBe(true);
    expect((await who(id, "Ana Ruiz")).drop_reason).toBe("excluded_company");
    expect(l.calls.v1).toEqual([]);
  });
  it("drops at find and verify on a CRM flag that appears after the run start", async () => {
    const held = rec("c1", { email: `bo@${ACME}`, email_opt_out: true });
    const l = singleLab();
    const crm = fake([held, rec("c2", { name: "Ana Ruiz", at: "Acme Cloud" })]);
    const id = await single(crm, l);
    expect((await who(id, "Bo Lee")).drop_reason).toBe("crm_unsubscribed");
    expect(l.calls.v1).not.toContain(`bo@${ACME}`);
  });
  it("drops on a local opt-out recorded mid-run, in find and in verify", async () => {
    await recordOptOut(db, DAN, { name: "Bo Lee", company: "Acme Cloud" });
    await recordOptOut(db, DAN, { email: `ana@${ACME}` });
    const l = singleLab();
    const id = await single(undefined, l);
    expect((await who(id, "Bo Lee")).drop_reason).toBe("opted_out");
    expect((await who(id, "Ana Ruiz")).drop_reason).toBe("opted_out");
    expect(l.calls.find).toEqual([]);
    expect(l.calls.v1).toEqual([]);
  });
  it("pauses in a job when the CRM fails there, and resumes without paying again", async () => {
    let bad = false;
    const l = singleLab();
    const crm = fake([], { down: (_k, qs) => bad && (qs as CrmPersonQuery[]).some((q) => q.email === `ana@${ACME}` || q.full_name === "Bo Lee") });
    const trigger = { ...crm, async personFlags(p: CrmPersonQuery[]) { if ((await db.query("SELECT 1 FROM jobs WHERE event_id = (SELECT id FROM events WHERE name = 'S') AND kind IN ('find', 'verify')")).length) bad = true; return crm.personFlags!(p); } };
    const id = await single(trigger, l);
    expect(await stage(id)).toBe("paused");
    expect(l.calls.v1).toEqual([]);
    expect(l.calls.find).toEqual([]);
    bad = false;
    const deps = { crm, llm: (await import("../src/server/providers.ts")).mockLlm, vendorsFor: l.vendorsFor };
    await moveEvent(db, id, "enriching", DAN);
    await (await import("../src/server/pipeline.ts")).processEvent(db, id, deps);
    expect(await stage(id)).toBe("delivered");
    expect(l.calls.v1.filter((e) => e === `ana@${ACME}`)).toHaveLength(1);
  });
});

describe("one record per person", () => {
  const CO = (rows: string) => "Company Name,First Name,Last Name,Job Title,Work Email,LinkedIn\n" + rows;
  const upload = async (csv: string, name = "E") => {
    const { createEvent } = await import("../src/server/events.ts");
    const { decideApproval } = await import("../src/server/approvals.ts");
    const { ingestUpload } = await import("../src/server/uploads.ts");
    const id = (await createEvent(db, MAYA, { name, starts_on: "2027-03-30", seat_count: 1, seat_price_cents: 100, flow: "two_card" })).id;
    const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]);
    await decideApproval(db, { approvalId: a.id, actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", csv);
    return id;
  };
  const people = () => db.query<{ id: string; email: string | null; linkedin: string | null }>("SELECT id, email, linkedin FROM people ORDER BY first_seen, id");
  const LI = "https://www.linkedin.com/in/ana-ruiz", LI2 = "https://www.linkedin.com/in/bo-lee";

  it("links at upload and finds the same person at a second event by address", async () => {
    const a = await upload(CO(`Acme,Ana,Ruiz,VP,ana@acme.example,\n`), "One");
    const b = await upload(CO(`Acme,Ana,Ruiz,VP,ana@acme.example,\n`), "Two");
    expect(await people()).toHaveLength(1);
    expect((await who(a, "Ana Ruiz")).person_id).toBe((await who(b, "Ana Ruiz")).person_id);
    const res = await createApp(db, { demo: true }).request(`/api/events/${b}/people`);
    const j = await res.json() as { rows: { seen_at: number; last_verified_at: string | null }[] };
    expect(j.rows[0].seen_at).toBe(2);
    expect(j.rows[0].last_verified_at).toBeNull();
  });
  it("a name alone never links or makes a record", async () => {
    await upload(CO(`Acme,Ana,Ruiz,VP,,\n`), "One");
    const b = await upload(CO(`Acme,Ana,Ruiz,VP,,\n`), "Two");
    expect(await people()).toHaveLength(0);
    expect((await who(b, "Ana Ruiz")).person_id).toBeNull();
  });
  it("a role address never links, whoever registers with it", async () => {
    await upload(CO(`Acme,Ana,Ruiz,VP,sales@acme.example,\n`), "One");
    const b = await upload(CO(`Acme,Ana,Ruiz,VP,sales@acme.example,\n`), "Two");
    expect(await people()).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM person_emails")).length).toBe(0);
    expect((await who(b, "Ana Ruiz")).person_id).toBeNull();
  });
  it("a role address does not stop a LinkedIn profile from linking", async () => {
    await upload(CO(`Acme,Ana,Ruiz,VP,sales@acme.example,${LI}\n`), "One");
    await upload(CO(`Acme,Ana,Ruiz,VP,info@acme.example,${LI}\n`), "Two");
    const p = await people();
    expect(p).toHaveLength(1);
    expect(p[0].email).toBeNull();
  });
  it("a shared address never links two different people, and is taken back when found late", async () => {
    await upload(CO(`Acme,Ana,Ruiz,VP,team1@acme.example,\n`), "One");
    expect(await people()).toHaveLength(1);
    const b = await upload(CO(`Acme,Bo,Lee,VP,team1@acme.example,\n`), "Two");
    expect((await who(b, "Bo Lee")).person_id).toBeNull();
    expect((await db.query("SELECT 1 FROM person_emails WHERE email = 'team1@acme.example'")).length).toBe(0);
  });
  it("an initial or a middle name is not a shared address", async () => {
    await upload(CO(`Acme,Ana,Ruiz,VP,ana@acme.example,\n`), "One");
    const b = await upload(CO(`Acme,A,Ruiz,VP,ana@acme.example,\n`), "Two");
    expect((await who(b, "A Ruiz")).person_id).not.toBeNull();
    expect(await people()).toHaveLength(1);
  });
  it("two rows found to be one are merged into the older, and everything repoints", async () => {
    const a = await upload(CO(`Acme,Ana,Ruiz,VP,ana@acme.example,\n`), "One");
    await db.query("UPDATE people SET first_seen = now() - interval '10 days'");
    const b = await upload(CO(`Acme,Ana,Ruiz,VP,,${LI}\n`), "Two");
    const [older, newer] = await people();
    expect(newer).toBeDefined();
    await db.query("INSERT INTO crm_outbox (id, person_id, kind, payload) VALUES ('o1', $1, 'email', '{}')", [newer.id]);
    const c = await upload(CO(`Acme,Ana,Ruiz,VP,ana@acme.example,${LI}\n`), "Three");
    const after = await people();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: older.id, email: "ana@acme.example", linkedin: LI });
    for (const e of [a, b, c]) expect((await who(e, "Ana Ruiz")).person_id).toBe(older.id);
    expect((await db.query<{ person_id: string }>("SELECT person_id FROM crm_outbox WHERE id = 'o1'"))[0].person_id).toBe(older.id);
  });
  it("keeps the address history, so an old address still finds the person", async () => {
    await upload(CO(`Acme,Ana,Ruiz,VP,ana@acme.example,${LI}\n`), "One");
    await upload(CO(`Newco,Ana,Ruiz,VP,ana@newco.example,${LI}\n`), "Two");
    const p = await people();
    expect(p).toHaveLength(1);
    expect(p[0].email).toBe("ana@newco.example");
    expect((await db.query("SELECT 1 FROM person_emails WHERE person_id = $1", [p[0].id])).length).toBe(2);
    await upload(CO(`Acme,Ana,Ruiz,VP,ana@acme.example,\n`), "Three");
    expect(await people()).toHaveLength(1);
  });
  it("a vendor id means nothing without its vendor", async () => {
    const a = await upload(CO(`Acme,Ana,Ruiz,VP,,\n`), "One");
    const b = await upload(CO(`Acme,Bo,Lee,VP,,\n`), "Two");
    await db.query("UPDATE contacts SET vendor_person_id = 'v1'");
    const ca = await who(a, "Ana Ruiz"), cb = await who(b, "Bo Lee");
    await db.tx((q) => linkContact(q, ca.id));
    expect(await people()).toHaveLength(0);
    await db.tx((q) => linkContact(q, ca.id, { vendor: "apollo" }));
    await db.tx((q) => linkContact(q, cb.id, { vendor: "other" }));
    expect(await people()).toHaveLength(2);
    const c2 = await upload(CO(`Acme,Di,Oz,VP,,\n`), "Three");
    await db.query("UPDATE contacts SET vendor_person_id = 'v1' WHERE event_id = $1", [c2]);
    const di = (await who(c2, "Di Oz")).id;
    await db.tx((q) => linkContact(q, di, { vendor: "apollo" }));
    expect((await who(c2, "Di Oz")).person_id).toBe((await who(a, "Ana Ruiz")).person_id);
  });
  it("marks last verified when an address passes, and links what the run learns", async () => {
    const r = await research(fake([]));
    await outreachRun(db, r);
    const ana = await who(r.id, "Ana Ruiz");
    const [p] = await db.query<{ last_verified_at: string | null }>("SELECT last_verified_at FROM people WHERE id = $1", [ana.person_id]);
    expect(p.last_verified_at).toBeTruthy();
  });
  it("deleting an event removes people left with nobody, cancels what was waiting about them, and keeps opt-outs and anyone still seen elsewhere", async () => {
    const a = await upload(CO(`Acme,Ana,Ruiz,VP,ana@acme.example,\nAcme,Bo,Lee,VP,bo@acme.example,\n`), "One");
    await upload(CO(`Acme,Bo,Lee,VP,bo@acme.example,\n`), "Two");
    const ana = (await who(a, "Ana Ruiz")).person_id!, bo = (await who(a, "Bo Lee")).person_id!;
    await db.query("INSERT INTO crm_outbox (id, person_id, kind, payload) VALUES ('oa', $1, 'email', '{}'), ('ob', $2, 'email', '{}'), ('oc', NULL, 'opt_out', '{}')", [ana, bo]);
    await deleteEvent(db, DAN, a);
    expect((await people()).map((p) => p.id)).toEqual([bo]);
    expect((await db.query("SELECT 1 FROM person_emails WHERE person_id = $1", [ana])).length).toBe(0);
    const rows = Object.fromEntries((await db.query<{ id: string; status: string; person_id: string | null }>("SELECT id, status, person_id FROM crm_outbox")).map((r) => [r.id, r]));
    expect(rows.oa).toMatchObject({ status: "cancelled", person_id: null });
    expect(rows.ob).toMatchObject({ status: "queued", person_id: bo });
    expect(rows.oc).toMatchObject({ status: "queued", person_id: null });
  });
  it("replacing a list takes people who were only on it", async () => {
    const a = await upload(CO(`Acme,Ana,Ruiz,VP,ana@acme.example,\n`), "One");
    const { ingestUpload } = await import("../src/server/uploads.ts");
    await ingestUpload(db, a, MAYA, "b.csv", CO(`Acme,Bo,Lee,VP,bo@acme.example,\n`));
    expect((await people()).map((p) => p.email)).toEqual(["bo@acme.example"]);
  });
  it("a run's priorities and kept people are unchanged by the people table, even when it is broken", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const shape = async (d: Db, id: string) => d.query("SELECT full_name, priority, drop_reason, email, verify_1, verify_2 FROM contacts WHERE event_id = $1 ORDER BY full_name", [id]);
    const run1 = await research(fake([]));
    await outreachRun(db, run1);
    const a = await shape(db, run1.id);
    expect((await people()).length).toBeGreaterThan(0);
    const d2 = await freshDb();
    await d2.query("DROP TABLE person_emails, people CASCADE");
    const save = db; db = d2;
    const run2 = await research(fake([]));
    await outreachRun(db, run2);
    expect(await stage(run2.id)).toBe("delivered");
    expect(await shape(db, run2.id)).toEqual(a);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
    db = save;
  });
});

describe("writing back", () => {
  const delivered = async (crm: Crm, l = lab({ wf: { "Bo Lee": { email: `bo@${ACME}`, apollo_verified: true, zerobounce_pass: true, credits: 2 } } })) => { const r = await research(crm, l); await outreachRun(db, r); return r; };
  const out = () => db.query<{ kind: string; status: string; attempts: number; person_id: string | null; payload: Record<string, string> }>("SELECT kind, status, attempts, person_id, payload FROM crm_outbox ORDER BY created_at, id");

  it("queues one row per kept person with an address checked twice, and none for someone checked once", async () => {
    const crm = fake([]);
    await delivered(crm);
    const rows = await out();
    expect(rows.map((r) => r.payload.email)).toEqual([`bo@${ACME}`]);
    expect(rows[0].person_id).not.toBeNull();
  });
  it("a run never writes: the sweep does", async () => {
    const crm = fake([rec("l1", { object: "Lead", name: "Bo Lee", at: ACME })]);
    await delivered(crm);
    expect(crm.writes).toHaveLength(0);
    await drainOutbox(db, crm);
    expect(crm.writes).toEqual([{ id: "l1", patch: { email: `bo@${ACME}` } }]);
    expect((await out())[0]).toMatchObject({ status: "done", attempts: 1 });
  });
  it("fills blanks only, on every matching record, and creates nothing", async () => {
    const crm = fake([rec("blank1", { name: "Bo Lee", at: ACME }), rec("blank2", { object: "Lead", name: "Bo Lee", at: ACME }), rec("other", { email: `bee@${ACME}`, name: "Bo Lee", at: ACME })]);
    await delivered(crm);
    await drainOutbox(db, crm);
    expect(crm.writes.map((w) => w.id).sort()).toEqual(["blank1", "blank2"]);
    expect(crm.records.find((r) => r.id === "other")!.email).toBe(`bee@${ACME}`);
    await db.query("UPDATE crm_outbox SET status = 'queued'");
    await drainOutbox(db, crm);
    expect(crm.writes).toHaveLength(2);
  });
  it("a row with no matching record is closed and nothing is created", async () => {
    const crm = fake([]);
    await delivered(crm);
    expect((await drainOutbox(db, crm)).none).toBe(1);
    expect(crm.writes).toEqual([]);
    expect((await out())[0].status).toBe("done");
  });
  it("an opt-out sets the checkbox, the one exception, keyed by address and not by person", async () => {
    const crm = fake([rec("a", { email: `ana@${ACME}` }), rec("b", { email: `ana@${ACME}`, email_opt_out: true })]);
    const app = createApp(db, { demo: true, crm });
    const res = await app.request("/api/suppressions", { method: "POST", headers: { "content-type": "application/json", "x-actor": DAN }, body: JSON.stringify({ email: `ana@${ACME}` }) });
    expect(res.status).toBe(201);
    const [row] = await out();
    expect(row).toMatchObject({ kind: "opt_out", person_id: null });
    expect(row.payload.email).toBe(`ana@${ACME}`);
    await drainOutbox(db, crm);
    expect(crm.writes).toEqual([{ id: "a", patch: { email_opt_out: true } }]);
  });
  it("an opt-out by name at a company finds records by name", async () => {
    const crm = fake([rec("a", { name: "Bo Lee", at: "Acme Cloud", email: `x@${ACME}` })]);
    await recordOptOut(db, DAN, { name: "Bo Lee", company: "Acme Cloud" }, crm);
    await drainOutbox(db, crm);
    expect(crm.writes).toEqual([{ id: "a", patch: { email_opt_out: true } }]);
  });
  it("queues nothing for a CRM that cannot write", async () => {
    const { write: _w, ...readOnly } = fake([]);
    await delivered(readOnly as Crm);
    await recordOptOut(db, DAN, { email: `z@${ACME}` }, readOnly as Crm);
    expect(await out()).toEqual([]);
    await recordOptOut(db, DAN, { email: `y@${ACME}` }, noCrm);
    expect(await out()).toEqual([]);
  });
  it("a write failure does not touch the delivery, is retried, and stops at the cap", async () => {
    const crm = fake([rec("l1", { name: "Bo Lee", at: ACME })], { writeFails: () => true });
    const r = await delivered(crm);
    expect(await stage(r.id)).toBe("delivered");
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) await drainOutbox(db, crm);
    expect((await out())[0]).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(await stage(r.id)).toBe("delivered");
    expect((await who(r.id, "Bo Lee")).drop_reason).toBeNull();
  });
  it("a CRM that cannot answer the sweep leaves the row queued for the next one", async () => {
    let bad = false;
    const crm = fake([], { down: () => bad });
    await delivered(crm);
    bad = true;
    expect((await drainOutbox(db, crm)).failed).toBe(1);
    expect((await out())[0]).toMatchObject({ status: "queued", attempts: 1 });
    bad = false;
    expect((await drainOutbox(db, crm)).sent).toBe(1);
  });
  it("is drained from the sweep started at boot and never from a run", () => {
    expect(readFileSync("src/server/pipeline.ts", "utf8")).not.toContain("drainOutbox");
    expect(readFileSync("src/server/pipeline.ts", "utf8")).not.toContain("drainQuietly");
    expect(readFileSync("src/server/node.ts", "utf8")).toContain("drainQuietly");
    expect(readFileSync("src/server/node.ts", "utf8")).toMatch(/crm: noCrm/);
  });
});

