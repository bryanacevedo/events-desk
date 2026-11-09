/* Company tiering under the pinned ICP (docs/TIERING-AND-ENRICHMENT.md, "Layer 2" and "Layer 3"). One `company_tier` job is one company, start to finish:

     firmographics   cache by domain, then the free search, then ONE paid enrich only if fields the ICP needs are still missing
     hard rules      in code; a missing field is Unknown, never a failure; a failed rule is tier 3 and costs the model nothing
     tier cache      domain plus ICP version, never domain alone
     tier            the model returns 1, 2, 3 or Unknown, with the segment, the company type, a reason and the supplied fact it relied on;
                     a tier that cites no supplied fact becomes Unknown
     Unknown         one website read, then one retry; still Unknown spends nothing more and becomes a review case
     baseline        size band plus keywords, computed per company at run time
     no second look  it was cut (docs/DECISIONS.md, 24); the model's stated confidence is never used.

   An event with no pinned ICP keeps the older single-prompt tiering in pipeline.ts. Everything here is paid through the ledger by step name, so
   the Research card's per-step caps hold. The same Ctx, decide() and paidVendor() the other jobs use are used here. */

import type { Db } from "./db.ts";
import { getFirmographics, getTier, logReuse, putFirmographics, putTier } from "./caches.ts";
import { openCase } from "./cases.ts";
import { decide, paidVendor, withVendorWait, type Ctx, type Job } from "./paid.ts";
import { logActivity, RuleError } from "./events.ts";
import { fill } from "./prompts.ts";
import { mockFirmographics, mockWebsite, type Llm } from "./providers.ts";
import { dropAtCompany, enqueue } from "./work.ts";
import { baselineTier, evalHardRules, matchSegment, renderIcp, type Icp, type Tier } from "../shared/icp.ts";
import { validCompanyTier, validWebsiteRead, type CompanyTierAnswer } from "../shared/tiers.ts";
import { buildFacts, cleanFirmo, firmoForRules, mergeFirmo, missingNeeded, spreadCheck, type Facts, type FirmoRecord, type Spread, type SpreadExample } from "../shared/tiering.ts";
import type { Settings } from "../shared/cost.ts";

/* ------------------------------------------------------------- the ICP */

export interface PinnedIcp { version: number; icp: Icp; rendered: string; segments: string[]; types: string[] }
const loaded = new WeakMap<Db, Map<number, Icp>>();

/** The ICP version this event pinned when its Research card was approved, or null for an event that has none. A published version never changes, so it is read once. */
export async function pinnedIcp(db: Db, eventId: string): Promise<PinnedIcp | null> {
  const [e] = await db.query<{ icp_version: number | null }>("SELECT icp_version FROM events WHERE id = $1", [eventId]);
  if (!e?.icp_version) return null;
  let byVersion = loaded.get(db);
  if (!byVersion) { byVersion = new Map(); loaded.set(db, byVersion); }
  let icp = byVersion.get(e.icp_version);
  if (!icp) {
    const [r] = await db.query<{ icp: Icp }>("SELECT icp FROM icp_versions WHERE version = $1", [e.icp_version]);
    if (!r) return null;
    icp = r.icp; byVersion.set(e.icp_version, icp);
  }
  return { version: e.icp_version, icp, rendered: renderIcp(icp), segments: icp.segments.map((s) => s.id), types: icp.company_types.map((t) => t.id) };
}

/** The same, from inside a transaction that only has a query function. Not cached. */
export async function pinnedIcpQ(q: Db["query"], eventId: string): Promise<PinnedIcp | null> {
  const [r] = await q<{ version: number; icp: Icp }>("SELECT v.version, v.icp FROM events e JOIN icp_versions v ON v.version = e.icp_version WHERE e.id = $1", [eventId]);
  return r ? { version: r.version, icp: r.icp, rendered: renderIcp(r.icp), segments: r.icp.segments.map((s) => s.id), types: r.icp.company_types.map((t) => t.id) } : null;
}

/* -------------------------------------------------------- file context */

