-- Sponsorship (docs/EVENT-PLAN.md 4.2): the package, its deliverables with due dates, what was promised against what arrived, and the deadlines view.
-- Money here is the package's own figures. What was paid is never stored here: it is recorded on the Cost tab ledger and read through eventCost.

CREATE TABLE sponsorships (
  id                 text PRIMARY KEY,
  involvement_id     text NOT NULL UNIQUE REFERENCES involvements (id) ON DELETE CASCADE,
  event_id           text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  tier               text NOT NULL DEFAULT '',
  price_cents        bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  contract_signed_on date,
  deposit_cents      bigint CHECK (deposit_cents IS NULL OR deposit_cents >= 0),
  deposit_due_on     date,
  deposit_paid_on    date,
  balance_due_on     date,
  balance_paid_on    date,
  updated_by         text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsorships_event ON sponsorships (event_id);

CREATE TABLE sponsorship_deliverables (
  id             text PRIMARY KEY,
  sponsorship_id text NOT NULL REFERENCES sponsorships (id) ON DELETE CASCADE,
  -- Kept here so the week's read does not join through the package.
  event_id       text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('logo_copy', 'booth_graphics', 'staff_badges', 'sponsor_session', 'freight', 'electrical', 'internet', 'lead_retrieval', 'other')),
  label          text NOT NULL CHECK (length(trim(label)) > 0),
  due_on         date,
  owner          text NOT NULL DEFAULT '',
  done_at        timestamptz,
  done_by        text,
  note           text NOT NULL DEFAULT '',
  -- The standard eight keep their order (0 to 7); a deliverable a person adds goes after them.
  position       integer NOT NULL DEFAULT 100,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliverables_done_pair CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX deliverables_due ON sponsorship_deliverables (due_on) WHERE done_at IS NULL;
CREATE INDEX deliverables_sponsorship ON sponsorship_deliverables (sponsorship_id);

CREATE TABLE sponsorship_promises (
  id             text PRIMARY KEY,
  sponsorship_id text NOT NULL REFERENCES sponsorships (id) ON DELETE CASCADE,
  item           text NOT NULL CHECK (item IN ('passes', 'booth', 'talk', 'logo', 'lead_retrieval', 'attendee_list', 'meeting_rooms', 'side_event', 'other')),
  label          text NOT NULL CHECK (length(trim(label)) > 0),
  promised_qty   integer CHECK (promised_qty IS NULL OR promised_qty >= 0),
  received_qty   integer CHECK (received_qty IS NULL OR received_qty >= 0),
  received_on    date,
  note           text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promises_received_counted CHECK (received_qty IS NULL OR promised_qty IS NOT NULL)
);
CREATE INDEX promises_sponsorship ON sponsorship_promises (sponsorship_id);

-- Read only. Replaced in 0052 to add the organizer rows; later steps add their own.
CREATE VIEW event_deadlines AS
  SELECT d.event_id, 'deliverable'::text AS kind, d.id AS ref_id, d.label, d.due_on, d.owner, (d.done_at IS NOT NULL) AS done FROM sponsorship_deliverables d WHERE d.due_on IS NOT NULL
  UNION ALL SELECT s.event_id, 'deposit', s.id, 'Sponsorship deposit', s.deposit_due_on, '', (s.deposit_paid_on IS NOT NULL) FROM sponsorships s WHERE s.deposit_due_on IS NOT NULL
  UNION ALL SELECT s.event_id, 'balance', s.id, 'Sponsorship balance', s.balance_due_on, '', (s.balance_paid_on IS NOT NULL) FROM sponsorships s WHERE s.balance_due_on IS NOT NULL;
