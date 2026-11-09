-- docs/DATA-HYGIENE.md, phase 2: Salesforce do not contact checks, one record per person, and writing back. Salesforce is not connected: all of this runs against a simulated CRM behind the Crm seam.

-- Set after a CRM check succeeds, never before. A run that paused on a CRM that could not answer asks again on resume.
ALTER TABLE events ADD COLUMN crm_start_checked boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN crm_final_checked boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN crm_checked_at timestamptz;

-- One person across events. A row needs an address, a LinkedIn profile or a vendor id: a name alone never makes or matches one.
CREATE TABLE people (
  id               text PRIMARY KEY,
  email            text,
  linkedin         text,
  -- A vendor's id means nothing without the vendor that issued it.
  vendor           text,
  vendor_person_id text,
  full_name        text,
  first_seen       timestamptz NOT NULL DEFAULT now(),
  last_seen        timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  CHECK ((vendor IS NULL) = (vendor_person_id IS NULL))
);
CREATE UNIQUE INDEX people_email ON people (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX people_linkedin ON people (linkedin) WHERE linkedin IS NOT NULL;
CREATE UNIQUE INDEX people_vendor ON people (vendor, vendor_person_id) WHERE vendor_person_id IS NOT NULL;

-- Every address a person has been known by, so an old address still finds them. Role and shared addresses are never here.
CREATE TABLE person_emails (
  email      text PRIMARY KEY,
  person_id  text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_emails_person ON person_emails (person_id);

ALTER TABLE contacts ADD COLUMN person_id text REFERENCES people(id) ON DELETE SET NULL;
-- Do Not Call: the person stays on the list and is not to be phoned.
ALTER TABLE contacts ADD COLUMN no_calls boolean NOT NULL DEFAULT false;
-- The latest bounce Salesforce holds, by address: {"a@x.example": "2026-11-01T09:00:00Z"}.
ALTER TABLE contacts ADD COLUMN crm_bounced jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX contacts_person ON contacts (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX contacts_email_lower ON contacts (lower(email)) WHERE email IS NOT NULL;

-- What is owed to Salesforce. The payload carries everything the write needs, so a row outlives the event that queued it. An opt-out has no person_id: it is keyed by address or by name.
CREATE TABLE crm_outbox (
  id         text PRIMARY KEY,
  person_id  text REFERENCES people(id) ON DELETE SET NULL,
  kind       text NOT NULL CHECK (kind IN ('email', 'opt_out')),
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'done', 'failed', 'cancelled')),
  attempts   integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at    timestamptz
);
CREATE INDEX crm_outbox_queued ON crm_outbox (created_at) WHERE status = 'queued';
