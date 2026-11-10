-- What it takes to run the after-delivery work for real: who hears, how fast, and whether anyone would notice it stopped.

-- Every Slack message is a row first, so a failed post is retried, not lost.
CREATE TABLE notifications (
  id        text PRIMARY KEY,
  event_id  text REFERENCES events(id) ON DELETE CASCADE,
  target    text NOT NULL CHECK (target IN ('dm', 'thread')),
  slack_id  text,
  card      jsonb NOT NULL,
  status    text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts  integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at   timestamptz
);
CREATE INDEX notifications_queued ON notifications (created_at) WHERE status = 'queued';

-- One alert per problem per day, in one place.
CREATE TABLE alerts (
  id        text PRIMARY KEY,
  key       text NOT NULL,
  day       date NOT NULL,
  text      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, day)
);

-- Proof that a tool was really heard from, and when.
CREATE TABLE connector_runs (
  connector text PRIMARY KEY,
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  last_events integer NOT NULL DEFAULT 0
);

ALTER TABLE inbound_messages
  ADD COLUMN owner text,
  ADD COLUMN respond_by timestamptz,
  ADD COLUMN handled_at timestamptz,
  ADD COLUMN handled_by text,
  ADD COLUMN escalated_at timestamptz;
CREATE INDEX inbound_waiting ON inbound_messages (respond_by) WHERE respond_by IS NOT NULL AND handled_at IS NULL;

ALTER TABLE touches ADD COLUMN sender text, ADD COLUMN step integer;
CREATE INDEX touches_sender ON touches (sender, kind) WHERE sender IS NOT NULL;

-- Someone met in person. They may not be on any list.
CREATE TABLE onsite_captures (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  full_name  text,
  email      text,
  linkedin   text,
  company    text,
  title      text,
  note       text NOT NULL DEFAULT '',
  temperature text NOT NULL DEFAULT 'warm' CHECK (temperature IN ('hot', 'warm', 'cold')),
  rep        text NOT NULL,
  source     text NOT NULL DEFAULT 'quick_add' CHECK (source IN ('quick_add', 'badge_scan')),
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onsite_event ON onsite_captures (event_id, captured_at DESC);

-- What the desk remembers about a sending domain, across every sequence.
CREATE TABLE sending_domains (
  domain     text PRIMARY KEY,
  status     text NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'resting', 'burned', 'retired')),
  reason     text NOT NULL DEFAULT '',
  set_by     text NOT NULL,
  set_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE placement_results ADD COLUMN provider text NOT NULL DEFAULT 'all';
ALTER TABLE placement_results DROP CONSTRAINT placement_results_pkey;
ALTER TABLE placement_results ADD PRIMARY KEY (domain, provider, tool, tested_at);

ALTER TABLE sequences
  ADD COLUMN timing_note text,
  ADD COLUMN copy_hash text,
  ADD COLUMN placement_override_by text,
  ADD COLUMN hooks_at timestamptz,
  ADD COLUMN released_by text,
  ADD COLUMN blind_since timestamptz;

ALTER TABLE meetings DROP CONSTRAINT meetings_source_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_source_check CHECK (source IN ('reply', 'sheet', 'calendar', 'manual', 'onsite', 'crm'));

-- Everything an event cost beyond tickets, travel and AI. A category with no entry is shown as missing, not as zero.
CREATE TABLE event_costs (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  category   text NOT NULL CHECK (category IN ('sponsorship', 'booth', 'dinners', 'swag', 'tools', 'rep_time', 'other')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  note       text NOT NULL DEFAULT '',
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, category)
);

-- One opportunity, credited to one event: the one whose held meeting came last before the deal moved.
CREATE TABLE attribution_claims (
  opportunity_id text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('sourced', 'influenced')),
  meeting_at timestamptz NOT NULL,
  moved_at   timestamptz NOT NULL,
  amount_cents integer NOT NULL DEFAULT 0,
  won        boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attribution_event ON attribution_claims (event_id);

