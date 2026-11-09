/* Writes the company-tier eval sets: evals/company-tier.dev.json and evals/company-tier.holdout.json (src/evals/company-tier.ts says what they are).

   The development set is the 100 generated fictional companies of evals/list.json plus 20 hand-written edge cases. The holdout is 30 hand-written
   fictional hard cases plus 38 real public companies. Every label is the tier the demo ICP (samples/orrery-icp.md) gives for the facts shown,
   assigned by hand; tests/company-tier-evals.test.ts cross-checks each label against the ICP's rules in code.

   The real companies' facts (employees, industry, who they sell to) are the AUTHOR'S OWN KNOWLEDGE, remembered, approximate, not checked against a
   filing, and may be out of date. They are marked `real_public_author_knowledge`. Do not re-run this script casually: the holdout is frozen, and the
   test pins its hash. To change it on purpose, change the pinned hash in the same commit. */

import { readFileSync, writeFileSync } from "node:fs";
import type { Tier } from "../src/shared/icp.ts";

type F = { employees?: number; industry?: string; business_model?: "B2B" | "B2C" | "B2B2C"; description?: string; country?: string };
type Item = { id: string; name: string; set: "dev" | "holdout"; source: "fictional" | "real_public_author_knowledge"; firmo: F; tier: Tier; why: string; incomplete?: boolean };

const list = JSON.parse(readFileSync("evals/list.json", "utf8")) as { companies: { id: string; name: string; context: string[]; tier: Tier }[] };
const WHY: Record<number, string> = { 1: "Sells to businesses, strong vertical, 200 to 5,000 employees.", 2: "Sells to businesses, and either in the size range or in a strong vertical, but not both.", 3: "Outside the ICP: consumer-only, an agency or consultancy, or a business-to-business company that is neither in range nor in a strong vertical." };

const dev: Item[] = list.companies.map((c) => {
  const get = (k: string) => c.context.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? "";
  return { id: `dev_${c.id}`, name: c.name, set: "dev", source: "fictional", firmo: { employees: Number(get("Employees")), industry: get("Industry"), business_model: get("Sells to") === "Consumers" ? "B2C" : "B2B" }, tier: c.tier, why: WHY[c.tier] };
});

const mk = (set: "dev" | "holdout", source: Item["source"], prefix: string): ((n: number, name: string, firmo: F, tier: Tier, why?: string, incomplete?: boolean) => Item) =>
  (n, name, firmo, tier, why, incomplete) => ({ id: `${set === "dev" ? "dev" : "hold"}_${prefix}${String(n).padStart(2, "0")}`, name, set, source, firmo, tier, why: why ?? WHY[tier], ...(incomplete ? { incomplete: true } : {}) });

const dx = mk("dev", "fictional", "x");
dev.push(
  dx(1, "Eskdale Payments", { employees: 199, industry: "Payments", business_model: "B2B" }, 2, "One employee under the range, in a strong vertical."),
  dx(2, "Fairlie Payments", { employees: 200, industry: "Payments", business_model: "B2B" }, 1, "The range starts at 200."),
  dx(3, "Gorsedd Data", { employees: 5000, industry: "Data platforms", business_model: "B2B" }, 1, "The range ends at 5,000 and includes it."),
  dx(4, "Haverill Cloud", { employees: 5001, industry: "B2B software", business_model: "B2B" }, 2, "One employee over the range, in a strong vertical."),
  dx(5, "Ingleby Pixel Agency", { employees: 400, industry: "Digital marketing agency", business_model: "B2B" }, 3, "An agency; its revenue is billable hours."),
  dx(6, "Jessamy Advisory", { employees: 300, industry: "Supply chain consulting", business_model: "B2B" }, 3, "A consultancy, whatever its subject."),
  dx(7, "Kestrel Rides", { employees: 900, industry: "Ride hailing app", business_model: "B2C" }, 3, "Sells only to consumers."),
  dx(8, "Lowther Machine Works", { employees: 800, industry: "Machined components", business_model: "B2B" }, 2, "In range, not a strong vertical."),
  dx(9, "Marram Health Group", { employees: 2200, industry: "Clinic networks", business_model: "B2B2C" }, 2, "Sells to businesses and consumers, in range, not a strong vertical."),
  dx(10, "Nethercott Freight Software", { employees: 1800, industry: "Freight software", business_model: "B2B2C" }, 1, "Sells to businesses too, strong vertical, in range."),
  dx(11, "Oakhurst", { employees: 700, business_model: "B2B", description: "Develops payment processing software for merchants." }, 1, "The description puts it in payments, in range."),
  dx(12, "Pennard", { employees: 700, industry: "Footwear", description: "Sells running shoes to consumers through its own shops." }, 3, "The business model is missing, and the description says consumers only."),
  dx(13, "Quillan Group", { industry: "B2B software", business_model: "B2B" }, 1, "Headcount missing: a reader cannot place it. Full facts (about 600 employees) would make it tier 1.", true),
  dx(14, "Rushmere", { country: "Spain" }, 2, "Nothing but a country: Unknown for a reader. Full facts would make it tier 2.", true),
  dx(15, "Saltmarsh Insurance", { employees: 150, industry: "Insurance brokerage", business_model: "B2B" }, 3, "Out of range and not a strong vertical."),
  dx(16, "Thornley Treasury", { employees: 30000, industry: "Treasury software", business_model: "B2B" }, 2, "Strong vertical, far over the range."),
  dx(17, "Ullswater Wholesale", { employees: 90, industry: "Wholesale distribution", business_model: "B2B" }, 3, "Out of range and not a strong vertical."),
  dx(18, "Vellacott Fleet", { employees: 60, industry: "Fleet telematics", business_model: "B2B" }, 2, "Strong vertical, under the range."),
  dx(19, "Wetherby Consulting", { employees: 1200, industry: "Management consulting", business_model: "B2B" }, 3, "A consultancy."),
  dx(20, "Yewdale Games", { employees: 300, industry: "Games", business_model: "B2C" }, 3, "Sells only to consumers."),
);

