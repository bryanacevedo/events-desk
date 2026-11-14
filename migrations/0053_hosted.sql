-- Hosted events (docs/HOSTED.md): a guest list, invitations the host sends, a public RSVP link, reminders from a transactional sender, a venue, check-in, and the follow-up.
-- Everything cascades from events. Money is integer cents.

CREATE TABLE target_accounts (
  id          text PRIMARY KEY,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  domain      text CHECK (domain IS NULL OR domain = lower(domain)),
  country     text,
  owner       text,
  open_deal   text,
  deal_stage  text,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('upload', 'crm', 'market_desk', 'manual')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX target_accounts_name ON target_accounts (lower(name));

CREATE TABLE hosted_events (
  event_id    text PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  capacity    integer CHECK (capacity IS NULL OR capacity >= 1),
  noshow_pct  integer CHECK (noshow_pct IS NULL OR (noshow_pct >= 0 AND noshow_pct <= 90)),
  host_name   text NOT NULL DEFAULT '',
  host_email  text NOT NULL DEFAULT '',
  doors_at    text CHECK (doors_at IS NULL OR doors_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  address     text NOT NULL DEFAULT '',
  welcome     text NOT NULL DEFAULT '' CHECK (length(welcome) <= 300),
  closed_at   timestamptz,
  rsvp_open   boolean NOT NULL DEFAULT true
);

CREATE TABLE event_guests (
  id              text PRIMARY KEY,
  event_id        text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  email           text CHECK (email IS NULL OR email = lower(email)),
  company         text NOT NULL DEFAULT '',
  title           text NOT NULL DEFAULT '',
  country         text,
  account_id      text REFERENCES target_accounts (id) ON DELETE SET NULL,
  owner           text NOT NULL CHECK (length(trim(owner)) > 0),
  side            text NOT NULL DEFAULT 'us' CHECK (side IN ('us', 'partner')),
  source          text NOT NULL CHECK (source IN ('account', 'deal', 'nomination', 'luma', 'splash', 'walk_in', 'manual')),
  nominated_by    text,
  status          text NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'invited', 'registered', 'waitlist', 'declined', 'attended', 'no_show')),
  -- The status a guest had before a check-in, so undoing it restores that and nothing else.
  prior_status    text CHECK (prior_status IS NULL OR prior_status IN ('listed', 'invited', 'registered', 'waitlist', 'declined', 'no_show')),
  rsvp_token      text NOT NULL UNIQUE,
  dietary         text NOT NULL DEFAULT '',
  decline_note    text NOT NULL DEFAULT '',
  invited_at      timestamptz,
  rsvp_at         timestamptz,
  waitlisted_at   timestamptz,
  checked_in_at   timestamptz,
  checked_in_by   text,
  seat            text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',
  removed_at      timestamptz,
  removed_reason  text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_guests_checkin_pair CHECK ((checked_in_at IS NULL) = (checked_in_by IS NULL)),
  CONSTRAINT event_guests_removed_pair CHECK ((removed_at IS NULL) = (removed_reason IS NULL)),
  CONSTRAINT event_guests_removal_has_reason CHECK (removed_reason IS NULL OR length(trim(removed_reason)) > 0)
);
CREATE INDEX event_guests_event ON event_guests (event_id);
CREATE UNIQUE INDEX event_guests_email_once ON event_guests (event_id, lower(email)) WHERE email IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX event_guests_name_once ON event_guests (event_id, lower(name), lower(coalesce(company, ''))) WHERE removed_at IS NULL AND email IS NULL;

-- guest_id is null for a row about the whole event (an import, a closing).
CREATE TABLE guest_log (
  id        text PRIMARY KEY,
  event_id  text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  guest_id  text REFERENCES event_guests (id) ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('invitation_logged', 'status', 'reminder', 'seat_open', 'owner', 'note', 'import', 'walk_in')),
  detail    text NOT NULL DEFAULT '',
  actor     text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guest_log_event ON guest_log (event_id, at);
CREATE INDEX guest_log_guest ON guest_log (guest_id);

