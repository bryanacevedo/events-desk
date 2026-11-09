-- Foundation for docs/TIERING-AND-ENRICHMENT.md (build-order step 2, plus the Layer 0
-- columns of step 3): event country, which approval flow an event uses, company
-- identity, the two cost cards with per-step caps, review cases, and the caches that
-- outlive one event. Nothing here changes what an existing event does: every new
-- column has a default that matches today's behavior.

ALTER TABLE events
  ADD COLUMN country          text,
  -- 'single_card' is today's flow (one cost card, tiering, enriching, flagging).
  -- 'two_card' is the design's flow (Research card, then Outreach card).
  ADD COLUMN flow             text NOT NULL DEFAULT 'single_card',
  ADD COLUMN research_started boolean NOT NULL DEFAULT false,
  -- Inside finding_people: 'titles' while title tiers are decided, 'people' once priorities are set.
  ADD COLUMN phase            text;

-- Layer 0: the list quality report, and what each source row looked like after cleaning.
ALTER TABLE uploads     ADD COLUMN quality jsonb;
ALTER TABLE source_rows ADD COLUMN website text, ADD COLUMN issues jsonb NOT NULL DEFAULT '[]';

-- Layer 1: company identity. A confirmed primary domain, the parent when known, the state, and the evidence behind it.
ALTER TABLE companies
  ADD COLUMN primary_domain     text,
  ADD COLUMN parent_id          text REFERENCES companies (id),
  ADD COLUMN parent_name        text,
  ADD COLUMN parent_domain      text,
  ADD COLUMN identity_state     text NOT NULL DEFAULT 'unresolved',
  ADD COLUMN identity_evidence  jsonb NOT NULL DEFAULT '[]',
  -- False when the company needs no research: a list match, or only Title 3 people with prospects off.
  ADD COLUMN in_research        boolean NOT NULL DEFAULT true;
CREATE INDEX companies_domain ON companies (primary_domain);

-- Cost cards: 'single' is today's card. 'research' and 'outreach' are the design's two. A card with step_caps
-- pays only the steps it names, and each step has its own cap in credits and in LLM calls.
ALTER TABLE cost_cards ADD COLUMN kind text NOT NULL DEFAULT 'single', ADD COLUMN step_caps jsonb;
ALTER TABLE credit_ledger ADD COLUMN step text;
CREATE INDEX credit_ledger_step ON credit_ledger (card_id, unit, step);

-- Review cases: a data conflict only a person can settle, with allowed answers.
CREATE TABLE review_cases (
  id            text PRIMARY KEY,
  event_id      text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  company_id    text REFERENCES companies (id),
  contact_id    text REFERENCES contacts (id),
  -- Blocking cases hold spend: no Outreach card while one is open.
  blocking      boolean NOT NULL,
  summary       text NOT NULL,
  facts         jsonb NOT NULL DEFAULT '[]',
  -- What the answer function needs and the screen does not show.
  payload       jsonb NOT NULL DEFAULT '{}',
  suggested     text,
  options       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'open',
  decision      text,
  decision_data jsonb,
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_status CHECK (status IN ('open', 'answered', 'skipped')),
  CONSTRAINT case_decided CHECK ((status = 'open') = (decided_at IS NULL))
);
CREATE INDEX review_cases_event ON review_cases (event_id, status);

-- Caches that span events. Aged out by the numbers in settings; a human correction overwrites and is never aged out.
CREATE TABLE company_cache (
  domain       text PRIMARY KEY,
  name         text,
  firmographics jsonb NOT NULL,
  source       text NOT NULL,
  corrected    boolean NOT NULL DEFAULT false,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE name_domain_map (
  name_key   text NOT NULL,
  domain     text NOT NULL,
  source     text NOT NULL,
  corrected  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name_key, domain)
);
-- Tier results cache on domain plus ICP version, never domain alone.
CREATE TABLE tier_cache (
  domain       text NOT NULL,
  icp_version  text NOT NULL,
  tier         integer,
  segment      text,
  company_type text,
  reason       text,
  fact         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, icp_version)
);
CREATE TABLE title_cache (
  title_key       text NOT NULL,
  company_type    text NOT NULL,
  size_band       text NOT NULL,
  persona_version text NOT NULL,
  tier            integer NOT NULL,
  func            text,
  seniority       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (title_key, company_type, size_band, persona_version)
);
-- Positive and negative verification results, by address.
CREATE TABLE verification_cache (
  email      text PRIMARY KEY,
  verdict    text NOT NULL,
  verifier   text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE domain_state (
  domain      text PRIMARY KEY,
  catch_all   boolean,
  mail_server boolean,
  probed_at   timestamptz NOT NULL DEFAULT now()
);
-- Anything a reveal returns is stored and never bought twice.
CREATE TABLE reveals (
  id               text PRIMARY KEY,
  vendor           text NOT NULL,
  vendor_person_id text NOT NULL,
  email            text,
  employer         text,
  linkedin         text,
  data             jsonb NOT NULL DEFAULT '{}',
  license          text,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, vendor_person_id)
);
-- Opt-outs and known wrong-person pairs, across events.
CREATE TABLE suppressions (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('opt_out', 'wrong_person')),
  email       text,
  name_key    text,
  company_key text,
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suppressions_email ON suppressions (email);
