import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { cancelEvent, decideApproval, patchSettings, requestCard } from "../src/server/approvals.ts";
import { createEvent, RuleError } from "../src/server/events.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { quote, titleRule, type Settings } from "../src/shared/cost.ts";
import { freshDb } from "./helpers.ts";

const defaults: Settings = JSON.parse(readFileSync("config/defaults.json", "utf8"));
const list = readFileSync("samples/attendees.csv", "utf8");
const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";

describe("title rule", () => {
  const k = defaults.title_keywords;
  it("decides what the table covers", () => {
    expect(titleRule("VP Revenue Operations", k)).toBe(1);
    expect(titleRule("Director of Sales", k)).toBe(2);
    expect(titleRule("Marketing Coordinator", k)).toBe(3);
  });
  it("lets tier 3 win so an assistant is not a VP", () => { expect(titleRule("Assistant to the VP", k)).toBe(3); });
  it("returns null for the LLM when nothing matches", () => { expect(titleRule("Account Executive", k)).toBeNull(); });
  it("matches whole words only", () => { expect(titleRule("Microbiologist", { ...k, 1: ["cro"] })).toBeNull(); });
});

describe("the cost card", () => {
  const s = { ...defaults, contacts_per_company: 2, finders: [{ name: "a", cost: 1 }, { name: "b", cost: 2 }], verifiers: [{ name: "c", cost: 1 }, { name: "d", cost: 3 }], discovery_cost: 5, agent_question_limit: 10, calls_per_question: 3, llm_call_cents: 2 };
  const c = quote({ person_rows: 4, company_only_rows: 3, people_without_email: 1, unique_companies: 5, titles_with_no_rule: 2, companies_with_people: 4 }, s);
  it("computes the worst case line by line", () => {
    expect(c.lines).toEqual({ contacts: 10, discovery_credits: 30, finder_credits: 21, verifier_credits: 40, linkedin_credits: 10, pipeline_llm: 34, agent_llm: 30 });
  });
  it("sets two caps and an AI-dollars-only estimate", () => {
    expect(c.credits_cap).toBe(101);
    expect(c.llm_cap).toBe(64);
    expect(c.est_cents).toBe(64 * 2);
  });
});

describe("adding prospects to the card", () => {
  const i = { person_rows: 4, company_only_rows: 1, people_without_email: 0, unique_companies: 5, titles_with_no_rule: 0, companies_with_people: 3 };
  it("raises the worst case by one lookup per attending company", () => {
    const off = quote(i, { ...defaults, add_prospects: false, contacts_per_company: 2 });
    const on = quote(i, { ...defaults, add_prospects: true, contacts_per_company: 2 });
    expect(on.lines.contacts - off.lines.contacts).toBe(6);
    expect(on.credits_cap).toBeGreaterThan(off.credits_cap);
  });
});

