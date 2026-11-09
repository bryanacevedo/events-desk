-- Slice 2: uploaded lists. A source row is one CSV line; a contact is one person.
-- A dropped row carries its reason on the same row, enforced here.

CREATE TABLE uploads (
  id          text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  filename    text NOT NULL DEFAULT '',
  mapping     jsonb NOT NULL,
  ignored     jsonb NOT NULL DEFAULT '[]',
  row_count   integer NOT NULL,
  uploaded_by text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id       text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  key      text NOT NULL,
  name     text NOT NULL,
  UNIQUE (event_id, key)
);

CREATE TABLE source_rows (
  id          text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  upload_id   text NOT NULL REFERENCES uploads (id) ON DELETE CASCADE,
  row_number  integer NOT NULL,
  raw         jsonb NOT NULL,
  kind        text NOT NULL,
  company_id  text REFERENCES companies (id),
  drop_reason text,
  dropped_at  timestamptz,
  CONSTRAINT source_drop_has_reason CHECK ((dropped_at IS NULL) = (drop_reason IS NULL))
);
CREATE INDEX source_rows_event ON source_rows (event_id);

CREATE TABLE contacts (
  id            text PRIMARY KEY,
  event_id      text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  source_row_id text NOT NULL REFERENCES source_rows (id) ON DELETE CASCADE,
  company_id    text REFERENCES companies (id),
  full_name     text,
  title         text,
  email         text,
  linkedin      text,
  drop_reason   text,
  dropped_at    timestamptz,
  CONSTRAINT contact_drop_has_reason CHECK ((dropped_at IS NULL) = (drop_reason IS NULL))
);
CREATE INDEX contacts_event ON contacts (event_id);
