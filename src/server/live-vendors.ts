/* Real vendors, only ever built in live mode. Apollo finds emails, first with its
   normal match and then with its email waterfall; ZeroBounce verifies. Hunter and the
   other waterfall sources are chosen in Apollo's settings and are never called from here.

   Apollo's match and waterfall follow its published docs as read 2026-11-09 (People
   Enrichment, the data waterfall guide, Poll Webhook Result). No real call has been made.
   ZeroBounce's page could not be fetched, so its contract is unconfirmed until its first real call. */

import { VendorError, type CompanyCandidate, type FirmographicsLookup, type FoundPerson, type PeopleSearch, type Reveal, type Identity, type PersonMatchResult, type Vendors, type Waterfall, type WaterfallPoll, type WebsiteReader } from "./providers.ts";
import { cleanFirmo } from "../shared/tiering.ts";
import { systemDns } from "./identity.ts";
import { companyDomain } from "../shared/identity.ts";
import type { Settings } from "../shared/cost.ts";
import { cleanLinkedin, companyKey } from "../shared/ingest.ts";
import type { Verdict } from "../shared/tiers.ts";

export interface LiveKeys { apollo: string; zerobounce: string }
export interface LiveOpts { fetch?: typeof fetch; paceMs?: number }

/** 429 and auth failures are not billed. Anything we cannot read might have been. */
async function call(f: typeof fetch, url: string, init?: RequestInit) {
  let r: Response;
  try { r = await f(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
  catch { throw new VendorError("unknown"); }
  if (r.status >= 500) throw new VendorError("unknown");
  return r;
}
/** Apollo's request ids are 64-bit integers, past what a JS number holds, so they are kept as the digits Apollo sent. */
const keepRequestId = (key: string, value: unknown, ctx?: { source?: string }) => (key === "request_id" && typeof value === "number" ? ctx?.source ?? String(value) : value);
const body = async (r: Response) => { try { return (JSON.parse(await r.text(), keepRequestId as never) as any) ?? {}; } catch { throw new VendorError("unknown"); } };

export function liveVendors(s: Settings, keys: LiveKeys, opts: LiveOpts = {}): Vendors {
  const f = opts.fetch ?? fetch;
  const pace = opts.paceMs ?? 1000;
  let last = 0;
  // Apollo answers a burst with 200 and empty results, which looks like no match.
  const paced = async () => { const wait = last + pace - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); last = Date.now(); };
  const apollo: ApolloCall = async (path, payload, opts) => {
    await paced();
    const url = `https://api.apollo.io/api/v1/${path}${opts?.get || opts?.query ? `?${new URLSearchParams(payload as Record<string, string>)}` : ""}`;
    const r = await call(f, url, opts?.get
      ? { method: "GET", headers: { "x-api-key": keys.apollo } }
      : opts?.query
      ? { method: "POST", headers: { "x-api-key": keys.apollo } }
      : { method: "POST", headers: { "x-api-key": keys.apollo, "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) throw new VendorError(0);
    return body(r);
  };
  const identity = apolloIdentity(s, apollo);
  const [apolloRate] = s.finders;
  const [zeroRate] = s.verifiers;
  /** The poll is not a body-or-nothing call: Apollo answers 404 while the result is still being built. */
  const webhookResult = async (requestId: string) => {
    await paced();
    return call(f, `https://api.apollo.io/api/v1/webhook_result/${encodeURIComponent(requestId)}`, { method: "GET", headers: { "x-api-key": keys.apollo } });
  };

  return {
    identity,
    firmographics: apolloFirmographics(s, apollo),
    website: liveWebsite(f),
    peopleSearch: apolloPeopleSearch(apollo),
    reveal: apolloReveal(s, apollo),
    waterfall: apolloWaterfall(s, apollo, webhookResult),
    discovery: {
      name: "apollo_search", cost: s.discovery_cost,
      async find(company, limit) {
        const j = await apollo("mixed_people/search", { q_keywords: company, person_titles: s.target_titles, per_page: Math.min(limit * 3, 25) });
        const people = (j.people ?? [])
          .filter((p: any) => p.name && p.organization?.name && companyKey(p.organization.name) === companyKey(company))
          .slice(0, limit).map((p: any) => ({ full_name: p.name as string, title: (p.title ?? "") as string, linkedin: cleanLinkedin(p.linkedin_url) }));
        return { people, charged: 0 };
      },
    },
    finders: [
      {
        name: "apollo_match", cost: apolloRate.cost,
        async find(p) {
          if (!p.full_name) return { value: null, charged: 0 };
          const j = await apollo("people/match", { name: p.full_name, organization_name: p.company });
          const person = j.person;
          // Apollo can match the right name at the wrong company. That is a miss, not a find.
          const sameCompany = person?.organization?.name && companyKey(person.organization.name) === companyKey(p.company);
          const email = sameCompany && person.email && !/not_unlocked/.test(person.email) ? String(person.email).toLowerCase() : null;
          // Misses can still burn credits on Apollo, so every attempt counts as charged.
          return { value: email, charged: apolloRate.cost, linkedin: sameCompany ? cleanLinkedin(person.linkedin_url) : null, apollo_verified: email !== null && isVerified(person.email_status) };
        },
      },
    ],
    linkedin: {
      name: "apollo_linkedin", cost: s.linkedin.cost,
      async find(p) {
        if (!p.full_name) return { value: null, charged: 0 };
        // The email, when we have it, is Apollo's strongest match key.
        const j = await apollo("people/match", { name: p.full_name, organization_name: p.company, ...(p.email ? { email: p.email } : {}), ...(p.title ? { title: p.title } : {}) });
        const person = j.person;
        const sameCompany = person?.organization?.name && companyKey(person.organization.name) === companyKey(p.company);
        return { value: sameCompany ? cleanLinkedin(person.linkedin_url) : null, charged: s.linkedin.cost, verified_email: sameCompany && person.email && isVerified(person.email_status) ? String(person.email).toLowerCase() : null };
      },
    },
    verifiers: [
      {
        name: "zerobounce", cost: zeroRate.cost,
        async verify(email) {
          const q = new URLSearchParams({ api_key: keys.zerobounce, email, ip_address: "" });
          const r = await call(f, `https://api.zerobounce.net/v2/validate?${q}`);
          if (!r.ok) throw new VendorError(0);
          const j = await body(r);
          if (j.error || !j.status) throw new VendorError(0);
          const map: Record<string, Verdict> = { valid: "deliverable", invalid: "undeliverable", spamtrap: "undeliverable", abuse: "undeliverable", do_not_mail: "undeliverable", "catch-all": "catch_all" };
          return { verdict: map[j.status] ?? "unknown", charged: zeroRate.cost };
        },
      },
    ],
  };
}

/* ------------------------------------------------------------- identity
   Company search, person match and reverse lookup on Apollo, behind the same live guards as every other
   adapter: this file is only built in live mode, with the keys LIVE_SPEND=1 requires. The guard in
   vendor-health.ts (rate limit, breaker, throttling probe) wraps these calls in the pipeline.

   UNCONFIRMED against the real service. The Apollo key on file returns 403 API_INACCESSIBLE on the free plan for
   the people endpoints, and the organization endpoint has not been called. The request and response shapes below
   follow Apollo's documented Organization Search (mixed_companies/search) and People Enrichment (people/match) as
   remembered, and are read defensively. The first paid-plan call decides whether they are right. Organization
   Search is treated as free (charged 0), which is also unconfirmed; the Research card does not price it. */
type ApolloCall = (path: string, payload: unknown, opts?: { get?: boolean; query?: boolean }) => Promise<any>;
/** Apollo's `email_status` and `email_status_cd`. Apollo's docs show "verified" and "Verified" and do not list the other values, so only that word counts. */
const isVerified = (s: unknown) => typeof s === "string" && s.trim().toLowerCase() === "verified";

const hostOf = (u: unknown) => { try { return new URL(/^https?:/i.test(String(u)) ? String(u) : `https://${u}`).hostname.replace(/^www\./, ""); } catch { return null; } };

function candidateOf(o: any): CompanyCandidate | null {
  const domain = companyDomain(o?.primary_domain) ?? companyDomain(hostOf(o?.website_url));
  if (!o?.name || !domain) return null;
  const parent = o.owned_by_organization ?? o.parent_organization ?? null;
  return { name: String(o.name), domain, parent_name: parent?.name ?? null, parent_domain: companyDomain(parent?.primary_domain) ?? null, country: o.country ?? o.organization_country ?? null, employees: typeof o.estimated_num_employees === "number" ? o.estimated_num_employees : null };
}
const str = (v: unknown, max = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const reversePerson = (p: any) => (p ? { full_name: str(p.name, 120), title: str(p.title, 160), linkedin: cleanLinkedin(p.linkedin_url) } : null);
function personOf(p: any): PersonMatchResult | null {
  if (!p?.id) return null;
  const email = p.email && !/not_unlocked/.test(String(p.email)) ? String(p.email).toLowerCase() : null;
  // Detail Apollo returns on the same call (city, state, country, seniority, departments, employment_history), read defensively; nothing extra is bought for it.
  const location = [str(p.city), str(p.state), str(p.country)].filter(Boolean).join(", ") || null;
  const departments = Array.isArray(p.departments) ? p.departments.map((d: unknown) => str(d, 40)).filter((d: string | null): d is string => d !== null).slice(0, 5) : null;
  const current = Array.isArray(p.employment_history) ? p.employment_history.find((h: any) => h?.current === true || h?.end_date == null) : null;
  const since = str(current?.start_date, 10);
  return {
    email_verified: email !== null && isVerified(p.email_status),
    vendor_person_id: String(p.id), full_name: String(p.name ?? ""), email, linkedin: cleanLinkedin(p.linkedin_url), employer: p.organization?.name ?? null,
    employer_domain: companyDomain(p.organization?.primary_domain) ?? companyDomain(hostOf(p.organization?.website_url)), title: p.title ?? null,
    location, seniority: str(p.seniority, 40), departments: departments?.length ? departments : null, role_since: since && /^\d{4}(-\d{2}){0,2}$/.test(since) ? since : null,
  };
}

export function apolloIdentity(s: Settings, apollo: ApolloCall): Identity {
  const pm = s.research.person_match_cost, rv = s.research.reverse_lookup_cost;
  return {
    companySearch: {
      name: "apollo_org_search", probe: { query: "Apollo.io", domain: "apollo.io" },
      async search(query) {
        const j = await apollo("mixed_companies/search", { q_organization_name: query, page: 1, per_page: 5 });
        const list: any[] = j.organizations ?? j.accounts ?? [];
        return { candidates: list.map(candidateOf).filter((c): c is CompanyCandidate => c !== null), charged: 0 };
      },
    },
    personMatch: {
      name: "apollo_person_match", cost: pm,
      async match(p) {
        const j = await apollo("people/match", { first_name: p.first, last_name: p.last, organization_name: p.company, ...(p.title ? { title: p.title } : {}) });
        // Every attempt counts as charged: a miss can still burn a credit on Apollo.
        return { person: personOf(j.person), charged: pm };
      },
    },
    reverse: {
      name: "apollo_reverse", cost: rv,
      async byEmail(email) { const j = await apollo("people/match", { email }); return { company: candidateOf(j.person?.organization), person: reversePerson(j.person), charged: rv }; },
      async byLinkedin(url) { const j = await apollo("people/match", { linkedin_url: url }); return { company: candidateOf(j.person?.organization), person: reversePerson(j.person), charged: rv }; },
    },
    dns: systemDns,
  };
}

/* ------------------------------------------------------------ firmographics
   Company facts by domain on Apollo (docs/TIERING-AND-ENRICHMENT.md, "Layer 2"): the free organization search first, and one paid
   Organization Enrichment only when fields the ICP needs are still missing. Behind the same live guards as every other adapter.

   UNCONFIRMED against the real service, like the identity adapter above: the free plan returns 403 on the people endpoints and this
   endpoint has not been called. The request shapes (mixed_companies/search by domain, GET organizations/enrich) and the response
   fields (estimated_num_employees, industry, short_description, country) are from Apollo's documentation as remembered, read
   defensively, and tested on faked responses only. Apollo does not return a business model, so the hard rule on it stays Unknown and
   the model judges from the description. The search is treated as free and the enrich as one credit; both are unconfirmed. */
const orgFirmo = (o: any) => cleanFirmo({
  employees: typeof o?.estimated_num_employees === "number" ? o.estimated_num_employees : null,
  industry: o?.industry ?? null, country: o?.country ?? o?.organization_country ?? null, description: o?.short_description ?? o?.seo_description ?? null,
  // The same answer carries facts no tier rule reads; they are kept for the delivered list (annual_revenue, founded_year, city, linkedin_url, latest_funding_stage, as documented).
  revenue: typeof o?.annual_revenue === "number" ? o.annual_revenue : null, founded: typeof o?.founded_year === "number" ? o.founded_year : null,
  city: o?.city ?? null, linkedin: o?.linkedin_url ?? null, funding_stage: o?.latest_funding_stage ?? null,
});

export function apolloFirmographics(s: Settings, apollo: ApolloCall): FirmographicsLookup {
  const cost = s.research.firmographics_cost;
  return {
    name: "apollo_firmographics", cost,
    // Apollo has no business model field, so no enrich is bought to find one.
    provides: ["employees", "industry", "country", "description"],
    async search(domain) {
      const j = await apollo("mixed_companies/search", { q_organization_domains_list: [domain], page: 1, per_page: 1 });
      const o = (j.organizations ?? j.accounts ?? [])[0];
      return { firmo: o ? orgFirmo(o) : null, charged: 0, company_name: str(o?.name, 160) };
    },
    async enrich(domain) {
      const j = await apollo("organizations/enrich", { domain }, { get: true });
      // Every attempt counts as charged: a miss can still burn a credit on Apollo.
      return { firmo: j.organization ? orgFirmo(j.organization) : null, charged: cost };
    },
  };
}

/** One read of a company's own home page, as plain text. Free. The text is untrusted data: the model prompt says so, and nothing here acts on it.
    Only public host names are fetched, over https, with a short timeout and a size cap; a redirect is followed only to the same site. A public name
    that resolves to a private address is not caught here, so run the server where it cannot reach internal hosts. */
export function publicHost(domain: string): boolean {
  const d = domain.toLowerCase().trim();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || /^\d+(\.\d+)+$/.test(d)) return false;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|example|test|invalid)$/.test(d)) return false;
  return /\.[a-z]{2,}$/.test(d);
}
const siteOf = (h: string) => h.replace(/^www\./, "");

export function liveWebsite(f: typeof fetch = fetch): WebsiteReader {
  return {
    name: "website_fetch",
    async read(domain) {
      if (!publicHost(domain)) return null;
      try {
        let url = `https://${domain.toLowerCase()}/`;
        for (let hop = 0; hop < 2; hop++) {
          const r = await f(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "EventsDesk/1.0 (company research; one page read)", accept: "text/html" } });
          if (r.status >= 300 && r.status < 400) {
            const next = new URL(r.headers.get("location") ?? "", url);
            if (next.protocol !== "https:" || siteOf(next.hostname) !== siteOf(domain.toLowerCase())) return null;
            url = next.toString();
            continue;
          }
          if (!r.ok || !(r.headers.get("content-type") ?? "").includes("text/html")) return null;
          // Read at most 200 KB, then stop: a huge page is never held whole.
          let html = "";
          const reader = r.body?.getReader(); const dec = new TextDecoder();
          while (reader && html.length < 200_000) { const { value, done } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }); }
          await reader?.cancel().catch(() => {});
          html = html.slice(0, 200_000);
          const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;|&#\d+;/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
          return text.length >= 40 ? text : null;
        }
      } catch { /* an unreadable site is simply not read */ }
      return null;
    },
  };
}

