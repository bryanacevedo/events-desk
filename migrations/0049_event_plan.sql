-- The event as a plan (docs/EVENT-PLAN.md 4.1): the plan stage beside the list stage, involvements, who goes, and budget lines.
-- Actual money is never stored here: it is read from eventCost (tickets, travel, the cost ledger, AI).

ALTER TABLE events
  ADD COLUMN plan_stage text NOT NULL DEFAULT 'preparing' CHECK (plan_stage IN ('planning', 'confirmed', 'preparing', 'live', 'following_up', 'judged')),
  ADD COLUMN approval_mode text NOT NULL DEFAULT 'per_seat' CHECK (approval_mode IN ('per_seat', 'budget')),
  ADD COLUMN reason text NOT NULL DEFAULT '',
  ADD COLUMN goal_meetings_held integer CHECK (goal_meetings_held IS NULL OR goal_meetings_held >= 0),
  ADD COLUMN goal_accounts_met integer CHECK (goal_accounts_met IS NULL OR goal_accounts_met >= 0),
  ADD COLUMN goal_pipeline_cents bigint CHECK (goal_pipeline_cents IS NULL OR goal_pipeline_cents >= 0),
  ADD COLUMN plan_submitted_at timestamptz,
  ADD COLUMN plan_approved_by text,
  ADD COLUMN plan_approved_at timestamptz,
  ADD COLUMN approved_budget_cents bigint,
  ADD COLUMN judged_at timestamptz,
  ADD COLUMN judged_by text,
  ADD CONSTRAINT events_plan_approval_pair CHECK ((plan_approved_at IS NULL) = (plan_approved_by IS NULL)),
  ADD CONSTRAINT events_judged_pair CHECK ((judged_at IS NULL) = (judged_by IS NULL));

CREATE INDEX events_plan_stage ON events (plan_stage) WHERE parent_event_id IS NULL;

-- Every event made before this is per-seat. No dates here, so the backfill is the same on any day: the first tick moves past events on.
UPDATE events SET plan_stage = 'judged' WHERE motion = 'scored';

CREATE TABLE involvements (
  id                  text PRIMARY KEY,
  event_id            text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('passes', 'sponsorship', 'talk', 'hosted')),
  label               text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'confirmed', 'dropped')),
  dropped_reason      text,
  -- Hosted only: the conference it hangs off. Not events.parent_event_id, which is the top-up's column.
  conference_event_id text REFERENCES events (id) ON DELETE SET NULL,
  pass_count          integer CHECK (pass_count IS NULL OR pass_count >= 0),
  hosted_format       text CHECK (hosted_format IS NULL OR hosted_format IN ('dinner', 'side_event', 'roadshow_stop', 'webinar', 'customer_event')),
  headcount           integer CHECK (headcount IS NULL OR headcount >= 0),
  talk_title          text,
  speaker             text,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT involvements_drop_has_reason CHECK ((status = 'dropped') = (dropped_reason IS NOT NULL AND length(trim(dropped_reason)) > 0)),
  CONSTRAINT involvements_conference_hosted CHECK (conference_event_id IS NULL OR kind = 'hosted'),
  CONSTRAINT involvements_not_self CHECK (conference_event_id IS NULL OR conference_event_id <> event_id),
  CONSTRAINT involvements_format_hosted CHECK ((kind = 'hosted') = (hosted_format IS NOT NULL))
);
CREATE INDEX involvements_event ON involvements (event_id);
CREATE INDEX involvements_conference ON involvements (conference_event_id) WHERE conference_event_id IS NOT NULL;
CREATE UNIQUE INDEX involvements_one_hosted ON involvements (event_id) WHERE kind = 'hosted' AND status <> 'dropped';

CREATE TABLE event_people (
  id             text PRIMARY KEY,
  event_id       text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  person         text NOT NULL CHECK (length(trim(person)) > 0),
  roles          text[] NOT NULL CHECK (cardinality(roles) >= 1 AND roles <@ ARRAY['attend', 'host', 'speak']::text[]),
  team           text NOT NULL DEFAULT '',
  involvement_id text REFERENCES involvements (id) ON DELETE SET NULL,
  role_title     text NOT NULL DEFAULT '',
  -- A pass is still a seat_requests row, so tickets, the ticket budget and event cost work as they did. One pass per person.
  seat_request_id text UNIQUE REFERENCES seat_requests (id) ON DELETE SET NULL,
  added_by       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  removed_reason text,
  CONSTRAINT event_people_removed_pair CHECK ((removed_at IS NULL) = (removed_reason IS NULL)),
  CONSTRAINT event_people_removal_has_reason CHECK (removed_reason IS NULL OR length(trim(removed_reason)) > 0)
);
CREATE INDEX event_people_event ON event_people (event_id);
CREATE UNIQUE INDEX event_people_once ON event_people (event_id, person) WHERE removed_at IS NULL;

-- Who goes, for every event, old or new: a per-seat event's requests show through the second half with no backfill.
CREATE VIEW who_goes AS
  SELECT p.id, p.event_id, p.person, p.roles, p.team, p.involvement_id, p.seat_request_id, r.status AS seat_status, p.created_at
  FROM event_people p LEFT JOIN seat_requests r ON r.id = p.seat_request_id WHERE p.removed_at IS NULL
  UNION ALL
  SELECT r.id, r.event_id, r.requester, ARRAY['attend']::text[], r.team, NULL::text, r.id, r.status, r.created_at
  FROM seat_requests r WHERE r.status IN ('pending', 'approved') AND NOT EXISTS (SELECT 1 FROM event_people p WHERE p.seat_request_id = r.id);

CREATE TABLE budget_lines (
  id               text PRIMARY KEY,
  event_id         text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  involvement_id   text REFERENCES involvements (id) ON DELETE SET NULL,
  category         text NOT NULL CHECK (category IN ('passes', 'sponsorship', 'booth', 'travel', 'dinners', 'swag', 'tools', 'rep_time', 'other')),
  label            text NOT NULL DEFAULT '',
  planned_cents    bigint NOT NULL CHECK (planned_cents >= 0),
  -- Null reads "Not contracted". There is no actual column: actual is read from eventCost, so it cannot be counted twice.
  contracted_cents bigint CHECK (contracted_cents IS NULL OR contracted_cents >= 0),
  note             text NOT NULL DEFAULT '',
  updated_by       text NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_lines_event_category ON budget_lines (event_id, category);
CREATE UNIQUE INDEX budget_lines_one_per_sponsorship ON budget_lines (involvement_id) WHERE category = 'sponsorship';
