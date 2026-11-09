-- Build-order step 7 of docs/TIERING-AND-ENRICHMENT.md: free people search, title parsing, persona tiers, ranking and quotas.

-- The design's drop reason is no_people_found. The old name is renamed in every stored row; screens that still know only the old name keep a label for it.
UPDATE contacts    SET drop_reason = 'no_people_found' WHERE drop_reason = 'no_contacts_found';
UPDATE source_rows SET drop_reason = 'no_people_found' WHERE drop_reason = 'no_contacts_found';

-- A title tier is read from the title's function and seniority. They are kept so a company's type and size can adjust the tier later,
-- and so a person can see why. non_buyer: an intern, student, assistant or press.
ALTER TABLE title_tiers ADD COLUMN func text, ADD COLUMN seniority text, ADD COLUMN non_buyer boolean NOT NULL DEFAULT false;

-- A person found by the free search: the vendor's id (pre-payment dedupe uses it, since a free search can hide the last name),
-- the date the vendor last refreshed the record (freshness, not proof of employment), and what the title was read as.
ALTER TABLE contacts ADD COLUMN vendor_person_id text, ADD COLUMN found_at date, ADD COLUMN title_function text, ADD COLUMN title_seniority text;
CREATE INDEX contacts_vendor_person ON contacts (event_id, vendor_person_id);
