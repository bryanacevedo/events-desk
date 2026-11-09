/* make apollo-check COMPANY="Some Company" [MATCHES=1]
   Tests the real Apollo adapter on your own account. Spends MATCHES credits
   (default 1, at most 5). Prints counts and HTTP statuses only, never a person's
   name or email, so its output is safe to paste anywhere. */

import { readFileSync } from "node:fs";
import { liveVendors } from "../src/server/live-vendors.ts";
import { checkRealRun } from "../src/server/spend-guard.ts";
import { VendorError } from "../src/server/providers.ts";
import type { Settings } from "../src/shared/cost.ts";

const key = process.env.APOLLO_API_KEY;
if (!key) { console.error("Set APOLLO_API_KEY first."); process.exit(1); }
const company = process.argv[2];
if (!company) { console.error('Name a company: make apollo-check COMPANY="Some Company"'); process.exit(1); }
const matches = Math.min(Math.max(Number(process.argv[3] || 1), 0), 5);
try { checkRealRun(matches, process.env, "This check"); } catch (e) { console.error((e as Error).message); process.exit(1); }

const health = await fetch("https://api.apollo.io/api/v1/auth/health", { headers: { "x-api-key": key } });
console.log(`auth/health: HTTP ${health.status}`);

const statuses: string[] = [];
const logging = (async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  statuses.push(`${new URL(url).pathname.replace("/api/v1/", "")}: HTTP ${r.status}`);
  return r;
}) as typeof fetch;

const settings: Settings = JSON.parse(readFileSync("config/defaults.json", "utf8"));
const v = liveVendors(settings, { apollo: key, zerobounce: "" }, { fetch: logging });
const report = (e: unknown) => { if (!(e instanceof VendorError)) throw e; console.log(`refused or failed (charged: ${e.charged})`); };

let people: { full_name: string }[] = [];
try { people = (await v.discovery.find(company, 3)).people; console.log(`search: ${people.length} people at that company with target titles`); } catch (e) { report(e); }

let found = 0;
for (const p of people.slice(0, matches)) {
  try { if ((await v.finders[0].find({ full_name: p.full_name, company })).value) found++; } catch (e) { report(e); }
}
console.log(`match: ${found} of ${Math.min(people.length, matches)} returned an email at the right company`);
console.log(statuses.join("\n"));
