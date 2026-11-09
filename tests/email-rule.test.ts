import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { VendorError, mockVendors, type Verifier } from "../src/server/providers.ts";
import { buildWorkbook } from "../src/server/workbook.ts";
import type { Settings } from "../src/shared/cost.ts";
import type { Verdict } from "../src/shared/tiers.ts";
import { deliverEvent, freshDb } from "./helpers.ts";

const LIST = "Company Name,Full Name,Job Title,Work Email\nTallgrass Software,Real Person,VP Sales,a@tallgrass.example\nTallgrass Software,Other Person,VP Sales,b@tallgrass.example\n";
const verifiers = (first: () => Promise<Verdict>, second: () => Promise<Verdict> = async () => "deliverable") => (s: Settings) => {
  const v = mockVendors(s);
  const mk = (x: Verifier, f: () => Promise<Verdict>): Verifier => ({ ...x, verify: async () => ({ verdict: await f(), charged: x.cost }) });
  v.verifiers = [mk(v.verifiers[0], first), mk({ name: "second_verifier", cost: 1 } as Verifier, second)];
  return v;
};

async function outcome(vendorsFor: (s: Settings) => ReturnType<typeof mockVendors>) {
  const db = await freshDb();
  // The single-card flow's email rule: an uncertain answer is email_unconfirmed. The two-card flow's rules (catch_all_unconfirmed and the rest) are in tests/email.test.ts.
  const id = await deliverEvent(db, LIST, { vendorsFor }, "T", "single_card");
  const rows = await db.query<{ drop_reason: string | null }>("SELECT drop_reason FROM contacts WHERE event_id = $1", [id]);
  return { db, id, reasons: rows.map((r) => r.drop_reason) };
}

describe("an email must be certainly valid", () => {
  it("keeps a contact only when both verifiers say deliverable", async () => {
    expect((await outcome(verifiers(async () => "deliverable"))).reasons).toEqual([null, null]);
  });
  it.each(["catch_all", "unknown"] as Verdict[])("drops %s from the first verifier as email_unconfirmed and skips the second", async (v) => {
    let second = 0;
    const o = await outcome(verifiers(async () => v, async () => { second++; return "deliverable"; }));
    expect(o.reasons).toEqual(["email_unconfirmed", "email_unconfirmed"]);
    expect(second).toBe(0);
  });
  it("drops catch-all or unknown from the second verifier too", async () => {
    expect((await outcome(verifiers(async () => "deliverable", async () => "catch_all"))).reasons).toEqual(["email_unconfirmed", "email_unconfirmed"]);
  });
  it("drops a verifier error as email_unconfirmed", async () => {
    const o = await outcome(verifiers(async () => { throw new VendorError("unknown"); }));
    expect(o.reasons).toEqual(["email_unconfirmed", "email_unconfirmed"]);
  });
  it("keeps undeliverable as not_deliverable", async () => {
    expect((await outcome(verifiers(async () => "undeliverable"))).reasons).toEqual(["not_deliverable", "not_deliverable"]);
  });
  it("leaves no Email confidence column and no uncertain flags", async () => {
    const o = await outcome(verifiers(async () => "deliverable"));
    expect((await o.db.query("SELECT 1 FROM review_flags WHERE flag = 'uncertain_email'")).length).toBe(0);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildWorkbook(o.db, o.id)) as never);
    expect(JSON.stringify(wb.getWorksheet("Attendees")!.getRow(3).values)).not.toMatch(/confidence/i);
  });
});
