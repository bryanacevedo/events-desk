-- An event's Slack channel closes 90 days after the event's last day; Slack keeps its history.
ALTER TABLE events ADD COLUMN slack_archived_at timestamptz;
-- Everyone with an approved seat is invited to the event's channel, once.
ALTER TABLE seat_requests ADD COLUMN channel_invited_at timestamptz;
