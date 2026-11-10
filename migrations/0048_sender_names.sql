-- Whose inbox or LinkedIn account a sender is, as the tool names it, so a sheet can say "Maya Ortiz" rather than an address or handle.
ALTER TABLE sequence_senders ADD COLUMN display_name text;
