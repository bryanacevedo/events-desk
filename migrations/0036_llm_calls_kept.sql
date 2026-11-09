-- Real AI spend outlives the event. llm_calls cascades away with its event, so the token counts are copied here before it goes
-- (the same approach as ledger_kept). Only what prices a call is kept, never the model's text. No foreign key, on purpose.
CREATE TABLE llm_calls_kept (
  id            text PRIMARY KEY,
  event_id      text NOT NULL,
  step          text NOT NULL,
  model         text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL,
  kept_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_kept_at ON llm_calls_kept (created_at);
