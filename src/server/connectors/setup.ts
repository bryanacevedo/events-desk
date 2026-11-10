/* Which connectors a running desk has. The demo gets the real connector code over a stand-in tool, labeled simulated. Real ones need their keys and LIVE_SEND=1. */

import type { Db } from "../db.ts";
import { FAKES, type FakeTool } from "./fake.ts";
import { apollo, heyreach, instantly, smartlead } from "./tools.ts";
import type { Connector } from "./types.ts";

/** The demo's reps, who own its inboxes and LinkedIn accounts. */
const REPS = ["Maya Ortiz", "Priya Nair", "Tomas Berg", "Camille Laurent", "Jonas Weber", "Leo Marsh"];
export const SIM_SENDERS = (n: number, domains: string[]) => Array.from({ length: n }, (_, i) => ({ email: `${REPS[i % REPS.length].split(" ")[0].toLowerCase()}${i >= REPS.length ? Math.floor(i / REPS.length) + 1 : ""}@${domains[i % domains.length]}`, first_name: REPS[i % REPS.length].split(" ")[0], last_name: REPS[i % REPS.length].split(" ")[1], status: 1, daily_limit: 40, stat_warmup_score: 99 - (i % 9), timestamp_warmup_start: "2026-08-01T00:00:00Z" }));

const INSTANTLY_STATE: Record<string, string> = { draft: "0", active: "1", paused: "2", archived: "3" };
const HEYREACH_STATE: Record<string, string> = { draft: "DRAFT", active: "IN_PROGRESS", paused: "PAUSED", archived: "FINISHED" };

/** The demo's two stand-in tools. A restart rebuilds what they hold from the database, so a sequence never vanishes from under an event. */
export async function demoConnectors(db: Db): Promise<{ connectors: Record<string, Connector>; tools: Record<string, FakeTool> }> {
  const email = FAKES.instantly(), li = FAKES.heyreach();
  email.senders = SIM_SENDERS(24, ["orrery-mail.example", "orrery-send.example", "tryorrery.example", "getorrery.example", "orreryhq.example", "meetorrery.example"]);
  li.senders = REPS.map((r, i) => ({ id: i + 1, firstName: r.split(" ")[0], lastName: r.split(" ")[1], profileUrl: `https://www.linkedin.com/in/${r.toLowerCase().replace(/ /g, "-")}-orrery`, isActive: true, authIsValid: true }));
  email.connector.simulated = true; li.connector.simulated = true;
  const rows = await db.query<{ connector: string; external_id: string; state: string; name: string; id: string }>("SELECT connector, external_id, state, name, id FROM sequences WHERE external_id IS NOT NULL");
  for (const s of rows) {
    const tool = s.connector === "instantly" ? email : s.connector === "heyreach" ? li : null;
    if (!tool) continue;
    tool.newSeq(s.external_id);
    const seq = tool.seqs.get(s.external_id)!;
    seq.name = s.name; seq.status = (s.connector === "instantly" ? INSTANTLY_STATE : HEYREACH_STATE)[s.state];
    for (const p of await db.query<{ external_contact_id: string; email: string | null; state: string }>("SELECT n.external_contact_id, k.email, n.state FROM enrollments n JOIN contacts k ON k.id = n.contact_id WHERE n.sequence_id = $1 AND n.external_contact_id IS NOT NULL AND n.state <> 'removed'", [s.id]))
      seq.people.set(s.connector === "instantly" ? p.email!.toLowerCase() : p.external_contact_id, { id: p.external_contact_id, email: p.email ?? undefined, paused: p.state === "paused" });
  }
  return { connectors: { instantly: email.connector, heyreach: li.connector }, tools: { instantly: email, heyreach: li } };
}

/** Real tools, only when asked for. Gong is left out on purpose: it cannot report replies or opt-outs, so stopping someone the moment they answer cannot work there. */
export function liveConnectors(env: Record<string, string | undefined>): Record<string, Connector> {
  if (env.LIVE_SEND !== "1") return {};
  // Real sending reaches real people. The desk has no login yet, so anyone with the write key could act as anyone: it does not start until one exists.
  if (env.DESK_LOGIN !== "1") throw new Error("LIVE_SEND=1 needs a real login, which is not built yet (anyone with the write key could act as anyone). Refusing to start.");
  if (env.LIVE_SPEND !== "1") throw new Error("LIVE_SEND=1 needs LIVE_SPEND=1, so replies are read by the real model and the timer runs. Refusing to start.");
  if (!env.WEBHOOK_BASE) throw new Error("LIVE_SEND=1 needs WEBHOOK_BASE, so bounces and unsubscribes reach the desk. Refusing to start.");
  if (!env.WRITE_KEY) throw new Error("LIVE_SEND=1 reaches real people, so it needs WRITE_KEY at the least. Refusing to start.");
  const secret = env.SEQUENCER_WEBHOOK_SECRET;
  if (!secret) throw new Error("LIVE_SEND=1 needs SEQUENCER_WEBHOOK_SECRET. Refusing to start.");
  const out: Record<string, Connector> = {};
  if (env.INSTANTLY_API_KEY) out.instantly = instantly({ apiKey: env.INSTANTLY_API_KEY, webhookSecret: secret });
  if (env.HEYREACH_API_KEY) out.heyreach = heyreach({ apiKey: env.HEYREACH_API_KEY, webhookSecret: secret });
  if (env.SMARTLEAD_API_KEY) out.smartlead = smartlead({ apiKey: env.SMARTLEAD_API_KEY, webhookSecret: secret });
  if (env.APOLLO_API_KEY && env.APOLLO_SEQUENCES === "1") out.apollo = apollo({ apiKey: env.APOLLO_API_KEY, webhookSecret: secret });
  return out;
}
