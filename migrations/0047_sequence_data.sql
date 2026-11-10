-- Every tool event keeps the sequence it came from (docs/SEQUENCES-VIEW.md §1, §2).
ALTER TABLE touches ADD COLUMN sequence_id text REFERENCES sequences(id) ON DELETE SET NULL;
-- A LinkedIn send says what it was: 'invite' (a connection request) or 'message'. Email leaves it null. Not `reason`: erasure blanks that.
ALTER TABLE touches ADD COLUMN action text CHECK (action IS NULL OR action IN ('invite', 'message'));
ALTER TABLE inbound_messages ADD COLUMN sequence_id text REFERENCES sequences(id) ON DELETE SET NULL;
ALTER TABLE inbound_messages ADD COLUMN step integer;
CREATE INDEX touches_sequence ON touches (sequence_id, kind) WHERE sequence_id IS NOT NULL;
CREATE INDEX inbound_sequence ON inbound_messages (sequence_id) WHERE sequence_id IS NOT NULL;

-- Backfill. Touches written from a tool event: the person's enrollment on the same channel and event, added at or before the touch, latest first.
UPDATE touches t SET sequence_id = (
  SELECT n.sequence_id FROM enrollments n
  WHERE n.contact_id = t.contact_id AND n.channel = t.channel AND n.event_id = t.event_id AND n.added_at <= t.at
  ORDER BY n.added_at DESC, n.id DESC LIMIT 1)
WHERE t.sequence_id IS NULL AND t.contact_id IS NOT NULL AND t.channel IS NOT NULL AND t.kind IN ('send', 'bounce', 'unsubscribe', 'reply');

-- Inbound rows carry the credited event, not the sequence's, so they match on the connector instead.
UPDATE inbound_messages m SET sequence_id = (
  SELECT n.sequence_id FROM enrollments n JOIN sequences s ON s.id = n.sequence_id
  WHERE n.contact_id = m.contact_id AND n.channel = m.channel AND s.connector = m.connector AND n.added_at <= m.received_at
  ORDER BY n.added_at DESC, n.id DESC LIMIT 1)
WHERE m.sequence_id IS NULL AND m.contact_id IS NOT NULL;

-- A reply-coded touch takes its inbound row's sequence (its key is code:<inbound id>:<code>).
UPDATE touches t SET sequence_id = m.sequence_id FROM inbound_messages m
WHERE t.sequence_id IS NULL AND t.kind LIKE 'reply\_%' AND t.dedup_key LIKE 'code:%' AND split_part(t.dedup_key, ':', 2) = m.id;

-- A LinkedIn send recorded before this change was a message.
UPDATE touches SET action = 'message' WHERE kind = 'send' AND channel = 'linkedin' AND action IS NULL;
