-- Build-order steps 4 and 5 of docs/TIERING-AND-ENRICHMENT.md: the structured, versioned ICP
-- (one seller per install), and company identity (merging, parent handling, stored reveals,
-- CRM account type). Nothing here changes what an existing event does.

-- The ICP. A document is data. A compile is one pass from a document to a draft a person confirms;
-- a published version is immutable. An event pins the version when its Research card is approved.
CREATE TABLE icp_documents (
  id          text PRIMARY KEY,
  filename    text NOT NULL,
  text        text NOT NULL,
  sha256      text NOT NULL,
  uploaded_by text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE icp_versions (
  version        integer PRIMARY KEY,
  icp            jsonb NOT NULL,
  document_id    text REFERENCES icp_documents (id),
  compile_id     text,
  published_by   text NOT NULL,
  published_at   timestamptz NOT NULL DEFAULT now(),
  note           text,
  bench_accuracy numeric
);
CREATE TABLE icp_compiles (
  id           text PRIMARY KEY,
  document_id  text NOT NULL REFERENCES icp_documents (id),
  -- estimated: cost shown, nothing run. drafted: the model's structure and its gaps. confirmed: a person approved the
  -- (edited) structure. published: a version exists. failed and cancelled end it.
  status       text NOT NULL DEFAULT 'estimated' CHECK (status IN ('estimated', 'drafted', 'confirmed', 'published', 'failed', 'cancelled')),
  base_version integer REFERENCES icp_versions (version),
  estimate     jsonb NOT NULL,
  llm_cap      integer NOT NULL,
  llm_calls    integer NOT NULL DEFAULT 0,
  draft        jsonb,
  gaps         jsonb NOT NULL DEFAULT '[]',
  unsupported  jsonb NOT NULL DEFAULT '[]',
  confirmed_by text,
  confirmed_at timestamptz,
  bench        jsonb,
  version      integer REFERENCES icp_versions (version),
  error        text,
  created_by   text NOT NULL,
  started_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE events ADD COLUMN icp_version integer REFERENCES icp_versions (version), ADD COLUMN icp_pinned_at timestamptz;

-- Identity (Layer 1). Reveals are stored by what was asked, so the same question is never bought twice.
-- One reveal can answer several questions (the same person under two spellings of the company), and a question that
-- found nobody is remembered too, so a miss is not bought twice either.
CREATE TABLE reveal_queries (
  vendor     text NOT NULL,
  query_key  text NOT NULL,
  reveal_id  text REFERENCES reveals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor, query_key)
);
ALTER TABLE companies
  ADD COLUMN identity_via text,
  -- The CRM's account type for this domain: customer, prospect, partner, competitor or none.
  ADD COLUMN account_type text,
  -- Other spellings of the name that folded into this company when rows resolving to one domain were merged.
  ADD COLUMN merged_names jsonb NOT NULL DEFAULT '[]';
-- The company name the row was filed under at upload, kept after a merge moves the row to another company.
ALTER TABLE source_rows ADD COLUMN listed_name text;
