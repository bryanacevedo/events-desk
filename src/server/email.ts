/* The email loop for the two-card flow (docs/TIERING-AND-ENRICHMENT.md, "Layer 5"; docs/DATA-HYGIENE.md, section 0). Apollo and ZeroBounce are the only email vendors called directly.

   One job is one person, and the whole loop runs inside it, but every paid call is written down BEFORE and AFTER it (`contacts.email_loop`), so a paused or
   crashed run never repeats a call whose outcome is unknown.

     probe       one verifier call on an address nobody has, at the company's domain, before anyone there is revealed. A domain that accepts it accepts every
                 address, so nobody there can be confirmed: the people drop as catch_all_unconfirmed and nothing more is spent on them. No mail server: not_deliverable.
     candidates  in order: the uploaded address, the reveal (a discovered person's first lookup, by the vendor that found them), Apollo's match, then Apollo's email
                 waterfall on a miss, and a pattern guess only if switched on. At most 3 are tested per person.
     reveal      paid once; a stored one is reused while under freshness_days. Then the employment check: the employer must match the company's domain, a parent or a known
                 alias. A record just bought that fails drops the person as employment_unconfirmed. A reused one over 30 days old that fails is bought once, fresh.
     waterfall   `run_waterfall_email` with `poll_only`. The worst case is reserved and recorded before the call; the request id is written the moment the call returns; a crash or
                 replay polls and never starts again. The polls are free. The result reconciles the reservation to `credits_consumed`. A result that never comes is a bounded wait,
                 then the person drops, or the event pauses when several are stuck at once. A reservation never reconciled stays counted as spent.
     verify      skip a role or disposable address, an opted-out one (ours or Salesforce's, asked here for any address newly found or revealed), a wrong-person pair, a domain without mail. Reuse a result under 30 days old, unless Salesforce holds a later bounce. Otherwise ZeroBounce,
                 with one retry of an unknown, its verdict written the moment it arrives. A catch-all answer marks the domain and stops.
     keep/drop   a found address is verified twice only with Apollo Verified and a ZeroBounce pass; anything less is not kept. An attendee-list address that ZeroBounce passes stays on
                 the list, "Verified once" unless Apollo also reports it Verified. A kept person goes on to the LinkedIn lookup; the rest drop with the most specific reason.

   Every vendor call goes through its guard, so an outage waits and then pauses the event; it never drops people. A call the cap refuses drops the person as budget_cap.
   The single-card flow keeps its own find and verify jobs in pipeline.ts. */

import type { Db } from "./db.ts";
import { apolloVerified, domainsForName, getFinderResult, getFreshDomainState, getVerification, isOptedOut, isWrongPerson, logReuse, putDomainState, putFinderResult, putVerification } from "./caches.ts";
import { checkAddress, crmConnected } from "./crm-checks.ts";
import { dbReveals, exampleDns } from "./identity.ts";
import { linkQuietly } from "./person-record.ts";
import { settleOnce } from "./ledger.ts";
import { attempt, holdVendor, PAUSE_AFTER, paidVendor, PauseSignal, withVendorWait, type Ctx, type Job, type Paid } from "./paid.ts";
import type { PersonMatchResult, Reveal, WaterfallPoll } from "./providers.ts";
import { enqueue, dropContact } from "./work.ts";
import { companyKey, cleanLinkedin } from "../shared/ingest.ts";
import { employerMatches, companyDomain } from "../shared/identity.ts";
import { applyPattern, dominantPattern, emailDomain, firstLast, isDisposable, isRoleAddress, nameKey } from "../shared/email.ts";
import { isFreeWebmail, nameSet } from "../shared/layer0.ts";
import type { Verdict } from "../shared/tiers.ts";
import { createHash } from "node:crypto";

export const MAX_CANDIDATES = 3;
/** A stored reveal is bought again on a failed employment check only when it is older than this. */
const REBUY_AFTER_DAYS = 30;

