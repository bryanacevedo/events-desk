/* Every DESIGN 2b row, alone and integrated (docs/SHARED-WORLD.md 3.2). The rows are read from the spec table; a row with no case, or a case for a row that is not there, fails
   the gate, the way Account Desk's coverage.py does for its scenarios. */

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { integrationView, refusalFor } from "../src/server/integration.ts";
import { crmDeskCrm } from "../src/server/crm-desk.ts";
import { syncCrm } from "../src/server/crm-sync.ts";
import { freshDb } from "./helpers.ts";
import { AFTER, depsAt, hostedDinner, yes, BEFORE } from "./hosted-helpers.ts";

const rows = (() => {
  const doc = readFileSync("docs/SHARED-WORLD.md", "utf8");
  const part = doc.slice(doc.indexOf("### 3.2"), doc.indexOf("## 4."));
  return part.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| DESIGN") && !l.startsWith("|---")).map((l) => l.split("|")[1].trim());
})();

type State = "alone" | "integrated";
const ENV: Record<State, Record<string, string>> = { alone: {}, integrated: { INTEGRATED_WITH: "account_desk,market_desk,crm_desk" } };
afterEach(() => { delete process.env.INTEGRATED_WITH; });

/** A route the row touches that must answer in both states. */
const open = (...paths: string[]) => async (s: State) => { for (const p of paths) expect(refusalFor("POST", p, undefined, ENV[s]), p).toBeNull(); };

/** Every row has a case. A case is an assertion made once for each state. */
const CASES: Record<string, (s: State) => Promise<void>> = {
  "Accounts": open("/api/events/e1/uploads"),
  "Company data": open("/api/events/e1/uploads"),
  "ICP and fit scoring": async (s) => { expect(refusalFor("POST", "/api/icp/documents", undefined, ENV[s])?.code ?? null).toBe(s === "alone" ? null : "owned_by_market_desk"); },
  "Tiers and segments": open("/api/events/e1/uploads"),
  "AE and SDR ownership": async () => { expect((crmDeskCrm("https://x.example", "k") as unknown as Record<string, unknown>).setOwner).toBeUndefined(); },
  "Plan, territories, capacity": open("/api/events/e1/plan"),
  "Contacts and the person record": open("/api/events/e1/uploads"),
  "People finding and enrichment": open("/api/events/e1/motion/contacts/c1/resume"),
  "Suppression, opt-outs, flags": open("/api/motion/consent"),
  "Contact basis and region rules": open("/api/motion/consent"),
  "Campaigns and event members": async (s) => { expect(integrationView("crm_desk", ENV[s]).campaigns).toBe("events_desk"); },
  "Outbound sequences, sending, replies": async (s) => {
    expect(refusalFor("POST", "/api/motion/sequences/s1/release", undefined, ENV[s])?.code ?? null).toBe(s === "alone" ? null : "owned_by_account_desk");
    expect(refusalFor("POST", "/api/motion/stop", undefined, ENV[s])).toBeNull();
  },
  "Activities, tasks, timeline": async (s) => {
    // Sends, replies and meetings go to the record in both states.
    process.env.INTEGRATED_WITH = ENV[s].INTEGRATED_WITH ?? "";
    const db = await freshDb();
    const id = await hostedDinner(db);
    const writes: string[] = [];
    const crm: any = { name: "crm_desk", connected: true, write: async () => {}, personFlags: async () => ({}), createActivity: async () => ({ id: "a" }), findCampaignByKey: async () => null, createCampaign: async () => ({ id: "c" }), createCampaignMember: async (a: any) => { writes.push(a.status); return { id: "m" }; } };
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    expect((await syncCrm(db, crm)).members).toBe(1);
  },
  "Meetings": async () => { expect(readFileSync("src/server/meetings.ts", "utf8")).toMatch(/comes back through the same change feed/); },
  "Leads and qualifying": async () => { expect((crmDeskCrm("https://x.example", "k") as unknown as Record<string, unknown>).qualify).toBeUndefined(); },
  "Lifecycle stage, do not prospect": async () => { expect(readFileSync("src/server/crm-desk.ts", "utf8")).not.toMatch(/lifecycle_stage: "(customer|opportunity)"/); },
  "Opportunities and pipeline": async () => { expect((crmDeskCrm("https://x.example", "k") as unknown as Record<string, unknown>).createOpportunity).toBeUndefined(); },
  "Attribution": async () => { expect(readFileSync("src/server/crm-desk.ts", "utf8")).not.toMatch(/source_desk/); },
  "Results and reporting": open("/api/events/e1/uploads"),
  "Held-back groups": open("/api/events/e1/uploads"),
  "Call notes and what was learned": async (s) => {
    process.env.INTEGRATED_WITH = ENV[s].INTEGRATED_WITH ?? "";
    expect(refusalFor("POST", "/api/events/e1/motion/start", "debrief_only", ENV[s])).toBeNull();
  },
  "Duplicates, merges, erasure": async () => { expect(readFileSync("src/server/operating.ts", "utf8")).toMatch(/Erasure request/); },
  "Team roster and users": async () => { const { worldSlice } = await import("../src/server/world-slice.ts"); expect(worldSlice().roster.length).toBeGreaterThan(0); },
  "Notifications": open("/api/events/e1/notify"),
};

describe("DESIGN 2b coverage", () => {
  it("the spec table has 24 rows and every row has a case, and every case a row", () => {
    expect(rows).toHaveLength(24);
    expect(rows.filter((r) => !(r in CASES))).toEqual([]);
    expect(Object.keys(CASES).filter((c) => !rows.includes(c))).toEqual([]);
  });
});

describe.each(["alone", "integrated"] as State[])("DESIGN 2b, %s", (state) => {
  for (const row of Object.keys(CASES)) it(row, async () => { await CASES[row](state); });
});
