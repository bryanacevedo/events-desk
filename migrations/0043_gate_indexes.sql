-- The gate runs once per person, at add, launch and resume. Measured at 10,000 people on Postgres 18 (tests/gate-scale.bench.test.ts):
-- the cool-off check read every "not interested" and "not now" ever recorded for each person, and the reply-waiting check scanned every inbound message.
-- Both indexes cover only rare rows, so they cost almost nothing on write.

-- A no carries to the next event: found by the person record. (By contact, touches_contact already serves it.)
CREATE INDEX touches_no_by_person ON touches (person_id, at DESC) WHERE kind IN ('reply_not_interested', 'reply_not_now') AND person_id IS NOT NULL;

-- A reply waiting on a person. The predicate matches the gate's own, so the planner can use it.
CREATE INDEX inbound_waiting_by_contact ON inbound_messages (contact_id) WHERE status = 'received' OR (doubtful AND decided_at IS NULL);
