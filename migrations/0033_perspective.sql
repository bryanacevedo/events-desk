-- The Summary's perspective, as written for a delivered list. One row of JSON per event:
--   { version, model, made_at, packet_hash, blocks: { why | list | stand: { by: 'model' | 'fallback' | 'simulated', text, note } } }
-- 'model' blocks carry the model's text, which passed every check in code. 'fallback' blocks carry the plain-words reason the code-written
-- text was used instead. 'simulated' means the demo's simulated model answered, so the Summary shows the code-written text.
-- packet_hash fingerprints the facts the model was shown; the workbook uses the model's text only while the facts still match.
-- NULL means no call was made (single-card events, or an event delivered before this existed): the Summary is code-written.
ALTER TABLE events ADD COLUMN perspective jsonb;
