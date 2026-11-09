-- Slice 3: each event's settings, cost cards and the two human approvals.

CREATE TABLE event_settings (
  event_id text PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  settings jsonb NOT NULL
);

CREATE TABLE cost_cards (
  id           text PRIMARY KEY,
  event_id     text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending',
  inputs       jsonb NOT NULL,
  rates        jsonb NOT NULL,
  lines        jsonb NOT NULL,
  credits_cap  integer NOT NULL CHECK (credits_cap >= 0),
  llm_cap      integer NOT NULL CHECK (llm_cap >= 0),
  est_cents    integer NOT NULL CHECK (est_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_cards_event ON cost_cards (event_id, created_at DESC);

CREATE TABLE approvals (
  id           text PRIMARY KEY,
  event_id     text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  kind         text NOT NULL,
  card_id      text REFERENCES cost_cards (id),
  status       text NOT NULL DEFAULT 'pending',
  requested_by text NOT NULL,
  decided_by   text,
  decided_at   timestamptz,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_decline_has_reason CHECK (status <> 'declined' OR length(trim(coalesce(reason, ''))) > 0)
);
CREATE INDEX approvals_pending ON approvals (status, created_at);
