/* Concierge's MCP server: read-only tools over delivered lists. Every query runs
   as a role that can read only the concierge_* views, so even a wrong query here
   cannot reach money. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../server/db.ts";

async function read(db: Db, sql: string, params: unknown[] = []) {
  return db.tx(async (q) => { await q("SET LOCAL ROLE concierge_reader"); return q(sql, params); });
}
const reply = (rows: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(rows) }] });
const eventId = z.string().describe("The event's id");

export function createConcierge(db: Db) {
  const s = new McpServer({ name: "concierge", version: "0.1.0" });
  s.registerTool("list_events", { description: "List the events with a delivered list." }, async () =>
    reply(await read(db, "SELECT * FROM concierge_events ORDER BY starts_on")));
  s.registerTool("priority_counts", { description: "How many contacts are priority A and B on an event's list.", inputSchema: { event_id: eventId } }, async ({ event_id }) =>
    reply(await read(db, "SELECT priority, contacts FROM concierge_priority_counts WHERE event_id = $1 ORDER BY priority", [event_id])));
  s.registerTool("company_counts", { description: "Companies on an event's list, with tier and contact count, most contacts first.", inputSchema: { event_id: eventId, limit: z.number().int().min(1).max(100).optional() } }, async ({ event_id, limit }) =>
    reply(await read(db, "SELECT company, tier, contacts FROM concierge_company_counts WHERE event_id = $1 ORDER BY contacts DESC, company LIMIT $2", [event_id, limit ?? 25])));
  s.registerTool("drop_counts", { description: "How many people or companies were dropped from an event's list, by reason.", inputSchema: { event_id: eventId } }, async ({ event_id }) =>
    reply(await read(db, "SELECT reason, dropped FROM concierge_drop_counts WHERE event_id = $1 ORDER BY dropped DESC", [event_id])));
  s.registerTool("find_prospects", { description: "Look up contacts on an event's list, optionally by company or priority.", inputSchema: { event_id: eventId, company: z.string().optional(), priority: z.enum(["A", "B"]).optional(), limit: z.number().int().min(1).max(50).optional() } }, async ({ event_id, company, priority, limit }) =>
    reply(await read(db, "SELECT full_name, title, company, priority, email, source FROM concierge_prospects WHERE event_id = $1 AND ($2::text IS NULL OR company ILIKE '%' || $2 || '%') AND ($3::text IS NULL OR priority = $3) ORDER BY priority, company LIMIT $4", [event_id, company ?? null, priority ?? null, limit ?? 25])));
  return s;
}
