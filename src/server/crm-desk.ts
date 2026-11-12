/* CRM Desk as Events Desk's CRM, chosen with CRM=crmdesk (docs/CONNECTING.md in the crm-desk repository).

   Unset, Events Desk keeps the CRM it has today: simCrm in the demo, noCrm in live mode. Every call fails closed:
   a timeout, a refused connection, a 429 or a 5xx throws, and the callers in crm-checks.ts turn that into CrmDown.
   A 409 `erased` from CRM Desk is a finished write with nothing written: the create answers a null id, as it does for
   nobody to write to. */

import { CrmAlreadyExists, heatOf, type AccountType, type Crm, type CrmAccount, type CrmAccountQuery, type CrmOpportunity, type CrmPatch, type CrmPersonQuery, type CrmRecord } from "./providers.ts";

type Fetch = typeof fetch;
const TYPES: Record<string, AccountType> = { customer: "customer", prospect: "prospect", partner: "partner", competitor: "competitor" };
const MEMBER: Record<string, string> = { sent: "sent", invited: "sent", registered: "registered", attended: "attended", met: "met", "no show": "no_show", responded: "responded" };
const MEETING: Record<string, "booked" | "held" | "cancelled"> = { booked: "booked", held: "held", cancelled: "cancelled", no_show: "cancelled" };
// An erased person: the outbox reads `.id`, and a null id is its "nobody to write to", a finished write.
const NOBODY = { id: null as unknown as string };
const NOTHING: CrmAccount = { owner: null, deal_name: null, deal_stage: null, last_activity: null, heat: null, account_type: null };

