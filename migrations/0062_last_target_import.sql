/* The last target account import, kept so the result stays readable after the page is closed or someone else opens it (S5 review). One row, replaced by each import.
   `skipped` is the rows left out, each with its row number and why. */

CREATE TABLE target_account_last_import (
  id         text PRIMARY KEY CHECK (id = 'last'),
  actor      text NOT NULL CHECK (length(trim(actor)) > 0),
  row_count  integer NOT NULL CHECK (row_count >= 0),
  added      integer NOT NULL CHECK (added >= 0),
  updated    integer NOT NULL CHECK (updated >= 0),
  skipped    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
