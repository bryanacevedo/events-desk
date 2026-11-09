-- Google Sheet delivery. The Sheet is a copy of the delivered workbook that the
-- team shares by link. sheet_id is set as soon as Drive has the file, so a retry
-- never makes a second one. sheet_url is set only once the file is shared with the
-- company domain. sheet_error is the last failure, cleared on success. Delivery
-- never depends on these: an event is delivered whether or not they are filled.
-- Concierge reads views with explicit columns, so none of this reaches it.
ALTER TABLE events
  ADD COLUMN sheet_id    text,
  ADD COLUMN sheet_url   text,
  ADD COLUMN sheet_error text;
