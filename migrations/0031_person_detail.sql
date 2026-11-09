-- Detail about a person that the paid reveal or match already returns and the delivered list shows.
-- Nothing is bought for these; a vendor that does not say leaves them null, and live mode without a vendor leaves them null too.
ALTER TABLE contacts
  -- City, state and country as the vendor gives them, one line.
  ADD COLUMN person_location  text,
  -- The vendor's own seniority word (c_suite, vp, director, manager, ...), kept apart from title_seniority, which the title parser derives.
  ADD COLUMN vendor_seniority text,
  -- Departments the vendor lists, comma separated.
  ADD COLUMN departments      text,
  -- When the person started in the current role, YYYY-MM or YYYY-MM-DD as given.
  ADD COLUMN role_since       text;
