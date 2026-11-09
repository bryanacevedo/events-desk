/* The simulated world: fictional companies and people with known truth, written
   by scripts/gen-world.ts to samples/world.json. The simulated vendors and the
   simulated model read this and nothing else. Every domain ends in `.example`, so
   no real vendor or mail server can ever be reached from it. */

export type WTier = 1 | 2 | 3;

export interface WorldCompany {
  id: string;
  name: string;
  /** Other spellings a vendor's name search would still resolve to this company. */
  aliases: string[];
  domain: string;
  parent_id: string | null;
  segment: string;
  employees: number;
  industry: string;
  business_model: "B2B" | "B2C" | "B2B2C";
  country: string;
  /** The right tier for the stated seller. */
  tier: WTier;
  /** Its mail server accepts every address, so no verifier can confirm anyone there. */
  catch_all: boolean;
  email_pattern: string;
  /** The seller's own lists: a competitor to exclude, or a customer to skip. */
  list_status: "excluded" | "existing_customer" | null;
}

export interface WorldPerson {
  id: string;
  /** Where they really work now. Null for students, press and the self-employed. */
  company_id: string | null;
  /** The company they registered under, when that is not where they work now. */
  listed_company_id: string | null;
  first: string;
  last: string;
  full_name: string;
  title: string;
  title_tier: WTier | null;
  /** False when the registered company is an old employer. */
  there: boolean;
  /** False for staff the vendors can find but who never registered. */
  attending: boolean;
  /** Their real, working address. */
  email: string;
  linkedin: string;
  kind: "employee" | "student" | "press" | "self_employed";
}

export interface WorldRow {
  /** 1-based data row in attendees-large.csv, below the header. */
  row: number;
  person_id: string | null;
  /** The company this row really belongs to, whatever the row says. */
  company_id: string | null;
  mess: string[];
}

export interface MessStat {
  tag: string;
  /** What the stated rate applies to. */
  of: "rows" | "person_rows" | "fixed";
  stated_rate: number | null;
  target: number;
  actual: number;
  note: string;
}

export interface HardCase { id: string; kind: string; description: string; rows: number[] }

export interface World {
  meta: {
    seed: number;
    event: { name: string; venue: string; starts_on: string };
    seller: { name: string; sells: string; icp: string; tier_rule: string };
    rows: number;
    person_rows: number;
    company_only_rows: number;
    companies: number;
    people: number;
    mess: MessStat[];
    /** Role mailboxes that really exist, such as the address one assistant registered a team on. */
    shared_mailboxes: string[];
    placeholder_domains: string[];
    webmail_domains: string[];
    /** Domains with real, working mailboxes that belong to no company in the world. */
    extra_domains: string[];
    delegation_sizes: { top: number[]; rows_per_company_median: number; companies_with_one_or_two_people: number };
  };
  companies: WorldCompany[];
  people: WorldPerson[];
  rows: WorldRow[];
  /** Lowercase title as written in the file, to its right tier. */
  titles: Record<string, WTier>;
  /** Company-field values that are filler or noise. A vendor finds nothing for them. */
  junk_company_keys: string[];
  hard_cases: HardCase[];
}
