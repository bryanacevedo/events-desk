-- Definitions Events Desk owns, published as numbered versions with a hash, the way CRM Desk publishes its own (docs/SHARED-WORLD.md section 6).
CREATE TABLE definition_versions (
  name         text NOT NULL,
  version      integer NOT NULL CHECK (version >= 1),
  hash         text NOT NULL CHECK (hash ~ '^sha256:[0-9a-f]{64}$'),
  body         jsonb NOT NULL,
  changed_by   text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
-- Append-only: a published version is never edited or deleted.
CREATE FUNCTION definition_versions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'definition versions are append-only'; END $$;
CREATE TRIGGER definition_versions_no_change BEFORE UPDATE OR DELETE ON definition_versions
  FOR EACH ROW EXECUTE FUNCTION definition_versions_append_only();
