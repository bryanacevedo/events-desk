-- Each credit vendor's pre-allocated pool, when it differs from config/defaults.json (the demo seed sets sample values).
-- Null allotment means unknown: the app then shows what was used and no limit. Credits are never converted to dollars.
CREATE TABLE vendor_pools (
  vendor    text PRIMARY KEY,
  allotment integer CHECK (allotment IS NULL OR allotment >= 0),
  period    text NOT NULL CHECK (period IN ('month', 'year'))
);
