/* The scanner's server side (docs/SCANNER.md 7, 11 and 14): the same id twice is one scan, the dedupe order, near matches and their review, consent, the hand-over, badge ids and the organizer,
   photos that resume, the counted read, who reads what, the CSV, and erasure. */

import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import type { LifecycleDeps } from "../src/server/lifecycle-deps.ts";
import { drainNotifications, forgetPerson } from "../src/server/operating.ts";
import { fakeOrganizer } from "../src/server/organizer-api.ts";
import { mockLlm, type Llm } from "../src/server/providers.ts";
import { advance, checkRead, confirmScan, ingestScan, listScans, putPhotoChunk, putSettings, readPhoto, resolvePending, resolveReview, scansCsv, ScanForeign, ScanForbidden, type ScanInput } from "../src/server/scans.ts";
import { fakeCrm } from "./lifecycle-harness.ts";
import { freshDb } from "./helpers.ts";
import { hostedDinner } from "./hosted-helpers.ts";
import { CAMILLE } from "./plan-helpers.ts";

const NOW = new Date("2027-06-10T22:00:00Z");
const crm = { ...fakeCrm({ owner: "Dana Owner" }), write: async () => ({ id: "x" }) } as never;
const deps = (over: Partial<LifecycleDeps> = {}): LifecycleDeps => ({ connectors: {}, llm: mockLlm, now: () => NOW, crm, userMap: { "Maya Ortiz": "UMAYA", "Dana Owner": "UDANA" }, ...over } as never);
const MAYA = "Maya Ortiz", LEO = "Leo Marsh";
let db: Db, ev: string, n = 0;
const sid = () => `scan-${Date.now().toString(36)}-${++n}-aaaa`;
const vcard = (name: string, email: string, company = "Orrery", title = "Head of Payments") => `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nORG:${company}\nTITLE:${title}\nEMAIL:${email}\nEND:VCARD`;
const code = (name: string, email: string, over: Partial<ScanInput> = {}, company = "Orrery"): ScanInput => ({ id: sid(), method: "badge_code", raw_payload: vcard(name, email, company), ...over });
const scan = (input: ScanInput, rep = MAYA, ext = {}, d = deps()) => ingestScan(db, d, ev, rep, input, ext);
const row = async (id: string) => (await db.query<any>("SELECT * FROM scans WHERE id = $1", [id]))[0];
const count = async (t: string, where = "TRUE") => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE ${where}`))[0].n;

beforeAll(async () => { db = await freshDb(); ev = await hostedDinner(db); });

describe("the same id twice", () => {
  it("is one scan, one person and one capture; the answer says it is a repeat", async () => {
    const input = code("Ana Lima", "ana.lima@orrery.example");
    const a = await scan(input), b = await scan(input);
    expect(a.repeat).toBe(false);
    expect(b.repeat).toBe(true);
    expect(b.person?.id).toBe(a.person?.id);
    expect(await count("scans", `id = '${input.id}'`)).toBe(1);
    expect(await count("onsite_captures", `contact_id = '${a.person!.id}'`)).toBe(1);
  });
  it("refuses another rep's repeat of the id instead of handing back the stored result", async () => {
    const input = code("Ben Ode", "ben.ode@orrery.example");
    await scan(input);
    await expect(scan(input, LEO)).rejects.toBeInstanceOf(ScanForeign);
  });
  it("is the same scan over HTTP, and a rep who is not the scanner cannot read its photo", async () => {
    const app = createApp(db, { demo: true, lifecycle: deps() });
    const h = (who: string) => ({ "x-actor": encodeURIComponent(who), "content-type": "application/json" });
    const input = code("Cleo Park", "cleo.park@orrery.example");
    const r1 = await app.request(`/api/events/${ev}/scans`, { method: "POST", headers: h(MAYA), body: JSON.stringify(input) });
    const r2 = await app.request(`/api/events/${ev}/scans`, { method: "POST", headers: h(MAYA), body: JSON.stringify(input) });
    expect(r1.status).toBe(201);
    expect((await r2.json() as any).repeat).toBe(true);
    expect(await count("scans", `id = '${input.id}'`)).toBe(1);
    expect((await app.request(`/api/events/${ev}/scans`, { method: "POST", headers: h(LEO), body: JSON.stringify(input) })).status).toBe(409);
    expect((await app.request(`/api/scans/${input.id}/photo?status`, { headers: h(LEO) })).status).toBe(403);
  });
});

describe("a badge code with contact data", () => {
  it("places the person offline-decoded, as a badge scan with a task for the scanning rep, and stores consent off with the wording shown", async () => {
    const input = code("Dan Ito", "dan.ito@orrery.example", { note: "Asked about payouts", marketing_consent: false });
    const r = await scan(input);
    expect(r.state).toBe("placed");
    const s = await row(input.id);
    expect(s).toMatchObject({ method: "badge_code", marketing_consent: false, consent_notice_version: 1, rep: MAYA, state: "placed" });
    expect(s.consent_wording).toMatch(/follow up on our conversation/);
    expect(await db.query("SELECT 1 FROM onsite_captures WHERE id = $1 AND source = 'badge_scan' AND rep = $2", [s.capture_id, MAYA])).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'task' AND desk_key = $1 AND payload->>'owner' = $2", [`scan:${s.capture_id}`, MAYA])).toHaveLength(1);
    expect((await db.query<any>("SELECT marketing_consent FROM contacts WHERE id = $1", [r.person!.id]))[0].marketing_consent).toBe(false);
  });
  it("when the person says yes, the answer, the notice version, the time and the source are on the scan and the person", async () => {
    const input = code("Eli Voss", "eli.voss@orrery.example", { marketing_consent: true });
    const r = await scan(input);
    const s = await row(input.id);
    expect(s.marketing_consent).toBe(true);
    expect(s.consent_at).not.toBeNull();
    const [k] = await db.query<any>("SELECT marketing_consent, consent_note FROM contacts WHERE id = $1", [r.person!.id]);
    expect(k.marketing_consent).toBe(true);
    expect(k.consent_note).toMatch(/Scanner, notice version 1/);
  });
  it("a card or typed scan is a conversation: it gets the follow-up task too, and a scan with no email gets no CRM task", async () => {
    const typed = { id: sid(), method: "typed" as const, fields: { name: "Fay Nunez", company: "Orrery", email: "fay.nunez@orrery.example" } };
    await scan(typed);
    const s = await row(typed.id);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE desk_key = $1 AND payload->>'subject' LIKE 'Follow up%'", [`scan:${s.capture_id}`])).toHaveLength(1);
    const noEmail = { id: sid(), method: "typed" as const, fields: { name: "Gil Moss", company: "Orrery" } };
    await scan(noEmail);
    const g = await row(noEmail.id);
    expect(g.state).toBe("placed");
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE desk_key = $1", [`scan:${g.capture_id}`])).toHaveLength(0);
  });
  it("hot goes to the rep the same day: a task and a card that names the account owner when there is one", async () => {
    const input = code("Hana Reed", "hana.reed@orrery.example", { temperature: "hot", note: "Wants a quote this week" });
    const r = await scan(input);
    const s = await row(input.id);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE desk_key = $1", [`hot:${s.capture_id}`])).toHaveLength(1);
    const cards = await db.query<{ card: any; mention: string[] }>("SELECT card, mention FROM notifications WHERE event_id = $1 AND card::text LIKE '%Hana Reed%'", [ev]);
    expect(cards).toHaveLength(1);
    expect(cards[0].mention).toContain("UMAYA");
    void r; void drainNotifications;
  });
  it("a code that reads as nothing is refused, and the first scan on an event with no list gives it one called Scanner", async () => {
    await expect(scan({ id: sid(), method: "badge_code", raw_payload: "BEGIN:VCARD\nEND:VCARD" })).rejects.toThrow(/did not read/);
    expect(await db.query("SELECT 1 FROM uploads WHERE event_id = $1 AND filename = 'Scanner'", [ev])).toHaveLength(1);
  });
});

describe("what was promised", () => {
  it("goes to the promise owner as a CRM task of their own, and the rep's task carries the note, the promise and the next step", async () => {
    const input = code("Uma Reyes", "uma.reyes@orrery.example", { note: "Likes the dashboard", promise: "Send the SOC 2 report", promise_owner: LEO, next_step: "Call", next_step_on: "2027-06-14" });
    await scan(input);
    const s = await row(input.id);
    const [t] = await db.query<any>("SELECT payload FROM crm_outbox WHERE desk_key = $1", [`promise:${s.capture_id}`]);
    expect(t.payload).toMatchObject({ owner: LEO, due: "2027-06-14" });
    expect(t.payload.body).toMatch(/SOC 2 report/);
    const [r] = await db.query<any>("SELECT payload FROM crm_outbox WHERE desk_key = $1", [`scan:${s.capture_id}`]);
    expect(r.payload.body).toMatch(/Promised: Send the SOC 2 report/);
    expect(r.payload.body).toMatch(/Next step: Call by 2027-06-14/);
  });
  it("a hot card says when no account owner is known and when there is no CRM task because there is no email", async () => {
    const input = { id: sid(), method: "typed" as const, fields: { name: "Vic Hale", company: "Newco Pay" }, temperature: "hot" };
    await scan(input);
    const [c] = await db.query<any>("SELECT card FROM notifications WHERE event_id = $1 AND card::text LIKE '%Vic Hale%'", [ev]);
    expect(JSON.stringify(c.card)).toMatch(/no CRM task/);
    expect(JSON.stringify(c.card)).toMatch(/No account owner is known/);
  });
});

describe("dedupe", () => {
  it("two reps scanning one person is one person with two scans and two tasks", async () => {
    const a = code("Ivo Platt", "ivo.platt@orrery.example"), b = code("Ivo Platt", "ivo.platt@orrery.example");
    const r1 = await scan(a, MAYA), r2 = await scan(b, LEO);
    expect(r2.person!.id).toBe(r1.person!.id);
    expect(await count("scans", `contact_id = '${r1.person!.id}'`)).toBe(2);
    expect(await count("onsite_captures", `contact_id = '${r1.person!.id}'`)).toBe(2);
    expect(await count("crm_outbox", `kind = 'task' AND payload->>'email' = 'ivo.platt@orrery.example'`)).toBe(2);
  });
  it("the registrant id wins over the address, then the address over the name at the company", async () => {
    const org = fakeOrganizer({ B100: { kind: "found", registrant_id: "x", fields: { name: "Jo Quill", email: "jo.quill@orrery.example", company: "Orrery" } }, B101: { kind: "found", registrant_id: "y", fields: { name: "Jo Quill", email: "jo.q@elsewhere.example", company: "Orrery" } } });
    const first = await scan({ id: sid(), method: "badge_id", raw_payload: "B100" }, MAYA, { organizer: org });
    // Same badge code, the organizer now answers a different address: the badge is the same person.
    const second = await scan({ id: sid(), method: "badge_id", raw_payload: "B100" }, LEO, { organizer: fakeOrganizer({ B100: { kind: "found", registrant_id: "x", fields: { name: "Jo Quill", email: "jo.quill+new@orrery.example", company: "Orrery" } } }) });
    expect(second.person!.id).toBe(first.person!.id);
    // A different badge for the same address joins by address.
    const third = await scan({ id: sid(), method: "typed", fields: { email: "JO.QUILL@orrery.example" } }, MAYA);
    expect(third.person!.id).toBe(first.person!.id);
    void org;
  });
  it("a name nearly the same at the company opens a review and still places the person; same merges them, a review is answered once", async () => {
    const a = await scan(code("Robert Kline", "robert.kline@orrery.example"));
    const b = code("Rob Kline", "rob.kline@orrery.example");
    const r = await scan(b, LEO);
    expect(r.person!.id).not.toBe(a.person!.id);
    expect(r.review).toBe("open");
    const view = await listScans(db, CAMILLE, ev);
    expect(view.reviews.find((x) => x.scan_id === b.id)).toMatchObject({ near_name: "Robert Kline", rep: LEO });
    expect((await listScans(db, LEO, ev)).reviews).toEqual([]);
    await expect(resolveReview(db, LEO, b.id, "same")).rejects.toBeInstanceOf(ScanForbidden);
    await resolveReview(db, CAMILLE, b.id, "same");
    const s = await row(b.id);
    expect(s).toMatchObject({ review: "same", contact_id: a.person!.id });
    expect((await db.query<any>("SELECT drop_reason FROM contacts WHERE id = $1", [r.person!.id]))[0].drop_reason).toBe("duplicate");
    expect(await count("onsite_captures", `contact_id = '${a.person!.id}'`)).toBe(2);
    await expect(resolveReview(db, CAMILLE, b.id, "same")).rejects.toThrow(/already answered/);
  });
  it("different people closes the review and keeps both", async () => {
    await scan(code("Mia Stone", "mia.stone@orrery.example"));
    const b = code("Mina Stone", "mina.stone@orrery.example");
    const r = await scan(b);
    expect(r.review).toBe("open");
    await resolveReview(db, CAMILLE, b.id, "different");
    expect((await row(b.id)).review).toBe("different");
    expect((await db.query<any>("SELECT dropped_at FROM contacts WHERE id = $1", [r.person!.id]))[0].dropped_at).toBeNull();
  });
});

describe("badge ids and the organizer", () => {
  it("wait with no adapter, are claimed one at a time so two calls make one lookup, and place when the organizer answers", async () => {
    const input = { id: sid(), method: "badge_id" as const, raw_payload: "WAIT-1" };
    expect((await scan(input)).state).toBe("lookup_pending");
    const calls: string[] = [];
    const org = fakeOrganizer({ "WAIT-1": { kind: "found", registrant_id: "r", fields: { name: "Kit Vale", company: "Orrery", email: "kit.vale@orrery.example" } } }, { calls });
    await Promise.all([advance(db, deps(), input.id, { organizer: org }), advance(db, deps(), input.id, { organizer: org })]);
    expect(calls).toEqual(["WAIT-1"]);
    expect((await row(input.id)).state).toBe("placed");
  });
  it("a down organizer leaves the scan waiting and a later resolve places it; a retry does not make a second capture", async () => {
    const input = { id: sid(), method: "badge_id" as const, raw_payload: "DOWN-1" };
    const table = { "DOWN-1": { kind: "found" as const, registrant_id: "r2", fields: { name: "Lou Park", company: "Orrery", email: "lou.park@orrery.example" } } };
    expect((await scan(input, MAYA, { organizer: fakeOrganizer(table, { down: true }) })).state).toBe("lookup_pending");
    expect((await resolvePending(db, deps(), ev, { organizer: fakeOrganizer(table) })).tried).toBeGreaterThan(0);
    await resolvePending(db, deps(), ev, { organizer: fakeOrganizer(table) });
    const s = await row(input.id);
    expect(s.state).toBe("placed");
    expect(await count("onsite_captures", `id = '${s.capture_id}'`)).toBe(1);
  });
  it("not found and refused fail the scan with the reason in words, and place nobody", async () => {
    const a = { id: sid(), method: "badge_id" as const, raw_payload: "NOPE-1" }, b = { id: sid(), method: "badge_id" as const, raw_payload: "REF-1" };
    const org = fakeOrganizer({ "REF-1": { kind: "refused", reason: "feature_not_allowed" } });
    expect((await scan(a, MAYA, { organizer: org })).state).toBe("failed");
    const r = await scan(b, MAYA, { organizer: org });
    expect(r.state).toBe("failed");
    expect(r.state_detail).toMatch(/not turned lead lookup on/);
    expect(r.person).toBeNull();
  });
});

describe("photos", () => {
  const png = (n: number) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
  it("resume from the bytes the server holds: a chunk at the wrong offset writes nothing and says where to start", async () => {
    const input = { id: sid(), method: "card_photo" as const };
    await scan(input);
    const bytes = png(1000);
    const p = (offset: number, chunk: Uint8Array) => putPhotoChunk(db, MAYA, input.id, { offset, total: 1000, kind: "card" }, chunk);
    expect(await p(0, bytes.slice(0, 400))).toMatchObject({ received: 400, complete: false });
    expect(await p(700, bytes.slice(700))).toMatchObject({ received: 400, complete: false });
    expect(await p(0, bytes.slice(0, 400))).toMatchObject({ received: 400 });
    expect(await p(400, bytes.slice(400))).toMatchObject({ received: 1000, complete: true });
    expect((await db.query<any>("SELECT length(data) AS n FROM scan_photos WHERE scan_id = $1", [input.id]))[0].n).toBe(1000);
  });
  it("must be an image by its first bytes, and only the scanner or a planner may send one", async () => {
    const input = { id: sid(), method: "card_photo" as const };
    await scan(input);
    await expect(putPhotoChunk(db, MAYA, input.id, { offset: 0, total: 20, kind: "card" }, new TextEncoder().encode("<svg onload=x>12345"))).rejects.toThrow(/JPEG, a PNG or a WebP/);
    await expect(putPhotoChunk(db, LEO, input.id, { offset: 0, total: 8, kind: "card" }, png(8))).rejects.toBeInstanceOf(ScanForbidden);
  });
});

describe("the photo read", () => {
  const reading = (answer: unknown, opts: { throws?: boolean } = {}): Llm & { calls: number } => {
    const l: any = { model: "test-vision", calls: 0, simulated: true, complete: async () => ({ text: "", input_tokens: 0, output_tokens: 0 }),
      read: async () => { l.calls++; if (opts.throws) throw new Error("boom"); return { text: JSON.stringify(answer), input_tokens: 100, output_tokens: 50 }; } };
    return l;
  };
  const withPhoto = async (kind: "card_photo" | "badge_photo" = "card_photo", fields?: Record<string, string>) => {
    const input = { id: sid(), method: kind, ...(fields ? { fields } : {}) } as ScanInput;
    await scan(input);
    const b = new Uint8Array(500); b.set([0xff, 0xd8, 0xff, 0xe0]);
    await putPhotoChunk(db, MAYA, input.id, { offset: 0, total: 500, kind: kind === "card_photo" ? "card" : "badge" }, b);
    return input.id;
  };
  it("places the person to confirm, flags what the reader doubted, and throws away a field that is not in what it transcribed or not shaped like its kind", async () => {
    const id = await withPhoto();
    const llm = reading({ fields: { name: "Ana Marsh", company: "Orrery", email: "ana.marsh@orrery.example", title: "CFO", phone: "12" }, confidence: { name: "high", company: "high", email: "low" }, text: "Ana Marsh CFO Orrery ana.marsh@orrery.example" });
    await readPhoto(db, deps(), llm, MAYA, id);
    const s = await row(id);
    expect(s.state).toBe("to_confirm");
    expect(s.fields).toMatchObject({ name: "Ana Marsh", company: "Orrery", email: "ana.marsh@orrery.example", title: "CFO" });
    expect(s.fields.phone).toBeUndefined();
    expect(s.uncertain.sort()).toEqual(["email", "title"]);
    const bare = checkRead(JSON.stringify({ fields: { name: "No Text", company: "Nowhere" }, confidence: { name: "high", company: "high" } }));
    expect(bare.uncertain.sort()).toEqual(["company", "name"]);
    const got = checkRead(JSON.stringify({ fields: { name: "Zed Invented", email: "no-at-sign" }, confidence: { name: "high" }, text: "Someone Else" }));
    expect(got.fields).toEqual({});
    expect(got.dropped).toHaveLength(2);
  });
  it("is counted before the call, never repeated on an unknown outcome, and the call row keeps no card text", async () => {
    const id = await withPhoto();
    const bad = reading({}, { throws: true });
    await readPhoto(db, deps(), bad, MAYA, id);
    expect(bad.calls).toBe(1);
    expect((await row(id)).state).toBe("needs_fields");
    const again = reading({ fields: { name: "X Y", company: "Z" }, confidence: {}, text: "X Y Z" });
    expect(await readPhoto(db, deps(), again, MAYA, id)).toMatchObject({ state: "failed" });
    expect(again.calls).toBe(0);
    const calls = await db.query<any>("SELECT output FROM llm_calls WHERE event_id = $1 AND step = 'scan_read'", [ev]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.output === "")).toBe(true);
  });
  it("a read that finds nothing leaves the scan to be typed, and the rep's own typing stands over the read", async () => {
    const id = await withPhoto();
    await readPhoto(db, deps(), reading({ fields: {}, confidence: {}, text: "" }), MAYA, id);
    expect((await row(id)).state).toBe("needs_fields");
    const id2 = await withPhoto("badge_photo", { name: "Typed Name", company: "Orrery" });
    await readPhoto(db, deps(), reading({ fields: { name: "Read Name", company: "Orrery" }, confidence: { name: "high" }, text: "Read Name Orrery" }), MAYA, id2);
    expect((await row(id2)).fields.name).toBe("Typed Name");
  });
  it("confirming fixes the fields on the scan and the person and clears the doubt; a corrected address that is already someone's opens a review, never a silent merge", async () => {
    const id = await withPhoto();
    await readPhoto(db, deps(), reading({ fields: { name: "Nia Frost", company: "Orrery", email: "nia.frost@orrery.example" }, confidence: { email: "low" }, text: "Nia Frost Orrery nia.frost@orrery.example" }), MAYA, id);
    await confirmScan(db, deps(), MAYA, id, { email: "nia.frost@orrery.example", title: "VP Risk" });
    expect(await row(id)).toMatchObject({ state: "placed", uncertain: [] });
    expect((await db.query<any>("SELECT title FROM contacts WHERE id = $1", [(await row(id)).contact_id]))[0].title).toBe("VP Risk");
    await confirmScan(db, deps(), MAYA, id, { email: "ana.lima@orrery.example" });
    expect((await row(id)).review).toBe("open");
    expect((await db.query<any>("SELECT email FROM contacts WHERE id = $1", [(await row(id)).contact_id]))[0].email).toBe("nia.frost@orrery.example");
  });
});

describe("who reads what, the CSV and erasure", () => {
  it("a rep reads their own scans and a planner every one; setup is for planners", async () => {
    expect((await listScans(db, LEO, ev)).scans.every((s) => s.rep === LEO)).toBe(true);
    expect((await listScans(db, CAMILLE, ev)).scans.some((s) => s.rep === MAYA)).toBe(true);
    await expect(putSettings(db, MAYA, ev, { qualifiers: [{ label: "Buying this year?" }] })).rejects.toBeInstanceOf(ScanForbidden);
    await putSettings(db, CAMILLE, ev, { qualifiers: [{ label: "Buying this year?" }, { label: "Has a team of ten or more?" }], notice_text: "We keep your details to follow up. Say if you would rather we did not." });
    expect((await listScans(db, MAYA, ev)).settings).toMatchObject({ notice_version: 2 });
    await expect(putSettings(db, CAMILLE, ev, { qualifiers: [1, 2, 3, 4].map((i) => ({ label: `q${i}` })) })).rejects.toThrow(/at most 3/);
  });
  it("keeps each scan's notice version: a scan sent with version 1 keeps that wording after the notice changed", async () => {
    const input = code("Pat Lund", "pat.lund@orrery.example", { notice_version: 1, qualifiers: { q1: "yes", q9: "yes" } });
    await scan(input);
    const s = await row(input.id);
    expect(s.consent_notice_version).toBe(1);
    expect(s.consent_wording).toMatch(/follow up on our conversation/);
    expect(s.qualifiers).toEqual({ q1: "yes" });
  });
  it("exports a CSV in which no cell can run as a formula", async () => {
    const input = code("Quin Hale", "quin.hale@orrery.example", { note: "=HYPERLINK(\"http://x\")" });
    await scan(input);
    const csv = await scansCsv(db, MAYA, ev);
    expect(csv.split("\r\n")[0]).toMatch(/^Scanned,Rep,Method,Name/);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
  it("erasing a person deletes their scans and photos, including a scan that never became a person", async () => {
    const input = code("Rae Wolfe", "rae.wolfe@orrery.example", { note: "private note" });
    await scan(input);
    const orphan = { id: sid(), method: "typed" as const, fields: { email: "rae.wolfe@orrery.example" } };
    await db.query("INSERT INTO scans (id, event_id, rep, method, fields, scanned_at, state) VALUES ($1, $2, $3, 'typed', $4::jsonb, now(), 'needs_fields')", [orphan.id, ev, MAYA, JSON.stringify(orphan.fields)]);
    const photoOnly = { id: sid(), method: "card_photo" as const, fields: { name: "Rae Wolfe" } };
    await scan(photoOnly);
    await forgetPerson(db, deps(), "rae.wolfe@orrery.example", "GTM Team");
    expect(await count("scans", `id = '${photoOnly.id}'`)).toBe(0);
    expect(await count("contacts", "registrant_id IS NOT NULL AND email IS NULL AND marketing_consent")).toBe(0);
    expect(await count("scans", `id IN ('${input.id}', '${orphan.id}')`)).toBe(0);
    expect(await count("scans", "raw_payload LIKE '%rae.wolfe%'")).toBe(0);
  });
});