/* ------------------------------------------------------------ people search
   Free people search by company domain on Apollo (docs/TIERING-AND-ENRICHMENT.md, "Layer 4"): `mixed_people/api_search`, which as documented
   returns the person's id, first name, an obfuscated last name, title, the date the record was last refreshed and whether an email exists, and
   spends no credit. This step makes no reveal call: a hidden last name stays hidden until step 8.

   UNCONFIRMED against the real service. The key on file gets 403 API_INACCESSIBLE on the free plan for the people endpoints, so the request
   body, the response fields and "costs nothing" are from documentation as remembered, read defensively, and tested on faked responses only. */
const hiddenName = (n: unknown) => typeof n !== "string" || !n.trim() || /\*/.test(n);

export function apolloPeopleSearch(apollo: ApolloCall): PeopleSearch {
  return {
    name: "apollo_people_search", probe: { domain: "apollo.io", company: "Apollo" },
    async search(q) {
      const j = await apollo("mixed_people/api_search", { q_organization_domains_list: [q.domain], ...(q.titles.length ? { person_titles: q.titles } : {}), ...(q.country ? { person_locations: [q.country] } : {}), page: 1, per_page: Math.min(Math.max(q.limit, 1), 100) });
      const people: FoundPerson[] = [];
      for (const p of (j.people ?? []) as any[]) {
        if (!p?.id || !p.first_name) continue;
        const day = typeof p.last_refreshed_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(p.last_refreshed_at) ? p.last_refreshed_at.slice(0, 10) : null;
        people.push({ vendor_person_id: String(p.id), first_name: String(p.first_name), last_name: hiddenName(p.last_name) ? null : String(p.last_name), title: typeof p.title === "string" && p.title.trim() ? p.title : null, linkedin: null, updated_at: day, has_email: typeof p.has_email === "boolean" ? p.has_email : null, country: q.country });
      }
      return { people: people.slice(0, q.limit), charged: 0 };
    },
  };
}

