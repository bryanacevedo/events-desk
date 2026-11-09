-- An opt-out recorded by name keeps the name and company as a person typed them, so Settings can show
-- "Ana Vega at Harbor Logistics" rather than the matching keys. Matching still runs on name_key and company_key.
ALTER TABLE suppressions ADD COLUMN name text;
ALTER TABLE suppressions ADD COLUMN company text;
