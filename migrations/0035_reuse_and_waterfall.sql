-- docs/DATA-HYGIENE.md, phase 1: Apollo's email waterfall replaces the second finder and second verifier, stored answers are reused, and what reuse saved is logged.

-- One row per paid call a stored answer replaced. No foreign key: the savings stay when an event is deleted. The unique key makes a replay count once.
CREATE TABLE reuse_log (
  id         text PRIMARY KEY,
  event_id   text NOT NULL,
  -- The contact, company, domain or title the answer was for.
  target     text NOT NULL,
  step       text NOT NULL,
  vendor     text NOT NULL,
  candidate  text NOT NULL DEFAULT '',
  unit       text NOT NULL CHECK (unit IN ('credits', 'llm')),
  n          integer NOT NULL CHECK (n > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, target, step, vendor, candidate)
);
CREATE INDEX reuse_log_created ON reuse_log (created_at);

-- Which event wrote each stored answer, so a saving can tell an earlier event's answer from this run's own.
ALTER TABLE verification_cache ADD COLUMN event_id text;
ALTER TABLE domain_state ADD COLUMN event_id text;
ALTER TABLE company_cache ADD COLUMN event_id text;
ALTER TABLE tier_cache ADD COLUMN event_id text;
ALTER TABLE title_cache ADD COLUMN event_id text;
ALTER TABLE reveals ADD COLUMN event_id text;
ALTER TABLE reveal_queries ADD COLUMN event_id text;

-- What Apollo's normal match and its waterfall returned for a person at a company. Only answers that really came back. A found address is reused within freshness_days, a miss within 30 days.
CREATE TABLE waterfall_cache (
  vendor          text NOT NULL,
  name_key        text NOT NULL,
  company_key     text NOT NULL,
  email           text,
  linkedin        text,
  apollo_verified boolean NOT NULL DEFAULT false,
  -- ZeroBounce passed the address inside the waterfall result.
  zerobounce_pass boolean NOT NULL DEFAULT false,
  -- What the call was charged, so a reuse is logged at its real cost.
  credits         integer NOT NULL DEFAULT 0,
  event_id        text,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor, name_key, company_key)
);

-- LinkedIn lookups, with the same ages as above.
CREATE TABLE linkedin_cache (
  name_key       text NOT NULL,
  company_key    text NOT NULL,
  linkedin       text,
  -- The address Apollo holds as Verified for this person, when the same answer said so.
  verified_email text,
  event_id       text,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name_key, company_key)
);

-- Events made before this change carry the old vendor lists in their settings.
UPDATE event_settings
SET settings = (settings #- '{pools,Hunter}' #- '{pools,NeverBounce}')
  || jsonb_build_object('finders', '[{"name":"finder_one","cost":1}]'::jsonb, 'verifiers', '[{"name":"verifier_one","cost":1}]'::jsonb)
WHERE jsonb_array_length(coalesce(settings->'finders', '[]'::jsonb)) > 1 OR jsonb_array_length(coalesce(settings->'verifiers', '[]'::jsonb)) > 1;

DELETE FROM vendor_pools WHERE vendor IN ('Hunter', 'NeverBounce');
