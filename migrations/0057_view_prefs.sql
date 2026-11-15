/* A person's own choice of how a screen looks (decision 81). One row per person and screen. Today only the Overview has a choice:
   a (ledger), b (trays) or c (timeline). The database refuses any other value. No row means the default, b. */

CREATE TABLE person_view_prefs (
  person     text NOT NULL CHECK (length(trim(person)) > 0),
  screen     text NOT NULL,
  choice     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person, screen),
  CONSTRAINT view_prefs_known CHECK (screen = 'overview' AND choice IN ('a', 'b', 'c'))
);
