-- The people list reads each person's latest campaign-member row by event and address.
CREATE INDEX crm_outbox_member_person ON crm_outbox ((payload->>'event_id'), lower(payload->>'email'), created_at DESC, id DESC) WHERE kind = 'campaign_member';
