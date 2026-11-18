/* The demo's directory (src/server/seed-directory.ts): thirty extension reads on Money20/20 USA 2026, three to check each with a reason, and one finished Brella recording on Tokyo. */

import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { directoryPanel } from "../src/server/directory.ts";
import { DIRECTORY_EVENT, RECORDING_EVENT, SEED_RECORDING, seedDirectory } from "../src/server/seed-directory.ts";
import { seedPlan } from "../src/server/seed-plan.ts";
import { seedReal } from "../src/server/seed-real.ts";
import { freshDb } from "./helpers.ts";
import { TODAY } from "./plan-helpers.ts";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await seedReal(db);
  await seedPlan(db, { today: TODAY });
  await seedDirectory(db, { today: TODAY });
}, 120_000);

describe("the demo's directory reads", () => {
  it("puts thirty Swapcard reads on Money20/20, most staged and three to check, each with a reason", async () => {
    const rows = await db.query<{ state: string; check_reason: string | null; via: string; platform: string }>("SELECT state, check_reason, via, platform FROM directory_reads WHERE event_id = $1", [DIRECTORY_EVENT]);
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.via === "extension" && r.platform === "swapcard")).toBe(true);
    expect(rows.filter((r) => r.state === "staged")).toHaveLength(27);
    const held = rows.filter((r) => r.state === "to_check");
    expect(held.map((r) => r.check_reason).sort()).toEqual(["Name has a digit", "Name is one word", "No title or company"]);
    expect(rows.filter((r) => r.state === "staged").every((r) => r.check_reason === null)).toBe(true);
  });
  it("builds the source sentence and terms note the way the server does, never from the read", async () => {
    const [r] = await db.query<{ source_text: string; terms_note: string; read_on: string }>("SELECT source_text, terms_note, read_on::text AS read_on FROM directory_reads WHERE event_id = $1 ORDER BY id LIMIT 1", [DIRECTORY_EVENT]);
    expect(r.source_text).toBe(`read from the Swapcard directory of Money20/20 USA 2026 by Maya Okafor on ${r.read_on}`);
    expect(r.read_on).toBe("2026-11-12");
    expect(r.terms_note).toMatch(/^Terms/);
  });
  it("holds one finished Brella recording on Tokyo with five reads, one of them to check for low confidence, and a failed frame", async () => {
    const [rec] = await db.query<{ app_name: string; state: string; people: number; frames_sent: number; frames_read: number; frames_failed: number }>("SELECT * FROM recordings WHERE id = $1", [SEED_RECORDING]);
    expect(rec).toMatchObject({ app_name: "Brella", state: "done", people: 5, frames_sent: 6, frames_read: 5, frames_failed: 1 });
    const reads = await db.query<{ state: string; check_reason: string | null; source_text: string; via: string }>("SELECT state, check_reason, source_text, via FROM directory_reads WHERE event_id = $1", [RECORDING_EVENT]);
    expect(reads).toHaveLength(5);
    expect(reads.every((r) => r.via === "recording" && /^read from a screen recording of Brella for Salesforce World Tour Tokyo 2026 by Camille Laurent on 2026-11-12$/.test(r.source_text))).toBe(true);
    expect(reads.filter((r) => r.state === "to_check").map((r) => r.check_reason)).toEqual(["Read with low confidence"]);
  });
  it("shows on the Directory panel, and a second run adds nothing", async () => {
    await seedDirectory(db, { today: TODAY });
    expect((await db.query("SELECT 1 FROM directory_reads")).length).toBe(35);
    expect((await db.query("SELECT 1 FROM recordings")).length).toBe(1);
    expect((await db.query("SELECT 1 FROM recording_frames")).length).toBe(6);
    const p = await directoryPanel(db, DIRECTORY_EVENT, ["DE"], { can_read: false, reason: null });
    expect(p.counts).toMatchObject({ staged: 27, to_check: 3 });
    expect(p.staged).toHaveLength(27);
    const t = await directoryPanel(db, RECORDING_EVENT, ["DE"], { can_read: false, reason: null });
    expect(t.recordings).toHaveLength(1);
    expect(t.recordings[0].frames).toHaveLength(6);
    expect(t.recordings[0]).toMatchObject({ frames_failed: 1, people: 5 });
  });
  it("uses invented people only: no email, no real company on the list", async () => {
    const rows = await db.query<{ full_name: string; company: string | null }>("SELECT full_name, company FROM directory_reads");
    expect(new Set(rows.map((r) => r.full_name)).size).toBe(rows.length);
    expect(rows.some((r) => /@/.test(r.full_name))).toBe(false);
  });
});
