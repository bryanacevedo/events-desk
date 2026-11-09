-- Build-order step 6 of docs/TIERING-AND-ENRICHMENT.md: firmographics, ICP hard rules, company tier with
-- Unknown, the baseline, the second look, and re-tier. Nothing here changes what an existing event does:
-- every column is nullable or defaults to zero, and an event with no pinned ICP tiers as before.

ALTER TABLE companies
  -- What the vendor said, as plain values: employees, industry, business_model (B2B, B2C, B2B2C), country, description.
  ADD COLUMN firmo            jsonb,
  -- Where those values came from: cache, search, search+enrich, human or none.
  ADD COLUMN firmo_source     text,
  ADD COLUMN segment          text,
  ADD COLUMN company_type     text,
  -- The supplied fact the tier relied on.
  ADD COLUMN tier_fact        text,
  -- hard_rule, model, cache or human.
  ADD COLUMN tier_via         text,
  ADD COLUMN tier_icp_version integer,
  -- The size-band-plus-keywords benchmark, computed per company at run time.
  ADD COLUMN baseline_tier    integer,
  -- The second model's answer and whether it agreed: { tier, reason, fact, agreed, why }.
  ADD COLUMN second_look      jsonb,
  -- What one read of the company's own website said, in two sentences.
  ADD COLUMN website_note     text;

-- Companies a person re-tiered before Approval 2, against the allowance stated on the Research card.
ALTER TABLE events ADD COLUMN retier_used integer NOT NULL DEFAULT 0;
