-- Seats: a catalog of events people can ask for a seat at, and one request per person per event.
-- An event row is made by the first request on a catalog entry. seat_count on the event is the number approved.

CREATE TABLE catalog_events (
  id                text PRIMARY KEY,
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  venue             text NOT NULL DEFAULT '',
  city              text NOT NULL DEFAULT '',
  country           text NOT NULL DEFAULT '',
  starts_on         date NOT NULL,
  ends_on           date NOT NULL,
  website           text,
  seat_price_cents  integer NOT NULL CHECK (seat_price_cents >= 0),
  price_is_estimate boolean NOT NULL DEFAULT false,
  source            text NOT NULL DEFAULT 'listed' CHECK (source IN ('listed', 'suggested')),
  suggested_by      text,
  confidence        text,
  source_url        text,
  size              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE events ADD COLUMN catalog_id text REFERENCES catalog_events (id);
CREATE INDEX events_catalog ON events (catalog_id);

CREATE TABLE seat_requests (
  id               text PRIMARY KEY,
  event_id         text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  catalog_id       text REFERENCES catalog_events (id),
  requester        text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by       text,
  decided_at       timestamptz,
  decline_reason   text,
  team             text NOT NULL,
  role             text NOT NULL,
  goal             text NOT NULL,
  why_event        text NOT NULL,
  why_you          text NOT NULL,
  expected_meetings integer NOT NULL CHECK (expected_meetings >= 0),
  known_accounts   text,
  travel_cents     integer CHECK (travel_cents IS NULL OR travel_cents >= 0),
  decide_by        date,
  suggestion       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- One open or approved request per person per event.
CREATE UNIQUE INDEX seat_requests_one_open ON seat_requests (event_id, requester) WHERE status IN ('pending', 'approved');
CREATE INDEX seat_requests_event ON seat_requests (event_id);
