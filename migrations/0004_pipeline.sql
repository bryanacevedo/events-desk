-- Slices 4 to 6: the paid pipeline. Ledger amounts are never negative; a release
-- is its own entry kind.

ALTER TABLE events ADD COLUMN tiering_started boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN tier integer, ADD COLUMN tier_reason text, ADD COLUMN list_status text;
ALTER TABLE source_rows ADD COLUMN priority text;
ALTER TABLE contacts ADD COLUMN priority text, ADD COLUMN title_tier integer, ADD COLUMN email_source text, ADD COLUMN verify_1 text, ADD COLUMN verify_2 text;

CREATE TABLE title_tiers (
  event_id  text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  title_key text NOT NULL,
  tier      integer NOT NULL,
  reason    text NOT NULL,
  source    text NOT NULL,
  PRIMARY KEY (event_id, title_key)
);

CREATE TABLE jobs (
  id          text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued',
  lease_until timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim ON jobs (event_id, status, created_at);

CREATE TABLE credit_ledger (
  id             text PRIMARY KEY,
  event_id       text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  card_id        text NOT NULL REFERENCES cost_cards (id),
  unit           text NOT NULL,
  kind           text NOT NULL,
  amount         integer NOT NULL CHECK (amount >= 0),
  reservation_id text,
  note           text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_event ON credit_ledger (event_id, unit, kind);

CREATE TABLE enrichment_attempts (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  target_id  text NOT NULL,
  vendor     text NOT NULL,
  step       text NOT NULL,
  result     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_calls (
  id            text PRIMARY KEY,
  event_id      text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  step          text NOT NULL,
  prompt_hash   text NOT NULL,
  model         text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  output        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE review_flags (
  contact_id text NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  flag       text NOT NULL,
  source     text NOT NULL,
  PRIMARY KEY (contact_id, flag)
);