type Why = "undeliverable" | "unknown" | "unverified" | "role" | "off_domain" | "suppressed" | "error" | "lost" | "duplicate";
interface Cand {
  email: string; source: "uploaded" | "reveal" | "finder" | "waterfall" | "pattern"; vendor?: string; state: "new" | "rejected" | "catch_all" | "kept"; why?: Why;
  /** Apollo reports this address Verified. */
  apollo?: boolean;
  /** The waterfall result carries a ZeroBounce pass for it, flagged usedForVerification. */
  zb_passed?: boolean;
  /** ZeroBounce's own answer on this address, written the moment it arrives, so a pause or a replay does not pay for it again. */
  zb?: Verdict;
  /** The CRM has answered for this address, so a replay does not ask again. */
  crm?: boolean;
  /** When a stored waterfall result was fetched. Its ZeroBounce pass does not count against a later bounce. */
  stored_at?: string;
}
/** One person's waterfall. `res` is the reservation, recorded before the call. `request_id` is written as soon as the call returns; while it is set the only thing that happens is a free poll. */
interface WaterfallState { res?: string; request_id?: string; deadline?: number; next?: number; linkedin?: string | null; done?: boolean }
export interface Loop {
  probed?: boolean; supp?: boolean; uploaded?: boolean; revealed?: boolean; pattern?: boolean; linked?: boolean;
  /** The next finder to try. */
  finder?: number;
  /** The reused reveal failed the employment check and is being bought again. Set before the call, so a replay cannot buy it twice. */
  rebought?: boolean;
  wf?: WaterfallState;
  /** Addresses found for a registered attendee that sit at another domain than the company the vendor puts them at, or a personal address they registered with. The review step turns these into cases. */
  mismatch?: { email: string; source: string; kind: "other_domain" | "webmail" }[];
  /** Finder calls that failed with an unknown outcome. */
  errs?: number;
  /** Verifier retries used for this person. */
  retries?: number;
  /** The paid call in flight, written before it is made. If the worker dies, this is the call whose outcome is unknown. */
  inflight?: string | null;
  cand?: Cand[];
}

interface Row {
  id: string; full_name: string | null; title: string | null; email: string | null; linkedin: string | null; source: string; vendor_person_id: string | null; name_hidden: boolean;
  dropped_at: string | null; email_loop: Loop; crm_bounced: Record<string, string>; company_id: string; company: string; company_key: string; domain: string | null; parent_domain: string | null; merged: { name: string }[];
}

/** The domains an employer may have: the company's own, its parent's, and any the name has resolved to. */
async function employerDomains(db: Db, r: Row): Promise<Set<string>> {
  const out = new Set<string>();
  for (const d of [r.domain, r.parent_domain]) if (d) out.add(d.toLowerCase());
  for (const k of [r.company_key, ...r.merged.map((m) => companyKey(m.name))]) for (const d of await domainsForName(db, k)) out.add(d);
  return out;
}

/** The employment check, right after a reveal and before any verifier is paid. */
export async function employmentOk(db: Db, r: Pick<Row, "domain" | "parent_domain" | "company_key" | "merged">, person: Pick<PersonMatchResult, "employer" | "employer_domain">): Promise<boolean> {
  const domains = await employerDomains(db, r as Row);
  const d = companyDomain(person.employer_domain);
  if (d) return domains.has(d);
  return person.employer ? employerMatches(r.company_key, companyKey(person.employer)) : false;
}

/** What to say when no candidate is left: the most specific reason. */
export function exhaustedReason(cand: Cand[], errs = 0): string {
  if (cand.some((x) => x.state === "catch_all")) return "catch_all_unconfirmed";
  if (cand.some((x) => x.why === "unknown" || x.why === "unverified")) return "email_unconfirmed";
  if (cand.some((x) => x.why === "undeliverable" || x.why === "role")) return "not_deliverable";
  if (cand.some((x) => x.why === "off_domain" || x.why === "suppressed")) return "employment_unconfirmed";
  if (cand.some((x) => x.why === "duplicate")) return "duplicate";
  if (errs > 0 || cand.some((x) => x.why === "error" || x.why === "lost")) return "vendor_error";
  return "no_email_found";
}

