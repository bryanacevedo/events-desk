-- docs/NEW-REGISTRATIONS.md, section 2. New registrations for a delivered event run as their own hidden event, a top-up, and merge into the parent when delivered.

ALTER TABLE events
  ADD COLUMN parent_event_id    text REFERENCES events (id) ON DELETE CASCADE,
  -- Ending a top-up: a stage like researching cannot reach declined, so a marker ends it and the stage stays where it was.
  ADD COLUMN ended_at           timestamptz,
  ADD COLUMN ended_reason       text,
  ADD COLUMN merged_at          timestamptz,
  -- Set on a merged top-up once the parent's Sheet has taken its rows, so a crash between the merge and the refresh is retried at boot and the parent's own row never changes.
  ADD COLUMN sheet_refreshed_at timestamptz,
  -- Whether the attendee titles have been read with the rules. Copied title rows on a top-up can no longer stand in for this.
  ADD COLUMN titles_read        boolean NOT NULL DEFAULT false;
UPDATE events e SET titles_read = true
  WHERE EXISTS (SELECT 1 FROM title_tiers t WHERE t.event_id = e.id AND t.source = 'persona') OR EXISTS (SELECT 1 FROM jobs j WHERE j.event_id = e.id AND j.kind = 'title_tier');

-- A top-up holds no seats.
ALTER TABLE events DROP CONSTRAINT events_seat_count_check;
ALTER TABLE events ADD CONSTRAINT events_seat_count_check CHECK (seat_count > 0 OR parent_event_id IS NOT NULL);

CREATE INDEX events_parent ON events (parent_event_id) WHERE parent_event_id IS NOT NULL;
-- One open top-up per parent, held by the database as well as by the code.
CREATE UNIQUE INDEX events_one_open_top_up ON events (parent_event_id) WHERE parent_event_id IS NOT NULL AND ended_at IS NULL AND merged_at IS NULL;

ALTER TABLE companies
  ADD COLUMN inherited_from text REFERENCES companies (id) ON DELETE SET NULL,
  -- The reason a new person at this company stops, when the parent's outcome was no usable tier.
  ADD COLUMN inherited_drop text;
CREATE UNIQUE INDEX companies_inherited ON companies (event_id, inherited_from) WHERE inherited_from IS NOT NULL;

-- On a top-up's upload, row_count is the new rows. These two say how big the file was and how much of it the parent already had.
ALTER TABLE uploads
  ADD COLUMN file_rows  integer,
  ADD COLUMN already_in integer,
  -- Which top-up brought this list. Stays after the merge moves the upload to the parent.
  ADD COLUMN top_up_id  text;

-- Concierge reads delivered events; a merged top-up is delivered but is not an event.
CREATE OR REPLACE VIEW concierge_events AS
  SELECT id, name, venue, starts_on::text AS starts_on FROM events WHERE stage = 'delivered' AND parent_event_id IS NULL;
