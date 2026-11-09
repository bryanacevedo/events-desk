-- The original attendee list file, kept as received, one per upload. Deleted with its upload and with its event.
CREATE TABLE upload_files (
  upload_id    text PRIMARY KEY REFERENCES uploads (id) ON DELETE CASCADE,
  event_id     text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  content_type text NOT NULL,
  bytes        bytea NOT NULL
);
CREATE INDEX upload_files_event ON upload_files (event_id);

-- Deleting an event removes its own rows. Money already spent is not its own: Usage pools count credits and AI calls by date, and the Budget
-- counts tickets bought, so those figures are copied here before the event goes. No foreign keys, on purpose: these rows outlive the event.
CREATE TABLE ledger_kept (
  id             text PRIMARY KEY,
  event_id       text NOT NULL,
  event_name     text NOT NULL,
  unit           text NOT NULL,
  kind           text NOT NULL,
  amount         integer NOT NULL CHECK (amount >= 0),
  reservation_id text,
  -- The note of the reservation this row belongs to, resolved at copy time, because the reservation row is not kept apart from it.
  note           text NOT NULL DEFAULT '',
  step           text,
  created_at     timestamptz NOT NULL,
  kept_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_kept_at ON ledger_kept (created_at);

CREATE TABLE ticket_spend_kept (
  id           text PRIMARY KEY,
  event_id     text NOT NULL,
  event_name   text NOT NULL,
  starts_on    date NOT NULL,
  country      text,
  team         text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  kept_at      timestamptz NOT NULL DEFAULT now()
);