/* ------------------------------------------------------------------ reveal
   The paid reveal of one discovered person by the id the free search gave (docs/TIERING-AND-ENRICHMENT.md, "Layer 5"): Apollo People Enrichment
   (`people/match` with the person's id), which returns the full name, work email, LinkedIn and current employer for one credit. Every attempt counts
   as charged, because a miss can still burn a credit on Apollo. Only a work email is read (personal emails are never requested).

   UNCONFIRMED against the real service: the key on file gets 403 on the people endpoints, so the request and response shapes are from documentation as
   remembered, read defensively, and tested on faked responses only. */
export function apolloReveal(s: Settings, apollo: ApolloCall): Reveal {
  const cost = s.outreach?.reveal_cost ?? s.finders[0]?.cost ?? 1;
  return {
    name: "apollo_reveal", cost,
    async reveal(q) {
      const j = await apollo("people/match", { id: q.vendor_person_id, reveal_personal_emails: false });
      return { person: personOf(j.person), charged: cost };
    },
  };
}

/* --------------------------------------------------------------- the waterfall
   Apollo's email waterfall (docs/DATA-HYGIENE.md, section 0): `people/match` with `run_waterfall_email` and `poll_only`, then `GET webhook_result/{request_id}`, which costs no credit.
   The lineup (Apollo's own data, then the sources, then ZeroBounce validating) is chosen in Apollo's settings.

   Read against Apollo's docs on 2026-11-09 and tested on faked responses only; the free plan cannot reach this feature. NOT CONFIRMED by a real call:
   - how a ZeroBounce validation appears in `vendors`. The docs' example shows only `usedForVerification: false`, with the placeholder name "Email Provider". This reads a vendor whose name contains
     ZeroBounce, flagged usedForVerification, with a status of VERIFIED. If it reads differently no address can be verified twice, which fails closed.
   - the status words a vendor uses when it finds nothing; the docs show only "VERIFIED".
   - the shape of a 200 while the result is in progress. A 200 with no `webhook_result` is read as still pending.
   - whether a failed start bills. It is read as not billed when Apollo says `waterfall.status` failed, as an unknown charge otherwise.
   - the query string on the POST: the reference lists these parameters as query parameters, while this file's other POSTs send JSON. */