/** The attendee file's own columns for a company. Every value is a claim, so it is labeled unverified when the model sees it. */
export async function companyContext(db: Db, eventId: string, companyId: string) {
  const [row] = await db.query<{ raw: Record<string, string>; website: string | null }>("SELECT raw, website FROM source_rows WHERE event_id = $1 AND company_id = $2 ORDER BY (website IS NULL), row_number LIMIT 1", [eventId, companyId]);
  const [up] = await db.query<{ ignored: string[] }>("SELECT ignored FROM uploads WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1", [eventId]);
  // A website column holds filler as often as not, so the model sees the cleaned domain or nothing.
  const site = (k: string) => /^(website|web|site|url|homepage|companywebsite|companyurl|companydomain|domain)$/.test(k.toLowerCase().replace(/[^a-z]/g, ""));
  // The LLM cap counts calls, so the size of each call has to be bounded here.
  return (up?.ignored ?? []).slice(0, 10).map((k) => (site(k) ? (row?.website ? `${k}: ${row.website}` : "") : row?.raw[k] ? `${k}: ${row.raw[k]}`.slice(0, 200) : "")).filter(Boolean);
}

/* ------------------------------------------------------------- the job */

interface CompanyRow {
  id: string; name: string; primary_domain: string | null; tier: number | null; tier_via: string | null; in_research: boolean;
  firmo: FirmoRecord | null; firmo_source: string | null; website_note: string | null;
}
const UNKNOWN: CompanyTierAnswer = { tier: null, segment: null, company_type: null, reason: "insufficient_information", fact: null, downgraded: null };

const whatWeKnow = (f: Facts) => (f.citable.length ? f.citable.join("; ") : "nothing from the file or our data providers");

/** Unknown: nothing more is spent on this company. A person tiers it, drops it, or skips what remains. The suggestion is no spend. */
async function unknownCase(c: Ctx, co: CompanyRow, facts: Facts, why: string) {
  await c.db.tx((q) => openCase(q, {
    eventId: c.eventId, kind: "unknown_tier", companyId: co.id,
    summary: `Which tier is "${co.name}"? ${why}`,
    facts: [{ company: co.name, website: co.primary_domain ?? "not known" }, { what_we_know: whatWeKnow(facts) }],
    suggested: "drop",
  }));
}

/** Firmographics for the company's domain. Cache first (a human correction is final), then the free search, then one paid enrich only if the ICP still lacks fields it needs. */
async function ensureFirmo(c: Ctx, co: CompanyRow, icp: Icp, reuseStored: boolean): Promise<{ firmo: FirmoRecord; source: string; note: string | null; cached_at: string | null }> {
  if (reuseStored && co.firmo) return { firmo: co.firmo, source: co.firmo_source ?? "cache", note: null, cached_at: null };
  const domain = co.primary_domain!;
  const fp = c.vendors.firmographics ?? mockFirmographics(c.settings);
  const cached = await getFirmographics(c.db, domain, c.settings.limits);
  let firmo: FirmoRecord = {};
  let meta = { searched: false, enriched: false };
  let source = "search";
  let note: string | null = null;
  if (cached) {
    const { _meta, website_note, ...fields } = cached.firmographics as Record<string, unknown> & { _meta?: typeof meta; website_note?: string };
    firmo = cleanFirmo(fields);
    meta = _meta ?? { searched: true, enriched: false };
    note = typeof website_note === "string" ? website_note : null;
    source = cached.corrected ? "human" : "cache";
    // A person's correction is final: nothing is searched or bought over it.
    if (cached.corrected) return { firmo, source, note, cached_at: cached.fetched_at };
    // Only an enrich the stored record really paid for saved a credit: the free search saved nothing.
    if (meta.enriched) await logReuse(c.db.query, c.eventId, { target: co.id, step: "firmographics", vendor: fp.name, unit: "credits", n: fp.cost, answered_at: cached.fetched_at, answered_by: cached.event_id });
  } else {
    const g = c.health.guard(fp.name);
    const r = await withVendorWait(c, () => g.call(() => fp.search(domain, co.name)));
    firmo = cleanFirmo(r.firmo);
    meta.searched = true;
  }
  let changed = !cached;
  if (!meta.enriched && missingNeeded(icp, firmo).some((m) => !fp.provides || fp.provides.includes(m))) {
    const g = c.health.guard(fp.name);
    const r = await withVendorWait(c, async () => {
      g.assertAvailable();
      return paidVendor(c, "firmographics", fp.name, fp.cost, "credits", async () => { const o = await g.call(() => fp.enrich(domain, co.name), { paid: true }); return { value: o.firmo, charged: o.charged }; });
    });
    // A refusal or an error is not retried here: the company goes on with what it has, and the missing fields stay Unknown.
    if (r.kind === "ok") { firmo = mergeFirmo(firmo, cleanFirmo(r.value)); meta.enriched = true; source = cached ? `${source}+enrich` : "search+enrich"; changed = true; }
  }
  if (changed) await putFirmographics(c.db, domain, co.name, { ...firmo, _meta: meta, ...(note ? { website_note: note } : {}) }, source, c.eventId);
  return { firmo, source, note, cached_at: cached?.fetched_at ?? null };
}

