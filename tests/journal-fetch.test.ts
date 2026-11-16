/* docs/SHARED-WORLD.md 14.2: what the rehearsal writes down of Events Desk's calls to CRM Desk. */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalFetch, writesOf } from "../src/server/journal-fetch.ts";
import { crmDeskCrm } from "../src/server/crm-desk.ts";

const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });

describe("what is journaled", () => {
  it("keeps writes and drops GETs and the two reads made with POST", () => {
    expect(writesOf("POST", "/campaigns")).toBe(true);
    expect(writesOf("PATCH", "/activities/act_1")).toBe(true);
    expect(writesOf("PUT", "/contacts/by-email/a%40b.example")).toBe(true);
    expect(writesOf("GET", "/campaigns/ext:events_desk:x")).toBe(false);
    expect(writesOf("POST", "/contacts/contactability")).toBe(false);
    expect(writesOf("POST", "/accounts/lookup")).toBe(false);
  });

  it("writes the line the other desks write, never the key, and the adapter's real calls come out in order", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "jf-")), "j.jsonl");
    const seen: string[] = [];
    const inner = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${new URL(url).pathname}`);
      if (url.includes("/campaigns/ext:")) return reply(404, {});
      if (url.endsWith("/campaigns") && init.method === "POST") return reply(201, { id: "cmp_1" });
      if (url.includes("/members")) return reply(201, { id: "cmm_1", status: "declined" });
      return reply(200, {});
    }) as unknown as typeof fetch;
    const crm = crmDeskCrm("http://crm.test", "SECRET-KEY-VALUE", journalFetch(file, inner));
    expect(await crm.findCampaignByKey!("evt_1")).toBeNull();
    await crm.createCampaign!({ key: "evt_1", name: "Dinner", type: "event", start: "2026-10-19", end: "2026-10-19", parent: "cmp_0" } as never);
    await crm.createCampaignMember!({ campaign: "cmp_1", record: { id: "con_1" }, status: "declined" } as never);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(seen).toEqual(["GET /api/v1/campaigns/ext:events_desk:evt_1", "POST /api/v1/campaigns", "POST /api/v1/campaigns/cmp_1/members"]);
    expect(lines.map((l) => [l.actor, l.method, l.path, l.status])).toEqual([["events_desk", "POST", "/campaigns", 201], ["events_desk", "POST", "/campaigns/cmp_1/members", 201]]);
    expect(lines[0].body).toMatchObject({ name: "Dinner", type: "event", parent_id: "cmp_0", external_id: "evt_1" });
    expect(lines[1].body).toEqual({ contact: "con_1", status: "declined" });
    expect(Object.keys(lines[0]).sort()).toEqual(["actor", "answer", "body", "method", "path", "status"]);
    expect(readFileSync(file, "utf8")).not.toContain("SECRET-KEY-VALUE");
  });

  it("writes nothing when nothing is written", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "jf-")), "j.jsonl");
    await journalFetch(file, (async () => reply(200, {})) as unknown as typeof fetch)("http://crm.test/api/v1/definitions");
    expect(existsSync(file)).toBe(false);
  });
});
