/* Which company a paid step belongs to, and the one rule the whole system keeps: vendor credits and AI dollars are
   different things. Apollo and ZeroBounce are counted in their own credits, drawn from a pool each subscription
   pre-allocates, and credits never become dollars. Only AI model calls (Anthropic) are dollars. Whatever Apollo's email
   waterfall spends, on its sources and on ZeroBounce as its validator, is Apollo credits.
   Simulated names (finder_one, reveal_sim, ...) map to the same vendors, so the demo reads like the live product.
   The ledger notes live steps by vendor name (apollo_match, zerobounce, ...) and simulated ones by the step. */

export const CREDIT_VENDORS = ["Apollo", "ZeroBounce"] as const;
export type CreditVendor = typeof CREDIT_VENDORS[number];

/** What a pool is measured over. */
export type PoolPeriod = "month" | "year";
/** `allotment` null means unknown: show what was used, never a limit. */
export interface Pool { allotment: number | null; period: PoolPeriod }
export type Pools = Record<CreditVendor, Pool>;

const BY_NAME: Record<string, CreditVendor> = {
  zerobounce: "ZeroBounce", verifier_one: "ZeroBounce",
  finder_one: "Apollo", email_waterfall: "Apollo",
};
/** Names on ledger rows from before the two direct vendors were removed. Those credits belong to no pool that exists now. */
const RETIRED = new Set(["hunter", "finder_two", "neverbounce", "verifier_two"]);
/** Steps only Apollo performs. */
const APOLLO_STEPS = new Set(["person_match", "reverse_lookup", "firmographics", "discovery", "reveal", "linkedin", "waterfall"]);

const bare = (raw: string) => raw.replace(/_(sim|mock)$/, "");

/** The vendor behind a ledger name (the reservation note) and step. Null when it is not a credit vendor, such as a model call or a free website read. */
export function vendorOf(name: string | null | undefined, step?: string | null): CreditVendor | null {
  const n = bare(name ?? "");
  if (RETIRED.has(n)) return null;
  if (BY_NAME[n]) return BY_NAME[n];
  if (n.startsWith("apollo") || n === "linkedin_lookup") return "Apollo";
  if (n === "website_fetch" || n === "website") return null;
  if (step && APOLLO_STEPS.has(step)) return "Apollo";
  if (step === "catch_all_probe" || step === "verify") return "ZeroBounce";
  if (step === "find") return "Apollo";
  if (APOLLO_STEPS.has(n) || ["company_search", "people_search", "reverse_lookup", "person_match", "discovery", "reveal", "firmographics"].includes(n)) return "Apollo";
  return null;
}

/** A vendor's name for people to read, never an internal one like verifier_one. */
export const vendorWords = (name: string) => vendorOf(name) ?? bare(name).replace(/_/g, " ");

/** Plain words for what a credit paid for, by step. */
const STEP_WORDS: Record<string, string> = {
  firmographics: "Company data", person_match: "Person match", reverse_lookup: "Company from email domain", discovery: "People search",
  reveal: "Contact details", find: "Email search", waterfall: "Backup email search", verify: "Email checks", catch_all_probe: "Email checks", linkedin: "LinkedIn profiles",
  successor_find: "Finding who replaced people who left", contact_create: "Adding contacts to the CRM",
};
export function creditWork(step: string | null | undefined, name?: string | null): string {
  if (step && STEP_WORDS[step]) return STEP_WORDS[step];
  const n = bare(name ?? step ?? "");
  const guess: [RegExp, string][] = [[/verif|zerobounce/, "Email checks"], [/waterfall/, "Backup email search"], [/finder|match/, "Email search"], [/linkedin/, "LinkedIn profiles"], [/firmo/, "Company data"], [/reveal/, "Contact details"], [/reverse/, "Company from email domain"], [/people_search|discovery|search/, "People search"]];
  for (const [re, w] of guess) if (re.test(n)) return w;
  const s = n.replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Other";
}
const AI_WORDS: Record<string, string> = {
  company_tier: "Tiering companies", second_look: "Second opinion on tiers", website_read: "Reading company websites", title_parse: "Reading job titles", title_tier: "Tiering job titles",
  review: "Second look at people", perspective: "Writing the Summary", icp_compile: "Reading the ICP document", concierge: "Answering questions in Slack",
  reply_classify: "Reading replies", debrief_extract: "Sorting notes from reps",
};
export function aiWork(step: string | null | undefined): string {
  const s = (step ?? "").trim();
  if (AI_WORDS[s]) return AI_WORDS[s];
  const w = s.replace(/_/g, " ");
  return w ? w[0].toUpperCase() + w.slice(1) : "Other";
}

/* ---------------------------------------------------------------- the cards */

/** Rates the card was quoted at, as stored on it. */
interface CardRates { llm_call_cents?: number }
export interface CardLike {
  step_caps?: Record<string, { credits?: number; llm?: number }> | null;
  lines?: Record<string, unknown> | null;
  rates?: CardRates | null;
  credits_cap?: number | null;
  llm_cap?: number | null;
}

/* Used only when a card carries no rates (older rows). They match config/defaults.json; a test keeps them in step. */
export const FALLBACK = { finders: [1], verifiers: [1], llm_call_cents: 1 };

/** What a card allows, by vendor: credits per vendor (never dollars) and the AI dollars. Computed from the step caps, or from the lines on older single-card rows. */
export function cardBreakdown(card: CardLike): { credits: { vendor: CreditVendor; credits: number }[]; ai_cents: number } {
  const acc: Record<CreditVendor, number> = { Apollo: 0, ZeroBounce: 0 };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const caps = card.step_caps;
  if (caps && Object.keys(caps).length) {
    for (const [step, c] of Object.entries(caps)) {
      const n = num(c.credits);
      if (!n) continue;
      const v = vendorOf(null, step);
      if (v) acc[v] += n;
    }
  } else if (card.lines) {
    const L = card.lines;
    acc.Apollo += num(L.discovery_credits) + num(L.reveal_credits) + num(L.linkedin_credits) + num(L.person_match_credits) + num(L.reverse_lookup_credits) + num(L.firmographics_credits) + num(L.finder_credits) + num(L.waterfall_credits);
    acc.ZeroBounce += num(L.verifier_credits) + num(L.probe_credits);
  }
  const rate = card.rates?.llm_call_cents ?? FALLBACK.llm_call_cents;
  return {
    credits: CREDIT_VENDORS.filter((v) => acc[v] > 0).map((v) => ({ vendor: v, credits: acc[v] })),
    ai_cents: Math.round(num(card.llm_cap) * rate),
  };
}