type Pass = { kind: "answer"; a: CompanyTierAnswer } | { kind: "refused" } | { kind: "vendor_error" };

/** One tier pass. An answer that cannot be read after the card's retry is Unknown, not a failure. A provider error is a failure. */
async function tierPass(c: Ctx, pin: PinnedIcp, step: "company_tier", facts: Facts, opts: { llm?: Llm; attempts?: number } = {}): Promise<Pass> {
  const prompt = fill(step, { icp: pin.rendered, segments: pin.segments.join(", ") || "none", company_types: pin.types.join(", ") || "none", input: facts.text });
  const r = await decide(c, step, prompt, (v) => validCompanyTier(v, { citable: facts.citable, requireFact: true, segments: pin.segments, types: pin.types }), opts);
  if (r.kind === "ok") return { kind: "answer", a: r.value };
  if (r.kind === "refused") return { kind: "refused" };
  return r.why === "vendor" ? { kind: "vendor_error" } : { kind: "answer", a: UNKNOWN };
}

/** One read of the company's own site, then one model call to say what it does. Free to read; the model call is the website_read step. Returns null when there is nothing to add. */
async function websiteRead(c: Ctx, co: CompanyRow): Promise<string | null> {
  if (!co.primary_domain) return null;
  const reader = c.vendors.website ?? mockWebsite;
  let page: string | null = null;
  try { page = await reader.read(co.primary_domain); } catch { page = null; }
  if (!page || page.trim().length < 20) return null;
  // The page is data. A marker inside it cannot close the data block early.
  const safe = page.replaceAll("PAGE>>>", "PAGE> >>").replaceAll("<<<PAGE", "<< <PAGE").slice(0, 4000);
  const r = await decide(c, "website_read", fill("website_read", { name: co.name, page: safe }), validWebsiteRead, { attempts: 1 });
  if (r.kind !== "ok" || !r.value.description) return null;
  return r.value.description;
}

interface Result { tier: Tier | null; a: CompanyTierAnswer; via: string; baseline: Tier | null; second: Record<string, unknown> | null }

async function save(c: Ctx, co: CompanyRow, pin: PinnedIcp, f: { firmo: FirmoRecord; source: string }, r: Result, note: string | null) {
  const seg = r.a.segment ?? matchSegment(pin.icp, firmoForRules(f.firmo))?.id ?? null;
  await c.db.query(
    `UPDATE companies SET tier = $2, tier_reason = $3, segment = $4, company_type = $5, tier_fact = $6, tier_via = $7, tier_icp_version = $8, baseline_tier = $9,
       second_look = $10::jsonb, firmo = $11::jsonb, firmo_source = $12, website_note = coalesce($13, website_note) WHERE id = $1`,
    [co.id, r.tier, r.tier === null ? null : r.a.reason, seg, r.a.company_type, r.a.fact, r.via, pin.version, r.baseline, r.second ? JSON.stringify(r.second) : null, JSON.stringify(f.firmo), f.source, note]);
}

