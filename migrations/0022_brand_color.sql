-- Seats: the organizer's brand color, read once from its favicon by scripts/brand-colors.ts. Null means the Desk tint.
ALTER TABLE catalog_events ADD COLUMN brand_color text;
