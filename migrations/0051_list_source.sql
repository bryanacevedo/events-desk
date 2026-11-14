-- Where a list came from (docs/EVENT-PLAN.md 4.3). contacts.source already means attendee, prospect or onsite, so the list's source is its own column.
-- It is recorded and shown; the gate does not read it.

ALTER TABLE uploads
  ADD COLUMN list_source text NOT NULL DEFAULT 'other' CHECK (list_source IN ('web_app_download', 'app_download', 'emailed_by_organizer', 'sponsor_export', 'other')),
  ADD COLUMN source_note text NOT NULL DEFAULT '';
UPDATE uploads SET source_note = 'Not recorded';

ALTER TABLE source_rows
  ADD COLUMN list_source text NOT NULL DEFAULT 'other' CHECK (list_source IN ('web_app_download', 'app_download', 'emailed_by_organizer', 'sponsor_export', 'other'));

-- Null is allowed: a prospect or a walk-up came from no list.
ALTER TABLE contacts
  ADD COLUMN list_source text CHECK (list_source IS NULL OR list_source IN ('web_app_download', 'app_download', 'emailed_by_organizer', 'sponsor_export', 'other'));
UPDATE contacts SET list_source = 'other' WHERE source = 'attendee';
