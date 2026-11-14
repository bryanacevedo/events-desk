-- Assessment and the organizer request (docs/EVENT-PLAN.md 4.4).
-- An assessment says what the team can see and take at an event, with where each answer came from. A model may propose an answer; a person confirms it.
-- The organizer request is the email a person copies and sends from their own mailbox. The desk never sends it.

CREATE TABLE event_assessments (
  id             text PRIMARY KEY,
  event_id       text NOT NULL UNIQUE REFERENCES events (id) ON DELETE CASCADE,
  conference_key text NOT NULL,
  catalog_id     text REFERENCES catalog_events (id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  confirmed_by   text,
  confirmed_at   timestamptz,
  copied_from_id text REFERENCES event_assessments (id) ON DELETE SET NULL,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessment_confirmed_pair CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL) AND (confirmed_at IS NULL) = (confirmed_by IS NULL))
);
CREATE INDEX event_assessments_conference ON event_assessments (conference_key);

CREATE TABLE assessment_sources (
  id            text PRIMARY KEY,
  assessment_id text NOT NULL REFERENCES event_assessments (id) ON DELETE CASCADE,
  input         text NOT NULL CHECK (input IN ('pasted', 'fetched')),
  source_kind   text NOT NULL CHECK (source_kind IN ('faq', 'registration_terms', 'app_store_listing', 'prospectus', 'organizer_email', 'event_page', 'other')),
  url           text,
  body          text NOT NULL CHECK (length(body) <= 40000),
  added_by      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessment_source_fetched_has_url CHECK (input <> 'fetched' OR (url IS NOT NULL AND length(trim(url)) > 0))
);
CREATE INDEX assessment_sources_assessment ON assessment_sources (assessment_id);

CREATE TABLE assessment_answers (
  id            text PRIMARY KEY,
  assessment_id text NOT NULL REFERENCES event_assessments (id) ON DELETE CASCADE,
  question      text NOT NULL CHECK (question IN ('directory_present', 'directory_tickets', 'directory_fields', 'can_hide', 'download', 'sponsor_adds', 'terms')),
  answer        text NOT NULL CHECK (length(trim(answer)) > 0),
  detail        text NOT NULL DEFAULT '',
  source_kind   text NOT NULL CHECK (source_kind IN ('faq', 'registration_terms', 'app_store_listing', 'prospectus', 'organizer_email', 'event_page', 'other', 'first_hand', 'last_year')),
  source_id     text REFERENCES assessment_sources (id) ON DELETE SET NULL,
  quote         text NOT NULL DEFAULT '',
  -- 'model', 'reuse' (copied from last year) or a person's name.
  proposed_by   text NOT NULL,
  state         text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'confirmed')),
  confirmed_by  text,
  confirmed_at  timestamptz,
  UNIQUE (assessment_id, question),
  CONSTRAINT assessment_answer_confirmed CHECK ((state = 'confirmed') = (confirmed_by IS NOT NULL) AND (state = 'confirmed') = (confirmed_at IS NOT NULL)),
  -- A model's answer never exists without a quote.
  CONSTRAINT assessment_model_has_quote CHECK (proposed_by <> 'model' OR length(trim(quote)) > 0)
);

CREATE TABLE organizer_requests (
  id             text PRIMARY KEY,
  event_id       text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  template       text NOT NULL CHECK (template IN ('ask_for_list', 'follow_up')),
  subject        text NOT NULL,
  body           text NOT NULL,
  organizer_name text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted', 'copied', 'sent', 'will_share', 'will_not_share', 'received')),
  copied_by      text,
  copied_at      timestamptz,
  sent_on        date,
  expected_on    date,
  follow_up_on   date,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizer_copied_pair CHECK ((copied_by IS NULL) = (copied_at IS NULL))
);
CREATE INDEX organizer_requests_event ON organizer_requests (event_id);
CREATE UNIQUE INDEX organizer_requests_one_open ON organizer_requests (event_id) WHERE status IN ('drafted', 'copied', 'sent', 'will_share');

-- The two organizer rows join the deadlines. Same columns as 0050, so the view is replaced in place.
CREATE OR REPLACE VIEW event_deadlines AS
  SELECT d.event_id, 'deliverable'::text AS kind, d.id AS ref_id, d.label, d.due_on, d.owner, (d.done_at IS NOT NULL) AS done FROM sponsorship_deliverables d WHERE d.due_on IS NOT NULL
  UNION ALL SELECT s.event_id, 'deposit', s.id, 'Sponsorship deposit', s.deposit_due_on, '', (s.deposit_paid_on IS NOT NULL) FROM sponsorships s WHERE s.deposit_due_on IS NOT NULL
  UNION ALL SELECT s.event_id, 'balance', s.id, 'Sponsorship balance', s.balance_due_on, '', (s.balance_paid_on IS NOT NULL) FROM sponsorships s WHERE s.balance_due_on IS NOT NULL
  UNION ALL SELECT r.event_id, 'organizer_expected', r.id, 'Attendee list expected from the organizer', r.expected_on, r.created_by, (r.status IN ('received', 'will_not_share')) FROM organizer_requests r WHERE r.expected_on IS NOT NULL
  UNION ALL SELECT r.event_id, 'organizer_follow_up', r.id, 'Follow up with the organizer', r.follow_up_on, r.created_by, (r.status IN ('received', 'will_not_share')) FROM organizer_requests r WHERE r.follow_up_on IS NOT NULL;
