-- CRM context per company, read through the CRM seam (mocked by default) after
-- tiering. Reading it is free, so it has no ledger entry. No deal amounts: the
-- workbook and Concierge stay free of money. heat is 'hot', 'warm' or 'cold'.
ALTER TABLE companies
  ADD COLUMN account_owner text,
  ADD COLUMN deal_name    text,
  ADD COLUMN deal_stage   text,
  ADD COLUMN last_activity date,
  ADD COLUMN heat         text;
