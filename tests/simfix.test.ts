/* The simulation fixes (branch simfix/events-desk): first paint and loading, the demo bar, the first screen, plan decisions and result closing without Slack or the sending stage,
   the kept import result, and the small safe fixes from the S5 review. Screens are drawn to static markup; the routes are called in process. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { demoConnectors } from "../src/server/connectors/setup.ts";
import type { Db } from "../src/server/db.ts";
import type { LifecycleDeps } from "../src/server/lifecycle-deps.ts";
import { mockLlm } from "../src/server/providers.ts";
import { createPlan, submitPlan } from "../src/server/plan.ts";
import { demoBarWords, sampleDayWords } from "../src/app/DemoBar.tsx";
import { Glossary, WORDS } from "../src/app/Glossary.tsx";
import { BlockSkeleton, Empty, PageSkeleton } from "../src/app/Skeleton.tsx";
import { CONTACT_URL, NEXT_STEP, NEXT_STEP_LEAD, NEXT_STEP_LINK, StartHere, TOUR_BUYER, TOUR_HIRING, VALUE_LINE } from "../src/app/start.tsx";
import { plainTools, setSampleTools, toolName } from "../src/app/tools.ts";
import { oneRowEach, sentTo } from "../src/app/waiting.ts";
import { nextLine } from "../src/app/words.ts";
import { NO_FILES } from "../src/app/access.tsx";
import { deliverEvent, freshDb } from "./helpers.ts";
import { LIST } from "./lifecycle-harness.ts";
import { as, CAMILLE, DAN, draftPlan, MAYA } from "./plan-helpers.ts";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("first paint", () => {
  it("serves the page with a shell in it, so something is on screen before any script runs", () => {
    const html = src("index.html");
    expect(html).toMatch(/<div id="root"><div class="boot"/);
    expect(html).toContain("Loading.");
  });
  it("loads every page on its own, so the shell is the only code every visit downloads first", () => {
    const app = src("src/app/App.tsx");
    for (const page of ["Events", "Event", "Overview", "Seats", "SeatDecisions", "Budget", "Usage", "MyDay", "Results", "Choosing", "Speaking", "More", "Settings", "Objects"]) {
      expect(app, page).not.toMatch(new RegExp(`^import .* from "\\./${page}";`, "m"));
      expect(app, page).toContain(`import("./${page}")`);
    }
  });
  it("draws the shell while the desk is still saying whether it is the demo", () => {
    const app = src("src/app/App.tsx");
    expect(app).not.toMatch(/if \(demo === null\) return/);
    expect(app).toContain("demo === null ? <PageSkeleton />");
  });
  it("sends the scripts compressed and cacheable, because hashed files never change under their name", () => {
    // The middleware moved from node.ts to static.ts (decision 106, review fix); tests/static-files.test.ts also runs it.
    expect(src("src/server/node.ts")).toContain("mountStatic(api)");
    const node = src("src/server/static.ts");
    expect(node).toContain('compress()');
    expect(node).toContain("max-age=31536000, immutable");
  });
  it("reads the open cases of every event in one request, not one per delivered event", () => {
    const w = src("src/app/waiting.ts");
    expect(w).toContain("/api/cases/open");
    expect(w).not.toMatch(/reviewable\.map/);
  });
  it("settles a page change in at most 150 ms and with no stagger", () => {
    const css = src("src/app/styles.css");
    const rule = css.match(/\.main > \* \{ animation: (page-in) (\d+)ms/);
    expect(rule && Number(rule[2])).toBeLessThanOrEqual(150);
    expect(css).not.toMatch(/\.main > \*:nth-child\(\d[^{]*\{ animation-delay/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important/);
  });
  it("draws a skeleton for a screen reader as a status with words", () => {
    const page = renderToStaticMarkup(createElement(PageSkeleton));
    expect(page).toContain('role="status"');
    expect(page).toContain('aria-busy="true"');
    expect(page).toContain("Loading.");
    expect(renderToStaticMarkup(createElement(BlockSkeleton, { label: "Loading the scanner." }))).toContain("Loading the scanner.");
  });
  it("leaves no page with a bare Loading line or a blank wait", () => {
    for (const f of ["Choosing", "Events", "MyDay", "Event", "Motion", "SeatDecisions", "Overview", "Plan", "Scanner", "Seats", "Results"]) {
      const s = src(`src/app/${f}.tsx`);
      expect(s, f).not.toContain('<p className="md-clear">{LOADING}</p>');
    }
    expect(src("src/app/Seats.tsx")).not.toContain("if (!needs) return null;");
    expect(src("src/app/Results.tsx")).not.toContain("if (!rows) return null;");
  });
});

describe("the demo bar", () => {
  it("says what is true of the public demo: invented data, shared changes that reset, no files, and the sample day", () => {
    const [who, change, day] = demoBarWords({ publicDemo: true, day: "2026-11-24" });
    expect(who).toBe("A sample company with invented data.");
    expect(change).toContain(NO_FILES);
    expect(change).toContain("gone when the demo restarts");
    expect(day).toBe(`Sample events are set around ${sampleDayWords("2026-11-24")}; days to go count from today.`);
    expect(sampleDayWords("2026-11-24")).toBe("Tue, 24 Nov 2026");
  });
  it("does not claim a refusal for a demo that is not public, and has no em dash", () => {
    const all = [...demoBarWords({ publicDemo: false, day: null }), ...demoBarWords({ publicDemo: true, day: "2026-11-24" })].join(" ");
    expect(demoBarWords({ publicDemo: false, day: null })[1]).not.toContain("does not take files");
    expect(all).not.toContain("\u2014");
  });
  it("is drawn above the app and can be hidden", () => {
    const app = src("src/app/App.tsx");
    expect(app).toContain("{demo && <DemoBar sample={sample} />}");
    expect(src("src/app/DemoBar.tsx")).toContain("sessionStorage");
  });
  it("is told by the server, from the desk's own mode", async () => {
    const pub = await (await createApp(db, { demo: true, publicDemo: true }).request("/api/health")).json() as { public_demo: boolean; sample_day: string | null };
    expect(pub.public_demo).toBe(true);
    const live = await (await createApp(db, { demo: false }).request("/api/health")).json() as { public_demo: boolean; sample_day: string | null };
    expect(live).toMatchObject({ public_demo: false, sample_day: null });
  });
  it("puts the refusal's own words on an upload before the click", () => {
    expect(NO_FILES).toBe("This public demo does not take files.");
    expect(src("src/app/Upload.tsx")).toContain("title={sample.publicDemo ? NO_FILES : undefined}");
    expect(src("src/app/Choosing.tsx")).toContain("title={sample.publicDemo ? NO_FILES : undefined}");
  });
});

describe("the first screen", () => {
  it("opens with one value line, one first step and a tour", () => {
    const html = renderToStaticMarkup(createElement(StartHere, { go: () => {} }));
    expect(html).toContain(VALUE_LINE);
    expect(html).toContain('href="/event/evt_money20-20-usa-2026#outreach"');
    expect(html).toContain("Take the tour");
    expect(TOUR_HIRING.length).toBeGreaterThanOrEqual(4);
    expect(TOUR_BUYER.length).toBeGreaterThanOrEqual(4);
    expect(TOUR_HIRING.length).toBeLessThanOrEqual(6);
    expect(TOUR_BUYER.length).toBeLessThanOrEqual(6);
  });
  it("ends the buyer's list with a next step that is a plain mailto link", () => {
    // Pinned to the exact address Bryan chose (2026-11-17); a changed address or subject must be a deliberate edit here.
    expect(CONTACT_URL).toBe("mailto:bryan@leandrive.io?subject=Events%20Desk%20demo");
    const html = renderToStaticMarkup(createElement(StartHere, { go: () => {} }));
    expect(NEXT_STEP).toBe("Next step: Write to Bryan about your own data");
    expect(html).toContain(`${NEXT_STEP_LEAD} <a href="${CONTACT_URL}">${NEXT_STEP_LINK}</a>`);
    // A mailto link opens the mail app: no new tab, no rel. The only other link is the first step.
    expect(html.match(/<a [^>]*>/g)).toEqual(['<a href="/event/evt_money20-20-usa-2026#outreach" class="btn">', `<a href="${CONTACT_URL}">`]);
    expect(html).not.toMatch(/mailto:[^>]*(target|rel)=/);
  });
  it("shows only in the demo", () => {
    expect(src("src/app/Overview.tsx")).toContain("{demo && <StartHere go={go} />}");
  });
  it("makes Request a seat a quiet control, not the loudest one", () => {
    expect(src("src/app/App.tsx")).toContain('className="btn line small side-cta">Request a seat');
    expect(src("src/app/Events.tsx")).toContain('className="btn line small phone-only">Request a seat');
  });
  it("explains the desk's words in one place, plain", () => {
    const html = renderToStaticMarkup(createElement(Glossary));
    for (const w of ["Case, Cases to settle", "Ledger, Trays, Timeline", "Acting as", "Scanner", "Held back by account owners", "Tier 1, 2, 3"]) expect(html).toContain(w);
    expect(WORDS.map((x) => x.join(" ")).join(" ")).not.toContain("\u2014");
  });
  it("shows what goes in an empty place, with an example marked as one", () => {
    const html = renderToStaticMarkup(createElement(Empty, { what: "Seat requests show here.", example: "Maya Ortiz asks for a seat." }));
    expect(html).toContain("Seat requests show here.");
    expect(html).toContain("<b>Example</b>");
  });
});

describe("tools by their job in the sample", () => {
  it("names a vendor in a real desk and says what it does in the sample", () => {
    setSampleTools(false);
    expect(toolName("instantly")).toBe("Instantly");
    expect(plainTools("Apollo keeps failing")).toBe("Apollo keeps failing");
    setSampleTools(true);
    try {
      expect(toolName("instantly")).toBe("email tool (sample)");
      expect(plainTools("Apollo keeps failing")).toBe("people finder (sample) keeps failing");
      expect(plainTools("Slack and ZeroBounce")).toBe("chat tool (sample) and email checker (sample)");
      expect(toolName("nothing", "the tool")).toBe("the tool");
    } finally { setSampleTools(false); }
  });
  it("calls a person's page a page, not a record", () => {
    expect(src("src/app/Objects.tsx")).not.toContain("'s record");
  });
});

describe("numbers that agreed with themselves", () => {
  it("shows one row for an event the seed made twice", () => {
    const a = { name: "Money20/20 Europe 2027", starts_on: "2027-06-08", approval_mode: "per_seat" as const, id: "a" };
    const b = { ...a, id: "b", approval_mode: "budget" as const };
    expect(oneRowEach([a, b]).map((e) => e.id)).toEqual(["b"]);
    expect(oneRowEach([a, { ...a, id: "c", starts_on: "2028-06-08" }]).map((e) => e.id)).toEqual(["a", "c"]);
  });
  it("says Declined everywhere an event is declined, never Ended", () => {
    expect(nextLine({ stage: "declined", decline_reason: "Not a priority" } as never)).toBe("Declined. Not a priority");
    expect(src("src/app/Overview.tsx")).toContain('words: "Declined"');
    expect(src("src/app/Plan.tsx")).toContain('judged: "Scored"');
    expect(src("src/shared/plan.ts")).toContain('judged: "Scored"');
  });
  it("tells booth meetings from people met, and a past booking from one coming up", () => {
    const m = src("src/app/Motion.tsx");
    expect(m).toContain('label="Meetings at the booth"');
    expect(m).toContain('`${num(o.captures.length)} ${o.captures.length === 1 ? "person" : "people"}`');
    expect(m).toContain("Date passed, not marked");
    expect(m).toContain("&& !passed(m)).length)} coming up");
  });
  it("does not print 0 reached beside meetings that were held in person", () => {
    expect(src("src/app/Overview.tsx")).toContain("met in person");
  });
});

describe("a plan is decided in the app when there is no Slack (decision 104)", () => {
  const body = (b: unknown) => JSON.stringify(b);
  it("an approver approves and declines through the panel route, and the maker cannot", async () => {
    const app = createApp(db, { demo: false });
    const id = await draftPlan(db);
    await submitPlan(db, CAMILLE, id);
    const post = (who: string, b: unknown) => app.request(`/api/events/${id}/plan/decision`, { method: "POST", headers: as(who), body: body(b) });
    expect((await post(CAMILLE, { decision: "approve" })).status).toBe(409);
    expect((await post(MAYA, { decision: "approve" })).status).toBe(409);
    expect((await post(DAN, { decision: "maybe" })).status).toBe(400);
    expect((await post(DAN, { decision: "approve" })).status).toBe(200);
    const [e] = await db.query<{ plan_approved_by: string }>("SELECT plan_approved_by FROM events WHERE id = $1", [id]);
    expect(e.plan_approved_by).toBe(DAN);
  });
  it("a decline needs a reason and moves the plan to declined", async () => {
    const app = createApp(db, { demo: false });
    const id = await draftPlan(db, { name: "No Thanks Summit" });
    await submitPlan(db, CAMILLE, id);
    const r = await app.request(`/api/events/${id}/plan/decision`, { method: "POST", headers: as(DAN), body: body({ decision: "decline", reason: "Outside this year's regions" }) });
    expect(r.status).toBe(200);
    expect((await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage).toBe("declined");
  });
  it("with Slack connected the decision route does not exist (the card is the one path)", async () => {
    const app = createApp(db, { demo: false, slack: { signingSecret: "s", botToken: "t", channel: "C", approvers: ["U1"] } as never });
    const id = await draftPlan(db, { name: "Slack Summit" });
    await submitPlan(db, CAMILLE, id);
    const r = await app.request(`/api/events/${id}/plan/decision`, { method: "POST", headers: as(DAN), body: body({ decision: "approve" }) });
    expect(r.status).toBe(404);
    expect((await db.query<{ plan_approved_by: string | null }>("SELECT plan_approved_by FROM events WHERE id = $1", [id]))[0].plan_approved_by).toBeNull();
  });
  it("a second decision is refused: approve twice changes nothing, decline after approve and decline twice are refused", async () => {
    const app = createApp(db, { demo: false });
    const id = await draftPlan(db, { name: "Twice Summit" });
    await submitPlan(db, CAMILLE, id);
    const post = (b: unknown) => app.request(`/api/events/${id}/plan/decision`, { method: "POST", headers: as(DAN), body: body(b) });
    expect((await post({ decision: "approve" })).status).toBe(200);
    const [first] = await db.query<{ plan_approved_at: string }>("SELECT plan_approved_at::text AS plan_approved_at FROM events WHERE id = $1", [id]);
    const again = await post({ decision: "approve" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { changed?: boolean }).changed).toBe(false);
    expect((await db.query<{ plan_approved_at: string }>("SELECT plan_approved_at::text AS plan_approved_at FROM events WHERE id = $1", [id]))[0].plan_approved_at).toBe(first.plan_approved_at);
    const late = await post({ decision: "decline", reason: "Changed my mind" });
    expect(late.status).toBe(409);
    expect(JSON.stringify(await late.json())).toContain("already approved");
    // A plan declined once cannot be declined again.
    const id2 = await draftPlan(db, { name: "Declined Twice Summit" });
    await submitPlan(db, CAMILLE, id2);
    const post2 = (b: unknown) => app.request(`/api/events/${id2}/plan/decision`, { method: "POST", headers: as(DAN), body: body(b) });
    expect((await post2({ decision: "decline", reason: "Not this year" })).status).toBe(200);
    expect((await post2({ decision: "decline", reason: "Not this year" })).status).toBe(409);
    expect((await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id2]))[0].stage).toBe("declined");
  });
  it("the desk says where decisions are taken: the app, unless Slack is connected", async () => {
    expect((await (await createApp(db, { demo: false }).request("/api/health")).json() as { decisions: string }).decisions).toBe("panel");
  });
  it("the plan page adds the plan and an abstract that wait for this person to Needs me now", () => {
    const plan = src("src/app/Plan.tsx");
    expect(plan).toContain('"The plan waits for your approval"');
    expect(plan).toContain("waits for a second person to approve it");
  });
});

describe("a planner closes plan against actual without the sending stage (decision 105)", () => {
  async function pastEvent(http: ReturnType<typeof createApp>) {
    const id = await deliverEvent(db, LIST, {}, "Old Summit");
    await db.query("UPDATE events SET starts_on = '2026-01-05', ends_on = '2026-01-07', catalog_id = NULL WHERE id = $1", [id]);
    void http;
    return id;
  }
  it("lets a planner close it, refuses a rep, and lists the closed result", async () => {
    const { connectors, tools } = await demoConnectors(db);
    const lifecycle: LifecycleDeps = { connectors, llm: mockLlm };
    const http = createApp(db, { demo: true, lifecycle, demoTools: tools });
    const id = await pastEvent(http);
    const close = (who: string) => http.request(`/api/events/${id}/plan/close`, { method: "POST", headers: as(who) });
    expect((await close(MAYA)).status).toBe(403);
    expect((await close(CAMILLE)).status).toBe(200);
    const [e] = await db.query<{ judged_by: string; motion: string }>("SELECT judged_by, motion FROM events WHERE id = $1", [id]);
    expect(e).toEqual({ judged_by: CAMILLE, motion: "none" });
    const rows = (await (await http.request("/api/results", { headers: as(DAN) })).json() as { events: { id: string }[] }).events;
    expect(rows.map((r) => r.id)).toContain(id);
    // A result a planner closed reads Scored, the word the Plan tab uses, not Closing (integrated week 2).
    expect((rows as { id: string; final: boolean }[]).find((r) => r.id === id)!.final).toBe(true);
  });
  it("the plan page offers the close to a planner once the event is over", () => {
    expect(src("src/app/Plan.tsx")).toContain("Close the result");
  });
});

describe("the last target account import stays on the desk", () => {
  it("keeps what was added, updated and left out, and why, for whoever opens the page next", async () => {
    const app = createApp(db, { demo: true });
    const csv = "name,domain\nAcme Payments,acme.example\n,nodomain.example\nBeta Ledger,beta.example\n";
    const r = await app.request("/api/target-accounts/import", { method: "POST", headers: { ...as(CAMILLE), "content-type": "text/csv" }, body: csv });
    expect(r.status).toBe(200);
    const read = await (await app.request("/api/target-accounts", { headers: as(DAN) })).json() as { last_import: { actor: string; row_count: number; added: number; updated: number; skipped: { row: number; why: string }[] } | null };
    expect(read.last_import).toMatchObject({ actor: CAMILLE, row_count: 3, added: 2, updated: 0 });
    expect(read.last_import!.skipped).toEqual([{ row: 3, why: "No name" }]);
    const again = await app.request("/api/target-accounts/import", { method: "POST", headers: { ...as(DAN), "content-type": "text/csv" }, body: "name,domain\nAcme Payments,acme.example\n" });
    expect(again.status).toBe(200);
    const next = await (await app.request("/api/target-accounts", { headers: as(CAMILLE) })).json() as { last_import: { actor: string; added: number; updated: number } };
    expect(next.last_import).toMatchObject({ actor: DAN, added: 0, updated: 1 });
  });
  it("shows it on the page, outside the session that uploaded", () => {
    expect(src("src/app/Choosing.tsx")).toContain("LastImportResult");
    expect(src("src/app/Choosing.tsx")).not.toContain("setDone");
  });
});

describe("open cases in one read", () => {
  it("counts the open cases of each event, with the first summary", async () => {
    const app = createApp(db, { demo: true });
    const id = await deliverEvent(db, LIST, {}, "Cases Summit");
    for (const n of [1, 2]) await db.query("INSERT INTO review_cases (id, event_id, kind, blocking, summary, facts, payload, options) VALUES ($1, $2, 'model_flag', false, $3, '[]', '{}', '[]')", [`case_${n}`, id, `Summary ${n}`]);
    await db.query("UPDATE review_cases SET status = 'skipped', decision = 'keep', decided_by = 'x', decided_at = now() WHERE id = 'case_2'");
    const r = await (await app.request("/api/cases/open")).json() as { events: { event_id: string; n: number; summary: string }[] };
    expect(r.events).toEqual([{ event_id: id, n: 1, summary: "Summary 1" }]);
  });
});

describe("small fixes from the review", () => {
  it("keeps the scanner's person under its own key", () => {
    const s = src("src/scan/ScanApp.tsx");
    expect(s).toContain('localStorage.setItem("scan-actor", a)');
    expect(s).not.toContain('localStorage.setItem("actor"');
  });
  it("says who a seat request went to, and not to the person who asked", () => {
    expect(sentTo({ approvers: ["Dan Whitlock", "Leo Marsh"] }, "Maya Ortiz")).toBe("Sent to Dan or Leo for approval. Their answer shows on your page.");
    expect(sentTo({ approvers: ["Dan Whitlock"] }, "Dan Whitlock")).toBe("Sent to an approver for approval. Their answer shows on your page.");
    expect(src("src/app/Events.tsx")).toContain("toast(sentTo(needs, actor))");
    expect(src("src/app/Seats.tsx")).toContain("toast(sentTo(needs, actor))");
  });
  it("shows why rows were set aside at the quoted stage as it does at mapped", () => {
    const e = src("src/app/Event.tsx");
    expect((e.match(/<DropReasons d=\{d\} \/>/g) ?? []).length).toBe(2);
  });
  it("links the scanner before the list is delivered", () => {
    expect(src("src/app/Event.tsx")).toContain("scanner={stage === \"declined\" ? undefined : <ScannerLink id={e.id} />}");
  });
  it("moves focus into the Request a seat dialog, and puts it back if the page behind takes it", () => {
    const f = src("src/app/RequestForm.tsx");
    expect(f).toContain("requestAnimationFrame(into)");
    expect(f).toContain("tabIndex={-1}");
  });
  it("lays a long title out so it cannot print over the status column", () => {
    const css = src("src/app/styles.css");
    expect(css).toMatch(/@media \(max-width: 1000px\) \{\s*\.tl-filters \.search/);
    expect(css).toMatch(/\.tl-track \{[^}]*overflow-x: clip/);
  });
});

describe("contrast", () => {
  it("every text colour in the stylesheets reads at 4.5:1, and small text at 7:1", () => {
    for (const args of [[], ["--strict"]]) expect(() => execFileSync("node", ["scripts/contrast.mjs", ...args], { stdio: "pipe" })).not.toThrow();
  });
});

describe("review fixes on the small things", () => {
  it("Close the result is offered only where the server would accept it (motion none)", () => {
    expect(src("src/app/Plan.tsx")).toContain('p.event.motion === "none"');
    expect(src("src/server/plan.ts")).toContain('hosted, motion: e.motion }');
    expect(src("src/server/plan.ts")).toContain('if (e.motion !== "none") throw new RuleError("This event\'s result closes when it is scored.")');
  });
  it("the skipped count is the rows left out, not the 200 kept", () => {
    expect(src("src/app/Choosing.tsx")).toContain("last.row_count - last.added - last.updated");
  });
  it("meetings coming up are counted from the sample day in the demo", () => {
    expect(src("src/app/Motion.tsx")).toContain("sample.day ? Date.parse(");
  });
});

describe("integrated week 2: small fixes on the desk's own screens", () => {
  it("asks before the result is closed, and states the goal against the result in one sentence", () => {
    const plan = src("src/app/Plan.tsx");
    expect(plan).toContain('import { ConfirmDialog } from "./Patterns"');
    expect(plan).toContain('<ConfirmDialog title="Close the result?"');
    expect(plan).toContain("Against the goal, the result is ");
    expect(plan).toContain("confirm: true, run: () => send(\"POST\", `/api/events/${id}/plan/close`");
    expect(plan).toContain("act.confirm ?");
  });
  it("the list on the Event page says where it came from", async () => {
    const id = await deliverEvent(db, LIST, {}, "Listed");
    const http = createApp(db, { demo: true });
    const d = await (await http.request(`/api/events/${id}`, { headers: as(CAMILLE) })).json() as { uploads: { list_source: string }[] };
    expect(d.uploads.length).toBeGreaterThan(0);
    expect(typeof d.uploads[0].list_source).toBe("string");
    const ev = src("src/app/Event.tsx");
    expect(ev).toContain("LIST_SOURCE_WORDS[u.list_source as ListSource]");
    expect(ev).toContain("{u.source && <>");
  });
  it("the person who wrote or edited an abstract is not offered to approve it", () => {
    const t = src("src/app/PlanTalk.tsx");
    expect(t).toContain("t.abstract_by === actor || (t.abstract_editors ?? []).includes(actor)");
    expect(t).toContain('a === "approve-abstract" && ownWords ? false');
  });
});