describe("approvals", () => {
  let db: Db, id: string, seats: string;
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  const stage = async () => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;
  const toQuoted = async () => {
    await decideApproval(db, { approvalId: seats, actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", list);
    await requestCard(db, id, MAYA);
  };
  beforeEach(async () => {
    db = await freshDb();
    id = (await createEvent(db, MAYA, { name: "T", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100, flow: "single_card" })).id;
    seats = await pending();
  });

  it("refuses self-approval", async () => {
    await patchSettings(db, id, MAYA, { contacts_per_company: 2 });
    await db.query(`UPDATE event_settings SET settings = jsonb_set(settings, '{approvers}', '["Maya Ortiz"]') WHERE event_id = $1`, [id]);
    await expect(decideApproval(db, { approvalId: seats, actor: MAYA, decision: "approve" })).rejects.toThrow(/own request/);
    expect(await stage()).toBe("requested");
  });
  it("lets the person who uploaded the list confirm its cost card, even though they also asked for it", async () => {
    await decideApproval(db, { approvalId: seats, actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", list);
    await requestCard(db, id, MAYA);
    const r = await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "approve" });
    expect(r).toMatchObject({ status: "approved", decided_by: MAYA });
    expect(await stage()).toBe("tiering");
  });
  it("refuses an approver who did not upload the list: leadership does not confirm cost cards", async () => {
    await decideApproval(db, { approvalId: seats, actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", list);
    await requestCard(db, id, DAN);
    const card = await pending();
    await expect(decideApproval(db, { approvalId: card, actor: DAN, decision: "approve" })).rejects.toThrow(/Only Maya Ortiz, who uploaded the attendee list, can confirm/);
    await expect(decideApproval(db, { approvalId: card, actor: DAN, decision: "decline", reason: "no" })).rejects.toThrow(/Only Maya Ortiz/);
    await expect(decideApproval(db, { approvalId: card, actor: "Random Person", decision: "approve" })).rejects.toThrow(/Only Maya Ortiz/);
    expect(await stage()).toBe("quoted");
    // The uploader may decline it, with a reason.
    await decideApproval(db, { approvalId: card, actor: MAYA, decision: "decline", reason: "Asked by mistake" });
    expect(await stage()).toBe("mapped");
  });
  it("keeps seat requests with the approvers: the approver list applies and nobody approves their own request", async () => {
    await expect(decideApproval(db, { approvalId: seats, actor: MAYA, decision: "approve" })).rejects.toThrow(/approvers/);
    await expect(decideApproval(db, { approvalId: seats, actor: "Random Person", decision: "approve" })).rejects.toThrow(/approvers/);
  });
  it("moves the confirmation to whoever uploads the list again, and voids the card quoted for the old list", async () => {
    await decideApproval(db, { approvalId: seats, actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", list);
    const rowsOnce = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM source_rows WHERE event_id = $1", [id]))[0].n;
    await requestCard(db, id, MAYA);
    const old = await pending();
    // Maya is away. Sam uploads the list again.
    await ingestUpload(db, id, "Sam Okafor", "b.csv", list);
    expect(await stage()).toBe("mapped");
    const [o] = await db.query<{ status: string; reason: string }>("SELECT status, reason FROM approvals WHERE id = $1", [old]);
    expect(o).toMatchObject({ status: "declined" });
    expect(o.reason).toMatch(/Sam Okafor uploaded a new list/);
    expect((await db.query<{ status: string }>("SELECT status FROM cost_cards WHERE event_id = $1", [id]))[0].status).toBe("declined");
    // The old approval can no longer be confirmed by anyone, and its card never ran.
    expect(await decideApproval(db, { approvalId: old, actor: MAYA, decision: "approve" })).toMatchObject({ already_decided: true, status: "declined" });
    await requestCard(db, id, "Sam Okafor");
    const fresh = await pending();
    await expect(decideApproval(db, { approvalId: fresh, actor: MAYA, decision: "approve" })).rejects.toThrow(/Only Sam Okafor/);
    await decideApproval(db, { approvalId: fresh, actor: "Sam Okafor", decision: "approve" });
    expect(await stage()).toBe("tiering");
    // One list, not two: the first upload's rows are gone.
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM source_rows WHERE event_id = $1", [id]))[0].n).toBe(rowsOnce);
  });
  it("never confirms a card quoted before the latest upload, even if the old pending row survived", async () => {
    await decideApproval(db, { approvalId: seats, actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", list);
    await requestCard(db, id, MAYA);
    const old = await pending();
    // A race: the upload landed but the pending row was left behind.
    await db.query("INSERT INTO uploads (id, event_id, filename, mapping, row_count, uploaded_by, created_at) VALUES ('upl_late', $1, 'late.csv', '{}', 1, 'Sam Okafor', now() + interval '1 second')", [id]);
    await expect(decideApproval(db, { approvalId: old, actor: "Sam Okafor", decision: "approve" })).rejects.toThrow(/earlier upload/);
    await expect(decideApproval(db, { approvalId: old, actor: MAYA, decision: "approve" })).rejects.toThrow(/Only Sam Okafor/);
  });
  it("refuses someone off the approver list", async () => {
    await expect(decideApproval(db, { approvalId: seats, actor: "Random Person", decision: "approve" })).rejects.toThrow(/approvers/);
  });
  it("a second click changes nothing and says who decided first", async () => {
    await decideApproval(db, { approvalId: seats, actor: DAN, decision: "approve" });
    const again = await decideApproval(db, { approvalId: seats, actor: DAN, decision: "decline", reason: "changed my mind" });
    expect(again).toMatchObject({ already_decided: true, status: "approved", decided_by: DAN });
    expect(await stage()).toBe("approved");
  });
  it("needs a reason to decline, and declining seats ends the event", async () => {
    await expect(decideApproval(db, { approvalId: seats, actor: DAN, decision: "decline", reason: " " })).rejects.toThrow(/why/);
    await decideApproval(db, { approvalId: seats, actor: DAN, decision: "decline", reason: "Over budget" });
    expect(await stage()).toBe("declined");
  });
  it("cannot quote before a list is mapped", async () => {
    await expect(requestCard(db, id, MAYA)).rejects.toBeInstanceOf(RuleError);
  });
  it("approving the card starts tiering and locks the caps", async () => {
    await toQuoted();
    const [card] = await db.query<{ credits_cap: number; status: string }>("SELECT credits_cap, status FROM cost_cards WHERE event_id = $1", [id]);
    expect(card.credits_cap).toBeGreaterThan(0);
    await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "approve" });
    expect(await stage()).toBe("tiering");
    await expect(patchSettings(db, id, MAYA, { contacts_per_company: 1 })).rejects.toThrow(/locked/);
  });
  it("declining the card returns to mapped so it can be re-quoted lower", async () => {
    await toQuoted();
    const [first] = await db.query<{ credits_cap: number }>("SELECT credits_cap FROM cost_cards WHERE event_id = $1", [id]);
    await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "decline", reason: "Too expensive" });
    expect(await stage()).toBe("mapped");
    await patchSettings(db, id, MAYA, { contacts_per_company: 1 });
    await requestCard(db, id, MAYA);
    const [second] = await db.query<{ credits_cap: number }>("SELECT credits_cap FROM cost_cards WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1", [id]);
    expect(second.credits_cap).toBeLessThan(first.credits_cap);
  });
  it("ending a quoted event closes its pending approval", async () => {
    await toQuoted();
    await cancelEvent(db, id, MAYA, "Event cancelled");
    expect(await stage()).toBe("declined");
    expect((await db.query("SELECT 1 FROM approvals WHERE event_id = $1 AND status = 'pending'", [id])).length).toBe(0);
  });
});

describe("prompts", () => {
  it("keeps dollar patterns in CSV values intact", async () => {
    const { fill } = await import("../src/server/prompts.ts");
    expect(fill("review", { input: "Company: Cash$$Co $` end" })).toContain("Cash$$Co $` end");
  });
});
