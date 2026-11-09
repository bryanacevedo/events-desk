-- An attendee was on the uploaded list. A prospect is someone found at a buyer
-- title at an attending company who was not on it.
ALTER TABLE contacts ADD COLUMN source text NOT NULL DEFAULT 'attendee';

CREATE OR REPLACE VIEW concierge_prospects AS
  SELECT c.event_id, c.full_name, c.title, co.name AS company, c.priority, c.email, c.source
  FROM contacts c JOIN companies co ON co.id = c.company_id JOIN events e ON e.id = c.event_id
  WHERE e.stage = 'delivered' AND c.dropped_at IS NULL;
