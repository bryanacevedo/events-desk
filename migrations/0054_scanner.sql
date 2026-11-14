/* The scanner (docs/SCANNER.md). One row per scan, made by the phone with its own id so a retry is the same scan. */

ALTER TABLE contacts
  ADD COLUMN registrant_id text,
  ADD COLUMN marketing_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN consent_note text;
CREATE INDEX contacts_registrant ON contacts (event_id, registrant_id) WHERE registrant_id IS NOT NULL;

CREATE TABLE scanner_settings (
  event_id text PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  qualifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  notice_text text NOT NULL DEFAULT '',
  notice_version integer NOT NULL DEFAULT 1,
  organizer text CHECK (organizer IN ('swapcard')),
  organizer_event_ref text NOT NULL DEFAULT '',
  organizer_exhibitor_ref text NOT NULL DEFAULT '',
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scans (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9-]{8,64}$'),
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rep text NOT NULL,
  method text NOT NULL CHECK (method IN ('badge_code', 'badge_id', 'badge_photo', 'card_photo', 'typed')),
  raw_payload text NOT NULL DEFAULT '',
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  uncertain jsonb NOT NULL DEFAULT '[]'::jsonb,
  registrant_id text,
  temperature text NOT NULL DEFAULT 'warm' CHECK (temperature IN ('hot', 'warm', 'cold')),
  qualifiers jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NOT NULL DEFAULT '',
  promise text NOT NULL DEFAULT '',
  promise_owner text,
  next_step text NOT NULL DEFAULT '',
  next_step_on date,
  marketing_consent boolean NOT NULL DEFAULT false,
  consent_notice_version integer,
  consent_wording text NOT NULL DEFAULT '',
  consent_at timestamptz,
  scanned_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  seconds integer CHECK (seconds IS NULL OR seconds BETWEEN 0 AND 3600),
  met boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received', 'resolving', 'lookup_pending', 'needs_fields', 'to_confirm', 'placed', 'failed')),
  state_detail text NOT NULL DEFAULT '',
  contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  capture_id text REFERENCES onsite_captures(id) ON DELETE SET NULL,
  near_contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  review text CHECK (review IN ('open', 'same', 'different')),
  reviewed_by text,
  confirmed_by text,
  confirmed_at timestamptz,
  device text NOT NULL DEFAULT '',
  claimed_at timestamptz
);
CREATE INDEX scans_event ON scans (event_id, scanned_at DESC);
CREATE INDEX scans_rep ON scans (event_id, rep);
CREATE INDEX scans_open ON scans (event_id) WHERE state IN ('received', 'lookup_pending', 'resolving');
CREATE INDEX scans_review ON scans (event_id) WHERE review = 'open';

CREATE TABLE scan_photos (
  scan_id text PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('badge', 'card')),
  mime text NOT NULL,
  total_bytes integer NOT NULL CHECK (total_bytes BETWEEN 1 AND 8388608),
  received_bytes integer NOT NULL DEFAULT 0,
  data bytea NOT NULL DEFAULT ''::bytea,
  read_state text NOT NULL DEFAULT 'none' CHECK (read_state IN ('none', 'pending', 'read', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

/* Every wording the notice has had, so a scan keeps the version it was shown. */
CREATE TABLE scanner_notices (
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version integer NOT NULL,
  text text NOT NULL,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, version)
);
