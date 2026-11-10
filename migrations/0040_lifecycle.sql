-- Everything after the list is delivered (docs/LIFECYCLE.md).

ALTER TABLE events
  ADD COLUMN motion text NOT NULL DEFAULT 'none' CHECK (motion IN ('none', 'owners', 'sequencing', 'in_market', 'closing', 'scored')),
  ADD COLUMN motion_changed_at timestamptz,
  ADD COLUMN outreach_started_by text,
  ADD COLUMN outreach_started_at timestamptz,
  ADD COLUMN slack_thread text,
  ADD COLUMN verify_once boolean NOT NULL DEFAULT false,
  ADD COLUMN write_leads boolean NOT NULL DEFAULT false,
  ADD COLUMN tools jsonb NOT NULL DEFAULT '{}'::jsonb;

-- A suppression that rests only on a model's reading: honored at once, and a person confirms it.
ALTER TABLE suppressions ADD COLUMN needs_confirmation boolean NOT NULL DEFAULT false;

-- Every contact the desk knows about. It stops collisions only for what it can see.
CREATE TABLE touches (
  id         text PRIMARY KEY,
  domain     text,
  person_id  text REFERENCES people(id) ON DELETE SET NULL,
  contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  event_id   text REFERENCES events(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  channel    text,
  reason     text NOT NULL DEFAULT '',
  at         timestamptz NOT NULL DEFAULT now(),
  source     text NOT NULL,
  dedup_key  text NOT NULL UNIQUE
);
CREATE INDEX touches_domain ON touches (domain, at DESC);
CREATE INDEX touches_contact ON touches (contact_id, at DESC);
CREATE INDEX touches_event ON touches (event_id, kind);

-- A null person means the whole domain. A null event means every event.
CREATE TABLE holds (
  id             text PRIMARY KEY,
  domain         text NOT NULL,
  person_id      text REFERENCES people(id) ON DELETE SET NULL,
  event_id       text REFERENCES events(id) ON DELETE CASCADE,
  cause          text NOT NULL CHECK (cause IN ('meeting', 'mine', 'live_thread')),
  cause_id       text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  released_at    timestamptz,
  released_by    text,
  UNIQUE (cause, cause_id, domain)
);
CREATE INDEX holds_domain ON holds (domain, expires_at);

CREATE TABLE owner_decisions (
  id           text PRIMARY KEY,
  event_id     text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  company_id   text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner        text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'include', 'mine', 'handed')),
  via          text CHECK (via IN ('owner', 'default', 'case', 'uploader')),
  sent_at      timestamptz,
  warned_at    timestamptz,
  decided_at   timestamptz,
  decided_by   text,
  UNIQUE (event_id, company_id)
);
CREATE INDEX owner_decisions_open ON owner_decisions (status) WHERE status = 'pending';

CREATE TABLE sequence_templates (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  version      integer NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('email', 'linkedin')),
  phase        text NOT NULL CHECK (phase IN ('pre', 'post')),
  steps        jsonb NOT NULL,
  external_id  text,
  approved_by  text NOT NULL,
  approved_at  timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  UNIQUE (name, version)
);

CREATE TABLE sequences (
  id           text PRIMARY KEY,
  event_id     text NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  connector    text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('email', 'linkedin')),
  priority     text NOT NULL,
  phase        text NOT NULL CHECK (phase IN ('pre', 'post')),
  zone_group   text NOT NULL DEFAULT 'event',
  template_id  text NOT NULL REFERENCES sequence_templates(id),
  external_id  text,
  name         text NOT NULL,
  state        text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'paused', 'archived')),
  launched_at  timestamptz,
  gate_passed_at timestamptz,
  pause_reason text,
  -- The tool has not confirmed a pause it was asked for. Retried until it does, and it alerts.
  pause_owed   boolean NOT NULL DEFAULT false,
  settings_ok  boolean,
  checklist_by text,
  checklist_at timestamptz,
  senders_needed integer,
  peak_daily   integer,
  sender_status text CHECK (sender_status IN ('ok', 'short', 'not_visible')),
  sender_excluded jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, channel, priority, phase, zone_group)
);
-- A campaign in a tool belongs to one sequence: pausing one event's outreach must never pause another's.
CREATE UNIQUE INDEX sequences_external ON sequences (connector, external_id) WHERE external_id IS NOT NULL;