export async function companyTierWithIcp(c: Ctx, job: Job, lost: boolean, pin: PinnedIcp) {
  const { company_id } = job.payload;
  const retier = job.payload.retier === true;
  const [co] = await c.db.query<CompanyRow>("SELECT id, name, primary_domain, tier, tier_via, in_research, firmo, firmo_source, website_note FROM companies WHERE id = $1", [company_id]);
  if (!co || !co.in_research) return;
  // A person already settled it (or an earlier pass did): nothing is paid twice.
  if (co.tier !== null && !retier) return;
  const empty = buildFacts({ name: co?.name ?? "", domain: co.primary_domain, firmo: null });
  if (lost) return unknownCase(c, co, empty, "A worker stopped while this company was being tiered, so a paid call may or may not have run. Nothing was repeated.");
  if (!co.primary_domain) return unknownCase(c, co, empty, "It has no confirmed website yet, so nothing could be looked up.");

  const fail = (reason: string) => c.db.tx((q) => dropAtCompany(q, c.eventId, co.id, reason));
  const f = await ensureFirmo(c, co, pin.icp, retier);
  let note = co.website_note ?? f.note;
  const rules = firmoForRules(f.firmo);
  const baseline = baselineTier(pin.icp, rules);
  const fileNotes = await companyContext(c.db, c.eventId, co.id);
  let facts = buildFacts({ name: co.name, domain: co.primary_domain, firmo: f.firmo, website_note: note, file_notes: fileNotes });

  // Hard rules run in code. A rule fires only when its field is present; a company that fails one is tier 3 and costs the model nothing.
  const { failed } = evalHardRules(pin.icp, rules);
  if (failed.length) {
    const a: CompanyTierAnswer = { tier: 3, segment: null, company_type: null, reason: "outside_icp", fact: `${failed[0].text}. ${facts.citable.slice(0, 3).join("; ")}`.slice(0, 300), downgraded: null };
    await save(c, co, pin, f, { tier: 3, a, via: "hard_rule", baseline, second: null }, note);
    await putTier(c.db, co.primary_domain, String(pin.version), { tier: 3, segment: matchSegment(pin.icp, rules)?.id, reason: "outside_icp", fact: a.fact ?? undefined }, c.eventId);
    return;
  }

  // Tier results cache on domain plus ICP version, never domain alone. A re-tier asks again.
  if (!retier) {
    const hit = await getTier(c.db, co.primary_domain, String(pin.version));
    if (hit && hit.tier !== null) {
      const a: CompanyTierAnswer = { tier: hit.tier as Tier, segment: hit.segment, company_type: hit.company_type, reason: hit.reason ?? "icp_match", fact: hit.fact, downgraded: null };
      // Each call the stored tier replaced, and only the ones that would really have run.
      const saved = (step: string) => logReuse(c.db.query, c.eventId, { target: co.id, step, vendor: step, unit: "llm", n: 1, answered_at: hit.created_at, answered_by: hit.event_id });
      if (facts.citable.length) await saved("company_tier");
      // A stored website note exists only because an earlier pass could not tell without it.
      if (f.note && !co.website_note) await saved("website_read");
      await save(c, co, pin, f, { tier: hit.tier as Tier, a, via: "cache", baseline, second: null }, note);
      return;
    }
  }

  // Pass one. With no supplied fact at all there is nothing to cite, so the answer is Unknown without a call.
  let a: CompanyTierAnswer = UNKNOWN;
  if (facts.citable.length) {
    const p = await tierPass(c, pin, "company_tier", facts);
    if (p.kind === "refused") { await save(c, co, pin, f, { tier: null, a: UNKNOWN, via: "model", baseline, second: null }, note); return unknownCase(c, co, facts, "The Research budget has no AI calls left for this step."); }
    if (p.kind === "vendor_error") return fail("tiering_failed");
    a = p.a;
  }

  // Unknown: one website read, then one retry.
  if (a.tier === null && !co.website_note && !f.note) {
    const got = await websiteRead(c, co);
    if (got) {
      note = got;
      facts = buildFacts({ name: co.name, domain: co.primary_domain, firmo: f.firmo, website_note: note, file_notes: fileNotes });
      const p = await tierPass(c, pin, "company_tier", facts);
      if (p.kind === "vendor_error") return fail("tiering_failed");
      if (p.kind === "answer") a = p.a;
      if (p.kind === "refused") a = UNKNOWN;
      // Keep the website note whatever the retry said, so the next look does not read the site again.
      await c.db.query("UPDATE company_cache SET firmographics = firmographics || jsonb_build_object('website_note', $2::text) WHERE domain = $1 AND NOT corrected", [co.primary_domain, note]);
    }
  }
  if (a.tier === null) {
    await save(c, co, pin, f, { tier: null, a, via: "model", baseline, second: null }, note);
    return unknownCase(c, co, facts, a.downgraded === "no_fact" ? "Nothing we found backs up a tier for it." : "We checked its website and still could not tell.");
  }

  // No second look: it was cut after the real recording (docs/DECISIONS.md, 24). The first tier stands.
  await save(c, co, pin, f, { tier: a.tier, a, via: "model", baseline, second: null }, note);
  await putTier(c.db, co.primary_domain, String(pin.version), { tier: a.tier, segment: a.segment ?? undefined, company_type: a.company_type ?? undefined, reason: a.reason, fact: a.fact ?? undefined }, c.eventId);
}

