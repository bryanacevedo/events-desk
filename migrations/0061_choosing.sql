-- Before the list, and choosing events (docs/CHOOSING.md, section 3). Every CHECK on a reason wraps it in coalesce, because
-- length(trim(NULL)) > 0 is NULL and a CHECK accepts NULL.

CREATE TABLE roster_pages (
  id         text PRIMARY KEY,
  catalog_id text NOT NULL REFERENCES catalog_events (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('speaker', 'sponsor')),
  input      text NOT NULL CHECK (input IN ('pasted', 'uploaded')),
  filename   text,
  body       text NOT NULL CHECK (length(body) > 0 AND length(body) <= 60000),
  body_hash  text NOT NULL,
  added_by   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (catalog_id, body_hash)
);

CREATE TABLE roster_matches (
  id              text PRIMARY KEY,
  page_id         text NOT NULL REFERENCES roster_pages (id) ON DELETE CASCADE,
  account_id      text NOT NULL REFERENCES target_accounts (id) ON DELETE CASCADE,
  matched_on      text NOT NULL CHECK (matched_on IN ('domain', 'name')),
  quote           text NOT NULL,
  status          text NOT NULL DEFAULT 'counted' CHECK (status IN ('counted', 'rejected')),
  rejected_by     text,
  rejected_reason text,
  rejected_at     timestamptz,
  UNIQUE (page_id, account_id),
  CONSTRAINT roster_matches_rejection CHECK ((status = 'rejected') = (rejected_by IS NOT NULL AND length(trim(coalesce(rejected_reason, ''))) > 0 AND rejected_at IS NOT NULL))
);
CREATE INDEX roster_matches_account ON roster_matches (account_id);

CREATE TABLE series_links (
  alias_key  text PRIMARY KEY,
  series_key text NOT NULL,
  reason     text NOT NULL CHECK (length(trim(coalesce(reason, ''))) > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (alias_key <> series_key)
);

CREATE TABLE repeat_decisions (
  id         text PRIMARY KEY,
  series_key text NOT NULL,
  decision   text NOT NULL CHECK (decision IN ('repeat', 'drop')),
  reason     text,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  evidence   jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT repeat_drop_has_reason CHECK (decision = 'repeat' OR length(trim(coalesce(reason, ''))) > 0)
);
CREATE INDEX repeat_decisions_series ON repeat_decisions (series_key, decided_at DESC);

CREATE TABLE repeat_wordings (
  id            text PRIMARY KEY,
  reading_hash  text NOT NULL,
  pattern_key   text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  text          text,
  by            text CHECK (by IS NULL OR by IN ('model', 'template')),
  model         text,
  input_tokens  integer,
  output_tokens integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reading_hash, pattern_key)
);
