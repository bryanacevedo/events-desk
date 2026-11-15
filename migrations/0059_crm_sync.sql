-- Step 6 part 2 (docs/SHARED-WORLD.md section 12): what the sweep has already queued for the CRM, and the new outbox kinds.
-- kind: member (ref = event id + ':' + lowercased email), meeting, meeting_status, send, reply, debrief, money (ref = event id).
-- last: the last value queued (a status, or "budget:actual" for money). n: how many rows were queued for this ref, the sequence in the row's key.
CREATE TABLE crm_sync (
  kind       text NOT NULL,
  ref        text NOT NULL,
  last       text NOT NULL,
  n          integer NOT NULL DEFAULT 1,
  queued_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref)
);
ALTER TABLE crm_outbox DROP CONSTRAINT crm_outbox_kind_check;
ALTER TABLE crm_outbox ADD CONSTRAINT crm_outbox_kind_check CHECK (kind IN ('email', 'opt_out', 'campaign', 'campaign_member', 'task', 'lead', 'activity', 'activity_update', 'campaign_money'));
-- A TRUNCATE skips row triggers, so the append-only guard needs its own.
CREATE TRIGGER definition_versions_no_truncate BEFORE TRUNCATE ON definition_versions
  FOR EACH STATEMENT EXECUTE FUNCTION definition_versions_append_only();
CREATE INDEX crm_outbox_member_ref ON crm_outbox ((payload->>'member_ref')) WHERE kind = 'campaign_member';