/* --------------------------------------------------------- spread check */

/** The spread of tiers across the companies that are still in research, with examples. A warning, never a block. */
export async function spreadFor(q: Db["query"], eventId: string, s: Settings): Promise<Spread> {
  const rows = await q<{ name: string; tier: number | null; tier_fact: string | null; firmo: FirmoRecord | null }>(
    "SELECT name, tier, tier_fact, firmo FROM companies WHERE event_id = $1 AND in_research AND list_status IS NULL AND identity_state = 'resolved' AND inherited_from IS NULL ORDER BY name", [eventId]);
  const ex = (pred: (r: (typeof rows)[number]) => boolean, detail: (r: (typeof rows)[number]) => string): SpreadExample[] => rows.filter(pred).slice(0, 5).map((r) => ({ company: r.name, detail: detail(r) }));
  const known = (r: (typeof rows)[number]) => (r.tier_fact ? r.tier_fact : r.firmo?.industry ?? "no facts");
  return spreadCheck(
    { total: rows.length, tier1: rows.filter((r) => r.tier === 1).length, tier2: rows.filter((r) => r.tier === 2).length, tier3: rows.filter((r) => r.tier === 3).length, unknown: rows.filter((r) => r.tier === null).length },
    { tier1: ex((r) => r.tier === 1, known), tier2: ex((r) => r.tier === 2, known), unknown: ex((r) => r.tier === null, () => "No tier yet") },
    s.limits);
}

/* -------------------------------------------------------------- re-tier */

export interface RetierOptions { company_ids?: string[]; scope?: "unknown" | "tier_1" | "all"; icp_version?: number }

/** Before Approval 2 a person can re-tier companies, against the allowance stated on the Research card, reusing the stored firmographics.
    Moving to another ICP version re-tiers every company that is not set by a person, so an event never mixes versions; it must fit the allowance. */