/** The moment a stored time means, whichever way it was written. */
const instant = (t: string) => Date.parse(t.includes("T") ? t : t.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
const probeAddress = (domain: string) => `zz-${createHash("sha256").update(`probe|${domain}`).digest("hex").slice(0, 10)}@${domain}`;

export async function emailJob(c: Ctx, job: Job, lost: boolean) {
  const contactId = job.payload.contact_id as string;
  const [r] = await c.db.query<Row>(
    `SELECT k.id, k.full_name, k.title, k.email, k.linkedin, k.source, k.vendor_person_id, k.name_hidden, k.dropped_at, k.email_loop, k.crm_bounced, k.company_id, co.name AS company, co.key AS company_key,
            co.primary_domain AS domain, co.parent_domain, co.merged_names AS merged
     FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.id = $1`, [contactId]);
  if (!r || r.dropped_at) return;
  const S: Loop = { cand: [], ...r.email_loop };
  S.cand ??= [];
  // Already kept: a job replayed after a crash has nothing left to pay for.
  if (S.cand.some((x) => x.state === "kept")) return;
  const o = c.settings.outreach;
  const save = () => c.db.query("UPDATE contacts SET email_loop = $2::jsonb WHERE id = $1", [contactId, JSON.stringify(S)]);
  const drop = async (reason: string) => { await save(); await dropContact(c.db, contactId, reason); };
  const domain = r.domain?.toLowerCase() ?? null;

  // A worker that died mid-call, or a run that stopped before it could close one: the call's outcome is unknown, so it is closed as a miss and never repeated.
  if (S.inflight) {
    const [kind, idx] = S.inflight.split(":");
    if (kind === "probe" && domain) { await putDomainState(c.db, domain, { catch_all: null, mail_server: true }, c.eventId); S.probed = true; }
    else if (kind === "reveal") S.revealed = true;
    else if (kind === "rebuy") S.rebought = true;
    else if (kind === "find") S.finder = Number(idx) + 1;
    // The waterfall's start, with no request id written: whether it ran is unknown, so it is never started again. With an id, the job simply polls.
    else if (kind === "wf" && !S.wf?.request_id) { S.wf = { ...S.wf, done: true }; S.errs = (S.errs ?? 0) + 1; }
    else if (kind === "v1") { const cd = S.cand![Number(idx)]; if (cd && cd.state === "new") { cd.state = "rejected"; cd.why = "lost"; } }
    S.inflight = null;
    await save();
  }
  if (!domain) return drop("no_email_found");
  const crm = c.deps.crm;
  const vendorOfId = c.vendors.reveal?.name ?? null;
  if (!S.linked && r.vendor_person_id && vendorOfId) { S.linked = true; await linkQuietly(c.db, contactId, { vendor: vendorOfId }); }

  /** One paid call, behind its vendor's guard. Written down before it is made. A guard that refuses (down, throttling) waits and then pauses the event with the call unmade.
      `apply` records the answer in the same write that closes the call, so there is no moment with the call closed and its answer unwritten. `hold` leaves the reservation open for an asynchronous result. */
  const pay = async <T>(inflight: string, step: string, vendor: { name: string }, cost: number, call: () => Promise<{ value: T; charged: number }>, opts: { apply?: (r: Paid<T>) => void; hold?: (reservation: string) => Promise<void>; closed?: () => void } = {}) => {
    S.inflight = inflight; await save();
    const g = c.health.guard(vendor.name);
    try {
      const res = await withVendorWait(c, async () => {
        g.assertAvailable();
        return opts.hold ? holdVendor(c, step, vendor.name, cost, "credits", opts.hold, call) : paidVendor(c, step, vendor.name, cost, "credits", call);
      });
      // `closed` marks the step done in the same write that closes the call, so a crash just after it can never buy the step again. A call known to be unbilled is not done: it runs again on resume.
      S.inflight = null;
      if (!(res.kind === "error" && res.unbilled)) { opts.apply?.(res); opts.closed?.(); }
      await save();
      // Every attempt failed and none billed: the vendor is down. Nobody is dropped for that; the event pauses with the loop where it was, and a resume tries again.
      if (res.kind === "error" && res.unbilled) throw new PauseSignal(vendor.name, true);
      return res;
    } catch (e) {
      // The call was never made when the guard or the pause refused it, so it is not "in flight". Any other exception may have billed.
      if (e instanceof PauseSignal && e.repeatable) { S.inflight = null; await save(); }
      throw e;
    }
  };
  const guarded = <T>(name: string, run: () => Promise<T>) => c.health.guard(name).call(run, { paid: true });
  const limits = c.settings.limits;
  /** Queues this person again, behind everyone else waiting, and frees the worker. */
  const later = () => c.db.tx((q) => enqueue(q, c.eventId, "verify", { contact_id: contactId, index: 0 }));

  // 1. Opt-out by name, before anything is paid.
  if (!S.supp) {
    S.supp = true;
    if (r.full_name && !r.name_hidden && (await isOptedOut(c.db, { name_key: nameKey(r.full_name), company_key: r.company_key }))) return drop("opted_out");
  }

  // 2. The catch-all probe, once per domain, before any reveal.
  if (!S.probed) {
    const ages = c.settings.limits;
    const fresh = await getFreshDomainState(c.db, domain, ages);
    // A stored answer that came from a paid probe saved one. A domain with no mail server was a free DNS answer.
    if (fresh && fresh.mail_server !== false) await logReuse(c.db.query, c.eventId, { target: domain, step: "catch_all_probe", vendor: c.vendors.verifiers[0].name, unit: "credits", n: Math.max(o.probe_cost, c.vendors.verifiers[0].cost), answered_at: fresh.probed_at, answered_by: fresh.event_id });
    let st: { catch_all: boolean | null; mail_server: boolean | null } | null = fresh;
    if (!st) {
      const hasMail = await (c.vendors.identity?.dns ?? exampleDns).hasMailServer(domain);
      if (!hasMail) { await putDomainState(c.db, domain, { catch_all: null, mail_server: false }, c.eventId); st = { catch_all: null, mail_server: false }; }
      else {
        const v = c.vendors.verifiers[0];
        const cost = Math.max(o.probe_cost, v.cost);
        const res = await pay("probe", "catch_all_probe", v, cost, async () => { const out = await guarded(v.name, () => v.verify(probeAddress(domain))); return { value: out.verdict, charged: out.charged }; }, { closed: () => { S.probed = true; } });
        if (res.kind === "refused") return drop("budget_cap");
        // An address nobody has that reads deliverable means the domain accepts everything.
        const verdict = res.kind === "ok" ? res.value : "unknown";
        const catchAll = verdict === "deliverable" || verdict === "catch_all" ? true : verdict === "undeliverable" ? false : null;
        await putDomainState(c.db, domain, { catch_all: catchAll, mail_server: true }, c.eventId);
        await attempt(c, domain, v.name, "catch_all_probe", res.kind === "ok" ? verdict : "error");
        st = { catch_all: catchAll, mail_server: true };
      }
    }
    S.probed = true; await save();
    if (st.mail_server === false) return drop("not_deliverable");
    if (st.catch_all === true) return drop("catch_all_unconfirmed");
  }

  /** `twice`: Apollo reported it Verified as well as ZeroBounce passing it. Otherwise the Sheet says "Verified once". */
  const keep = async (cd: Cand, twice: boolean) => {
    const [dup] = await c.db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND email = $2 AND id <> $3 AND dropped_at IS NULL LIMIT 1", [c.eventId, cd.email, contactId]);
    if (dup) { cd.state = "rejected"; cd.why = "duplicate"; return drop("duplicate"); }
    cd.state = "kept";
    // One write: the address, the mark that it was kept, and the next job, so a crash leaves all of them or none.
    await c.db.tx(async (q) => {
      await q("UPDATE contacts SET email = $2, email_source = $3, verify_1 = 'deliverable', verify_2 = $4, email_loop = $5::jsonb WHERE id = $1", [contactId, cd.email, cd.vendor ?? cd.source, twice ? "deliverable" : null, JSON.stringify(S)]);
      const [row] = await q<{ linkedin: string | null }>("SELECT linkedin FROM contacts WHERE id = $1", [contactId]);
      await enqueue(q, c.eventId, row.linkedin ? "flag" : "linkedin", { contact_id: contactId });
    });
    await linkQuietly(c.db, contactId, { vendor: vendorOfId, verified: true });
  };

  const add = (email: string, source: Cand["source"], vendor?: string, flags: Pick<Cand, "apollo" | "zb_passed" | "stored_at"> = {}) => {
    const e = email.toLowerCase().trim();
    if (!e) return;
    const seen = S.cand!.find((x) => x.email === e);
    // An address set aside only because Apollo had not marked it Verified gets another chance from a source that does.
    if (seen && !(seen.why === "unverified" && flags.apollo)) return;
    if (seen) S.cand!.splice(S.cand!.indexOf(seen), 1);
    const cd: Cand = { email: e, source, vendor, state: "new", ...flags };
    // Free checks: an address at another domain is not evidence of employment here; a role or disposable address is never worth a verifier credit.
    if (emailDomain(e) !== domain) {
      cd.state = "rejected"; cd.why = "off_domain";
      if (r.source === "attendee") (S.mismatch ??= []).push({ email: e, source, kind: isFreeWebmail(emailDomain(e)) ? "webmail" : "other_domain" });
    }
    else if (isRoleAddress(e) || isDisposable(e)) { cd.state = "rejected"; cd.why = "role"; }
    S.cand!.push(cd);
  };

  /** Tests one candidate. Returns a drop reason when the person must stop, "kept" when it stays on the list, or null to try the next candidate. */
  const test = async (i: number): Promise<string | null> => {
    const cd = S.cand![i];
    if (await isOptedOut(c.db, { email: cd.email })) return "opted_out";
    // The address has just been learned, so Salesforce has not been asked about it. An uploaded one was asked about at the start of the run. Name at the account runs alongside it.
    if (cd.source !== "uploaded" && !cd.crm && crmConnected(crm)) {
      const seen = await checkAddress(c.db, crm, { id: contactId, full_name: r.name_hidden ? null : r.full_name, company: r.company, domain }, cd.email);
      cd.crm = true;
      if (seen.reason) return seen.reason;
      Object.assign(r.crm_bounced, seen.bounces);
    }
    if (r.full_name && !r.name_hidden && (await isWrongPerson(c.db, cd.email, nameKey(r.full_name)))) { cd.state = "rejected"; cd.why = "suppressed"; return null; }
    const bouncedAt = r.crm_bounced[cd.email] ?? null;
    // A stored ZeroBounce pass from before the bounce says nothing about the address now.
    if (cd.source === "waterfall" && bouncedAt && cd.stored_at && instant(bouncedAt) >= instant(cd.stored_at)) { cd.source = "finder"; cd.zb_passed = false; }
    // The waterfall's own result carries both checks. Nothing else is called.
    if (cd.source === "waterfall") {
      if (!cd.apollo || !cd.zb_passed) { cd.state = "rejected"; cd.why = "unverified"; return null; }
      await putVerification(c.db, cd.email, "deliverable", cd.vendor ?? cd.source, c.eventId);
      await keep(cd, true); return "kept";
    }
    // A found address Apollo has not marked Verified can never reach two checks, so no ZeroBounce credit is spent on it.
    if ((cd.source === "reveal" || cd.source === "finder") && !cd.apollo) { cd.state = "rejected"; cd.why = "unverified"; return null; }

    const v = c.vendors.verifiers[0];
    const pass = async () => {
      const twice = cd.apollo === true || (!bouncedAt && (await apolloVerified(c.db, cd.email, limits)));
      await keep(cd, twice);
      return "kept" as const;
    };
    if (!cd.zb) {
      // A result under the reuse window is reused, positive or negative, with no call.
      const cached = await getVerification(c.db, cd.email, limits, bouncedAt);
      if (cached) {
        await logReuse(c.db.query, c.eventId, { target: contactId, step: "verify", vendor: v.name, unit: "credits", n: v.cost, candidate: cd.email, answered_at: cached.checked_at, answered_by: cached.event_id });
        if (cached.verdict === "undeliverable") { cd.state = "rejected"; cd.why = "undeliverable"; return null; }
        if (cached.verdict === "catch_all") { cd.state = "catch_all"; return "catch_all_unconfirmed"; }
        if (cached.verdict === "deliverable") return pass();
      }
    }
    let unchecked = !cd.zb;
    while (unchecked || (cd.zb === "unknown" && (S.retries ?? 0) < o.verifier_retries)) {
      // A retry is used up only by a call that got an answer, so a retry the vendor refused without billing is still there after a pause.
      const retrying = !unchecked;
      unchecked = false;
      const res = await pay(`v1:${i}`, "verify", v, v.cost, async () => { const out = await guarded(v.name, () => v.verify(cd.email)); return { value: out.verdict, charged: out.charged }; }, { apply: (x) => { if (x.kind === "ok") { cd.zb = x.value; if (retrying) S.retries = (S.retries ?? 0) + 1; } } });
      await attempt(c, contactId, v.name, "verify", res.kind === "ok" ? res.value : res.kind);
      if (res.kind === "refused") return "budget_cap";
      if (res.kind === "error") { cd.state = "rejected"; cd.why = "error"; return null; }
    }
    if (cd.zb === "undeliverable") { cd.state = "rejected"; cd.why = "undeliverable"; await putVerification(c.db, cd.email, "undeliverable", v.name, c.eventId); return null; }
    if (cd.zb === "catch_all") { cd.state = "catch_all"; await putDomainState(c.db, domain, { catch_all: true, mail_server: true }, c.eventId); return "catch_all_unconfirmed"; }
    if (cd.zb !== "deliverable") { cd.state = "rejected"; cd.why = "unknown"; return null; }
    await putVerification(c.db, cd.email, "deliverable", v.name, c.eventId);
    return pass();
  };

  for (;;) {
    const i = S.cand!.findIndex((x) => x.state === "new");
    if (i >= 0) {
      const out = await test(i);
      await save();
      if (out === "kept") return;
      if (out) return drop(out);
      continue;
    }
    if (!S.uploaded) { S.uploaded = true; if (r.email) add(r.email, "uploaded"); await save(); continue; }

    // The reveal: a discovered person's first lookup, paid once by the vendor that found them, stored, then the employment check.
    const rv = c.vendors.reveal;
    if (r.source === "prospect" && !S.revealed && rv && r.vendor_person_id) {
      const pid = r.vendor_person_id;
      const store = dbReveals(c.db, limits.freshness_days, c.eventId);
      const buy = async (tag: string, reveal: Reveal) => {
        const res = await pay(tag, "reveal", reveal, reveal.cost, async () => { const out = await guarded(reveal.name, () => reveal.reveal({ vendor_person_id: pid, first_name: (r.full_name ?? "").split(" ")[0], company: r.company, domain })); return { value: out.person, charged: out.charged }; }, tag === "reveal" ? { closed: () => { S.revealed = true; } } : {});
        if (res.kind === "refused") return "refused" as const;
        await attempt(c, contactId, reveal.name, "reveal", res.kind === "ok" ? (res.value ? "found" : "miss") : "error");
        if (res.kind === "ok") await store.put(reveal.name, `pid:${pid}`, res.value);
        return res.kind === "ok" ? res.value : null;
      };
      const stored = await store.find(rv.name, `pid:${pid}`);
      let person: PersonMatchResult | null;
      let reused = false;
      if (stored) { person = stored.person; reused = person !== null; }
      else {
        const got = await buy("reveal", rv);
        if (got === "refused") return drop("budget_cap");
        person = got;
      }
      S.revealed = true;
      let working = person ? await employmentOk(c.db, r, person) : false;
      // A reused record is not grounds for dropping anyone: the person may have moved since. If it is old enough to be stale, it is bought once, fresh.
      if (person && !working && reused && !S.rebought && (stored?.age_days ?? 0) > REBUY_AFTER_DAYS) {
        S.rebought = true; await save();
        const got = await buy("rebuy", rv);
        if (got === "refused") return drop("budget_cap");
        reused = false;
        person = got;
        working = person ? await employmentOk(c.db, r, person) : false;
      }
      if (person) {
        const li = cleanLinkedin(person.linkedin);
        // Written only now, so what lands on the contact is the record the check was finally made on.
        await c.db.query(
          `UPDATE contacts SET full_name = coalesce($2, full_name), name_hidden = false, employer = $3, linkedin = coalesce(linkedin, $4),
             person_location = coalesce($5, person_location), vendor_seniority = coalesce($6, vendor_seniority), departments = coalesce($7, departments), role_since = coalesce($8, role_since) WHERE id = $1`,
          [contactId, person.full_name || null, person.employer, li, person.location ?? null, person.seniority ?? null, person.departments?.length ? person.departments.join(", ") : null, person.role_since ?? null]);
        r.full_name = person.full_name || r.full_name; r.name_hidden = false;
        // The employer must match this company, a parent or a known alias. A discovered person who has moved is dropped before any verifier is paid.
        if (!working) return drop("employment_unconfirmed");
        // Saved only now: a stored record that failed the check replaced nothing.
        if (reused && stored?.fetched_at) await logReuse(c.db.query, c.eventId, { target: contactId, step: "reveal", vendor: rv.name, unit: "credits", n: rv.cost, answered_at: stored.fetched_at, answered_by: stored.event_id });
        if (await isOptedOut(c.db, { email: person.email, name_key: nameKey(person.full_name), company_key: r.company_key })) return drop("opted_out");
        if (person.email) add(person.email, "reveal", rv.name, { apollo: person.email_verified === true });
      }
      await save();
      continue;
    }

    if (S.cand!.length >= MAX_CANDIDATES) return drop(exhaustedReason(S.cand!, S.errs));
    // Finders need a full name. A person whose last name is still hidden (the reveal missed) has none.
    const nm = r.full_name && !r.name_hidden ? firstLast(r.full_name) : null;
    const nk = r.full_name && !r.name_hidden ? nameKey(r.full_name) : null;
    const keepLinkedin = async (url: string | null | undefined) => { const li = cleanLinkedin(url); if (li) { await c.db.query("UPDATE contacts SET linkedin = coalesce(linkedin, $2) WHERE id = $1", [contactId, li]); await linkQuietly(c.db, contactId, { vendor: vendorOfId }); } };

    // Apollo's match. Someone Apollo has just revealed has already had this answer.
    const fi = r.source === "prospect" && r.vendor_person_id && rv ? c.vendors.finders.length : S.finder ?? 0;
    if (nm && nk && fi < c.vendors.finders.length) {
      const f = c.vendors.finders[fi];
      // The Research step may have bought this very match to confirm the company. It is the same Apollo record, so it is not bought again.
      const pm = c.vendors.identity?.personMatch;
      const bought = pm && f.name.startsWith("apollo") && pm.name.startsWith("apollo") ? await dbReveals(c.db, limits.freshness_days, c.eventId).find(pm.name, `pm|${nameSet(r.full_name!)}|${r.company_key}`) : null;
      if (bought?.person && bought.person.employer && employerMatches(r.company_key, companyKey(bought.person.employer))) {
        const email = bought.person.email?.toLowerCase() ?? null, linkedin = bought.person.linkedin ?? null, verified = bought.person.email_verified === true;
        S.finder = fi + 1;
        await keepLinkedin(linkedin);
        await putFinderResult(c.db, f.name, nk, r.company_key, { email, linkedin: cleanLinkedin(linkedin), apollo_verified: verified, credits: 0 }, c.eventId);
        if (email) { add(email, "finder", f.name, { apollo: verified }); await logReuse(c.db.query, c.eventId, { target: contactId, step: "find", vendor: f.name, unit: "credits", n: f.cost, answered_at: bought.fetched_at!, answered_by: bought.event_id }); }
        await save();
        continue;
      }
      const stored = await getFinderResult(c.db, f.name, nk, r.company_key, limits);
      if (stored) {
        S.finder = fi + 1;
        await keepLinkedin(stored.linkedin);
        // A stored miss saved nothing: Apollo does not charge for a match that finds nobody.
        if (stored.email) { add(stored.email, "finder", f.name, { apollo: stored.apollo_verified }); await logReuse(c.db.query, c.eventId, { target: contactId, step: "find", vendor: f.name, unit: "credits", n: f.cost, answered_at: stored.fetched_at, answered_by: stored.event_id }); }
        await save();
        continue;
      }
      const res = await pay(`find:${fi}`, "find", f, f.cost, async () => { const out = await guarded(f.name, () => f.find({ full_name: r.full_name, company: r.company })); return { value: out, charged: out.charged }; }, { closed: () => { S.finder = fi + 1; } });
      S.finder = fi + 1;
      if (res.kind === "refused") return drop("budget_cap");
      await attempt(c, contactId, f.name, "find", res.kind === "ok" ? (res.value.value ? "found" : "miss") : "error");
      if (res.kind === "error") S.errs = (S.errs ?? 0) + 1;
      else {
        await keepLinkedin(res.value.linkedin);
        await putFinderResult(c.db, f.name, nk, r.company_key, { email: res.value.value, linkedin: cleanLinkedin(res.value.linkedin), apollo_verified: res.value.apollo_verified, credits: res.value.charged }, c.eventId);
        if (res.value.value) add(res.value.value, "finder", f.name, { apollo: res.value.apollo_verified === true });
      }
      await save();
      continue;
    }

    // Apollo's waterfall, on a miss. One per person.
    const wf = c.vendors.waterfall;
    if (nm && nk && wf && !S.wf?.done) {
      const useResult = (email: string | null, apolloOk: boolean, zbOk: boolean, storedAt?: string) => { if (email) add(email, "waterfall", wf.name, { apollo: apolloOk, zb_passed: zbOk, stored_at: storedAt }); };
      if (!S.wf) {
        const stored = await getFinderResult(c.db, wf.name, nk, r.company_key, limits);
        if (stored) {
          S.wf = { done: true };
          await keepLinkedin(stored.linkedin);
          // Its ZeroBounce pass counts only while it is under the reuse window. Older, the address is checked again like any other Apollo address.
          if (stored.email && stored.zerobounce_pass && stored.age_days > limits.verification_reuse_days) add(stored.email, "finder", wf.name, { apollo: stored.apollo_verified });
          else useResult(stored.email, stored.apollo_verified, stored.zerobounce_pass, stored.fetched_at);
          await logReuse(c.db.query, c.eventId, { target: contactId, step: "waterfall", vendor: wf.name, unit: "credits", n: stored.credits, answered_at: stored.fetched_at, answered_by: stored.event_id });
          await save();
          continue;
        }
      }
      if (!S.wf?.request_id) {
        const res = await pay("wf", "waterfall", wf, wf.reserve, async () => ({ value: await guarded(wf.name, () => wf.start({ full_name: r.full_name!, company: r.company, domain })), charged: 0 }), {
          hold: async (id) => { S.wf = { res: id, deadline: c.health.clock.now() + c.settings.waterfall.max_wait_minutes * 60_000 }; await save(); },
          apply: (x) => { if (x.kind === "ok") { S.wf!.request_id = x.value.request_id; S.wf!.linkedin = x.value.linkedin ?? null; } },
        });
        if (res.kind === "refused") { S.wf = { done: true }; return drop("budget_cap"); }
        await attempt(c, contactId, wf.name, "waterfall", res.kind === "ok" ? "started" : "error");
        if (res.kind === "error") { S.wf = { ...S.wf, done: true }; S.errs = (S.errs ?? 0) + 1; await save(); continue; }
        await later();
        return;
      }
      const st = S.wf;
      const clock = c.health.clock;
      const wait = (st.next ?? 0) - clock.now();
      if (wait > 0) {
        await clock.sleep(Math.min(wait, 20_000));
        if ((st.next ?? 0) > clock.now()) { await later(); return; }
      }
      const g = c.health.guard(wf.name);
      const out: WaterfallPoll = await withVendorWait(c, () => g.call(() => wf.poll(st.request_id!)));
      if (out.state === "pending") {
        if (clock.now() < (st.deadline ?? 0)) { st.next = clock.now() + out.retry_after_ms; await save(); await later(); return; }
        // The wait is over. Several stuck at once is an outage: the event pauses, nobody drops, and the waits start again on resume. One or two stuck are closed, and their reservations stay spent.
        const [{ n }] = await c.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND email_loop->'wf'->>'request_id' IS NOT NULL AND (email_loop->'wf'->>'done') IS NULL AND (email_loop->'wf'->>'deadline')::bigint <= $2::bigint`, [c.eventId, String(clock.now())]);
        if (n >= PAUSE_AFTER) {
          st.deadline = clock.now() + c.settings.waterfall.max_wait_minutes * 60_000;
          await save();
          await c.db.query(`UPDATE contacts SET email_loop = jsonb_set(email_loop, '{wf,deadline}', to_jsonb($2::bigint)) WHERE event_id = $1 AND dropped_at IS NULL AND email_loop->'wf'->>'request_id' IS NOT NULL AND (email_loop->'wf'->>'done') IS NULL AND (email_loop->'wf'->>'deadline')::bigint <= $3::bigint`, [c.eventId, String(st.deadline), String(clock.now())]);
          throw new PauseSignal(wf.name, true);
        }
      }
      if (out.state !== "done") {
        st.done = true; S.errs = (S.errs ?? 0) + 1;
        await attempt(c, contactId, wf.name, "waterfall", "no_result");
        await save();
        continue;
      }
      if (st.res) await settleOnce(c.db, st.res, out.result.credits);
      const li = cleanLinkedin(out.result.linkedin ?? st.linkedin);
      await putFinderResult(c.db, wf.name, nk, r.company_key, { email: out.result.email, linkedin: li, apollo_verified: out.result.apollo_verified, zerobounce_pass: out.result.zerobounce_pass, credits: out.result.credits }, c.eventId);
      await keepLinkedin(li);
      st.done = true;
      useResult(out.result.email, out.result.apollo_verified, out.result.zerobounce_pass);
      await attempt(c, contactId, wf.name, "waterfall", out.result.email ? "found" : "miss");
      await save();
      continue;
    }
    // Pattern guessing is off by default: it needs verified addresses at the domain, and guessing addresses carries legal risk in some markets.
    if (o.pattern_guess && nm && !S.pattern) {
      S.pattern = true;
      const known = await c.db.query<{ email: string; full_name: string }>("SELECT email, full_name FROM contacts WHERE event_id = $1 AND company_id = $2 AND email IS NOT NULL AND dropped_at IS NULL AND verify_1 = 'deliverable'", [c.eventId, r.company_id]);
      const p = dominantPattern(known.flatMap((k) => { const f = firstLast(k.full_name); return f ? [{ email: k.email, ...f }] : []; }));
      if (p) add(`${applyPattern(p, nm.first, nm.last)}@${domain}`, "pattern");
      await save();
      continue;
    }
    return drop(exhaustedReason(S.cand!, S.errs));
  }
}

