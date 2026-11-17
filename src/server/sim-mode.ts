/* Sim mode (decision 102): SIM_DB_GUARD=1 and SIM_MODE=1 both set, over the given simulation database.
   It builds what the demo builds after delivery, the simulated vendors, the simulated sequencer and LinkedIn tools and the simulated CRM,
   so the sequencer, My day, replies, meetings, the scanner and the dinner reminder exist on a database that is not the laptop's.
   Nothing here can spend or send: resolveMode refuses the mode beside LIVE_SPEND or LIVE_SEND, and every tool is a stand-in. */

import type { Db } from "./db.ts";
import type { Deps } from "./pipeline.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { simDeps } from "./sim-vendors.ts";
import { demoConnectors } from "./connectors/setup.ts";
import { withDemoCrm } from "./demo-run.ts";

export const SIM_BANNER = "SIM MODE IS ON: simulated vendors, simulated sequencer and CRM, nothing real is spent or sent. Database: DATABASE_URL (simulation guard on).";

type Setup = Awaited<ReturnType<typeof demoConnectors>>;

/** The lifecycle the demo and sim mode share: the real connector code over stand-in tools, and the simulated CRM wrapped for the demo's calendar. */
export const demoLifecycle = (db: Db, deps: Deps, setup: Setup, now: () => Date = () => new Date()): LifecycleDeps =>
  ({ crm: withDemoCrm(deps.crm, db, now), connectors: setup.connectors, llm: deps.llm, demoCalendar: true });

/** The simulated vendors and tools. The lifecycle is built from these once the CRM choice is made (see node.ts). */
export async function buildSim(db: Db) {
  return { deps: simDeps() as Deps, setup: await demoConnectors(db) };
}
