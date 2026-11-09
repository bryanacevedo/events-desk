import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { createApp } from "../src/server/app.ts";
import { decideApproval, requestCard } from "../src/server/approvals.ts";
import { createEvent } from "../src/server/events.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors } from "../src/server/providers.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { finishTwoCard, freshDb } from "./helpers.ts";

const LIST = readFileSync("samples/attendees.csv", "utf8");
const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";

describe("reviewing one person from the screen", () => {
  let db: Db, id: string, app: ReturnType<typeof createApp>;
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  const post = (path: string, body: unknown, actor = MAYA) =>
    app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "x-actor": actor, "content-type": "application/json" } });
  const contacts = async () => (await (await app.request(`/api/events/${id}/contacts`)).json() as { contacts: { id: string; full_name: string; flags: string[]; drop_reason: string | null }[] }).contacts;

  beforeEach(async () => {
    db = await freshDb();
    app = createApp(db, { demo: true });
    id = (await createEvent(db, MAYA, { name: "T", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100 })).id;
    await decideApproval(db, { approvalId: await pending(), actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", LIST);
  });

  it("refuses until the list is delivered", async () => {
    const [c] = await contacts();
    const r = await post(`/api/events/${id}/contacts/${c.id}/review`, { decision: "drop" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/not delivered/);
    expect((await contacts()).find((x) => x.id === c.id)!.drop_reason).toBeNull();
  });

  it("drops as rejected_in_review, keeps by clearing the flags, and lists flags on the contacts route", async () => {
    await finishTwoCard(db, id);
    const kept = (await contacts()).filter((c) => !c.drop_reason);
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.every((c) => Array.isArray(c.flags))).toBe(true);

    const flagged = kept.find((c) => c.flags.length) ?? kept[0];
    await db.query("INSERT INTO review_flags (contact_id, flag, source) VALUES ($1, 'name_looks_wrong', 'code') ON CONFLICT DO NOTHING", [flagged.id]);
    expect((await contacts()).find((c) => c.id === flagged.id)!.flags).toContain("name_looks_wrong");

    const keep = await post(`/api/events/${id}/contacts/${flagged.id}/review`, { decision: "keep" });
    expect(keep.status).toBe(200);
    expect(await keep.json()).toEqual({ dropped: 0, kept: 1 });
    const afterKeep = (await contacts()).find((c) => c.id === flagged.id)!;
    expect(afterKeep.flags).toEqual([]);
    expect(afterKeep.drop_reason).toBeNull();

    const other = kept.find((c) => c.id !== flagged.id)!;
    const drop = await post(`/api/events/${id}/contacts/${other.id}/review`, { decision: "drop" });
    expect(await drop.json()).toEqual({ dropped: 1, kept: 0 });
    expect((await contacts()).find((c) => c.id === other.id)!.drop_reason).toBe("rejected_in_review");
    // A second drop changes nothing, like a repeated row in the imported Review tab.
    expect(await (await post(`/api/events/${id}/contacts/${other.id}/review`, { decision: "drop" })).json()).toEqual({ dropped: 0, kept: 0 });

    const bad = await post(`/api/events/${id}/contacts/${other.id}/review`, { decision: "maybe" });
    expect(bad.status).toBe(400);
    const log = await db.query<{ detail: string }>("SELECT detail FROM activity_log WHERE event_id = $1 AND kind = 'review' ORDER BY created_at", [id]);
    expect(log.map((l) => l.detail)).toEqual([`Kept ${flagged.full_name} in review`, `Dropped ${other.full_name} in review`]);
  });
});
