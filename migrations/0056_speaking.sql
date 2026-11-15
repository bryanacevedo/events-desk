/* Speaking and the "I'm going" kit (docs/SPEAKING.md 4). Calls for papers, the talk with its two-person approvals (the author never approves, by CHECK),
   kit offers, the one photo a person keeps, and the organizer's kit. Rendered images are never stored. */

CREATE TABLE calls_for_papers (
  id            text PRIMARY KEY,
  event_id      text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (length(trim(title)) > 0),
  url           text NOT NULL CHECK (url ~* '^https?://'),
  closes_on     date NOT NULL,
  notes         text NOT NULL DEFAULT '',
  route         text NOT NULL DEFAULT 'editorial' CHECK (route IN ('editorial', 'paid')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'passed')),
  passed_reason text,
  source        text NOT NULL DEFAULT 'person' CHECK (source IN ('person', 'model')),
  source_url    text,
  added_by      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cfp_passed_has_reason CHECK ((status = 'passed') = (passed_reason IS NOT NULL AND length(trim(passed_reason)) > 0))
);
CREATE INDEX cfp_event ON calls_for_papers (event_id);
CREATE INDEX cfp_closing ON calls_for_papers (closes_on) WHERE status = 'open';

CREATE TABLE talks (
  id                   text PRIMARY KEY,
  event_id             text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  involvement_id       text NOT NULL UNIQUE REFERENCES involvements (id) ON DELETE CASCADE,
  cfp_id               text REFERENCES calls_for_papers (id) ON DELETE SET NULL,
  title                text NOT NULL DEFAULT '',
  abstract             text NOT NULL DEFAULT '',
  speaker              text NOT NULL DEFAULT '',
  status               text NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting', 'approved_to_submit', 'submitted', 'accepted', 'declined')),
  abstract_by          text,
  abstract_approved_by text,
  abstract_approved_at timestamptz,
  slides_url           text,
  slides_by            text,
  slides_approved_by   text,
  slides_approved_at   timestamptz,
  slides_sent_on       date,
  submitted_on         date,
  slide_due_on         date,
  rehearsal_on         date,
  declined_reason      text,
  updated_by           text NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT talks_abstract_two_people CHECK (abstract_approved_by IS NULL OR (abstract_by IS NOT NULL AND abstract_approved_by <> abstract_by)),
  CONSTRAINT talks_abstract_pair CHECK ((abstract_approved_by IS NULL) = (abstract_approved_at IS NULL)),
  CONSTRAINT talks_slides_two_people CHECK (slides_approved_by IS NULL OR (slides_by IS NOT NULL AND slides_approved_by <> slides_by AND slides_url IS NOT NULL)),
  CONSTRAINT talks_slides_pair CHECK ((slides_approved_by IS NULL) = (slides_approved_at IS NULL)),
  CONSTRAINT talks_forward_needs_approval CHECK (status NOT IN ('approved_to_submit', 'submitted', 'accepted') OR abstract_approved_at IS NOT NULL),
  CONSTRAINT talks_submitted_has_day CHECK (status NOT IN ('submitted', 'accepted') OR submitted_on IS NOT NULL),
  CONSTRAINT talks_declined_has_reason CHECK ((status = 'declined') = (declined_reason IS NOT NULL AND length(trim(declined_reason)) > 0)),
  CONSTRAINT talks_sent_needs_approved_slides CHECK (slides_sent_on IS NULL OR slides_approved_at IS NOT NULL)
);
CREATE INDEX talks_event ON talks (event_id);
ALTER TABLE calls_for_papers ADD COLUMN talk_id text REFERENCES talks (id) ON DELETE SET NULL;

ALTER TABLE scans ADD COLUMN talk_id text REFERENCES talks (id) ON DELETE SET NULL;

CREATE TABLE kit_offers (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  person     text NOT NULL CHECK (length(trim(person)) > 0),
  role       text NOT NULL CHECK (role IN ('attending', 'speaking', 'sponsoring', 'hosting')),
  reason     text NOT NULL CHECK (reason IN ('seat_approved', 'talk_accepted', 'hosted_confirmed', 'sponsorship_confirmed', 'asked')),
  source_id  text,
  status     text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'dismissed')),
  caption    integer NOT NULL DEFAULT 0,
  post_url   text,
  posted_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, person, role),
  CONSTRAINT kit_post_pair CHECK ((post_url IS NULL) = (posted_at IS NULL))
);
CREATE INDEX kit_offers_person ON kit_offers (person);

CREATE TABLE kit_photos (
  person     text PRIMARY KEY,
  bytes      bytea NOT NULL CHECK (octet_length(bytes) <= 2097152),
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  source     text NOT NULL CHECK (source IN ('upload', 'slack')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizer_kits (
  event_id   text PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  logo       bytea CHECK (logo IS NULL OR octet_length(logo) <= 512000),
  logo_mime  text CHECK (logo_mime IS NULL OR logo_mime = 'image/png'),
  color      text CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  hashtag    text NOT NULL DEFAULT '',
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizer_kit_logo_pair CHECK ((logo IS NULL) = (logo_mime IS NULL))
);
