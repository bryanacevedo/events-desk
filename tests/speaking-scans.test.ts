/* A scan picked "from the session" credits the talk (docs/SPEAKING.md 7); a talk that is not valid leaves the scan stored without it. */

import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import type { LifecycleDeps } from "../src/server/lifecycle-deps.ts";
import { mockLlm } from "../src/server/providers.ts";
import { ingestScan, listScans, scansCsv } from "../src/server/scans.ts";
import { speakingView, acceptTalk, approveAbstract, createTalk, saveTalk, submitTalk } from "../src/server/talks.ts";
import { fakeCrm } from "./lifecycle-harness.ts";
import { freshDb } from "./helpers.ts";
import { hostedDinner } from "./hosted-helpers.ts";
import { CAMILLE } from "./plan-helpers.ts";

const crm = { ...fakeCrm({ owner: "Dana Owner" }), write: async () => ({ id: "x" }) } as never;
const deps = { connectors: {}, llm: mockLlm, now: () => new Date("2027-06-10T22:00:00Z"), crm, userMap: {} } as never as LifecycleDeps;
const DAN = "Dan Whitlock", MAYA = "Maya Okafor";
let db: Db, ev: string, talk: string;
const vcard = (name: string, email: string) => `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nORG:Orrery\nTITLE:Head\nEMAIL:${email}\nEND:VCARD`;

beforeAll(async () => {
  db = await freshDb(); ev = await hostedDinner(db);
  talk = (await createTalk(db, CAMILLE, ev)).id;
  await saveTalk(db, CAMILLE, talk, { title: "Billing without surprises", abstract: "Words.", speaker: MAYA });
});

describe("credit from scans", () => {
  it("a talk that is not accepted gives no credit, and the scan is still stored", async () => {
    await ingestScan(db, deps, ev, MAYA, { id: "scan-early-0001", method: "badge_code", raw_payload: vcard("Ana Lima", "ana@orrery.example"), talk_id: talk });
    expect((await db.query<any>("SELECT talk_id FROM scans WHERE id = 'scan-early-0001'"))[0].talk_id).toBeNull();
  });
  it("an accepted talk is credited, shows on the scan list and the CSV, and a talk of another event is ignored", async () => {
    await approveAbstract(db, DAN, talk); await submitTalk(db, CAMILLE, talk, "2027-05-01"); await acceptTalk(db, DAN, talk);
    await ingestScan(db, deps, ev, MAYA, { id: "scan-late-00001", method: "badge_code", raw_payload: vcard("Bo Chen", "bo@orrery.example"), talk_id: talk });
    await ingestScan(db, deps, ev, MAYA, { id: "scan-else-00001", method: "badge_code", raw_payload: vcard("Cy Dunn", "cy@orrery.example"), talk_id: "tlk_unknown" });
    const l = await listScans(db, MAYA, ev);
    expect(l.scans.find((s) => s.id === "scan-late-00001")!.talk_title).toBe("Billing without surprises");
    expect(l.scans.find((s) => s.id === "scan-else-00001")!.talk_title).toBeNull();
    const csv = await scansCsv(db, MAYA, ev);
    expect(csv.split("\r\n")[0]).toMatch(/From the session$/);
    expect(csv).toContain("Billing without surprises");
    const t = (await speakingView(db, CAMILLE, "2027-06-10", { eventId: ev })).talks[0];
    expect(t.scans).toBe(1);
  });
  it("speaking reads hold no dollar key", async () => {
    expect(JSON.stringify(await speakingView(db, CAMILLE, "2027-06-10"))).not.toMatch(/cents/);
  });
});
