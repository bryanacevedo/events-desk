-- The person who asked for the cost card can differ from the event's requester.
-- Neither may approve it.
ALTER TABLE approvals ADD COLUMN also_requested_by text;
