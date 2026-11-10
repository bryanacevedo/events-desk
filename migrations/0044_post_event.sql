-- The post-event wave (docs/LIFECYCLE.md §5b). The follow-up starts on a person's press, from a card posted the day after the event's last day.

-- A custom event can run more than one day. Without it, a three-day event looked over after its first.
ALTER TABLE events ADD COLUMN ends_on date;
ALTER TABLE events ADD CONSTRAINT events_ends_after_start CHECK (ends_on IS NULL OR ends_on >= starts_on);

-- The card, its one reminder, and the press.
ALTER TABLE events ADD COLUMN post_card_at timestamptz;
ALTER TABLE events ADD COLUMN post_reminded_at timestamptz;
ALTER TABLE events ADD COLUMN post_started_at timestamptz;
ALTER TABLE events ADD COLUMN post_started_by text;
