-- Every event gets its own Slack channel, and everything about the event is posted there with the responsible person @-mentioned.
-- Direct messages are gone: a reply, an owner card or a reminder sent privately is work the rest of the team cannot see.
-- Problems that belong to no one event go to the desk's ops channel.

ALTER TABLE events ADD COLUMN slack_channel text;
ALTER TABLE notifications ADD COLUMN mention text[] NOT NULL DEFAULT '{}';
ALTER TABLE notifications DROP CONSTRAINT notifications_target_check;
UPDATE notifications SET target = 'ops' WHERE target = 'dm' AND event_id IS NULL;
UPDATE notifications SET mention = ARRAY[slack_id] WHERE target = 'dm' AND slack_id IS NOT NULL;
UPDATE notifications SET target = 'event' WHERE target IN ('dm', 'thread');
ALTER TABLE notifications ADD CONSTRAINT notifications_target_check CHECK (target IN ('event', 'ops'));
ALTER TABLE notifications ADD CONSTRAINT notifications_event_has_event CHECK (target = 'ops' OR event_id IS NOT NULL);