-- One switch that stops every send and resume, everywhere.
CREATE TABLE desk_controls (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  sending_stopped_at timestamptz,
  stopped_by   text,
  reason       text
);
INSERT INTO desk_controls (id) VALUES (true);

-- Which sending accounts carry each sequence. `daily_share` is what this sequence takes from the sender on its busiest day.
CREATE TABLE sequence_senders (
  sequence_id  text NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  sender_id    text NOT NULL,
  address      text NOT NULL,
  domain       text NOT NULL,
  role         text NOT NULL CHECK (role IN ('primary', 'spare')),
  daily_share  integer NOT NULL,
  health_at_pick numeric,
  picked_at    timestamptz NOT NULL,
  dropped_at   timestamptz,
  drop_reason  text,
  PRIMARY KEY (sequence_id, sender_id)
);

-- Inbox placement results by sending domain, from whatever test tool is in use.
CREATE TABLE placement_results (
  domain     text NOT NULL,
  inbox_rate numeric NOT NULL CHECK (inbox_rate >= 0 AND inbox_rate <= 1),
  tool       text NOT NULL,
  tested_at  timestamptz NOT NULL,
  PRIMARY KEY (domain, tool, tested_at)
);

-- pending_op is written before the tool is called, so a crash leaves work a sweep can finish.
CREATE TABLE enrollments (
  id           text PRIMARY KEY,
  event_id     text NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  contact_id   text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  person_id    text REFERENCES people(id) ON DELETE SET NULL,
  domain       text NOT NULL,
  sequence_id  text NOT NULL REFERENCES sequences(id) ON DELETE RESTRICT,
  channel      text NOT NULL,
  external_contact_id text,
  state        text NOT NULL DEFAULT 'adding' CHECK (state IN ('adding', 'enrolled', 'paused', 'removed')),
  pending_op   text CHECK (pending_op IN ('add', 'pause', 'resume', 'remove')),
  cause        text,
  cause_id     text,
  resume_at    timestamptz,
  retry_after  timestamptz,
  added_at     timestamptz NOT NULL DEFAULT now(),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, contact_id)
);
CREATE INDEX enrollments_person ON enrollments (person_id) WHERE state <> 'removed';
CREATE INDEX enrollments_contact ON enrollments (contact_id);
CREATE INDEX enrollments_domain ON enrollments (domain) WHERE state <> 'removed';
CREATE INDEX enrollments_pending ON enrollments (pending_op) WHERE pending_op IS NOT NULL;

CREATE TABLE gate_log (
  id          text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id  text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  moment      text NOT NULL CHECK (moment IN ('add', 'launch', 'resume')),
  passed      boolean NOT NULL,
  reason      text,
  retry_after timestamptz,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_log_contact ON gate_log (contact_id, at DESC);

CREATE TABLE legal_bases (
  event_id    text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  region      text NOT NULL,
  basis       text NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, region)
);

CREATE TABLE inbound_messages (
  id           text PRIMARY KEY,
  connector    text NOT NULL,
  provider_message_id text NOT NULL,
  event_id     text REFERENCES events(id) ON DELETE CASCADE,
  contact_id   text REFERENCES contacts(id) ON DELETE SET NULL,
  channel      text NOT NULL,
  signal       text NOT NULL CHECK (signal IN ('reply', 'bounce', 'unsubscribe')),
  body         text,
  received_at  timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'done', 'unmatched')),
  code         text,
  model_code   text,
  code_matched boolean NOT NULL DEFAULT false,
  doubtful     boolean NOT NULL DEFAULT false,
  needs_confirmation boolean NOT NULL DEFAULT false,
  decided_by   text,
  decided_at   timestamptz,
  lease_until  timestamptz,
  UNIQUE (connector, provider_message_id)
);
CREATE INDEX inbound_open ON inbound_messages (received_at) WHERE status = 'received';
CREATE INDEX inbound_event ON inbound_messages (event_id, code);

