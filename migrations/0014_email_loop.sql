-- Build-order step 8 of docs/TIERING-AND-ENRICHMENT.md: reveal, employment check, the catch-all probe and the verification loop (two-card flow).

-- A person the free search returned with the last name hidden is kept (and ranked) under their first name until a reveal gives the rest.
ALTER TABLE contacts
  ADD COLUMN name_hidden boolean NOT NULL DEFAULT false,
  -- The employer the reveal reported, for the employment check and for a person to read.
  ADD COLUMN employer text,
  -- Where this person is in the email loop. Each paid call is one job and the state is written before and after it, so a paused or crashed run
  -- never repeats a call whose outcome is unknown: { probed, revealed, finder, tested, retries, inflight, cand: [{ email, source, state, why }] }.
  ADD COLUMN email_loop jsonb NOT NULL DEFAULT '{}';
