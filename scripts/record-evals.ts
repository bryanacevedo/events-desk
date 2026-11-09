/* make evals-live: calls the real model on the labeled list and re-records.
   Spends real money, so it needs ANTHROPIC_API_KEY and LIVE_SPEND=1. */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { modelCostUsd } from "../src/shared/model-pricing.ts";
import { connectConcierge } from "../src/concierge/agent.ts";
import { anthropicLlm } from "../src/server/anthropic.ts";
import { migrate, pglite } from "../src/server/db.ts";
import { fill, promptHash, type Step } from "../src/server/prompts.ts";
import { VendorError } from "../src/server/providers.ts";
import { planEvalRun } from "../src/evals/limits.ts";
import { loadTitleDev, loadTitleHoldout, titlePrompt } from "../src/evals/title-tier.ts";
import { decidedByRule, demoIcp, inputsHash, loadDev, loadHoldout, promptFor, secondLookItems } from "../src/evals/company-tier.ts";

if (process.env.LIVE_SPEND !== "1" || !process.env.ANTHROPIC_API_KEY) {
  console.error("make evals-live needs ANTHROPIC_API_KEY and LIVE_SPEND=1. It calls the real model and costs money.");
  process.exit(1);
}

const list = JSON.parse(readFileSync("evals/list.json", "utf8"));
const settings = JSON.parse(readFileSync("config/defaults.json", "utf8"));
const db = await pglite();
await migrate(db, readdirSync("migrations").filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") })));
const client = await connectConcierge(db);
const tools = (await client.listTools()).tools.filter((t) => t.name !== "list_events").map((t) => `${t.name}: ${t.description}`).join("\n");
await client.close();
await db.close();

type Item = { id: string; prompt: string };
// Company tier is scored on the development set and the frozen holdout (src/evals/company-tier.ts). The hard rules decide some items in code, so the
// model is asked only about the rest. The second look runs on the items production would look at twice: the model's tier 1s and its tiers more than
// one level from the baseline, so it needs the first pass.
const icp = demoIcp();
const tierSets = [...loadDev(), ...loadHoldout()];
const toAsk = tierSets.filter((it) => !decidedByRule(icp, it));
const recorded = (step: string): Record<string, string> => (existsSync(`evals/recordings/${step}.json`) ? JSON.parse(readFileSync(`evals/recordings/${step}.json`, "utf8")).outputs : {});
const results: Record<string, Record<string, string>> = {};
const steps: [Step, Item[] | (() => Item[])][] = [
  ["company_tier", toAsk.map((it) => ({ id: it.id, prompt: promptFor(icp, it, "company_tier") }))],
  ["second_look", () => secondLookItems(icp, tierSets, results.company_tier ?? recorded("company_tier")).map((it) => ({ id: it.id, prompt: promptFor(icp, it, "second_look") }))],
  // Title parsing is scored on the title sets (src/evals/title-tier.ts). The model is asked about every title, so the report can show the model alone beside the rules; production asks it only about the few the rules cannot place.
  ["title_parse", [...loadTitleDev(), ...loadTitleHoldout()].map((it) => ({ id: it.id, prompt: titlePrompt(it) }))],
  ["title_tier", list.titles.map((t: { id: string; title: string }) => ({ id: t.id, prompt: fill("title_tier", { targets: settings.target_titles.join(", "), input: `Title: ${t.title}` }) }))],
  ["review", list.contacts.map((c: { id: string; name: string; title: string; company: string; email: string }) => ({ id: c.id, prompt: fill("review", { input: `Name: ${c.name}\nTitle: ${c.title}\nCompany: ${c.company}\nEmail: ${c.email}` }) }))],
  ["concierge", list.questions.map((q: { id: string; question: string }) => ({ id: q.id, prompt: fill("concierge", { tools, input: `Event: evt_eval\nQuestion: ${q.question}` }) }))],
];

const only = process.argv[2];
// The second look's size is known only after the first pass, so the plan counts its upper bound: every item the model is asked about.
const plan = planEvalRun(Object.fromEntries(steps.filter(([step]) => !only || step === only).map(([step, items]) => [step, typeof items === "function" ? toAsk.length : items.length])));
console.log(`${plan.total} items in this list; limit ${plan.limit}${plan.explicit ? "" : " (default, set EVALS_MAX_ITEMS to change)"}; making ${plan.run} real calls.`);
if (!plan.full) console.log("Partial run: results go to evals/recordings/partial/ and the CI recordings are left alone. A full re-record needs EVALS_MAX_ITEMS=" + plan.total + ".");
const llm = anthropicLlm();
async function withBackoff(step: Step, prompt: string) {
  for (let i = 1; ; i++) {
    try { const r = await llm.complete(step, prompt); if (r.model) served.add(r.model); spent.calls++; spent.input += r.input_tokens; spent.output += r.output_tokens; return r.text; }
    catch (e) { if (!(e instanceof VendorError) || i >= 6) throw e; await new Promise((r) => setTimeout(r, 5000 * i)); }
  }
}
// The API can fall back to another model; the recording says which models actually answered.
const served = new Set<string>();
// Every real run says what it cost, per step and in total, and leaves a line in evals/cost-log.jsonl.
const spent = { calls: 0, input: 0, output: 0 };
let runUsd = 0;
function logCost(step: string) {
  const usd = modelCostUsd(llm.model, spent.input, spent.output);
  runUsd += usd ?? 0;
  console.log(`${step}: ${spent.calls} calls, ${spent.input} input and ${spent.output} output tokens, ${usd === null ? "no price listed for this model" : `$${usd.toFixed(2)}`}`);
  appendFileSync("evals/cost-log.jsonl", `${JSON.stringify({ at: new Date().toISOString(), step, model: llm.model, ...spent, usd })}\n`);
  spent.calls = 0; spent.input = 0; spent.output = 0;
}
const dir = plan.full ? "evals/recordings" : "evals/recordings/partial";
mkdirSync(dir, { recursive: true });
for (const [step, source] of steps) {
  if (only && step !== only) continue;
  const all = typeof source === "function" ? source() : source;
  const items = all.slice(0, plan.take[step]);
  if (!items.length) continue;
  const outputs: Record<string, string> = {};
  const queue = [...items];
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) outputs[item.id] = await withBackoff(step, item.prompt);
  }));
  results[step] = outputs;
  // inputs_hash covers the filled prompts, so a changed ICP, fact format or eval set makes the recording stale even when the template is the same.
  writeFileSync(`${dir}/${step}.json`, `${JSON.stringify({ step, prompt_hash: promptHash(step, llm.model), inputs_hash: inputsHash(Object.fromEntries(items.map((i) => [i.id, i.prompt]))), model: llm.model, served_models: [...served].sort(), recorded_at: new Date().toISOString(), outputs }, null, 1)}\n`);
  console.log(step, items.length, "recorded");
  logCost(step);
}
console.log(`Run total: $${runUsd.toFixed(2)}`);
