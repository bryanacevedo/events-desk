-- Budget: tickets only. A yearly budget split by quarter, set by approvers, and the cost recorded when a ticket is bought.
-- One purchase per seat request, so a seat is never counted twice. A seat counts in the quarter its event starts.

CREATE TABLE budget_quarters (
  year    integer NOT NULL,
  quarter integer NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  cents   integer NOT NULL CHECK (cents >= 0),
  PRIMARY KEY (year, quarter)
);

CREATE TABLE budget_log (
  id         text PRIMARY KEY,
  year       integer NOT NULL,
  actor      text NOT NULL,
  detail     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ticket_purchases (
  seat_request_id text PRIMARY KEY REFERENCES seat_requests (id) ON DELETE CASCADE,
  event_id        text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  amount_cents    integer NOT NULL CHECK (amount_cents >= 0),
  recorded_by     text NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_purchases_event ON ticket_purchases (event_id);
