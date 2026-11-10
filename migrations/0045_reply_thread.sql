-- Where a reply can be answered: the conversation in the sending tool's own inbox. The rep answers there, from the inbox that sent the sequence,
-- so the thread stays one thread. HeyReach gives the exact conversation; the email tools give their shared inbox.
ALTER TABLE inbound_messages ADD COLUMN thread_url text;
