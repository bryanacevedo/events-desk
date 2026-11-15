-- Step 6 part 3 (docs/SHARED-WORLD.md section 13): an outbox row can be held (the CRM does not carry its status meaning yet), and an event has a booking link.
-- A held row keeps its payload, counts no attempt and raises no failure; the daily pass and any change in the CRM's feature list set it back to queued.
ALTER TABLE crm_outbox DROP CONSTRAINT crm_outbox_status_check;
ALTER TABLE crm_outbox ADD CONSTRAINT crm_outbox_status_check CHECK (status IN ('queued', 'held', 'done', 'failed', 'cancelled'));
CREATE INDEX crm_outbox_held ON crm_outbox (created_at) WHERE status = 'held';
ALTER TABLE events ADD COLUMN booking_url text CHECK (booking_url IS NULL OR (booking_url ~ '^https?://[^[:space:]]+$' AND length(booking_url) <= 500));
