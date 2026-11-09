import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { decideApproval, requestCard } from "../src/server/approvals.ts";
import { answerCase, listCases, openCase, skipOpenCases } from "../src/server/cases.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent, RuleError } from "../src/server/events.ts";
import { reserve, settle, spend, spendByStep } from "../src/server/ledger.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors, type Verifier } from "../src/server/providers.ts";
import { requestOutreachCard, requestResearchCard } from "../src/server/research.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { quoteOutreach, quoteResearch } from "../src/shared/cost.ts";
import { DEFAULT_FLOW, validateRequest } from "../src/shared/domain.ts";
import { freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";
const mock: Deps = { llm: mockLlm, vendorsFor: mockVendors };
const LIST = [
  "Company Name,First Name,Last Name,Job Title,Work Email",
  "Tallgrass Software,Ana,Ruiz,VP Sales,ana@tallgrass.example",
  "Tallgrass Software,Bo,Lee,Intern,bo@tallgrass.example",
  "Dunmore Payments,Cy,Day,Account Executive,",
  "Quillmere Consulting,Di,Fay,Director of Sales,di@quillmere.example",
  "Rivalcrest Systems,Ed,Gray,VP Sales,ed@rivalcrest.example",
  "Pinefold Ltd,Fi,Hart,VP Sales,",
  "Intern Only Co,Gil,Ito,Student Intern,",
  "Harbor Logistics,,,,",
  "Rivalcrest Systemz,Jo,Kim,VP Sales,jo@rivalcrestsystemz.example",
].join("\n");

let db: Db, id: string;
const pending = async (kind?: string) => (await db.query<{ id: string }>(`SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'${kind ? ` AND kind = '${kind}'` : ""}`, [id]))[0].id;
// Seat requests are approved by Dan; cost cards are confirmed by Maya, who uploaded the list.
const approve = async (kind?: string) => decideApproval(db, { approvalId: await pending(kind), actor: kind ? MAYA : DAN, decision: "approve" });
const stage = async () => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;
const dropped = async () => Object.fromEntries((await db.query<{ drop_reason: string; n: number }>("SELECT drop_reason, count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NOT NULL GROUP BY 1", [id])).map((r) => [r.drop_reason, r.n]));

async function mapped(csv = LIST, flow: "two_card" | "single_card" = "two_card") {
  id = (await createEvent(db, MAYA, { name: "Two cards", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100, country: "Spain", flow })).id;
  await approve();
  await ingestUpload(db, id, MAYA, "a.csv", csv);
}
/** Through the Research card and its run, to ready for review. */
async function researched(csv = LIST, deps: Deps = mock) {
  await mapped(csv);
  await requestResearchCard(db, id, MAYA);
  await approve("research");
  await processEvent(db, id, deps);
}

beforeEach(async () => { db = await freshDb(); });

describe("the event's country and the flow", () => {
  it("stores the country on the event and returns it", async () => {
    await mapped();
    const app = createApp(db, { demo: true });
    const body = await (await app.request(`/api/events/${id}`)).json() as { event: { country: string; flow: string } };
    expect(body.event).toMatchObject({ country: "Spain", flow: "two_card" });
    expect(validateRequest({ name: "x", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 0, country: 5 })).toMatch(/country/);
    expect(validateRequest({ name: "x", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 0, flow: "three_card" })).toMatch(/flow/);
  });
  it("creates two-card events by default, and still runs the single-card flow when asked", async () => {
    expect(DEFAULT_FLOW).toBe("two_card");
    const e = await createEvent(db, MAYA, { name: "New", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 0 });
    expect(e.flow).toBe("two_card");
    expect(e.country).toBeNull();
    const old = await createEvent(db, MAYA, { name: "Old", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 0, flow: "single_card" });
    expect(old.flow).toBe("single_card");
  });
  it("keeps each flow to its own cards", async () => {
    await mapped();
    await expect(requestCard(db, id, MAYA)).rejects.toThrow(/Research card and an Outreach card/);
    db = await freshDb();
    await mapped(LIST, "single_card");
    await expect(requestResearchCard(db, id, MAYA)).rejects.toThrow(/single cost card/);
  });
});

describe("the Research card", () => {
  it("runs the free work first and prices only the companies that still need research", async () => {
    await mapped();
    await requestResearchCard(db, id, MAYA);
    expect(await stage()).toBe("quoted");
    // The exact-name matches and the Title 3 people are gone before the card.
    expect(await dropped()).toMatchObject({ excluded_company: 1, existing_customer: 1, low_tier: 2 });
    const [card] = await db.query<{ kind: string; status: string; lines: Record<string, number>; credits_cap: number; llm_cap: number; step_caps: Record<string, object>; inputs: { quality: { rows: number } } }>("SELECT kind, status, lines, credits_cap, llm_cap, step_caps, inputs FROM cost_cards WHERE event_id = $1", [id]);
    expect(card.kind).toBe("research");
    // Five companies remain: Tallgrass, Dunmore, Quillmere, Harbor, Rivalcrest Systemz. "Intern Only Co" stopped at the title pass.
    expect(card.lines).toMatchObject({
      companies: 5, unresolved_companies: 2, person_match_companies: 1, reverse_lookup_rows: 0, person_match_credits: 1, reverse_lookup_credits: 0, firmographics_credits: 5,
      max_companies: 5, llm_calls_per_company: 5, tier_llm: 20, website_read_llm: 5, retier_companies: 1, retier_llm: 4, retier_website_read_llm: 1,
    });
    // Free identity from the file's own addresses settled Tallgrass, Quillmere and Rivalcrest Systemz before the card. Only Dunmore (a named person, no address) could use a person match; Harbor has nobody to match.
    expect(card.credits_cap).toBe(6);
    // 20 tier calls + 4 re-tier, 5 + 1 website reads: the true worst case, re-tier included.
    expect(card.llm_cap).toBe(30);
    expect(Object.keys(card.step_caps).sort()).toEqual(["company_tier", "firmographics", "person_match", "reverse_lookup", "website_read"]);
    // The list quality report rides on the card.
    expect(card.inputs.quality.rows).toBe(9);
    const [a] = await db.query<{ kind: string }>("SELECT kind FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]);
    expect(a.kind).toBe("research");
  });

  it("keeps the screens' card shape: contacts and linkedin_credits sit in lines", async () => {
    await mapped();
    await requestResearchCard(db, id, MAYA);
    const app = createApp(db, { demo: true });
    const b = await (await app.request(`/api/events/${id}`)).json() as { card: { lines: Record<string, number>; credits_cap: number; llm_cap: number; est_cents: number }; list: { quality: { rows: number } } };
    expect(b.card.lines.contacts).toBe(4);
    expect(b.card.lines.linkedin_credits).toBe(0);
    expect(b.list.quality.rows).toBe(9);
    const pend = await (await app.request("/api/approvals")).json() as { approvals: { kind: string; credits_cap: number }[] };
    expect(pend.approvals.find((x) => x.kind === "research")!.credits_cap).toBe(6);
  });

  it("puts everything back when the card is declined, and redoes it at the next request", async () => {
    await mapped();
    await requestResearchCard(db, id, MAYA);
    await decideApproval(db, { approvalId: await pending("research"), actor: MAYA, decision: "decline", reason: "lower the list" });
    expect(await stage()).toBe("mapped");
    expect(await dropped()).toEqual({});
    expect((await db.query("SELECT 1 FROM companies WHERE event_id = $1 AND (list_status IS NOT NULL OR NOT in_research)", [id])).length).toBe(0);
    expect((await db.query("SELECT 1 FROM title_tiers WHERE event_id = $1", [id])).length).toBe(0);
    await requestResearchCard(db, id, MAYA);
    expect(await dropped()).toMatchObject({ excluded_company: 1, existing_customer: 1, low_tier: 2 });
  });

  it("gives a person who came in with no company one reverse lookup, priced on the card", async () => {
    await researched("Company Name,Full Name,Work Email\nTallgrass Software,Ana Ruiz,ana@tallgrass.example\n,Sam Okafor,sam@nocompany.example\n");
    const [card] = await db.query<{ lines: Record<string, number> }>("SELECT lines FROM cost_cards WHERE event_id = $1", [id]);
    expect(card.lines).toMatchObject({ reverse_lookup_rows: 1, reverse_lookup_credits: 1 });
    // The mock vendor knows the address's company, so Sam is attached to a new company at that domain and nobody is dropped.
    expect(await dropped()).toEqual({});
    const [sam] = await db.query<{ company: string; domain: string }>("SELECT co.name AS company, co.primary_domain AS domain FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.full_name = 'Sam Okafor'");
    expect(sam).toEqual({ company: "Nocompany", domain: "nocompany.example" });
    expect((await spendByStep(db, id)).find((x) => x.step === "reverse_lookup")!.n).toBe(1);
  });

  it("drops a person with no company and nothing to look up with", async () => {
    await researched("Company Name,Full Name,Work Email,LinkedIn URL\nTallgrass Software,Ana Ruiz,ana@tallgrass.example,\n,Sam Okafor,,https://www.linkedin.com/in/sam-okafor-1\n,Lee Park,lee@free.example,\n");
    // The mock cannot place a LinkedIn profile; the one with an address is found.
    expect(await dropped()).toEqual({ no_company: 1 });
  });
});

describe("the money rules", () => {
  it("pays nothing before the right card is approved", async () => {
    await mapped();
    await requestResearchCard(db, id, MAYA);
    // Quoted, not approved.
    expect(await reserve(db, id, "llm", 1, "mock", "company_tier")).toBeNull();
    await approve("research");
    const r = await reserve(db, id, "llm", 1, "mock", "company_tier");
    expect(r).not.toBeNull();
    await settle(db, r!, 1);
    // The Research card does not pay people steps, however much room it has.
    for (const step of ["find", "verify", "discovery", "linkedin", "title_tier", "review", "catch_all_probe", "concierge"]) {
      expect(await reserve(db, id, step === "find" || step === "verify" || step === "discovery" || step === "linkedin" || step === "catch_all_probe" ? "credits" : "llm", 1, "mock", step), step).toBeNull();
    }
    // A step no card names is refused.
    expect(await reserve(db, id, "credits", 1, "mock", "made_up")).toBeNull();
  });

  it("holds each step to its own cap even when the card total has room", async () => {
    await researched();
    const [card] = await db.query<{ step_caps: Record<string, { credits?: number; llm?: number }>; llm_cap: number }>("SELECT step_caps, llm_cap FROM cost_cards WHERE event_id = $1 AND kind = 'research'", [id]);
    // 5 company_tier calls ran in research; the step cap is 24 of a 36 total.
    const used = (await spendByStep(db, id)).find((s) => s.step === "company_tier")!.n;
    expect(used).toBe(5);
    const room = card.step_caps.company_tier.llm! - used;
    const a = await reserve(db, id, "llm", room, "mock", "company_tier");
    expect(a).not.toBeNull();
    // company_tier is now at its cap; the card total (36) is not.
    expect(await reserve(db, id, "llm", 1, "mock", "company_tier")).toBeNull();
    const other = await reserve(db, id, "llm", 1, "mock", "website_read");
    expect(other).not.toBeNull();
    // A step with only an LLM cap cannot spend credits.
    expect(await reserve(db, id, "credits", 1, "mock", "company_tier")).toBeNull();
  });

  it("runs two cards to delivered, each step inside its cap, research untouched by outreach", async () => {
    await researched();
    expect(await stage()).toBe("ready_for_review");
    const spentAfterResearch = await spend(db, id);
    expect(spentAfterResearch.credits).toBe(0);
    expect(spentAfterResearch.llm).toBe(5);

    // Rivalcrest Systemz looks like the excluded Rivalcrest Systems. A person decides; nothing acts on it alone.
    const cases = await listCases(db, id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ kind: "fuzzy_list_match", suggested: "same_company", decision: null, blocking: true });
    await expect(requestOutreachCard(db, id, MAYA)).rejects.toThrow(/1 case is still open/);
    await answerCase(db, id, cases[0].id, DAN, "different_company");
    expect(await processEvent(db, id, mock)).toBe("ready_for_review");

    await requestOutreachCard(db, id, MAYA);
    const [card] = await db.query<{ kind: string; lines: Record<string, number>; credits_cap: number; llm_cap: number }>("SELECT kind, lines, credits_cap, llm_cap FROM cost_cards WHERE event_id = $1 AND kind = 'outreach'", [id]);
    expect(card.kind).toBe("outreach");
    // Three attendees at A or B (Ana, Cy, Jo), Harbor searched at the tier 1 quota of 5, Cy has no email.
    expect(card.lines).toMatchObject({
      max_people: 8, attendees_ab: 3, discovered_people: 5, discovery_credits: 0, reveal_credits: 5, finder_credits: 3, waterfall_credits: 80, verifier_credits: 32,
      probe_credits: 4, linkedin_credits: 8, uploaded_title_llm: 2, discovered_title_llm: 10, title_llm: 12, review_llm: 16, perspective_llm: 2, agent_llm: 150,
    });
    // The people search is free (step 7), so the 5 discovery credits are gone; the 5 discovered people's titles may each need the model, twice.
    // 100 before Apollo's waterfall replaced the second finder and the second verifier: match 3, verifier 32, and the waterfall's worst case 8 x 10, on top of reveal 5, probe 4, LinkedIn 8.
    expect(card.credits_cap).toBe(132);
    // 178 before the Summary perspective, which is its own step on this card: one call and one retry.
    expect(card.llm_cap).toBe(180);
    const estimate = (card.lines as unknown as { estimate: { label: string; credits: number } }).estimate;
    expect(estimate.label).toMatch(/not measured/);
    expect(estimate.credits).toBeLessThan(card.credits_cap);

    // Nothing from the Outreach card is spendable until it is approved.
    expect(await reserve(db, id, "credits", 1, "mock", "find")).toBeNull();
    await approve("outreach");
    expect(await stage()).toBe("finding_people");
    expect(await processEvent(db, id, mock)).toBe("delivered");

    const steps = await spendByStep(db, id);
    const caps = Object.fromEntries((await db.query<{ kind: string; step_caps: Record<string, Record<string, number>> }>("SELECT kind, step_caps FROM cost_cards WHERE event_id = $1", [id])).map((c) => [c.kind, c.step_caps]));
    for (const s of steps) expect(s.n, `${s.kind}/${s.step}/${s.unit}`).toBeLessThanOrEqual(caps[s.kind][s.step][s.unit]!);
    const research = steps.filter((s) => s.kind === "research"), outreach = steps.filter((s) => s.kind === "outreach");
    expect(research.every((s) => s.step === "company_tier")).toBe(true);
    expect(research.reduce((a, s) => a + s.n, 0)).toBe(5);
    expect(outreach.map((s) => s.step)).toEqual(expect.arrayContaining(["find", "verify", "review"]));
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND dropped_at IS NOT NULL AND drop_reason IS NULL", [id])).length).toBe(0);
    // The people search is free: nothing was reserved for it.
    expect(outreach.some((x) => x.step === "discovery")).toBe(false);
    // The search for Harbor used the tier 1 quota, not contacts_per_company.
    const prospects = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND source = 'prospect'", [id]);
    expect(prospects[0].n).toBeGreaterThan(0);
    expect(prospects[0].n).toBeLessThanOrEqual(5);
  });

  it("refuses a late spend: a card at its cap refuses and the contact drops as budget_cap", async () => {
    await researched();
    for (const k of await listCases(db, id)) await answerCase(db, id, k.id, DAN, "different_company");
    await requestOutreachCard(db, id, MAYA);
    await approve("outreach");
    // Use up the review step's whole allowance before the run.
    const [{ step_caps }] = await db.query<{ step_caps: Record<string, { llm: number }> }>("SELECT step_caps FROM cost_cards WHERE kind = 'outreach' AND event_id = $1", [id]);
    await settle(db, (await reserve(db, id, "llm", step_caps.review.llm, "test", "review"))!, step_caps.review.llm);
    expect(await processEvent(db, id, mock)).toBe("delivered");
    // Review calls were refused: code adds not_reviewed, and nobody who was already paid for is dropped.
    expect((await db.query("SELECT 1 FROM review_flags WHERE flag = 'not_reviewed'")).length).toBeGreaterThan(0);
  });
});

describe("the Outreach card", () => {
  it("returns to the review step when declined, and can be asked for again", async () => {
    await researched();
    for (const k of await listCases(db, id)) await answerCase(db, id, k.id, DAN, "different_company");
    await requestOutreachCard(db, id, MAYA);
    await expect(requestOutreachCard(db, id, MAYA)).rejects.toThrow(/already waiting/);
    await decideApproval(db, { approvalId: await pending("outreach"), actor: MAYA, decision: "decline", reason: "too many people" });
    expect(await stage()).toBe("ready_for_review");
    expect((await db.query("SELECT 1 FROM cost_cards WHERE event_id = $1 AND kind = 'research' AND status = 'approved'", [id])).length).toBe(1);
    // The declined card pays nothing.
    expect(await reserve(db, id, "credits", 1, "mock", "find")).toBeNull();
    await requestOutreachCard(db, id, MAYA);
    await approve("outreach");
    expect(await stage()).toBe("finding_people");
  });
  it("is asked for only after research, and only the second time through the same route", async () => {
    await mapped();
    await expect(requestOutreachCard(db, id, MAYA)).rejects.toThrow(/once research is done/);
  });
  it("counts a title with no rule at its best case so the card is never too low", () => {
    const s = JSON.parse(JSON.stringify(mockSettings()));
    const q = quoteOutreach({ attendees_ab: 10, attendees_without_email: 4, search_companies_tier1: 2, search_companies_tier2: 3, domains: 7, titles_with_no_rule: 5 }, s);
    // 10 + 2x5 + 3x3 = 29 people.
    expect(q.lines.max_people).toBe(29);
    // An attendee may use Apollo's match; a discovered person's first lookup is the reveal (1 each), so the match is not paid again for them. Everyone may use the waterfall at its reserve.
    expect(q.lines.reveal_credits).toBe(19);
    expect(q.lines.finder_credits).toBe(10 * 1);
    expect(q.lines.waterfall_credits).toBe(29 * s.waterfall.reserve);
    expect(q.lines.verifier_credits).toBe(29 * 4 * 1);
    // 5 uploaded titles x 2, and 29 - 10 = 19 discovered people x 2 (their titles are unknown when the card is quoted).
    expect(q.lines.title_llm).toBe(10 + 38);
    expect(q.lines.review_llm).toBe(58);
  });
});

describe("catch-all domains are reported as a gap", () => {
  const catchAll = (s: ReturnType<typeof mockSettings>) => {
    const v = mockVendors(s);
    v.verifiers = v.verifiers.map((x): Verifier => ({ ...x, verify: async () => ({ verdict: "catch_all", charged: x.cost }) }));
    return v;
  };
  it("uses catch_all_unconfirmed in the two-card flow", async () => {
    await researched("Company Name,Full Name,Job Title,Work Email\nTallgrass Software,Ana Ruiz,VP Sales,ana@tallgrass.example\n", { llm: mockLlm, vendorsFor: catchAll });
    await requestOutreachCard(db, id, MAYA);
    await approve("outreach");
    await processEvent(db, id, { llm: mockLlm, vendorsFor: catchAll });
    expect(await dropped()).toEqual({ catch_all_unconfirmed: 1 });
  });
  it("keeps email_unconfirmed in the single-card flow", async () => {
    await mapped("Company Name,Full Name,Job Title,Work Email\nTallgrass Software,Ana Ruiz,VP Sales,ana@tallgrass.example\n", "single_card");
    await requestCard(db, id, MAYA);
    await approve("card");
    await processEvent(db, id, { llm: mockLlm, vendorsFor: catchAll });
    expect(await dropped()).toEqual({ email_unconfirmed: 1 });
  });
});

describe("review cases", () => {
  const open = async (kind: Parameters<typeof openCase>[1]["kind"], companyId: string, extra: Partial<Parameters<typeof openCase>[1]> = {}) =>
    db.tx((q) => openCase(q, { eventId: id, kind, companyId, summary: `case ${kind}`, facts: [], ...extra }));
  const company = async (name: string) => (await db.query<{ id: string }>("SELECT id FROM companies WHERE event_id = $1 AND name = $2", [id, name]))[0].id;

  it("holds the Outreach card while any blocking case is open, and releases it when they are settled or skipped", async () => {
    await researched();
    for (const k of await listCases(db, id)) await answerCase(db, id, k.id, DAN, "different_company");
    const dun = await company("Dunmore Payments"), harbor = await company("Harbor Logistics");
    await open("unknown_tier", dun);
    await open("company_not_found", harbor);
    await expect(requestOutreachCard(db, id, MAYA)).rejects.toThrow(/2 cases are still open/);
    const cases = await listCases(db, id);
    const unknown = cases.find((c) => c.kind === "unknown_tier")!;
    await answerCase(db, id, unknown.id, DAN, "tier_3");
    expect((await db.query<{ tier: number }>("SELECT tier FROM companies WHERE id = $1", [dun]))[0].tier).toBe(3);
    await expect(requestOutreachCard(db, id, MAYA)).rejects.toThrow(/1 case is still open/);
    // Skipping what remains drops those companies with a reason from the list: no spend for them.
    expect(await skipOpenCases(db, id, DAN)).toBe(1);
    expect((await db.query("SELECT 1 FROM source_rows WHERE event_id = $1 AND drop_reason = 'company_not_found'", [id])).length).toBe(1);
    const after = await listCases(db, id);
    expect(after.filter((c) => !c.decision)).toHaveLength(0);
    expect(after.find((c) => c.kind === "company_not_found")).toMatchObject({ status: "skipped", decision: "skipped" });
    await requestOutreachCard(db, id, MAYA);
  });

  it("changes nothing on a second answer, and refuses an answer that is not allowed", async () => {
    await researched();
    const [k] = await listCases(db, id);
    await expect(answerCase(db, id, k.id, DAN, "maybe")).rejects.toBeInstanceOf(RuleError);
    const first = await answerCase(db, id, k.id, DAN, "same_company");
    expect(first.already_decided).toBe(false);
    const second = await answerCase(db, id, k.id, "Someone Else", "different_company");
    expect(second).toMatchObject({ already_decided: true, decision: "same_company" });
    // Same company as the excluded one: dropped, and nothing is spent on it.
    expect(await dropped()).toMatchObject({ excluded_company: 2 });
  });

  it("applies each kind by its own function", async () => {
    await researched();
    for (const k of await listCases(db, id)) await answerCase(db, id, k.id, DAN, "different_company");
    const dun = await company("Dunmore Payments"), harbor = await company("Harbor Logistics"), quill = await company("Quillmere Consulting");
    // A company not found: a person supplies the website. A webmail address is not a website.
    await db.query("UPDATE companies SET tier = NULL WHERE id = $1", [harbor]);
    const nf = await open("company_not_found", harbor);
    await expect(answerCase(db, id, nf!, DAN, "supply_domain", { domain: "gmail.com" })).rejects.toThrow(/own website/);
    await answerCase(db, id, nf!, DAN, "supply_domain", { domain: "https://www.Harbor-Logistics.example/about" });
    const [h] = await db.query<{ primary_domain: string; identity_state: string; identity_evidence: { source: string }[] }>("SELECT primary_domain, identity_state, identity_evidence FROM companies WHERE id = $1", [harbor]);
    expect(h).toMatchObject({ primary_domain: "harbor-logistics.example", identity_state: "resolved" });
    expect(h.identity_evidence.at(-1)!.source).toBe("human");
    // The settled company finishes its research at once, under the card already approved.
    expect((await db.query("SELECT 1 FROM jobs WHERE event_id = $1 AND kind = 'company_tier' AND status = 'queued' AND payload->>'company_id' = $2", [id, harbor])).length).toBe(1);
    expect(await processEvent(db, id, mock)).toBe("ready_for_review");
    expect((await db.query<{ tier: number | null }>("SELECT tier FROM companies WHERE id = $1", [harbor]))[0].tier).not.toBeNull();

    const amb = await open("ambiguous_identity", dun, { options: [{ value: "pick:dunmore.example", label: "dunmore.example", effect: "" }, { value: "pick:dunmorepay.example", label: "dunmorepay.example", effect: "" }, { value: "drop", label: "Neither", effect: "" }] });
    await answerCase(db, id, amb!, DAN, "pick:dunmore.example");
    expect((await db.query<{ primary_domain: string }>("SELECT primary_domain FROM companies WHERE id = $1", [dun]))[0].primary_domain).toBe("dunmore.example");

    const sub = await open("subsidiary_inheritance", quill, { payload: { status: "existing_customer" } });
    await answerCase(db, id, sub!, DAN, "inherit");
    expect((await db.query<{ list_status: string }>("SELECT list_status FROM companies WHERE id = $1", [quill]))[0].list_status).toBe("existing_customer");
    expect((await dropped()).existing_customer).toBeGreaterThanOrEqual(2);
  });

  it("stops holding spend once spending starts, and non-blocking cases never hold it", async () => {
    await researched();
    for (const k of await listCases(db, id)) await answerCase(db, id, k.id, DAN, "different_company");
    const dun = await company("Dunmore Payments");
    await db.query("UPDATE companies SET tier = 1 WHERE id = $1", [dun]);
    const later = await open("free_webmail", dun);
    await requestOutreachCard(db, id, MAYA);
    await approve("outreach");
    await processEvent(db, id, mock);
    const blocking = await open("unknown_tier", dun);
    await expect(answerCase(db, id, blocking!, DAN, "tier_1")).rejects.toThrow(/Spending has already started/);
    await expect(skipOpenCases(db, id, DAN)).rejects.toThrow(/nothing left to skip/);
    // A later case needs a person but changes no spend: the contact can still be dropped.
    const [c] = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND dropped_at IS NULL LIMIT 1", [id]);
    const lc = await db.tx((q) => openCase(q, { eventId: id, kind: "model_flag", contactId: c.id, summary: "title looks wrong", facts: [] }));
    await answerCase(db, id, lc!, DAN, "drop");
    expect((await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE id = $1", [c.id]))[0].drop_reason).toBe("rejected_in_review");
    await answerCase(db, id, later!, DAN, "keep");
  });

  it("serves the Cases screen's shape over HTTP and kicks the run after an answer", async () => {
    await researched();
    let kicked = 0;
    const app = createApp(db, { demo: true, kick: () => { kicked++; } });
    const post = (path: string, body: object) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "x-actor": DAN, "content-type": "application/json" } });
    const { cases } = await (await app.request(`/api/events/${id}/cases`)).json() as { cases: { id: string; summary: string; options: { value: string; label: string; effect: string }[]; suggested: string; decision: string | null }[] };
    expect(cases).toHaveLength(1);
    expect(cases[0].options.map((o) => o.value)).toEqual(["same_company", "different_company"]);
    expect((await post(`/api/events/${id}/cases/${cases[0].id}`, { decision: "nope" })).status).toBe(409);
    expect((await post(`/api/events/${id}/cases/${cases[0].id}`, {})).status).toBe(400);
    expect((await post(`/api/events/${id}/cases/${cases[0].id}`, { decision: "different_company" })).status).toBe(200);
    expect(kicked).toBe(1);
    expect((await (await app.request(`/api/events/${id}/cases`)).json() as { cases: { decision: string }[] }).cases[0].decision).toBe("different_company");
    // One /quote route asks for whichever card is next.
    expect((await post(`/api/events/${id}/quote`, {})).status).toBe(200);
    const b = await (await app.request(`/api/events/${id}`)).json() as { cards: { kind: string }[]; card: { kind: string }; open_cases: number };
    expect(b.cards.map((c) => c.kind)).toEqual(["outreach", "research"]);
    expect(b.card.kind).toBe("outreach");
    expect(b.open_cases).toBe(0);
    expect(await (await post(`/api/events/${id}/cases/skip`, {})).json()).toEqual({ skipped: 0 });
  });
});

function mockSettings() {
  return JSON.parse(readFileSync("config/defaults.json", "utf8")) as Parameters<typeof quoteResearch>[1];
}
