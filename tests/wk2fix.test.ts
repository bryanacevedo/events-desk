/* Integrated week 2, Events Desk fixes (branch wk2fix/events-desk): one list of what waits on a person, a seat approval that asks first and keeps a note, a reminder signed by the person
   sending it, a follow-up date a person may set, set-aside people by reason, the walk-in's owner, and the small screen fixes. Routes are called in process; screens are read as source. */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { patchOrganizerRequest } from "../src/server/assessment.ts";
import type { Db } from "../src/server/db.ts";
import { waitingOn } from "../src/server/seat-routes.ts";
import { decideSeat } from "../src/server/seats.ts";
import { createPlan, submitPlan } from "../src/server/plan.ts";
import { createTalk, saveTalk } from "../src/server/talks.ts";
import { reminderPreview, sendReminder } from "../src/server/hosted-reminders.ts";
import { NO_SENDER } from "../src/server/transactional.ts";
import { walkIn } from "../src/server/hosted.ts";
import { PERSONAS } from "../src/shared/roles.ts";
import { deliverEvent, freshDb } from "./helpers.ts";
import { LIST } from "./lifecycle-harness.ts";
import { depsAt, hostedDinner, ON_THE_DAY, BEFORE, yes } from "./hosted-helpers.ts";
import { as, CAMILLE, DAN, draftPlan, MAYA } from "./plan-helpers.ts";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("J10: one page for what waits on a person", () => {
  it("lists seats, plans and abstracts an approver can decide, each with its event, and leaves out their own", async () => {
    const http = createApp(db, { demo: false });
    const ask = await http.request("/api/seat-requests", { method: "POST", headers: as(MAYA), body: JSON.stringify({ suggestion: { name: "Decide Summit", website: "https://decide.example", starts_on: "2027-02-01", ends_on: "2027-02-02", city: "Lisbon", country: "Portugal", price_dollars: 900 }, team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are who we sell to.", why_you: "I run outreach for this region.", expected_meetings: 4 }) });
    expect([200, 201]).toContain(ask.status);
    const planId = await draftPlan(db, { name: "Waiting Summit" });
    await submitPlan(db, CAMILLE, planId);
    const talkEvent = await draftPlan(db, { name: "Talk Summit" });
    const t = await createTalk(db, CAMILLE, talkEvent);
    await saveTalk(db, CAMILLE, t.id, { title: "Billing without surprises", abstract: "How finance sees the number first.", speaker: MAYA });

    const dan = await waitingOn(db, DAN);
    expect(dan.plans.map((p) => p.event)).toEqual(["Waiting Summit"]);
    expect(dan.plans[0]).toMatchObject({ event_id: planId, who: CAMILLE });
    expect(dan.abstracts.map((a) => a.title)).toEqual(["Billing without surprises"]);
    expect(dan.total).toBe(dan.seats.length + 1 + 1);
    // The person who wrote the abstract is not asked to approve it, and the person who asked for the plan is not asked to approve it.
    const camille = await waitingOn(db, CAMILLE);
    expect(camille.plans).toEqual([]);
    expect(camille.abstracts).toEqual([]);
    // Someone who approves nothing sees nothing.
    expect((await waitingOn(db, "Leo Marsh")).total).toBe(0);
    const res = await http.request("/api/waiting", { headers: as(DAN) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(dan.total);
  });

  it("the screen links each row to its event and a seat to its own request", () => {
    const page = src("src/app/SeatDecisions.tsx");
    expect(page).toContain("`/event/${p.event_id}#plan`");
    expect(page).toContain('new URLSearchParams(location.search).get("request")');
    expect(src("src/app/Seats.tsx")).toContain("`/seat-decisions?request=${r.id}`");
    // The badge refetches on every page change, so an approval on an event page is counted.
    expect(src("src/app/App.tsx")).toMatch(/\/api\/waiting"\)[^\n]*\[actor, needs\?\.requests\.length, pathname\]\)/);
    expect(src("scripts/build-static-snapshot.ts")).toContain('"/api/waiting"');
  });

  it("My day shows a hosted event's guests in pages of eight", () => {
    const d = src("src/app/MyDay.tsx");
    expect(d).toContain("const GUESTS_SHOWN = 8;");
    expect(d).toContain("rows.slice(0, GUESTS_SHOWN)");
  });
});

describe("m14: a seat approval asks first and keeps a note", () => {
  it("writes the note on the event's activity and never as a decline reason", async () => {
    const http = createApp(db, { demo: false });
    const ask = await http.request("/api/seat-requests", { method: "POST", headers: as(MAYA), body: JSON.stringify({ suggestion: { name: "Note Summit", website: "https://note.example", starts_on: "2027-02-01", ends_on: "2027-02-02", city: "Lisbon", country: "Portugal", price_dollars: 900 }, team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are who we sell to.", why_you: "I run outreach for this region.", expected_meetings: 4 }) });
    const { id, event_id } = (await ask.json()) as { id: string; event_id: string };
    await decideSeat(db, { requestId: id, actor: DAN, decision: "approve", reason: "Go, and book the booth tour." });
    const [r] = await db.query<{ status: string; decline_reason: string | null }>("SELECT status, decline_reason FROM seat_requests WHERE id = $1", [id]);
    expect(r).toEqual({ status: "approved", decline_reason: null });
    const lines = (await db.query<{ detail: string }>("SELECT detail FROM activity_log WHERE event_id = $1", [event_id])).map((x) => x.detail);
    expect(lines.some((l) => l.includes("Approved Maya Okafor's seat: Go, and book the booth tour."))).toBe(true);
  });
  it("the Approve button opens a dialog that states the cost, and the same dialog serves both seat screens", () => {
    const seats = src("src/app/Seats.tsx");
    expect(seats).toContain("export function ApproveSeat");
    expect(seats).toContain("setApproving(true)");
    expect(seats).not.toMatch(/onClick=\{\(\) => decide\("approve"\)\}/);
    const page = src("src/app/SeatDecisions.tsx");
    expect(page).toContain("<ApproveSeat");
    expect(page).not.toMatch(/onClick=\{\(\) => decide\("approve"\)\}/);
  });
});

describe("m12, m13, m11, m20: small screen fixes", () => {
  it("the made plan says so, Approve the plan says what else it approves, the talk has one word for one action", () => {
    expect(src("src/app/Events.tsx")).toContain('toast("The plan is made.');
    const plan = src("src/app/Plan.tsx");
    expect(plan).toContain("also approves the ${plural(seatsWithIt");
    expect(plan).toContain("onConfirm={go}");
    const talk = src("src/app/PlanTalk.tsx");
    expect(talk).not.toContain("Make the words");
    expect(talk).toContain("setEditing(true); }}>Write the words</button>");
  });
  it("a dialog remembers the button that opened it before focus moves into it", () => {
    const p = src("src/app/Patterns.tsx");
    expect(p.indexOf("const back = document.activeElement")).toBeLessThan(p.indexOf('querySelector<HTMLElement>("[data-keep]")?.focus()'));
  });
});

describe("m16: a reminder is signed by the person sending it and a missing sender is said plainly", () => {
  it("signs with the actor, not the host, and the refusal names no setting", async () => {
    const id = await hostedDinner(db);
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    const preview = await reminderPreview(db, id, "reminder", { actor: MAYA });
    expect(preview.body.trimEnd().split("\n").at(-1)).toBe(MAYA);
    const sent = await sendReminder(db, depsAt(BEFORE), MAYA, id, "reminder");
    expect(sent.sent).toBeGreaterThan(0);
    const [row] = await db.query<{ body: string }>("SELECT body FROM transactional_outbox WHERE event_id = $1 LIMIT 1", [id]);
    expect(row.body.trimEnd().split("\n").at(-1)).toBe(MAYA);
    expect(NO_SENDER).not.toMatch(/TRANSACTIONAL|KEY|URL/);
    await expect(sendReminder(db, { now: () => BEFORE, live: true }, CAMILLE, id, "reminder")).rejects.toThrow(/no email sender is connected/);
  });
});

describe("m17: a walk-in is owned by the person at the door, and the screen says it was added", () => {
  it("defaults the owner to whoever adds them, not the host", async () => {
    const id = await hostedDinner(db);
    const w = await walkIn(db, depsAt(ON_THE_DAY), "Leo Marsh", id, { name: "Walt Inn" });
    expect((await db.query<{ owner: string }>("SELECT owner FROM event_guests WHERE id = $1", [w.id]))[0].owner).toBe("Leo Marsh");
    const c = src("src/app/CheckIn.tsx");
    expect(c).toContain("owner: actor, email");
    expect(c).toContain("is checked in as a walk-in.");
  });
});

describe("m18: the follow-up date can be set", () => {
  it("keeps the date a person sets, refuses one before the day it was sent, and computes one when none is set", async () => {
    const id = await draftPlan(db, { name: "Ask Summit" });
    const [r] = await db.query<{ id: string }>("INSERT INTO organizer_requests (id, event_id, template, subject, body, status, created_by) VALUES ('org_t1', $1, 'ask_for_list', 's', 'b', 'copied', 'Camille Laurent') RETURNING id", [id]);
    const out = await patchOrganizerRequest(db, CAMILLE, id, r.id, { sent_on: "2027-01-10", expected_on: "2027-01-20", follow_up_on: "2027-01-15" });
    expect(out.follow_up_on).toBe("2027-01-15");
    // Moving the sent day past a hand-set date drops it instead of failing the save.
    expect((await patchOrganizerRequest(db, CAMILLE, id, r.id, { sent_on: "2027-01-18" })).follow_up_on).toBe("2027-01-21");
    await patchOrganizerRequest(db, CAMILLE, id, r.id, { sent_on: "2027-01-10", follow_up_on: "2027-01-15" });
    await expect(patchOrganizerRequest(db, CAMILLE, id, r.id, { follow_up_on: "2027-01-05" })).rejects.toThrow(/before the day it was sent/);
    // A later save that does not touch the follow-up date keeps the one set by hand.
    expect((await patchOrganizerRequest(db, CAMILLE, id, r.id, { status: "will_share", expected_on: "2027-01-25" })).follow_up_on).toBe("2027-01-15");
    expect((await patchOrganizerRequest(db, CAMILLE, id, r.id, { follow_up_on: null })).follow_up_on).toBe("2027-01-26");
    expect(src("src/app/PlanAssessment.tsx")).toContain("Follow up on");
  });
});

describe("J11: set-aside people by reason, merged scans", () => {
  it("the people list filters dropped people by their reason", async () => {
    const id = await deliverEvent(db, LIST, {}, "Reasons");
    await db.query("UPDATE contacts SET dropped_at = now(), drop_reason = 'duplicate' WHERE id = (SELECT id FROM contacts WHERE event_id = $1 AND source = 'attendee' ORDER BY id LIMIT 1)", [id]);
    await db.query("UPDATE contacts SET dropped_at = now(), drop_reason = 'low_priority' WHERE id = (SELECT id FROM contacts WHERE event_id = $1 AND source = 'attendee' AND dropped_at IS NULL ORDER BY id LIMIT 1)", [id]);
    const http = createApp(db, { demo: true });
    const get = async (qs: string) => (await (await http.request(`/api/events/${id}/people?${qs}`, { headers: as(CAMILLE) })).json()) as { total: number; rows: { drop_reason: string }[] };
    expect((await get("status=dropped")).total).toBe(2);
    const one = await get("status=dropped&reason=duplicate");
    expect(one.total).toBe(1);
    expect(one.rows[0].drop_reason).toBe("duplicate");
  });
  it("a scan the near-match review merged says so", () => {
    expect(src("src/app/Scanner.tsx")).toContain('r.review === "same" ? "Merged with another scan"');
    expect(src("src/app/Event.tsx")).toContain("go(`${location.pathname}?s=dropped&r=");
  });
});

describe("J12, J13, m15: Outreach rows, the typed badge code, the deliverable editor", () => {
  it("a row Account Desk owns says there is nothing yet when no fold answers it", () => {
    const m = src("src/app/Motion.tsx");
    expect(m).toContain("nothing yet: Account Desk has not reported back");
    expect(m).toContain("const openFold = (title: string): boolean =>");
  });
  it("the scanner has a box to type the badge code", () => {
    const s = src("src/scan/ScanApp.tsx");
    expect(s).toContain("Type the code");
    expect(s).toContain('aria-label="Badge code"');
    expect(s).toContain("(typing || state === \"blocked\" || state === \"frozen\")");
  });
  it("the deliverable owner offers the team, and rows keep their place while saving", () => {
    const d = src("src/app/PlanSponsor.tsx");
    expect(d).toContain('list="deliverable-owners"');
    expect(d).toContain("order.current.indexOf(d.id)");
    expect(src("src/app/styles.css")).toContain(".pl-line.pl-nokind");
  });
});

describe("J15 and CI: the SDR is Maya Okafor, the smoke step waits up to 90 s", () => {
  it("no screen, seed or demo person is called Maya Ortiz, and the picker carries Maya Okafor", () => {
    expect(PERSONAS.map((p) => p.name)).toContain("Maya Okafor");
    for (const f of ["src/shared/roles.ts", "src/server/seed.ts", "src/server/demo-run.ts", "src/server/node.ts", "src/app/PersonAvatar.tsx"]) expect(src(f)).not.toContain("Maya Ortiz");
    expect(src("src/app/PersonAvatar.tsx")).toContain('"Maya Okafor": "/avatars/maya-okafor.jpg"');
  });
  it("the boot smoke step in CI loops 90 times", () => {
    expect(src(".github/workflows/ci.yml")).toContain("for i in $(seq 1 90); do curl -sf localhost:8787/api/health");
  });
});

describe("J11: where a person stands in CRM Desk, read from the outbox", () => {
  it("each person row carries the latest member row for this event and address, and the screen says it in words", async () => {
    const id = await deliverEvent(db, LIST, {}, "Handover");
    const [a, b] = await db.query<{ email: string }>("SELECT lower(email) AS email FROM contacts WHERE event_id = $1 AND source = 'attendee' AND email IS NOT NULL ORDER BY email LIMIT 2", [id]);
    const row = (key: string, email: string, status: string, at: string) => db.query("INSERT INTO crm_outbox (id, kind, payload, desk_key, status, created_at) VALUES ($1, 'campaign_member', $2::jsonb, $1, $3, $4::timestamptz)", [key, JSON.stringify({ email, event_id: id }), status, at]);
    await row("o1", a.email, "queued", "2026-11-01T10:00:00Z");
    await row("o2", a.email, "done", "2026-11-02T10:00:00Z");
    await row("o3", b.email, "held", "2026-11-02T10:00:00Z");
    const http = createApp(db, { demo: true });
    const res = (await (await http.request(`/api/events/${id}/people?status=all&limit=50`, { headers: as(CAMILLE) })).json()) as { rows: { email: string; crm: string | null }[] };
    expect(res.rows.find((r) => r.email.toLowerCase() === a.email)?.crm).toBe("done");
    expect(res.rows.find((r) => r.email.toLowerCase() === b.email)?.crm).toBe("held");
    expect(res.rows.filter((r) => r.crm === null).length).toBe(res.rows.length - 2);
    expect(src("src/app/Event.tsx")).toContain('done: "in the CRM"');
    const [ix] = await db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE indexname = 'crm_outbox_member_person'");
    expect(ix?.indexname).toBe("crm_outbox_member_person");
  });
});

describe("m15: bulk owner and due day on the open deliverables", () => {
  it("the editor patches only the fields filled in, on every deliverable not yet done", () => {
    const d = src("src/app/PlanSponsor.tsx");
    expect(d).toContain("Set on all open");
    expect(d).toContain("const open = items.filter((d) => !d.done);");
    expect(d).toContain('if (all.owner.trim()) body.owner = all.owner.trim();');
    expect(d).toContain("`Set on ${set} of ${open.length}. ${failed}`");
    expect(d).toContain('else setAll({ owner: "", due: "" });');
  });
});
