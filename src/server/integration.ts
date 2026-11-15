/* Which other desks this install runs beside (docs/SHARED-WORLD.md section 3, shared-world DESIGN 2b). `INTEGRATED_WITH` is a comma list of
   `account_desk`, `market_desk` and `crm_desk`. Unset means alone. It is validated at boot and read on each call, so a test changes it without an import.

   `account_desk` turns the sequencer off for new work; `market_desk` makes the ICP page read-only; `crm_desk` changes nothing by itself (the CRM is `CRM=crmdesk`).
   The transactional sender (confirmations, reminders) never depends on any of this. */

export const KNOWN_DESKS = ["account_desk", "market_desk", "crm_desk"] as const;
export type Desk = (typeof KNOWN_DESKS)[number];
type Env = Record<string, string | undefined>;

export const integratedWith = (env: Env = process.env): string[] =>
  (env.INTEGRATED_WITH ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Stops the server at boot on a name it does not know. `events_desk` is refused: a desk never names itself. */
export function checkIntegration(env: Env = process.env): void {
  const bad = integratedWith(env).filter((n) => !(KNOWN_DESKS as readonly string[]).includes(n));
  if (bad.length) throw new Error(`INTEGRATED_WITH names ${bad.join(", ")}; use ${KNOWN_DESKS.join(", ")}.`);
}

export const has = (desk: Desk, env: Env = process.env) => integratedWith(env).includes(desk);
export const sequencerOn = (env: Env = process.env) => !has("account_desk", env);
export const icpOwnUpload = (env: Env = process.env) => !has("market_desk", env);

export const OWNED_BY_ACCOUNT_DESK = "Account Desk runs the outreach for events in this install. Sequences, senders and templates are its to set up.";
export const OWNED_BY_MARKET_DESK = "Market Desk owns the ICP in this install. The profile in force is shown here; change it there.";

const SEQUENCER_ROUTES: RegExp[] = [
  /^\/api\/events\/[^/]+\/motion\/(tools|legal-basis|sequences)$/,
  /^\/api\/motion\/sequences\/[^/]+\/(campaign|checklist|release|placement-override)$/,
  /^\/api\/motion\/(templates|placement|account-domains)$/,
];
export const START = /^\/api\/events\/[^/]+\/motion\/start$/;
const ICP_ROUTES: RegExp[] = [
  /^\/api\/icp\/documents$/,
  /^\/api\/icp\/compiles\/[^/]+\/(start|confirm|bench|bench\/run|bench\/example|publish|reopen|draft)$/,
];

/** The sentence to refuse a write with, or null. `purpose` is the body's, for the Motion card route only (its default is outreach). */
export function refusalFor(method: string, path: string, purpose: unknown, env: Env = process.env): { code: "owned_by_account_desk" | "owned_by_market_desk"; message: string } | null {
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") return null;
  if (!sequencerOn(env) && (SEQUENCER_ROUTES.some((r) => r.test(path)) || (START.test(path) && purpose !== "debrief_only")))
    return { code: "owned_by_account_desk", message: OWNED_BY_ACCOUNT_DESK };
  if (!icpOwnUpload(env) && ICP_ROUTES.some((r) => r.test(path))) return { code: "owned_by_market_desk", message: OWNED_BY_MARKET_DESK };
  return null;
}

/** What `GET /api/integration` answers. */
export function integrationView(crmName: string | undefined, env: Env = process.env) {
  const crm = crmName === "crm_desk" ? "crm_desk" : crmName === "no_crm" || !crmName ? "none" : crmName === "crm_mock" ? "mock" : "sim";
  return {
    with: integratedWith(env), crm, crm_named_not_connected: has("crm_desk", env) && crm !== "crm_desk",
    links: deskLinks(env),
    sequencer: sequencerOn(env) ? "events_desk" : "account_desk", icp: icpOwnUpload(env) ? "events_desk" : "market_desk", campaigns: "events_desk", campaign_money: (env.CRM_CAMPAIGN_MONEY ?? "").toLowerCase() === "usd" ? "on" : "off",
  };
}

/** `DESK_LINKS=account_desk=https://...,crm_desk=https://...`: addresses for "Open in" links only. It never switches anything. */
export function deskLinks(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (env.DESK_LINKS ?? "").split(",")) {
    const [k, ...v] = part.split("="); const url = v.join("=").trim();
    if ((KNOWN_DESKS as readonly string[]).includes(k.trim()) && url.startsWith("https://")) out[k.trim()] = url.replace(/\/$/, "");
  }
  return out;
}
