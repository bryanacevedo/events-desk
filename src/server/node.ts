/* Local and self-hosted entry point.

     node src/server/node.ts --demo     sample events in PGlite, freshly reset, every vendor mocked (what `make demo` runs)
     node src/server/node.ts            serve against DATABASE_URL, or PGlite in .data/ if it is unset
     node src/server/node.ts --migrate  apply migrations to DATABASE_URL, then exit

   Safety lives in modes.ts: `--demo` ignores DATABASE_URL and every vendor and model key. */

import { execFileSync } from "node:child_process";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { canWrite, drainQuietly } from "./crm-outbox.ts";
import { migrate, pglite, postgresJs, type Db } from "./db.ts";
import { parseUserMap, resolveMode } from "./modes.ts";
import { anthropicLlm, DEFAULT_MODEL } from "./anthropic.ts";
import { liveVendors } from "./live-vendors.ts";
import { processEvent, type Deps } from "./pipeline.ts";
import { retryMerges } from "./top-up.ts";
import { mockLlm, mockVendors, noCrm } from "./providers.ts";
import { sheetsFor } from "./sheets.ts";
import { exampleDns, systemDns } from "./identity.ts";
import { seed } from "./seed.ts";
import { simDeps } from "./sim-vendors.ts";
import { demoConnectors, liveConnectors } from "./connectors/setup.ts";
import { lifecycleTick } from "./lifecycle-tick.ts";
import { withDemoCrm } from "./demo-run.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { slackNotifier } from "./slack.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const migrateOnly = process.argv.includes("--migrate");

let mode;
try { mode = resolveMode(process.argv, process.env); }
catch (e) { console.error((e as Error).message); process.exit(1); }
const url = mode.databaseUrl;

if (migrateOnly && !url) { console.error("--migrate needs DATABASE_URL."); process.exit(1); }
// The demo gets its own folder, so `make demo` never wipes a local non-demo database.
const dataDir = join(root, ".data", mode.demo ? "demo" : "local");
if (mode.demo) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
// Building the sample data takes about 1 GB, more than a small host has. The hosted demo opens a copy built ahead of time (make demo-snapshot).
const snapshot = join(root, "samples", "demo-snapshot.tgz");
const fromSnapshot = mode.demo && process.env.PUBLIC_DEMO === "1" && existsSync(snapshot);
if (fromSnapshot) execFileSync("tar", ["xzf", snapshot, "-C", join(root, ".data")]);
const db: Db = url ? await postgresJs(url) : await pglite(dataDir);

const migrations = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql"))
  .map((name) => ({ name, sql: readFileSync(join(root, "migrations", name), "utf8") }));
await migrate(db, migrations);
if (migrateOnly) { console.log("Migrations applied."); await db.close(); process.exit(0); }

const empty = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events"))[0]?.n === 0;
const mayLoadSample = !url || process.env.SEED_SAMPLE === "1";
if ((mode.demo && !fromSnapshot) || (empty && mayLoadSample && !fromSnapshot)) {
  const t0 = Date.now();
  await seed(db, mode.demo ? { real: true } : {});
  console.log(`Loaded the sample events in ${Date.now() - t0} ms.${mode.demo ? " Includes the flagship with about 1,650 rows." : ""}`);
}

const env = process.env as Record<string, string>;
const deps: Deps = mode.liveSpend
  ? { live: true, crm: noCrm, llm: anthropicLlm(), vendorsFor: (s) => liveVendors(s, { apollo: env.APOLLO_API_KEY, zerobounce: env.ZEROBOUNCE_API_KEY }) }
  : mode.demo ? simDeps() : { llm: mockLlm, vendorsFor: mockVendors };
// Google only in live mode. Bad Google settings stop the start here, not at the first delivery.
try { deps.sheets = sheetsFor(mode.liveSpend, env); } catch (e) { console.error((e as Error).message); process.exit(1); }
const slack = mode.liveSpend
  ? { signingSecret: env.SLACK_SIGNING_SECRET, botToken: env.SLACK_BOT_TOKEN, channel: env.SLACK_APPROVALS_CHANNEL, approvers: env.APPROVER_SLACK_IDS.split(",").map((s) => s.trim()), userMap: parseUserMap(env.SLACK_USER_MAP), llm: deps.llm }
  : undefined;
// A real database with spend off must never run mock vendors: that would write fake emails into real events.
const mayRun = mode.liveSpend || !url;
const kick = mayRun ? (id: string) => { processEvent(db, id, deps).catch((e) => console.error("pipeline", id, e)); } : undefined;
if (kick) {
  // One process runs the jobs, so anything still marked running died with the last process.
  await db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE status = 'running'");
  for (const e of await db.query<{ id: string }>("SELECT id FROM events WHERE stage IN ('tiering', 'enriching', 'flagging', 'researching', 'ready_for_review', 'finding_people') AND ended_at IS NULL AND merged_at IS NULL")) kick(e.id);
  // New registrations left at delivered and unmerged, or merged with a Sheet that never took them.
  await retryMerges(db, deps.crm, deps.sheets);
}
// Everything after delivery. The demo runs the real connector code over stand-in tools. Real tools need LIVE_SEND=1 and their keys.
let live: Awaited<ReturnType<typeof liveConnectors>> = {};
try { live = liveConnectors(env); } catch (e) { console.error((e as Error).message); process.exit(1); }
const demoSetup = mode.demo ? await demoConnectors(db) : undefined;
const lifecycle: LifecycleDeps | undefined = demoSetup
  ? { crm: withDemoCrm(deps.crm, db, () => new Date()), connectors: demoSetup.connectors, llm: deps.llm }
  : Object.keys(live).length ? { crm: deps.crm, connectors: live, llm: deps.llm, notify: slack ? slackNotifier(slack) : undefined, userMap: slack?.userMap } : undefined;
const api = createApp(db, { lifecycle, demoTools: demoSetup?.tools, writeKey: mode.demo ? undefined : process.env.WRITE_KEY, demo: mode.demo, publicDemo: mode.demo && process.env.PUBLIC_DEMO === "1", kick, slack, sheets: deps.sheets, llm: deps.llm, dns: mode.liveSpend ? systemDns : exampleDns, crm: deps.crm });
// Write-back to the CRM runs here and never from a run, so a failed write cannot touch a delivery. A CRM that cannot write (noCrm) makes this do nothing.
if (mayRun && canWrite(deps.crm)) {
  const sweep = () => { void drainQuietly(db, deps.crm); };
  sweep();
  setInterval(sweep, 5 * 60_000).unref();
}
// One pass every 5 minutes, the opt-out and CRM sweep every 15, and the checks that alert once a night.
// The demo has no clock of its own: a visitor moves it forward, one press at a time.
if (mayRun && lifecycle && !mode.demo) {
  let n = 0;
  const tick = () => { n++; void lifecycleTick(db, lifecycle, { flags: n % 3 === 0, nightly: n % 288 === 0 }).catch((e) => console.error("lifecycle", e)); };
  setInterval(tick, 5 * 60_000).unref();
}
if (existsSync(join(root, "dist"))) {
  api.use("/*", serveStatic({ root: "./dist" }));
  api.get("*", serveStatic({ path: "./dist/index.html" }));
}

// There is no login, so the app listens on this machine only unless HOST says otherwise.
serve({ fetch: api.fetch, port, hostname: process.env.HOST?.trim() || "127.0.0.1" }, () => {
  console.log(`Events Desk on http://localhost:${port}  (database: ${url ? "DATABASE_URL" : "PGlite in .data/"}, spend: ${mode.liveSpend ? "LIVE" : "mocked"})`);
});

const stop = async () => { await db.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