CREATE TABLE meetings (
  id           text PRIMARY KEY,
  event_id     text NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  contact_id   text REFERENCES contacts(id) ON DELETE SET NULL,
  domain       text NOT NULL,
  external_key text NOT NULL UNIQUE,
  status       text NOT NULL CHECK (status IN ('proposed', 'booked', 'held', 'no_show', 'cancelled', 'rescheduled')),
  scheduled_at timestamptz NOT NULL,
  timezone     text NOT NULL DEFAULT 'UTC',
  source       text NOT NULL CHECK (source IN ('reply', 'sheet', 'calendar', 'manual')),
  rep          text,
  enrolled     boolean NOT NULL DEFAULT false,
  outcome_at   timestamptz,
  release_confirmed_by text,
  reminded_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_event ON meetings (event_id, status);
CREATE INDEX meetings_domain ON meetings (domain);

CREATE TABLE debriefs (
  id          text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  author      text NOT NULL,
  prompted_at timestamptz NOT NULL DEFAULT now(),
  body        text,
  answered_at timestamptz,
  extracted   boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'answered', 'accepted', 'rejected')),
  decided_by  text,
  UNIQUE (event_id, author)
);

CREATE TABLE debrief_facts (
  id         text PRIMARY KEY,
  debrief_id text NOT NULL REFERENCES debriefs(id) ON DELETE CASCADE,
  account    text,
  theme      text NOT NULL,
  fact       text NOT NULL,
  quote      text NOT NULL
);
CREATE INDEX debrief_facts_debrief ON debrief_facts (debrief_id);

CREATE TABLE scorecards (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  window_days integer NOT NULL CHECK (window_days IN (30, 60, 90, 180, 365)),
  metrics    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, window_days)
);

CREATE TABLE learning_proposals (
  id          text PRIMARY KEY,
  kind        text NOT NULL,
  subject     text NOT NULL,
  evidence    jsonb NOT NULL,
  edit        jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, subject)
);

CREATE TABLE integrity_runs (
  id        text PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  failures  jsonb NOT NULL
);

-- CRM writes that create records carry a key made here, so a retry cannot create a second one.
ALTER TABLE crm_outbox DROP CONSTRAINT crm_outbox_kind_check;
ALTER TABLE crm_outbox ADD CONSTRAINT crm_outbox_kind_check CHECK (kind IN ('email', 'opt_out', 'campaign_member', 'task', 'lead'));
ALTER TABLE crm_outbox ADD COLUMN desk_key text UNIQUE;
ALTER TABLE crm_outbox ADD COLUMN result_id text;

-- One definition of each funnel step. The enrollment funnel only counts people who were enrolled.
CREATE VIEW event_funnel AS
SELECT e.id AS event_id,
  (SELECT count(*) FROM contacts k WHERE k.event_id = e.id AND k.dropped_at IS NULL AND k.priority IS NOT NULL)::int AS kept,
  (SELECT count(DISTINCT n.contact_id) FROM enrollments n JOIN sequences s ON s.id = n.sequence_id WHERE n.event_id = e.id AND s.launched_at IS NOT NULL AND n.state <> 'adding')::int AS enrolled,
  (SELECT count(DISTINCT t.contact_id) FROM touches t WHERE t.event_id = e.id AND t.kind = 'send' AND EXISTS (SELECT 1 FROM enrollments n WHERE n.contact_id = t.contact_id))::int AS sent,
  (SELECT count(DISTINCT m.contact_id) FROM inbound_messages m WHERE m.event_id = e.id AND m.signal = 'reply' AND (m.code IS NULL OR m.code NOT IN ('out_of_office', 'bounced', 'unsubscribe', 'wrong_person', 'departed'))
     AND EXISTS (SELECT 1 FROM touches t WHERE t.contact_id = m.contact_id AND t.kind = 'send'))::int AS replied,
  (SELECT count(DISTINCT m.contact_id) FROM meetings m WHERE m.event_id = e.id AND m.enrolled AND m.status IN ('booked', 'held', 'no_show', 'rescheduled') AND EXISTS (SELECT 1 FROM inbound_messages i WHERE i.contact_id = m.contact_id AND i.signal = 'reply'))::int AS booked,
  (SELECT count(DISTINCT m.contact_id) FROM meetings m WHERE m.event_id = e.id AND m.enrolled AND m.status = 'held' AND EXISTS (SELECT 1 FROM inbound_messages i WHERE i.contact_id = m.contact_id AND i.signal = 'reply'))::int AS held,
  (SELECT count(*) FROM meetings m WHERE m.event_id = e.id AND NOT m.enrolled AND m.status IN ('booked', 'held'))::int AS logged_outside
FROM events e;