const hf = mk("holdout", "fictional", "f");
const hr = mk("holdout", "real_public_author_knowledge", "r");
const holdout: Item[] = [
  hf(1, "Pellam Freight Systems", { employees: 3100, industry: "Freight software", business_model: "B2B" }, 1),
  hf(2, "Orville Settlements", { employees: 205, industry: "Invoicing and settlement", business_model: "B2B" }, 1),
  hf(3, "Tarn Ledger", { employees: 5000, industry: "Payments", business_model: "B2B" }, 1, "The range ends at 5,000 and includes it."),
  hf(4, "Wick Data Platforms", { employees: 5001, industry: "Data platforms", business_model: "B2B" }, 2, "One employee over the range, in a strong vertical."),
  hf(5, "Ravenel Logistics Technology", { employees: 199, industry: "Warehouse automation", business_model: "B2B" }, 2, "One employee under the range, in a strong vertical."),
  hf(6, "Hobart Fabrication", { employees: 1200, industry: "Industrial manufacturing", business_model: "B2B" }, 2),
  hf(7, "Calder Wholesale", { employees: 640, industry: "Wholesale distribution", business_model: "B2B" }, 2),
  hf(8, "Mirren Insurance Brokers", { employees: 90, industry: "Insurance brokerage", business_model: "B2B" }, 3),
  hf(9, "Sorrel Metals", { employees: 60, industry: "Machined components", business_model: "B2B" }, 3),
  hf(10, "Dunlin Cloud Kitchens", { employees: 2000, industry: "Restaurants", business_model: "B2C" }, 3, "The name says cloud; it sells meals to consumers."),
  hf(11, "Brightline Freight Consulting", { employees: 450, industry: "Supply chain consulting", business_model: "B2B" }, 3, "The name says freight; it is a consultancy."),
  hf(12, "Quarrel Software Studio", { employees: 120, industry: "Software development agency", business_model: "B2B", description: "Builds apps for other companies and bills by the hour." }, 3, "The name says software; it is an agency."),
  hf(13, "Halden Payments Advisory", { employees: 800, industry: "Payments consulting", business_model: "B2B" }, 3, "The name says payments; it is a consultancy."),
  hf(14, "Fenmoor Telematics", { employees: 80, industry: "Fleet telematics", business_model: "B2B" }, 2),
  hf(15, "Larch Treasury Software", { employees: 28000, industry: "Treasury software", business_model: "B2B" }, 2),
  hf(16, "Corvane Health Network", { employees: 1500, industry: "Clinic networks", business_model: "B2B2C" }, 2),
  hf(17, "Ivybridge Apps", { employees: 400, industry: "Consumer mobile apps", business_model: "B2C" }, 3),
  hf(18, "Selkirk Brewing", { employees: 900, industry: "Brewing and beverages", business_model: "B2C" }, 3),
  hf(19, "Norwood Merchant Acquiring", { employees: 1800, industry: "Merchant acquiring", business_model: "B2B2C" }, 1),
  hf(20, "Aldous Workflow", { employees: 450, industry: "Workflow software", business_model: "B2B2C" }, 1),
  hf(21, "Tessel Works", { business_model: "B2B", description: "Builds route optimisation software for delivery fleets." }, 1, "Headcount missing: a reader cannot place it. Full facts (about 700 employees) would make it tier 1.", true),
  hf(22, "Umber Group", { employees: 500, industry: "Business services", business_model: "B2B" }, 2, "In range, not a strong vertical, and not an agency or consultancy by what is shown."),
  hf(23, "Vesper and Lane", { employees: 350 }, 3, "Only a headcount: Unknown for a reader. Full facts (an agency) would make it tier 3.", true),
  hf(24, "Wren Holdings", { country: "Ireland" }, 2, "Only a country: Unknown for a reader. Full facts would make it tier 2.", true),
  hf(25, "Yarrow Systems", { employees: 2400, business_model: "B2B" }, 1, "No industry or description: Unknown for a reader. Full facts (a software company) would make it tier 1.", true),
  hf(26, "Zinnia Retail Cloud", { employees: 900, description: "Sells home goods to shoppers online." }, 3, "The business model is missing, and the description says shoppers."),
  hf(27, "Ashgrove Partners", { employees: 40, industry: "Management consulting", business_model: "B2B" }, 3),
  hf(28, "Brackenridge Payments", { employees: 12, industry: "Payments", business_model: "B2B" }, 2, "Strong vertical, far under the range."),
  hf(29, "Copperfield Logistics Technology", { employees: 4999, industry: "Logistics technology", business_model: "B2B" }, 1),
  hf(30, "Dovecote Media Buying", { employees: 700, industry: "Media buying", business_model: "B2B" }, 3, "An agency."),
  // Real public companies. Facts from the author's own knowledge: approximate, unverified, possibly dated.
  hr(1, "Gong", { employees: 1300, industry: "Revenue intelligence software", business_model: "B2B", description: "Sells software that records and analyses sales calls for revenue teams." }, 1),
  hr(2, "Clari", { employees: 600, industry: "Revenue platform software", business_model: "B2B", description: "Sells forecasting and pipeline software to sales organisations." }, 1),
  hr(3, "Gainsight", { employees: 800, industry: "Customer success software", business_model: "B2B", description: "Sells customer success software to companies." }, 1),
  hr(4, "Outreach", { employees: 900, industry: "Sales engagement software", business_model: "B2B", description: "Sells sales engagement software to sales teams." }, 1),
  hr(5, "project44", { employees: 1000, industry: "Supply chain visibility software", business_model: "B2B", description: "Sells shipment tracking and logistics visibility software to shippers and carriers." }, 1),
  hr(6, "Descartes Systems Group", { employees: 2100, industry: "Logistics software", business_model: "B2B", description: "Sells logistics and supply chain software." }, 1),
  hr(7, "Manhattan Associates", { employees: 4500, industry: "Supply chain software", business_model: "B2B", description: "Sells warehouse and supply chain software." }, 1),
  hr(8, "Samsara", { employees: 3500, industry: "Fleet telematics software", business_model: "B2B", description: "Sells fleet tracking and operations software." }, 1),
  hr(9, "BILL Holdings", { employees: 2200, industry: "Payments software", business_model: "B2B", description: "Sells accounts payable and payments software to businesses." }, 1),
  hr(10, "Paymentus", { employees: 1200, industry: "Payments software", business_model: "B2B", description: "Sells bill payment software to billers and utilities." }, 1),
  hr(11, "Marqeta", { employees: 800, industry: "Card issuing payments platform", business_model: "B2B", description: "Sells card issuing technology to companies." }, 1),
  hr(12, "Cloudflare", { employees: 4200, industry: "Cloud security and network software", business_model: "B2B", description: "Sells internet security and network services to companies." }, 1),
  hr(13, "Pipedrive", { employees: 900, industry: "CRM software", business_model: "B2B", description: "Sells sales CRM software to small and medium businesses." }, 1),
  hr(14, "Zuora", { employees: 1200, industry: "Subscription billing software", business_model: "B2B", description: "Sells subscription billing software to companies." }, 1),
  hr(15, "Salesforce", { employees: 76000, industry: "Business software", business_model: "B2B", description: "Sells CRM and cloud software to companies." }, 2, "Strong vertical, far over the range."),
  hr(16, "SAP", { employees: 107000, industry: "Enterprise software", business_model: "B2B", description: "Sells enterprise software to large companies." }, 2, "Strong vertical, far over the range."),
  hr(17, "Datadog", { employees: 6500, industry: "Monitoring software", business_model: "B2B", description: "Sells observability software to engineering teams." }, 2, "Strong vertical, over the range."),
  hr(18, "Snowflake", { employees: 7000, industry: "Data platform software", business_model: "B2B", description: "Sells a cloud data platform to companies." }, 2, "Strong vertical, over the range."),
  hr(19, "Stripe", { employees: 8000, industry: "Payments", business_model: "B2B", description: "Sells payment processing to online businesses." }, 2, "Strong vertical, over the range."),
  hr(20, "PayPal", { employees: 24000, industry: "Payments", business_model: "B2B2C", description: "Runs a payments network for consumers and merchants." }, 2, "Strong vertical, far over the range; sells to businesses too."),
  hr(21, "Atlassian", { employees: 12000, industry: "Collaboration software", business_model: "B2B", description: "Sells team collaboration software to companies." }, 2, "Strong vertical, over the range."),
  hr(22, "Okta", { employees: 5900, industry: "Identity software", business_model: "B2B", description: "Sells identity and access software to companies." }, 2, "Strong vertical, over the range."),
  hr(23, "Graco", { employees: 4000, industry: "Industrial equipment manufacturing", business_model: "B2B", description: "Makes fluid handling equipment for industry." }, 2, "In range, not a strong vertical."),
  hr(24, "Badger Meter", { employees: 2000, industry: "Flow measurement manufacturing", business_model: "B2B", description: "Makes flow measurement products for utilities and industry." }, 2, "In range, not a strong vertical."),
  hr(25, "Lindsay Corporation", { employees: 1200, industry: "Irrigation equipment manufacturing", business_model: "B2B", description: "Makes irrigation equipment for farms." }, 2, "In range, not a strong vertical."),
  hr(26, "Gorman-Rupp", { employees: 1300, industry: "Pump manufacturing", business_model: "B2B", description: "Makes pumps for industrial and municipal customers." }, 2, "In range, not a strong vertical."),
  hr(27, "McKinsey and Company", { employees: 45000, industry: "Management consulting", business_model: "B2B", description: "Advises companies and governments on strategy and operations." }, 3, "A consultancy."),
  hr(28, "Boston Consulting Group", { employees: 33000, industry: "Management consulting", business_model: "B2B", description: "Advises companies on strategy." }, 3, "A consultancy."),
  hr(29, "WPP", { employees: 100000, industry: "Advertising agency group", business_model: "B2B", description: "Runs advertising and marketing agencies for brands." }, 3, "An agency group."),
  hr(30, "Omnicom Group", { employees: 75000, industry: "Advertising agency group", business_model: "B2B", description: "Runs advertising and marketing agencies for brands." }, 3, "An agency group."),
  hr(31, "Netflix", { employees: 13000, industry: "Video streaming", business_model: "B2C", description: "Sells a streaming subscription to consumers." }, 3, "Sells only to consumers."),
  hr(32, "Duolingo", { employees: 800, industry: "Language learning software", business_model: "B2C", description: "Sells a language learning app to consumers." }, 3, "Sells only to consumers, although it is software and in range."),
  hr(33, "Peloton", { employees: 2500, industry: "Fitness equipment and subscriptions", business_model: "B2C", description: "Sells exercise equipment and classes to consumers." }, 3, "Sells only to consumers, although in range."),
  hr(34, "Starbucks", { employees: 380000, industry: "Coffee retail", business_model: "B2C", description: "Runs coffee shops." }, 3, "Sells only to consumers."),
  hr(35, "Caterpillar", { employees: 113000, industry: "Heavy equipment manufacturing", business_model: "B2B", description: "Makes construction and mining machinery." }, 3, "Out of range and not a strong vertical."),
  hr(36, "Deere and Company", { employees: 75000, industry: "Agricultural machinery manufacturing", business_model: "B2B", description: "Makes farm and construction machinery." }, 3, "Out of range and not a strong vertical."),
  hr(37, "JPMorgan Chase", { employees: 310000, industry: "Banking", business_model: "B2B2C", description: "A bank serving consumers, companies and governments." }, 3, "Out of range and not a strong vertical."),
  hr(38, "Walmart", { employees: 2100000, industry: "Retail", business_model: "B2C", description: "Runs retail stores and an online shop." }, 3, "Sells only to consumers."),
];

const frame = (note: string, items: Item[]) => `${JSON.stringify({ note, items }, null, 1)}\n`;
writeFileSync("evals/company-tier.dev.json", frame("Development set. Tune prompts on this. Fictional companies and hand-written edge cases; labels follow samples/orrery-icp.md and the facts shown.", dev));
writeFileSync("evals/company-tier.holdout.json", frame("FROZEN HOLDOUT. Do not tune on it. 30 fictional hard cases and 38 real public companies labeled by hand against the demo ICP. The real companies' facts are the author's own knowledge: remembered, approximate, unverified, possibly dated. The test pins this file's hash.", holdout));
console.log(`dev ${dev.length}, holdout ${holdout.length} (${holdout.filter((h) => h.source !== "fictional").length} real)`);
