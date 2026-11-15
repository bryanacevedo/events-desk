/* The directory extension and the screen recording (docs/DIRECTORY.md 4). Two new list sources, what a person read keeps about where it came from,
   the capture key the extension signs with, the reads held before they are brought in, and the recordings. Frames are never stored. */

-- The CHECKs were unnamed inline in 0051, so Postgres named them <table>_list_source_check.
ALTER TABLE uploads DROP CONSTRAINT uploads_list_source_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_list_source_check
  CHECK (list_source IN ('web_app_download', 'app_download', 'emailed_by_organizer', 'sponsor_export', 'other', 'directory_extension', 'screen_recording'));
ALTER TABLE source_rows DROP CONSTRAINT source_rows_list_source_check;
ALTER TABLE source_rows ADD CONSTRAINT source_rows_list_source_check
  CHECK (list_source IN ('web_app_download', 'app_download', 'emailed_by_organizer', 'sponsor_export', 'other', 'directory_extension', 'screen_recording'));
ALTER TABLE contacts DROP CONSTRAINT contacts_list_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_list_source_check
  CHECK (list_source IS NULL OR list_source IN ('web_app_download', 'app_download', 'emailed_by_organizer', 'sponsor_export', 'other', 'directory_extension', 'screen_recording'));

-- Null for everyone not read from a directory or a recording.
ALTER TABLE contacts ADD COLUMN read_note text, ADD COLUMN read_terms text;

CREATE TABLE capture_keys (
  id           text PRIMARY KEY,
  owner        text NOT NULL,
  label        text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  tail         text NOT NULL,
  scope        text NOT NULL CHECK (scope = 'add_people'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   text
);
CREATE INDEX capture_keys_owner ON capture_keys (owner);

CREATE TABLE recordings (
  id            text PRIMARY KEY,
  event_id      text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  app_name      text NOT NULL,
  uploaded_by   text NOT NULL,
  frames_sent   integer NOT NULL DEFAULT 0,
  frames_read   integer NOT NULL DEFAULT 0,
  frames_failed integer NOT NULL DEFAULT 0,
  people        integer NOT NULL DEFAULT 0,
  state         text NOT NULL DEFAULT 'reading' CHECK (state IN ('reading', 'done')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recordings_event ON recordings (event_id);

-- One row per frame, taken before the model is called so a repeat of a frame calls nothing. The picture itself is not kept.
CREATE TABLE recording_frames (
  recording_id text NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  n            integer NOT NULL,
  state        text NOT NULL DEFAULT 'reading' CHECK (state IN ('reading', 'read', 'failed')),
  found        integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, n)
);

CREATE TABLE directory_reads (
  id           text PRIMARY KEY,
  event_id     text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  dedupe_key   text NOT NULL,
  full_name    text NOT NULL,
  title        text,
  company      text,
  location     text,
  profile_url  text,
  via          text NOT NULL CHECK (via IN ('extension', 'recording')),
  platform     text NOT NULL,
  read_by      text NOT NULL,
  read_on      date NOT NULL,
  source_text  text NOT NULL,
  terms_note   text NOT NULL,
  state        text NOT NULL CHECK (state IN ('staged', 'to_check', 'brought_in', 'dismissed')),
  check_reason text,
  recording_id text REFERENCES recordings (id) ON DELETE SET NULL,
  -- A replaced list deletes its contacts; the read stays and is pointed at the new one.
  contact_id   text REFERENCES contacts (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, dedupe_key)
);
CREATE INDEX directory_reads_state ON directory_reads (event_id, state);
CREATE INDEX directory_reads_contact ON directory_reads (contact_id) WHERE contact_id IS NOT NULL;
