/* A delivered event taken into the motion, on the real connector code over a fake tool, with a clock the test controls. */

import { decideApproval } from "../src/server/approvals.ts";
import type { Db } from "../src/server/db.ts";
import { fakeHeyreach, fakeInstantly, type FakeTool } from "../src/server/connectors/fake.ts";
import type { LifecycleDeps, Notifier } from "../src/server/lifecycle-deps.ts";
import { requestMotionCard } from "../src/server/motion.ts";
import { mockLlm, type Crm, type CrmRecord } from "../src/server/providers.ts";
import { approveTemplate, recordLegalBasis, setTools } from "../src/server/sequences.ts";
import type { CardMessage } from "../src/server/slack-cards.ts";
import { deliverEvent } from "./helpers.ts";

export const MAYA = "Maya Ortiz";
export const OWNER = "Priya Natarajan";

export const LIST = `Company,Name,Title,Email,LinkedIn
Tallgrass Software,Ana Ruiz,VP Sales,ana@tallgrasssoftware.example,https://www.linkedin.com/in/ana-ruiz
Tallgrass Software,Ben Ode,Head of Growth,ben@tallgrasssoftware.example,https://www.linkedin.com/in/ben-ode
Brightwater Software,Cleo Park,VP Marketing,cleo@brightwatersoftware.example,https://www.linkedin.com/in/cleo-park
Northwind Software,Dan Ito,Director of Sales,dan@northwindsoftware.example,https://www.linkedin.com/in/dan-ito
`;

export interface Clock { now: Date; set(iso: string): void; forward(days: number): void }
export const clock = (iso = "2027-01-10T12:00:00Z"): Clock => {
  const c: Clock = { now: new Date(iso), set(i) { c.now = new Date(i); }, forward(d) { c.now = new Date(c.now.getTime() + d * 86_400_000); } };
  return c;
};

export function fakeNotifier(opts: { fail?: boolean } = {}) {
  const sent: { to: string; card: CardMessage }[] = [], thread: CardMessage[] = [];
  const n: Notifier & { sent: typeof sent; posts: typeof thread; fail: boolean } = {
    sent, posts: thread, fail: Boolean(opts.fail),
    async dm(to, card) { if (n.fail) return false; sent.push({ to, card }); return true; },
    async thread(t, card) { thread.push(card); return t ?? "thread_1"; },
  };
  return n;
}

export function fakeCrm(over: Partial<Crm> & { owner?: string | null; records?: Record<string, CrmRecord[]>; lastActivity?: string | null } = {}) {
  const calls: string[] = [];
  const crm: Crm & { calls: string[]; down: boolean } = {
    name: "fake_crm", connected: true, calls, down: false,
    async lookup() { if (crm.down) throw new Error("down"); return { owner: over.owner === undefined ? OWNER : over.owner, deal_name: null, deal_stage: null, last_activity: over.lastActivity ?? null, heat: "cold" as never }; },
    async lookupByDomain() { if (crm.down) throw new Error("down"); return { owner: over.owner === undefined ? OWNER : over.owner, deal_name: null, deal_stage: null, last_activity: over.lastActivity ?? null, heat: "cold" as never }; },
    async personFlags(people) { if (crm.down) throw new Error("down"); return Object.fromEntries(people.map((p) => [p.ref, over.records?.[p.email ?? ""] ?? []])); },
    async accountFlags(accounts) { if (crm.down) throw new Error("down"); return Object.fromEntries(accounts.map((a) => [a.ref, { do_not_prospect: false }])); },
    ...over,
  };
  return crm;
}

export interface Harness { id: string; deps: LifecycleDeps; email: FakeTool; li: FakeTool; time: Clock; notify: ReturnType<typeof fakeNotifier>; template: string }

const healthy = (n: number, domain = "send.example") => Array.from({ length: n }, (_, i) => ({ email: `s${i}@${domain}`, status: 1, daily_limit: 50, stat_warmup_score: 98 - i, timestamp_warmup_start: "2026-01-01T00:00:00Z" }));

