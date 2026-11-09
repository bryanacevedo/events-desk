-- Concierge reads only these views, and only as this role. None of them has a
-- cost, credit, budget or seat-price column, so money is out of its reach.

CREATE VIEW concierge_events AS
  SELECT id, name, venue, starts_on::text AS starts_on FROM events WHERE stage = 'delivered';

CREATE VIEW concierge_priority_counts AS
  SELECT c.event_id, c.priority, count(*)::int AS contacts
  FROM contacts c JOIN events e ON e.id = c.event_id
  WHERE e.stage = 'delivered' AND c.dropped_at IS NULL GROUP BY 1, 2;

CREATE VIEW concierge_company_counts AS
  SELECT co.event_id, co.name AS company, co.tier, count(c.id) FILTER (WHERE c.dropped_at IS NULL)::int AS contacts
  FROM companies co JOIN events e ON e.id = co.event_id LEFT JOIN contacts c ON c.company_id = co.id
  WHERE e.stage = 'delivered' GROUP BY co.id;

-- A drop caused by the spend cap would reveal the budget, so it reads as "other".
CREATE VIEW concierge_drop_counts AS
  SELECT event_id, reason, sum(n)::int AS dropped FROM (
    SELECT event_id, CASE drop_reason WHEN 'budget_cap' THEN 'other' ELSE drop_reason END AS reason, count(*) AS n FROM contacts WHERE dropped_at IS NOT NULL GROUP BY 1, 2
    UNION ALL
    SELECT event_id, CASE drop_reason WHEN 'budget_cap' THEN 'other' ELSE drop_reason END, count(*) FROM source_rows WHERE dropped_at IS NOT NULL AND kind <> 'person' GROUP BY 1, 2
  ) d WHERE event_id IN (SELECT id FROM events WHERE stage = 'delivered') GROUP BY 1, 2;

CREATE VIEW concierge_prospects AS
  SELECT c.event_id, c.full_name, c.title, co.name AS company, c.priority, c.email
  FROM contacts c JOIN companies co ON co.id = c.company_id JOIN events e ON e.id = c.event_id
  WHERE e.stage = 'delivered' AND c.dropped_at IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'concierge_reader') THEN CREATE ROLE concierge_reader NOLOGIN; END IF;
END $$;
GRANT SELECT ON concierge_events, concierge_priority_counts, concierge_company_counts, concierge_drop_counts, concierge_prospects TO concierge_reader;
GRANT concierge_reader TO CURRENT_USER;
