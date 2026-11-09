-- Slice 1: events and their audit trail. Later slices add their own migrations.
-- CHECK constraints cover only what docs/SPEC.md lists. Stage transitions live in
-- src/shared/domain.ts and are not checked here.

CREATE TABLE events (
  id               text PRIMARY KEY,
  name             text NOT NULL CHECK (length(trim(name)) > 0),
  venue            text NOT NULL DEFAULT '',
  starts_on        date NOT NULL,
  seat_count       integer NOT NULL CHECK (seat_count > 0),
  seat_price_cents integer NOT NULL CHECK (seat_price_cents >= 0),
  stage            text NOT NULL DEFAULT 'requested',
  paused_from      text,
  decline_reason   text,
  requested_by     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT declined_needs_reason CHECK (stage <> 'declined' OR length(trim(coalesce(decline_reason, ''))) > 0)
);

CREATE TABLE activity_log (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  actor      text NOT NULL,
  kind       text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_event ON activity_log (event_id, created_at DESC);
