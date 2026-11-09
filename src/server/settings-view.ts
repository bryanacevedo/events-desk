/* Read-only values for the Settings sections that have no saving route yet: the rules as they
   stand in config/defaults.json, the spend caps, which vendors are connected, and who has which
   role. Never returns a key, only whether one is set. */

import type { Hono } from "hono";
import { priority } from "../shared/tiers.ts";
import { GTM_TEAM, PERSONAS } from "../shared/roles.ts";
import { defaultSettings } from "./approvals.ts";
import { DEFAULT_MODEL } from "./anthropic.ts";
import { GOOGLE_SIGN_INS } from "./modes.ts";
import { realRunMaxRows } from "./spend-guard.ts";
import type { Db } from "./db.ts";
import { readPools } from "./pools.ts";
import { CREDIT_VENDORS, type CreditVendor, type Pools } from "../shared/vendors.ts";

export interface SettingsViewConfig { demo: boolean; slack?: { userMap?: Record<string, string> } }
type Env = Record<string, string | undefined>;

export function settingsView(cfg: SettingsViewConfig, env: Env = process.env, pools: Pools = defaultSettings().pools) {
  const d = defaultSettings();
  const set = (k: string) => Boolean(env[k]?.trim());
  const tiers = [1, 2, 3] as const;
  const state = (ok: boolean) => (cfg.demo ? "simulated" : ok ? "connected" : "not connected");
  const connections = [
    ["Apollo", "APOLLO_API_KEY"], ["ZeroBounce", "ZEROBOUNCE_API_KEY"], ["Anthropic", "ANTHROPIC_API_KEY"],
  ].map(([name, key]) => ({ name, state: state(set(key)), pool: (CREDIT_VENDORS as readonly string[]).includes(name) ? pools[name as CreditVendor] : null }));
  connections.push({ name: "Google", state: state(Object.values(GOOGLE_SIGN_INS).some((keys) => keys.every(set))), pool: null });
  connections.push({ name: "Slack", state: state(set("SLACK_BOT_TOKEN") && set("SLACK_SIGNING_SECRET")), pool: null });
  const userMap = cfg.slack?.userMap ?? {};
  return {
    scoring: {
      matrix: tiers.map((c) => ({ company_tier: c, by_title: tiers.map((t) => priority(c, t)), no_title: priority(c, null) })),
      quota_tier1: d.outreach.quota_tier1, quota_tier2: d.outreach.quota_tier2,
      tier1_share_warning: d.limits.tier1_share_warning, small_list_companies: d.limits.small_list_companies,
    },
    titles: { buyer_titles: d.target_titles, keywords: d.title_keywords, contacts_per_company: d.contacts_per_company, add_prospects: d.add_prospects },
    lists: { never_contact: d.excluded_companies, customers: d.existing_customers },
    data_rules: {
      email_rule: "Apollo and ZeroBounce", catch_all: "Tested once before paying for an address", pattern_guessing: false,
      freshness_days: d.limits.freshness_days, verification_reuse_days: d.limits.verification_reuse_days, firmographics_cache_days: d.limits.firmographics_cache_days,
      candidates_per_person: d.outreach.candidates_per_person,
    },
    spend: {
      llm_call_cents: d.llm_call_cents, retier_share: d.research.retier_share,
      tier_calls_per_company: d.research.tier_calls_per_company, website_read_calls: d.research.website_read_calls,
      agent_question_limit: d.agent_question_limit, calls_per_question: d.calls_per_question,
      models: [
        { step: "Tiering and research", model: env.EVENTS_DESK_MODEL || DEFAULT_MODEL },
      ],
      real_run_row_limit: realRunMaxRows(env),
    },
    connections,
    team: {
      approvers: d.approvers, gtm: GTM_TEAM, personas: PERSONAS,
      slack_users: Object.keys(userMap).length ? Object.keys(userMap).map((name) => ({ name, mapped: true })) : [],
    },
  };
}

export function mountSettingsView(app: Hono<any>, cfg: SettingsViewConfig, db?: Db) {
  app.get("/api/settings/view", async (c) => c.json(settingsView(cfg, process.env, db ? await readPools(db) : undefined)));
}