CREATE TABLE guest_invitations (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  guest_id   text NOT NULL REFERENCES event_guests (id) ON DELETE CASCADE,
  sent_by    text NOT NULL,
  sent_on    date NOT NULL,
  mailbox    text NOT NULL DEFAULT '',
  logged_by  text NOT NULL,
  logged_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guest_invitations_guest ON guest_invitations (guest_id, sent_on);

CREATE TABLE reminder_runs (
  id          text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('reminder', 'logistics')),
  subject     text NOT NULL,
  body        text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_count  integer NOT NULL DEFAULT 0,
  skipped     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX reminder_runs_event ON reminder_runs (event_id, kind, created_at);

-- A row here is an attempt, made before the send. It is the truth: a send whose outcome is unknown is never repeated.
CREATE TABLE reminder_sends (
  id        text PRIMARY KEY,
  run_id    text NOT NULL REFERENCES reminder_runs (id) ON DELETE CASCADE,
  guest_id  text NOT NULL REFERENCES event_guests (id) ON DELETE CASCADE,
  email     text NOT NULL,
  sent_at   timestamptz,
  outcome   text NOT NULL DEFAULT 'queued' CHECK (outcome IN ('queued', 'sent', 'failed', 'unknown')),
  UNIQUE (run_id, guest_id)
);

CREATE TABLE event_venues (
  event_id             text PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  name                 text NOT NULL DEFAULT '',
  address              text NOT NULL DEFAULT '',
  budget_line_id       text REFERENCES budget_lines (id) ON DELETE SET NULL,
  minimum_spend_cents  bigint CHECK (minimum_spend_cents IS NULL OR minimum_spend_cents >= 0),
  guarantee_headcount  integer CHECK (guarantee_headcount IS NULL OR guarantee_headcount >= 0),
  guarantee_by         date,
  -- Set when the host has told the venue the number. The guarantee date stays late until then.
  guarantee_confirmed_on date,
  note                 text NOT NULL DEFAULT ''
);

CREATE TABLE venue_cancellation_steps (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  position   integer NOT NULL DEFAULT 0,
  by_date    date NOT NULL,
  rule       text NOT NULL CHECK (length(trim(rule)) > 0),
  fee_cents  bigint CHECK (fee_cents IS NULL OR fee_cents >= 0),
  done       boolean NOT NULL DEFAULT false
);
CREATE INDEX venue_cancellation_steps_event ON venue_cancellation_steps (event_id, by_date);

CREATE TABLE cohosts (
  event_id         text PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  partner          text NOT NULL DEFAULT '',
  our_share_percent integer NOT NULL DEFAULT 50 CHECK (our_share_percent >= 0 AND our_share_percent <= 100),
  lead_rule        text NOT NULL DEFAULT 'own_invites' CHECK (lead_rule IN ('own_invites', 'by_account', 'partner_keeps_theirs')),
  note             text NOT NULL DEFAULT ''
);

CREATE TABLE transactional_outbox (
  id            text PRIMARY KEY,
  event_id      text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  guest_id      text REFERENCES event_guests (id) ON DELETE CASCADE,
  run_id        text REFERENCES reminder_runs (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('reminder', 'logistics', 'seat_open')),
  to_email      text NOT NULL,
  subject       text NOT NULL,
  body          text NOT NULL,
  state         text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sent', 'failed', 'unknown')),
  provider_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX transactional_outbox_event ON transactional_outbox (event_id, created_at);
CREATE UNIQUE INDEX transactional_outbox_once ON transactional_outbox (run_id, guest_id) WHERE run_id IS NOT NULL;

-- The venue dates join the deadlines: the headcount guarantee, and each cancellation step. Same columns as 0052, so the view is replaced in place.
-- Read like every other deadline: a date stays late until it is marked done or the event is declined. There is no clock in the view.
CREATE OR REPLACE VIEW event_deadlines AS
  SELECT d.event_id, 'deliverable'::text AS kind, d.id AS ref_id, d.label, d.due_on, d.owner, (d.done_at IS NOT NULL) AS done FROM sponsorship_deliverables d WHERE d.due_on IS NOT NULL
  UNION ALL SELECT s.event_id, 'deposit', s.id, 'Sponsorship deposit', s.deposit_due_on, '', (s.deposit_paid_on IS NOT NULL) FROM sponsorships s WHERE s.deposit_due_on IS NOT NULL
  UNION ALL SELECT s.event_id, 'balance', s.id, 'Sponsorship balance', s.balance_due_on, '', (s.balance_paid_on IS NOT NULL) FROM sponsorships s WHERE s.balance_due_on IS NOT NULL
  UNION ALL SELECT r.event_id, 'organizer_expected', r.id, 'Attendee list expected from the organizer', r.expected_on, r.created_by, (r.status IN ('received', 'will_not_share')) FROM organizer_requests r WHERE r.expected_on IS NOT NULL
  UNION ALL SELECT r.event_id, 'organizer_follow_up', r.id, 'Follow up with the organizer', r.follow_up_on, r.created_by, (r.status IN ('received', 'will_not_share')) FROM organizer_requests r WHERE r.follow_up_on IS NOT NULL
  UNION ALL SELECT v.event_id, 'venue', v.event_id, 'Headcount guarantee to the venue', v.guarantee_by, coalesce(nullif(h.host_name, ''), e.requested_by), (v.guarantee_confirmed_on IS NOT NULL)
    FROM event_venues v JOIN events e ON e.id = v.event_id LEFT JOIN hosted_events h ON h.event_id = v.event_id WHERE v.guarantee_by IS NOT NULL
  UNION ALL SELECT s.event_id, 'venue', s.id, 'Venue cancellation: ' || s.rule, s.by_date, coalesce(nullif(h.host_name, ''), e.requested_by), s.done
    FROM venue_cancellation_steps s JOIN events e ON e.id = s.event_id LEFT JOIN hosted_events h ON h.event_id = s.event_id;