const POLL_DEFAULT_MS = 10_000;
export function apolloWaterfall(s: Settings, apollo: ApolloCall, result: (requestId: string) => Promise<Response>): Waterfall {
  const { reserve } = s.waterfall;
  return {
    name: "apollo_waterfall", reserve,
    async start(p) {
      const j = await apollo("people/match", { name: p.full_name, organization_name: p.company, domain: p.domain, run_waterfall_email: "true", run_waterfall_phone: "false", poll_only: "true", reveal_personal_emails: "false" }, { query: true });
      if (j.waterfall?.status === "failed") throw new VendorError(0);
      if (j.request_id === undefined || j.request_id === null || j.waterfall?.status !== "accepted") throw new VendorError("unknown");
      const sameCompany = j.person?.organization?.name && companyKey(j.person.organization.name) === companyKey(p.company);
      return { request_id: String(j.request_id), linkedin: sameCompany ? cleanLinkedin(j.person.linkedin_url) : null };
    },
    async poll(requestId): Promise<WaterfallPoll> {
      const r = await result(requestId);
      if (r.status === 400 || r.status === 410) return { state: "gone" };
      if (r.status === 404) {
        const j = await body(r);
        return j.error_code === "result_pending" ? { state: "pending", retry_after_ms: (Number(j.retry_after_seconds) || POLL_DEFAULT_MS / 1000) * 1000 } : { state: "gone" };
      }
      if (!r.ok) throw new VendorError(0);
      const j = await body(r);
      if (!j.webhook_result) return j.webhook_status === "failed" ? { state: "gone" } : { state: "pending", retry_after_ms: POLL_DEFAULT_MS };
      return { state: "done", result: waterfallResult(j.webhook_result, reserve) };
    },
  };
}

/** One person's result. An unreported charge is taken as the whole reservation: an unknown charge is money gone. */
export function waterfallResult(w: any, reserve: number) {
  const credits = typeof w.credits_consumed === "number" ? w.credits_consumed : reserve;
  const person = Array.isArray(w.people) ? w.people[0] : null;
  const final = [...(Array.isArray(person?.emails) ? person.emails : [])].sort((a: any, b: any) => (a?.position ?? 0) - (b?.position ?? 0))[0];
  const email = typeof final?.email === "string" && final.email.trim() ? final.email.trim().toLowerCase() : null;
  const vendors: any[] = (Array.isArray(person?.waterfall?.emails) ? person.waterfall.emails : []).flatMap((g: any) => (Array.isArray(g?.vendors) ? g.vendors : []));
  const zerobounce_pass = email !== null && vendors.some((v) => /zero\s*bounce/i.test(String(v?.name ?? "")) && v?.usedForVerification === true && isVerified(v?.status)
    && (!Array.isArray(v?.emails) || v.emails.length === 0 || v.emails.map((e: unknown) => String(e).toLowerCase()).includes(email)));
  return { email, apollo_verified: email !== null && isVerified(final?.email_status_cd), zerobounce_pass, credits };
}
