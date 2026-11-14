/* The one module that mails people who asked for the mail: a confirmation, a reminder, a seat that opened (docs/HOSTED.md 8). It is not a sequence and has no cadence or cold step.
   Every message is written to `transactional_outbox` first, so a test can read exactly what went out; the sender is handed it only after the database transaction commits.
   A send whose outcome is unknown is never repeated. The live path (TRANSACTIONAL_URL and TRANSACTIONAL_KEY, a JSON POST) is not proven against a provider. */

import type { Db } from "./db.ts";

export interface TransactionalMessage { to: string; subject: string; body: string; ref: string }
export interface SendResult { state: "sent" | "failed" | "unknown"; ref?: string; error?: string }
export interface TransactionalSender {
  /** True for a sender that reaches real mailboxes. The simulated one is demo and tests only. */
  live: boolean;
  send(m: TransactionalMessage): Promise<SendResult>;
}

/** Records what it was given and says sent. Demo and tests. */
export function simulatedSender(opts: { fail?: (m: TransactionalMessage) => SendResult | null } = {}): TransactionalSender & { sent: TransactionalMessage[] } {
  const sent: TransactionalMessage[] = [];
  return {
    live: false, sent,
    async send(m) { const f = opts.fail?.(m); if (f) return f; sent.push(m); return { state: "sent", ref: `sim_${m.ref}` }; },
  };
}

/** A JSON POST: { to, subject, body, ref } with a bearer key. 2xx is sent, 4xx is a definite failure, anything else (5xx, a dropped connection, a timeout) is unknown and is not retried. */
export function liveSender(url: string, key: string, fetchImpl: typeof fetch = fetch): TransactionalSender {
  return {
    live: true,
    async send(m) {
      try {
        const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(m), signal: AbortSignal.timeout(15_000) });
        if (r.ok) return { state: "sent", ref: m.ref };
        if (r.status >= 400 && r.status < 500) return { state: "failed", error: `The mail service answered ${r.status}.` };
        return { state: "unknown", error: `The mail service answered ${r.status}.` };
      } catch (e) { return { state: "unknown", error: (e as Error).message }; }
    },
  };
}

/** The sender the environment names, or null when it does not name one (the caller decides whether that is allowed). */
export function senderFromEnv(env: Record<string, string | undefined> = process.env): TransactionalSender | null {
  const url = env.TRANSACTIONAL_URL?.trim(), key = env.TRANSACTIONAL_KEY?.trim();
  return url && key ? liveSender(url, key) : null;
}

export const NO_SENDER = "Live mode needs TRANSACTIONAL_URL and TRANSACTIONAL_KEY before the desk can send a reminder.";

/** Hands each queued outbox row to the sender. A row is claimed (state unknown) before the call, so a crash in the middle never repeats a send; the answer then sets sent or failed. */
export async function deliverOutbox(db: Db, sender: TransactionalSender, ids: string[], now: Date = new Date()) {
  const out = { sent: 0, failed: 0, unknown: 0 };
  for (const id of ids) {
    const [m] = await db.query<{ id: string; to_email: string; subject: string; body: string; run_id: string | null; guest_id: string | null }>(
      "UPDATE transactional_outbox SET state = 'unknown' WHERE id = $1 AND state = 'queued' RETURNING id, to_email, subject, body, run_id, guest_id", [id]);
    if (!m) continue;
    let r: SendResult;
    try { r = await sender.send({ to: m.to_email, subject: m.subject, body: m.body, ref: m.id }); } catch (e) { r = { state: "unknown", error: (e as Error).message }; }
    await db.tx(async (q) => {
      await q("UPDATE transactional_outbox SET state = $2, provider_ref = $3, sent_at = CASE WHEN $2 = 'sent' THEN $4::timestamptz ELSE NULL END WHERE id = $1", [id, r.state, r.ref ?? null, now.toISOString()]);
      if (m.run_id && m.guest_id) await q("UPDATE reminder_sends SET outcome = $3, sent_at = CASE WHEN $3 = 'sent' THEN $4::timestamptz ELSE NULL END WHERE run_id = $1 AND guest_id = $2", [m.run_id, m.guest_id, r.state, now.toISOString()]);
      if (m.run_id && r.state === "sent") await q("UPDATE reminder_runs SET sent_count = sent_count + 1 WHERE id = $1", [m.run_id]);
    });
    out[r.state]++;
  }
  return out;
}