ALTER TABLE events ADD COLUMN holdout_percent integer NOT NULL DEFAULT 0 CHECK (holdout_percent >= 0 AND holdout_percent <= 50);

-- One company, several mail domains: aliases, legacy domains, subdomains. Holds and stops reach all of them.
CREATE TABLE account_domains (
  domain     text PRIMARY KEY,
  canonical  text NOT NULL,
  how        text NOT NULL,
  added_by   text NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_domains_canonical ON account_domains (canonical);

-- A rep's bookable time at the event. One meeting per slot.
CREATE TABLE meeting_slots (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rep        text NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  location   text NOT NULL,
  meeting_id text UNIQUE REFERENCES meetings(id) ON DELETE SET NULL
);
CREATE INDEX meeting_slots_rep ON meeting_slots (rep, starts_at);

-- Who gets which follow-up after the event. Someone met has a rep; a badge scan gets its own copy.
ALTER TABLE contacts ADD COLUMN followup_tier text CHECK (followup_tier IN ('scanned'));
-- A template can be for one audience: a priority, or the people scanned at the booth.
ALTER TABLE sequence_templates ADD COLUMN audience text NOT NULL DEFAULT 'all';

-- An add was sent to the tool. If its answer was lost, a later stop must still be carried out there.
ALTER TABLE enrollments ADD COLUMN add_attempted boolean NOT NULL DEFAULT false;

-- Consent recorded per rep before their LinkedIn account sends anything.
CREATE TABLE sender_consents (
  connector  text NOT NULL,
  sender_id  text NOT NULL,
  rep        text NOT NULL,
  risk_note  text NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector, sender_id)
);

DROP VIEW event_funnel;
CREATE VIEW event_funnel AS
SELECT e.id AS event_id,
  (SELECT count(*) FROM contacts k WHERE k.event_id = e.id AND k.dropped_at IS NULL AND k.priority IS NOT NULL)::int AS kept,
  (SELECT count(DISTINCT n.contact_id) FROM enrollments n JOIN sequences s ON s.id = n.sequence_id WHERE n.event_id = e.id AND s.launched_at IS NOT NULL AND n.state <> 'adding')::int AS enrolled,
  (SELECT count(DISTINCT t.contact_id) FROM touches t WHERE t.event_id = e.id AND t.kind = 'send' AND EXISTS (SELECT 1 FROM enrollments n WHERE n.contact_id = t.contact_id))::int AS sent,
  (SELECT count(DISTINCT m.contact_id) FROM inbound_messages m WHERE m.event_id = e.id AND m.signal = 'reply' AND (m.code IS NULL OR m.code NOT IN ('out_of_office', 'bounced', 'unsubscribe', 'wrong_person', 'departed'))
     AND EXISTS (SELECT 1 FROM touches t WHERE t.contact_id = m.contact_id AND t.kind = 'send'))::int AS replied,
  (SELECT count(DISTINCT m.contact_id) FROM meetings m WHERE m.event_id = e.id AND m.enrolled AND m.status IN ('booked', 'held', 'no_show', 'rescheduled') AND EXISTS (SELECT 1 FROM inbound_messages i WHERE i.contact_id = m.contact_id AND i.signal = 'reply'))::int AS booked,
  (SELECT count(DISTINCT m.contact_id) FROM meetings m WHERE m.event_id = e.id AND m.enrolled AND m.status = 'held' AND EXISTS (SELECT 1 FROM inbound_messages i WHERE i.contact_id = m.contact_id AND i.signal = 'reply'))::int AS held,
  (SELECT count(*) FROM meetings m WHERE m.event_id = e.id AND m.status IN ('booked', 'held') AND NOT (m.enrolled AND EXISTS (SELECT 1 FROM inbound_messages i WHERE i.contact_id = m.contact_id AND i.signal = 'reply')))::int AS logged_outside,
  (SELECT count(DISTINCT m.contact_id) FROM meetings m WHERE m.event_id = e.id AND m.status = 'held')::int AS held_all
FROM events e;
