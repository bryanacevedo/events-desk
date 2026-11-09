import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { freshDb } from "./helpers.ts";
import { createEvent, moveEvent, RuleError } from "../src/server/events.ts";
import { GOOGLE_SIGN_INS, LIVE_REQUIRED, resolveMode } from "../src/server/modes.ts";
import { moveError } from "../src/shared/domain.ts";

describe("stage rules", () => {
  it("allows the approved path and refuses skipping an approval", () => {
    expect(moveError({ stage: "requested", paused_from: null }, "approved")).toBeNull();
    expect(moveError({ stage: "requested", paused_from: null }, "tiering")).toMatch(/cannot go/);
    expect(moveError({ stage: "mapped", paused_from: null }, "tiering")).toMatch(/cannot go/);
  });
  it("returns a declined cost card to mapped so it can be re-quoted", () => {
    expect(moveError({ stage: "quoted", paused_from: null }, "mapped")).toBeNull();
  });
  it("needs a reason to decline", () => {
    expect(moveError({ stage: "requested", paused_from: null }, "declined", "  ")).toMatch(/why/);
    expect(moveError({ stage: "requested", paused_from: null }, "declined", "Over budget")).toBeNull();
  });
  it("resumes a paused event only where it paused", () => {
    expect(moveError({ stage: "paused", paused_from: "enriching" }, "enriching")).toBeNull();
    expect(moveError({ stage: "paused", paused_from: "enriching" }, "flagging")).toMatch(/only resume/);
  });
  it("treats delivered and declined as terminal", () => {
    expect(moveError({ stage: "delivered", paused_from: null }, "paused")).toMatch(/cannot go/);
    expect(moveError({ stage: "declined", paused_from: null }, "requested")).toMatch(/cannot go/);
  });
});

describe("modes", () => {
  const keys = { DATABASE_URL: "postgres://real", LIVE_SPEND: "1", ANTHROPIC_API_KEY: "x" };
  it("--demo ignores every exported database and spend setting", () => {
    expect(resolveMode(["--demo"], keys)).toEqual({ demo: true, liveSpend: false });
  });
  it("refuses live spend while any key, Slack setting or database is missing", () => {
    const all = { ...Object.fromEntries(LIVE_REQUIRED.map((k) => [k, "x"])), ...Object.fromEntries(GOOGLE_SIGN_INS.oauth.map((k) => [k, "x"])), SLACK_USER_MAP: '{"Maya Ortiz":"U01ABC"}' };
    expect(resolveMode([], { ...all, LIVE_SPEND: "1" }).liveSpend).toBe(true);
    // A cost card is confirmed by the uploader, and the Slack user is the proof, so the person-to-Slack map must be real JSON of real-looking IDs.
    for (const bad of ["not json", "{}", '{"Maya Ortiz": "maya"}', '["U01ABC"]']) expect(() => resolveMode([], { ...all, SLACK_USER_MAP: bad, LIVE_SPEND: "1" }), bad).toThrow(/SLACK_USER_MAP/);
    for (const k of LIVE_REQUIRED) expect(() => resolveMode([], { ...all, [k]: " ", LIVE_SPEND: "1" })).toThrow(new RegExp(k));
  });
});

describe("events in Postgres", () => {
  let db: Db;
  const sample = { name: "Test Forum", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 5000 };
  beforeEach(async () => {
    db = await freshDb();
  });

  it("logs creation and every move", async () => {
    const e = await createEvent(db, "Maya", sample);
    await moveEvent(db, e.id, "approved", "Dan");
    const log = await db.query<{ kind: string }>("SELECT kind FROM activity_log WHERE event_id = $1", [e.id]);
    expect(log.map((l) => l.kind).sort()).toEqual(["requested", "stage"]);
  });
  it("refuses an illegal move and changes nothing", async () => {
    const e = await createEvent(db, "Maya", sample);
    await expect(moveEvent(db, e.id, "tiering", "Dan")).rejects.toBeInstanceOf(RuleError);
    const [row] = await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [e.id]);
    expect(row.stage).toBe("requested");
  });
  it("records where a pause came from and clears it on resume", async () => {
    const e = await createEvent(db, "Maya", sample);
    await db.query("UPDATE events SET stage = 'enriching' WHERE id = $1", [e.id]);
    expect((await moveEvent(db, e.id, "paused", "system")).paused_from).toBe("enriching");
    const resumed = await moveEvent(db, e.id, "enriching", "Dan");
    expect(resumed.stage).toBe("enriching");
    expect(resumed.paused_from).toBeNull();
  });
  it("Postgres itself refuses a declined event with no reason", async () => {
    const e = await createEvent(db, "Maya", sample);
    await expect(db.query("UPDATE events SET stage = 'declined' WHERE id = $1", [e.id])).rejects.toThrow(/declined_needs_reason/);
  });
});