export async function deliveredInMotion(db: Db, opts: { crm?: Crm | null; csv?: string; to?: "owners" | "sequencing"; time?: Clock; senders?: number } = {}): Promise<Harness> {
  const email = fakeInstantly(), li = fakeHeyreach(), time = opts.time ?? clock(), notify = fakeNotifier();
  (email as any).senders = healthy(opts.senders ?? 6);
  (li as any).senders = [{ id: 1, profileUrl: "https://www.linkedin.com/in/sender1", isActive: true, authIsValid: true }, { id: 2, profileUrl: "https://www.linkedin.com/in/sender2", isActive: true, authIsValid: true }];
  const deps: LifecycleDeps = { crm: opts.crm === undefined ? null : opts.crm, connectors: { instantly: email.connector, heyreach: li.connector }, llm: mockLlm, notify, userMap: { [OWNER]: "UOWNER" }, now: () => time.now };
  const id = await deliverEvent(db, opts.csv ?? LIST, {}, "Payments Summit");
  await db.query("UPDATE contacts SET verify_1 = 'deliverable', verify_2 = 'deliverable' WHERE event_id = $1 AND email IS NOT NULL AND dropped_at IS NULL", [id]);
  await db.query("INSERT INTO verification_cache (email, verdict, verifier, checked_at) SELECT lower(email), 'deliverable', 'test', $2::timestamptz FROM contacts WHERE event_id = $1 AND email IS NOT NULL ON CONFLICT (email) DO UPDATE SET checked_at = EXCLUDED.checked_at", [id, time.now.toISOString()]);
  await db.query("UPDATE contacts SET title_tier = 1, priority = 'A', drop_reason = NULL, dropped_at = NULL WHERE event_id = $1 AND source = 'attendee'", [id]);
  await db.query("UPDATE contacts SET verify_1 = 'deliverable', verify_2 = 'deliverable' WHERE event_id = $1 AND source = 'attendee'", [id]);
  await db.query("DELETE FROM contacts WHERE event_id = $1 AND source <> 'attendee'", [id]);
  await requestMotionCard(db, deps, id, MAYA);
  const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND kind = 'motion' AND status = 'pending'", [id]);
  await decideApproval(db, { approvalId: a.id, actor: MAYA, decision: "approve" });
  await setTools(db, id, MAYA, { email: "instantly", linkedin: "heyreach" }, deps);
  await recordLegalBasis(db, id, MAYA, "unknown", "Legitimate interest, attendee list");
  await recordLegalBasis(db, id, MAYA, "spain", "Legitimate interest, attendee list");
  const seedE = email.newSeq("tpl_email");
  const { id: template } = await approveTemplate(db, "GTM", { name: "Pre email", channel: "email", phase: "pre", steps: [{ day: 0 }, { day: 3 }], external_id: seedE });
  void seedE;
  await approveTemplate(db, "GTM", { name: "Post email", channel: "email", phase: "post", steps: [{ day: 0 }], external_id: seedE });
  await approveTemplate(db, "GTM", { name: "Pre li", channel: "linkedin", phase: "pre", steps: [{ day: 0 }] });
  await approveTemplate(db, "GTM", { name: "Post li", channel: "linkedin", phase: "post", steps: [{ day: 0 }] });
  return { id, deps, email, li, time, notify, template };
}

export const personAt = async (db: Db, id: string, name: string) => (await db.query<{ id: string; email: string; linkedin: string; person_id: string | null }>("SELECT id, email, linkedin, person_id FROM contacts WHERE event_id = $1 AND full_name = $2", [id, name]))[0];
export const enrollmentStates = (db: Db, contactId: string) => db.query<{ channel: string; state: string; pending_op: string | null; cause: string | null; external_contact_id: string | null }>("SELECT channel, state, pending_op, cause, external_contact_id FROM enrollments WHERE contact_id = $1 ORDER BY channel", [contactId]);
export const motionOf = async (db: Db, id: string) => (await db.query<{ motion: string }>("SELECT motion FROM events WHERE id = $1", [id]))[0].motion;
