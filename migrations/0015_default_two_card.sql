-- Build-order step 9 / the default flow. New events run the two-card flow. Events that already exist keep the flow they have.
ALTER TABLE events ALTER COLUMN flow SET DEFAULT 'two_card';

-- Who recorded a suppression, and when. An opt-out has its own drop reason, opted_out; rows already dropped under it are not rewritten.
ALTER TABLE suppressions ADD COLUMN created_by text;
