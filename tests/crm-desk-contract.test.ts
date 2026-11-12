/* The CRM contract (crm-desk repository, docs/CONTRACT-TESTS.md) for Events Desk: tests 1, 3, 4, 5 and 6.

   Today's CRM (simCrm in the demo, noCrm live) is covered by this suite's own tests, unchanged (test 7); this desk has
   no Salesforce adapter yet, so CRM=salesforce is refused. The CRM Desk half runs against a running CRM Desk named by
   CRM_DESK_URL, with CRM_DESK_KEY (a key made with --desk events_desk) and CRM_DESK_ADMIN_KEY (to set up the records);
   without them it is skipped. */

import { describe, expect, it } from "vitest";
import { askPeople, CrmDown } from "../src/server/crm-checks.ts";
import { chooseCrm, crmDeskCrm } from "../src/server/crm-desk.ts";
import { CrmAlreadyExists, noCrm } from "../src/server/providers.ts";

const env = process.env;
const LIVE = Boolean(env.CRM_DESK_URL && env.CRM_DESK_KEY && env.CRM_DESK_ADMIN_KEY);

describe("test 6: configuration picks one CRM", () => {
  it("keeps today's CRM when CRM is unset, and refuses what it cannot run", () => {
    expect(chooseCrm(noCrm, {}, true)).toBe(noCrm);
    expect(chooseCrm(undefined, { CRM: "" }, false)).toBeUndefined();
    expect(() => chooseCrm(noCrm, { CRM: "salesforce" }, true)).toThrow(/no Salesforce adapter/);
    expect(() => chooseCrm(noCrm, { CRM: "crmdesk" }, true)).toThrow(/CRM_DESK_URL/);
    expect(() => chooseCrm(noCrm, { CRM: "sim" }, true)).toThrow();
    expect(chooseCrm(noCrm, { CRM: "crmdesk", CRM_DESK_URL: "http://crm.test", CRM_DESK_KEY: "k" }, true)?.name).toBe("crm_desk");
  });
});

describe("test 4: fails closed", () => {
  for (const answer of ["timeout", 503, 429] as const) {
    it(`pauses on ${answer}`, async () => {
      const fake = (async () => {
        if (answer === "timeout") throw new DOMException("timed out", "TimeoutError");
        return new Response(JSON.stringify({ error: "down" }), { status: answer });
      }) as unknown as typeof fetch;
      const crm = crmDeskCrm("http://crm.test", "k", fake);
      await expect(askPeople(crm, [{ ref: "a", email: "x@y.example", full_name: null, company: null, domain: null }])).rejects.toBeInstanceOf(CrmDown);
      await expect(crm.lookupByDomain!("y.example", "Y", "2026-11-12")).rejects.toThrow();
      await expect(crm.meetings!("")).rejects.toThrow();
    });
  }
});

