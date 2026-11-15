/* Shared set-up for the directory tests: an approved event, a capture key, the app with and without the write key, and a vision model that answers from a script. */

import { createApp } from "../src/server/app.ts";
import { decideApproval } from "../src/server/approvals.ts";
import type { Db } from "../src/server/db.ts";
import { createCaptureKey } from "../src/server/directory.ts";
import { createEvent } from "../src/server/events.ts";
import type { Llm } from "../src/server/providers.ts";

export const MAYA = "Maya Ortiz", DAN = "Dan Whitlock", LEO = "Leo Marsh", GTM = "GTM Team";

/** An event as a person would have it before a list: requested, then approved by Dan. */
export async function approvedEvent(db: Db, name = "AWS re:Invent 2026", over: { approve?: boolean } = {}) {
  const id = (await createEvent(db, MAYA, { name, starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100 })).id;
  if (over.approve === false) return id;
  const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]);
  await decideApproval(db, { approvalId: a.id, actor: DAN, decision: "approve" });
  return id;
}

/** A key for the owner. A person holds at most five, so all but the newest two of a crowded owner are revoked first: tests make many. */
export async function keyFor(db: Db, owner = MAYA, label = "Work laptop") {
  await db.query("UPDATE capture_keys SET revoked_at = now(), revoked_by = 'test' WHERE id IN (SELECT id FROM capture_keys WHERE owner = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id DESC OFFSET 2)", [owner]);
  return createCaptureKey(db, owner, label);
}
export const bearer = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
export const as = (who: string, extra: Record<string, string> = {}) => ({ "x-actor": encodeURIComponent(who), "content-type": "application/json", ...extra });
export const send = (app: ReturnType<typeof createApp>, path: string, key: string, body: unknown) => app.request(path, { method: "POST", headers: bearer(key), body: JSON.stringify(body) });

export const person = (name: string, over: Record<string, unknown> = {}) => ({ name, title: "Head of Payments", company: "Orrery", ...over });
export const count = async (db: Db, table: string, where = "TRUE") => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n;

/** A model that sees: it answers the scripted replies in order (a function is called with the call's index), counts its calls, and can be made to throw. */
export function seeing(replies: (unknown | ((i: number) => unknown))[], opts: { throws?: number[]; text?: boolean } = {}): Llm & { calls: number } {
  const l: Llm & { calls: number } = {
    model: "test-vision", calls: 0,
    async complete() { throw new Error("not used"); },
    async read() {
      const i = l.calls++;
      if (opts.throws?.includes(i)) throw new Error("boom");
      const r = replies[Math.min(i, replies.length - 1)];
      const v = typeof r === "function" ? (r as (n: number) => unknown)(i) : r;
      return { text: typeof v === "string" ? v : JSON.stringify(v), input_tokens: 900, output_tokens: 300 };
    },
  };
  return l;
}

/** A frame answer in the shape the prompt asks for: the transcription is built from the people so the check passes. */
export const frame = (people: { name: string; title?: string; company?: string; location?: string; low?: boolean }[], extraText = "") => ({
  people: people.map((p) => ({ name: p.name, title: p.title, company: p.company, location: p.location, confidence: { name: p.low ? "low" : "high", company: p.low ? "low" : "high" } })),
  text: `${people.map((p) => [p.name, p.title, p.company, p.location].filter(Boolean).join(" ")).join(" ")} ${extraText}`.trim(),
});

/** Bytes that read as a JPEG. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

/** A confirmed `terms` answer on the event's assessment, as the assessment step leaves it. */
export async function confirmTerms(db: Db, eventId: string, answer: string) {
  await db.query("INSERT INTO event_assessments (id, event_id, conference_key, status, confirmed_by, confirmed_at, created_by) VALUES ($1, $2, 'k', 'confirmed', $3, now(), $3)", [`as_${eventId}`, eventId, MAYA]);
  await db.query("INSERT INTO assessment_answers (id, assessment_id, question, answer, source_kind, proposed_by, state, confirmed_by, confirmed_at) VALUES ($1, $2, 'terms', $3, 'faq', $4, 'confirmed', $4, now())", [`aa_${eventId}`, `as_${eventId}`, answer, MAYA]);
}