export async function retier(db: Db, eventId: string, actor: string, opts: RetierOptions) {
  return db.tx(async (q) => {
    const [e] = await q<{ stage: string; icp_version: number | null; retier_used: number }>("SELECT stage, icp_version, retier_used FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (!e) throw new RuleError("That event does not exist.");
    if (e.stage !== "ready_for_review") throw new RuleError(`Companies can be re-tiered once research is done and before the Outreach card is approved. This event is ${e.stage.replace(/_/g, " ")}.`);
    if ((await q("SELECT 1 FROM approvals WHERE event_id = $1 AND kind = 'outreach' AND status = 'pending'", [eventId])).length) throw new RuleError("The Outreach card is waiting for approval and was quoted from the current tiers. Decline it first, then re-tier.");
    if ((await q("SELECT 1 FROM jobs WHERE event_id = $1 AND status IN ('queued', 'running')", [eventId])).length) throw new RuleError("Research is still finishing. Try again in a moment.");
    const [card] = await q<{ lines: { retier_companies?: number } }>("SELECT lines FROM cost_cards WHERE event_id = $1 AND kind = 'research' AND status = 'approved' ORDER BY created_at DESC LIMIT 1", [eventId]);
    const allowance = card?.lines.retier_companies ?? 0;
    const remaining = Math.max(0, allowance - e.retier_used);

    let version = e.icp_version;
    const repin = opts.icp_version !== undefined && opts.icp_version !== e.icp_version;
    if (repin) {
      const [v] = await q<{ version: number }>("SELECT version FROM icp_versions WHERE version = $1", [opts.icp_version]);
      if (!v) throw new RuleError("That ICP version does not exist.");
      version = v.version;
    }
    const live = await q<{ id: string; tier: number | null; tier_via: string | null; primary_domain: string | null }>(
      "SELECT id, tier, tier_via, primary_domain FROM companies WHERE event_id = $1 AND in_research AND list_status IS NULL AND identity_state = 'resolved' AND inherited_from IS NULL", [eventId]);
    let targets: typeof live;
    if (opts.company_ids?.length) {
      targets = live.filter((r) => opts.company_ids!.includes(r.id));
      if (targets.length !== new Set(opts.company_ids).size) throw new RuleError("One of those companies is not in this event's research.");
    } else if (opts.scope === "unknown") targets = live.filter((r) => r.tier === null);
    else if (opts.scope === "tier_1") targets = live.filter((r) => r.tier === 1 && r.tier_via !== "human");
    else if (opts.scope === "all" || repin) targets = live.filter((r) => r.tier_via !== "human");
    else throw new RuleError("Say which companies to re-tier: some company ids, or a scope.");
    // Another ICP version never mixes with the old one.
    if (repin) { const rest = live.filter((r) => r.tier_via !== "human" && !targets.includes(r)); targets = [...targets, ...rest]; }
    if (!targets.length) return { requeued: 0, remaining, allowance, icp_version: version };
    if (targets.length > remaining) throw new RuleError(repin
      ? `Moving to ICP version ${version} re-tiers all ${targets.length} companies, and the Research card allows ${remaining} more re-tiers (${allowance} in all). Re-tier a smaller set under the current version, or decline and start a new Research card.`
      : `Re-tiering ${targets.length} companies is more than the ${remaining} the Research card has left (${allowance} in all).`);

    const ids = targets.map((t) => t.id);
    await q("UPDATE review_cases SET status = 'skipped', decision = 'retier', decided_by = $2, decided_at = now() WHERE event_id = $1 AND status = 'open' AND kind IN ('unknown_tier', 'second_look_disagreement') AND company_id = ANY($3::text[])", [eventId, actor, ids]);
    await q("UPDATE companies SET tier = NULL, tier_reason = NULL, segment = NULL, company_type = NULL, tier_fact = NULL, tier_via = NULL, baseline_tier = NULL, second_look = NULL WHERE id = ANY($1::text[])", [ids]);
    for (const t of targets) {
      if (t.primary_domain) await q("DELETE FROM tier_cache WHERE domain = $1 AND icp_version = $2", [t.primary_domain, String(version)]);
      await enqueue(q, eventId, "company_tier", { company_id: t.id, retier: true });
    }
    await q("UPDATE events SET retier_used = retier_used + $2, icp_version = $3, icp_pinned_at = CASE WHEN $4 THEN now() ELSE icp_pinned_at END WHERE id = $1", [eventId, ids.length, version, repin]);
    await logActivity(q, eventId, actor, "retier", `Re-tiered ${ids.length} companies${repin ? ` under ICP version ${version}` : ""}; ${remaining - ids.length} of ${allowance} re-tiers left`);
    return { requeued: ids.length, remaining: remaining - ids.length, allowance, icp_version: version };
  });
}

/* ------------------------------------------------------ human correction */

/** A person corrects a company's firmographics. The correction overwrites the cache for that domain and is never aged out, and the tiers cached on the old values are dropped. It takes effect for this event on a re-tier. */
export async function correctCompanyFirmo(db: Db, eventId: string, companyId: string, actor: string, patch: unknown) {
  const fixes = cleanFirmo(patch);
  if (!Object.keys(fixes).length) throw new RuleError("Give at least one of: employees, industry, business_model, country, description.");
  return db.tx(async (q) => {
    const [co] = await q<{ name: string; primary_domain: string | null; firmo: FirmoRecord | null }>("SELECT name, primary_domain, firmo FROM companies WHERE id = $1 AND event_id = $2 FOR UPDATE", [companyId, eventId]);
    if (!co) throw new RuleError("That company is not on this event.");
    if (!co.primary_domain) throw new RuleError("This company has no confirmed website yet, so its facts cannot be filed under one.");
    const merged = { ...(co.firmo ?? {}), ...fixes };
    await q(
      `INSERT INTO company_cache (domain, name, firmographics, source, corrected) VALUES ($1, $2, $3::jsonb, $4, true)
       ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name, firmographics = EXCLUDED.firmographics, source = EXCLUDED.source, corrected = true, fetched_at = now()`,
      [co.primary_domain, co.name, JSON.stringify({ ...merged, _meta: { searched: true, enriched: true } }), `human:${actor}`]);
    await q("DELETE FROM tier_cache WHERE domain = $1", [co.primary_domain]);
    await q("UPDATE companies SET firmo = $2::jsonb, firmo_source = 'human' WHERE id = $1", [companyId, JSON.stringify(merged)]);
    await logActivity(q, eventId, actor, "correction", `Corrected the facts for ${co.name}: ${Object.keys(fixes).join(", ")}`);
    return { domain: co.primary_domain, firmo: merged };
  });
}