describe.skipIf(!LIVE)("against a running CRM Desk", () => {
  const admin = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${env.CRM_DESK_URL}/api/v1${path}`, { method, headers: { authorization: `Bearer ${env.CRM_DESK_ADMIN_KEY}`, "content-type": "application/json" },
      body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
    expect(r.status, await r.clone().text()).toBeLessThan(300);
    return r.json();
  };
  const tag = Math.random().toString(16).slice(2, 10);
  const domain = `contract-${tag}.example`;
  const crm = () => crmDeskCrm(env.CRM_DESK_URL!, env.CRM_DESK_KEY!);

  it("test 3: contactability", async () => {
    const acc = await admin("PUT", `/accounts/by-domain/${domain}`, { name: `Contract ${tag}` });
    await admin("PUT", `/contacts/by-email/nia.${tag}@${domain}`, { first_name: "Nia", account_id: acc.id, do_not_email: true });
    await admin("PUT", `/contacts/by-email/rui.${tag}@${domain}`, { first_name: "Rui", account_id: acc.id, do_not_call: true });
    await admin("POST", "/contacts", { first_name: "Lee", last_name: tag, account_id: acc.id, do_not_contact: true });
    await admin("POST", "/contacts/opt-out", { email: `gone.${tag}@${domain}` });
    const got = await crm().personFlags!([
      { ref: "a", email: `nia.${tag}@${domain}`, full_name: null, company: null, domain: null },
      { ref: "b", email: `rui.${tag}@${domain}`, full_name: null, company: null, domain: null },
      { ref: "c", email: null, full_name: `Lee ${tag}`, company: null, domain },
      { ref: "d", email: `gone.${tag}@${domain}`, full_name: null, company: null, domain: null },
      { ref: "e", email: `fresh.${tag}@${domain}`, full_name: null, company: null, domain: null },
    ]);
    expect(got.a[0].email_opt_out).toBe(true);
    expect(got.b[0].do_not_call && !got.b[0].email_opt_out && !got.b[0].do_not_contact).toBe(true);
    expect(got.c.some((r) => r.do_not_contact)).toBe(true);
    expect(got.d[0].id.startsWith("suppressed:") && got.d[0].email_opt_out).toBe(true);
    expect(got.e).toEqual([]);
  });

  it("test 1: every create lands once on a retry; an erased person is a finished write", async () => {
    const c = crm();
    expect(await c.findCampaignByKey!(`ev:${tag}`)).toBeNull();
    const cmp = await c.createCampaign!({ name: `Summit ${tag}`, start: "2026-12-01", end: "2026-12-02", type: "Conference", key: `ev:${tag}` });
    expect(await c.findCampaignByKey!(`ev:${tag}`)).toEqual(cmp);
    const rec = (await c.personFlags!([{ ref: "r", email: `rui.${tag}@${domain}`, full_name: null, company: null, domain: null }])).r[0];
    expect((await c.createCampaignMember!({ campaign: cmp.id, record: rec, key: `cm:${tag}` })).id).toBeTruthy();
    await expect(c.createCampaignMember!({ campaign: cmp.id, record: rec, key: `cm:${tag}:met`, status: "Met" })).rejects.toBeInstanceOf(CrmAlreadyExists);
    await c.updateCampaignMemberStatus!({ campaign: cmp.id, record: rec, status: "Met" });
    expect((await admin("GET", `/campaigns/${cmp.id}/members`)).data.map((m: any) => m.status)).toEqual(["met"]);
    const t1 = await c.createTask!({ record: rec, subject: "Send the deck", body: "Asked at the booth", due: "2026-12-04", key: `tk:${tag}` });
    expect(await c.createTask!({ record: rec, subject: "Send the deck", body: "", due: "2026-12-04", key: `tk:${tag}` })).toEqual(t1);
    const gone = await admin("POST", "/contacts", { first_name: "Zia", email: `zia.${tag}@${domain}` });
    await admin("POST", `/contacts/${gone.id}/erase`, { requested_by: "the person", channel: "email" });
    expect((await c.createLead!({ email: `zia.${tag}@${domain}`, full_name: "Zia Cole", company: "Contract", domain, key: `ld:${tag}` })).id).toBeNull();
  });

  it("test 5: write-back fills blanks only, except the opt-out", async () => {
    const c = crm();
    const acc = await admin("GET", `/accounts/domain:${domain}`);
    await admin("POST", "/contacts", { first_name: "Bo", last_name: `Blank${tag}`, account_id: acc.id });
    const got = await c.personFlags!([
      { ref: "a", email: `rui.${tag}@${domain}`, full_name: null, company: null, domain: null },
      { ref: "b", email: null, full_name: `Bo Blank${tag}`, company: null, domain },
    ]);
    await c.write!(got.a[0], { email: `other.${tag}@${domain}` });
    await c.write!(got.b[0], { email: `bo.${tag}@${domain}` });
    expect((await admin("GET", `/contacts/email:rui.${tag}@${domain}`)).email).toBe(`rui.${tag}@${domain}`);
    expect((await admin("GET", `/contacts/email:bo.${tag}@${domain}`)).id).toBe(got.b[0].id);
    await c.write!(got.a[0], { email_opt_out: true });
    expect((await admin("GET", `/contacts/email:rui.${tag}@${domain}`)).contact.do_not_email.value).toBe(true);
  });
});