export function crmDeskCrm(url: string, key: string, doFetch: Fetch = fetch, timeoutMs = 15000): Crm {
  const base = url.replace(/\/$/, "") + "/api/v1";
  let users: Record<string, string> | null = null;

  async function call(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; json: any }> {
    const q = query ? "?" + new URLSearchParams(query).toString() : "";
    let res: Response;
    try {
      res = await doFetch(base + path + q, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
      });
    } catch (e) { throw new Error(`CRM Desk did not answer: ${(e as Error).name}`); }
    if (res.status >= 500 || res.status === 429) throw new Error(`CRM Desk answered ${res.status} on ${path}`);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  }
  async function ok(method: string, path: string, body?: unknown, query?: Record<string, string>) {
    const r = await call(method, path, body, query);
    if (r.status >= 400) throw new Error(`CRM Desk refused ${path}: ${r.status} ${r.json?.code ?? ""}`);
    return r.json;
  }
  const erased = (r: { status: number; json: any }) => r.status === 409 && r.json?.code === "erased";
  const stub = (id: string) => id.startsWith("suppressed:");

  async function ownerName(email: string | null): Promise<string | null> {
    if (!email) return null;
    if (!users) users = Object.fromEntries(((await ok("GET", "/meta/users")).data as { email: string; name: string }[]).map((u) => [u.email, u.name]));
    return users[email] ?? null;
  }
  async function account(found: any, asOf: string): Promise<CrmAccount> {
    const a = found?.accounts?.[0];
    if (!a) return NOTHING;
    const last = a.last_activity_at ? String(a.last_activity_at).slice(0, 10) : null;
    const days = last ? Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400000) : null;
    const opp = a.open_opportunity;
    return { owner: await ownerName(a.owner_email), deal_name: opp?.name ?? null, deal_stage: opp?.stage ?? null, last_activity: last,
      heat: heatOf(Boolean(opp), days), account_type: TYPES[a.type] ?? "none" };
  }

  const crm: Crm = {
    name: "crm_desk",
    connected: true,

    async lookup(company, asOf) {
      const found = (await ok("POST", "/accounts/lookup", { items: [{ name: company }] })).results[0];
      return found.ambiguous ? NOTHING : account(found, asOf);           // two accounts with one name: never guessed between
    },
    async lookupByDomain(domain, company, asOf) {
      const found = (await ok("POST", "/accounts/lookup", { items: [{ domain }] })).results[0];
      return found.found ? account(found, asOf) : crm.lookup(company, asOf);
    },

    async personFlags(people: CrmPersonQuery[]) {
      const contacts = people.map((p) => p.email ? { ref: p.ref, email: p.email } : { ref: p.ref, full_name: p.full_name, domain: p.domain, company: p.company });
      const answers = (await ok("POST", "/contacts/contactability", { contacts })).results as any[];
      const out: Record<string, CrmRecord[]> = {};
      for (const a of answers) {
        const asked = people.find((p) => p.ref === a.ref);
        const records: CrmRecord[] = (a.contacts as any[]).map((c) => ({
          id: c.id, object: ["subscriber", "lead"].includes(c.lifecycle_stage) && !c.account_id ? "Lead" : "Contact",
          email: asked?.email ?? null, email_opt_out: Boolean(c.do_not_email.value || c.unsubscribed.value),
          do_not_contact: Boolean(c.do_not_contact.value || c.left_company), do_not_call: Boolean(c.do_not_call.value), bounced_at: c.bounced.at ?? null,
        }));
        // Kept off every list (unsubscribed or erased) and held by no contact: one stand-in record with every flag set,
        // so the desk stops. Writes to a `suppressed:` id do nothing.
        if (!records.length && a.suppressed) records.push({ id: `suppressed:${a.ref}`, object: "Contact", email: null, email_opt_out: true, do_not_contact: true, do_not_call: true, bounced_at: null });
        out[a.ref] = records;
      }
      return out;
    },

    async accountFlags(accounts: CrmAccountQuery[]) {
      const items = accounts.map((a) => a.domain ? { domain: a.domain } : { name: a.name });
      const found = (await ok("POST", "/accounts/lookup", { items })).results as any[];
      const out: Record<string, { do_not_prospect: boolean }> = {};
      for (let i = 0; i < accounts.length; i++) {
        let f = found[i];
        if (!f.found && accounts[i].domain && accounts[i].name) f = (await ok("POST", "/accounts/lookup", { items: [{ name: accounts[i].name }] })).results[0];
        out[accounts[i].ref] = { do_not_prospect: (f.accounts as any[]).some((x) => x.do_not_prospect) };
      }
      return out;
    },

    async write(record: CrmRecord, patch: CrmPatch) {
      if (stub(record.id)) return;
      if (patch.email_opt_out) {
        if (record.email) await ok("POST", "/contacts/opt-out", { email: record.email });
        else await ok("PATCH", `/contacts/${record.id}`, { do_not_email: true });
      }
      if (patch.email) {
        const r = await call("PATCH", `/contacts/${record.id}`, { email: patch.email });
        if (!erased(r) && r.status >= 400) throw new Error(`CRM Desk refused the address: ${r.status}`);
      }
    },

    async findCampaignByKey(key) {
      const r = await call("GET", `/campaigns/ext:events_desk:${encodeURIComponent(key)}`);
      if (r.status === 404) return null;
      if (r.status >= 400) throw new Error(`CRM Desk refused the campaign lookup: ${r.status}`);
      return { id: r.json.id };
    },
    async createCampaign(a) {
      return { id: (await ok("POST", "/campaigns", { name: a.name, type: "event", status: "planned", start_date: a.start, end_date: a.end, external_id: a.key })).id };
    },
    async createCampaignMember(a) {
      if (stub(a.record.id)) return { id: a.record.id };
      const status = MEMBER[(a.status ?? "Sent").toLowerCase()] ?? "sent";
      const r = await call("POST", `/campaigns/${a.campaign}/members`, { contact: a.record.id, status });
      if (erased(r)) return NOBODY;
      if (r.status === 409 && r.json?.code === "already_member") throw new CrmAlreadyExists();
      if (r.status >= 400) throw new Error(`CRM Desk refused the member: ${r.status}`);
      return { id: r.json.id };
    },
    async updateCampaignMemberStatus(a) {
      if (stub(a.record.id)) return;
      const r = await call("POST", `/campaigns/${a.campaign}/members`, { contact: a.record.id, status: MEMBER[a.status.toLowerCase()] ?? "sent", update: true });
      if (r.status >= 400 && !(r.status === 409 && r.json?.code === "already_member") && !erased(r)) throw new Error(`CRM Desk refused the status: ${r.status}`);
    },
    // A task made with the desk's key as its external id is the same task when made again.
    async findTaskByKey() { return null; },
    async createTask(a) {
      if (stub(a.record.id)) return { id: a.record.id };
      const r = await call("POST", "/tasks", { title: a.subject, body: a.body, due_on: a.due, contact: a.record.id, external_id: a.key });
      if (erased(r)) return NOBODY;
      if (r.status >= 400) throw new Error(`CRM Desk refused the task: ${r.status}`);
      return { id: r.json.id };
    },
    async createLead(a) {
      const [first, ...rest] = (a.full_name ?? "").split(" ");
      const r = await call("PUT", `/contacts/by-email/${encodeURIComponent(a.email)}`, {
        first_name: first || null, last_name: rest.join(" ") || null, company_name: a.company || null, website: a.domain, lifecycle_stage: "lead" });
      if (erased(r)) return NOBODY;
      if (r.status >= 400) throw new Error(`CRM Desk refused the lead: ${r.status}`);
      return { id: r.json.id };
    },

    async meetings(since) {
      const out: { id: string; email: string; start: string; timezone: string | null; organizer: string | null; status: "booked" | "held" | "cancelled" }[] = [];
      let cursor = since;
      for (;;) {
        const j = await ok("GET", "/changes/meetings", undefined, { since: cursor, limit: "200" });
        for (const m of j.data) if (m.email) out.push({ ...m, status: MEETING[m.status] ?? "held" });
        cursor = j.next;
        if (!j.has_more) return out;
      }
    },

    async opportunities(accounts: CrmAccountQuery[]) {
      const out: Record<string, CrmOpportunity[]> = {};
      for (const a of accounts) {
        if (!a.domain) { out[a.ref] = []; continue; }
        const rows = (await ok("GET", "/opportunities", undefined, { account: `domain:${a.domain}`, limit: "200" })).data as any[];
        out[a.ref] = rows.map((o) => ({ id: o.id, name: o.name, owner: o.owner?.name ?? null, next_step: o.next_step, stage: o.stage,
          amount_cents: o.amount_cents, created_date: String(o.created_at).slice(0, 10), stage_history: o.stage_history,
          close_date: o.close_date, is_won: o.is_won, is_closed: o.is_closed }));
      }
      return out;
    },
  };
  return crm;
}

/** CRM picks the desk's CRM. Unset keeps today's. `salesforce` is refused until a Salesforce adapter exists. */
export function chooseCrm(current: Crm | undefined, env: Record<string, string | undefined>, live: boolean): Crm | undefined {
  const choice = (env.CRM ?? "").trim().toLowerCase();
  if (choice === "" || choice === "default") return current;
  if (choice === "crmdesk") {
    if (!env.CRM_DESK_URL || !env.CRM_DESK_KEY) throw new Error("CRM=crmdesk needs CRM_DESK_URL and CRM_DESK_KEY (a key made with --desk events_desk).");
    return crmDeskCrm(env.CRM_DESK_URL, env.CRM_DESK_KEY);
  }
  if (choice === "sim" && !live) return current;
  if (choice === "salesforce") throw new Error("CRM=salesforce: this desk has no Salesforce adapter yet. Leave CRM unset or use CRM=crmdesk.");
  throw new Error(`CRM=${choice} is not a CRM this desk knows. Use crmdesk, or leave it unset.`);
}
