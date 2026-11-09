/* The thin agent over the MCP server. Each model call is reserved against the
   cost card's allowance. The event is fixed by the caller, never by the model. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getSettingsNow } from "../server/approvals.ts";
import type { Db } from "../server/db.ts";
import { logActivity, newId } from "../server/events.ts";
import { reserve, settle } from "../server/ledger.ts";
import { fill, promptHash } from "../server/prompts.ts";
import type { Llm } from "../server/providers.ts";
import { createConcierge } from "./server.ts";

export const USED_UP = "This event's question allowance is used up.";
export const NO_MONEY = "I can share counts and contacts, but not money.";
const NOT_READY = "That event has no delivered list yet.";
const STUCK = "I could not answer that. Try asking about counts, companies or contacts.";
const MONEY = /[$€£]\s?\d|\b\d[\d,.]*\s*(?:usd|dollars?|credits?)\b|\b(?:budget|spend|spent|cost)\b[^.]*\d/i;

export async function connectConcierge(db: Db) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createConcierge(db).connect(a);
  const client = new Client({ name: "events-desk", version: "0.1.0" });
  await client.connect(b);
  return client;
}

export async function askConcierge(db: Db, client: Client, llm: Llm, eventId: string, question: string): Promise<string> {
  const [event] = await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [eventId]);
  if (event?.stage !== "delivered") return NOT_READY;
  const s = await getSettingsNow(db, eventId);
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM activity_log WHERE event_id = $1 AND kind = 'concierge'", [eventId]);
  if (n >= s.agent_question_limit) return USED_UP;
  await logActivity(db.query, eventId, "Concierge", "concierge", "Answered a question");

  // list_events would reach beyond the one event this question is about.
  const tools = (await client.listTools()).tools.filter((t) => t.name !== "list_events");
  const toolList = tools.map((t) => `${t.name}: ${t.description}`).join("\n");
  let transcript = `Event: ${eventId}\nQuestion: ${question}`;
  for (let i = 0; i < s.calls_per_question; i++) {
    const res = await reserve(db, eventId, "llm", 1, "concierge");
    if (!res) return USED_UP;
    let text: string;
    try {
      const out = await llm.complete("concierge", fill("concierge", { tools: toolList, input: transcript }));
      text = out.text;
      await db.query("INSERT INTO llm_calls (id, event_id, step, prompt_hash, model, input_tokens, output_tokens, output) VALUES ($1, $2, 'concierge', $3, $4, $5, $6, $7)", [newId("llm"), eventId, promptHash("concierge", llm.model), out.model ?? llm.model, out.input_tokens, out.output_tokens, text]);
    } finally { await settle(db, res, 1); }
    let parsed: { tool?: string; args?: Record<string, unknown>; answer?: string };
    try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return STUCK; }
    if (typeof parsed.answer === "string") return MONEY.test(parsed.answer) ? NO_MONEY : parsed.answer;
    if (!parsed.tool || !tools.some((t) => t.name === parsed.tool)) return STUCK;
    const result = await client.callTool({ name: parsed.tool, arguments: { ...parsed.args, event_id: eventId } });
    const body = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
    transcript += `\nTOOL RESULT ${parsed.tool}: ${body}`;
  }
  return STUCK;
}
