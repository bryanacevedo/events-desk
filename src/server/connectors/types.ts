/* The plug every sequencer goes through (docs/LIFECYCLE.md, section 5). The desk owns the rules; nothing about any one tool reaches code outside its connector.
   Written against each tool's public docs and run against scripted fakes. None is proven until a real account runs it. */

import type { Channel } from "../../shared/motion.ts";
import type { SenderInfo } from "../../shared/sending.ts";

export type SequenceState = "draft" | "active" | "paused" | "archived";

export interface Capabilities {
  /** False: the tool cannot make a sequence through its API, so the template carries the id of one a person made. */
  createsSequences: boolean;
  /** "remove-only": the tool cannot pause one person. The desk removes them and adds them back, and records why. */
  pause: "contact" | "remove-only";
  events: "webhook" | "poll" | "both";
  /** False: replies arrive with no text, so the desk knows that someone answered and not what they said. */
  replyBodies: boolean;
  /** True: the tool assigns by CRM record id, so anyone without one is refused. */
  needsCrmRecord: boolean;
  /** False: the tool cannot say a sequence went live, so adding someone is the launch. */
  observesLaunch: boolean;
  /** False: the tool only accepts people once the sequence runs. */
  addsWhileDraft: boolean;
  /** False: the tool never tells the desk about replies or opt-outs, so stopping someone the moment they answer cannot work. Refused for sending. */
  reportsStops: boolean;
  /** False: send windows, tracking and stop-on-reply cannot be set through the API, so a person confirms them at launch. */
  appliesSettings: boolean;
}

export interface SendSettings { timezone: string; from: string; to: string; days: number[]; stop_on_reply: boolean; track_opens: boolean; track_links: boolean; daily_limit: number }

export interface PersonForTool { ref: string; email: string | null; linkedin: string | null; first_name: string; last_name: string; company: string; title: string | null; crm_id: string | null }
export interface AddContact extends PersonForTool { external_id: string }
export interface AddResult { ref: string; ok: boolean; external_id?: string; reason?: string; retry_after_minutes?: number }
export type EventSignal = "send" | "reply" | "bounce" | "unsubscribe";
export interface ToolEvent { provider_message_id: string; signal: EventSignal; channel: Channel; sequence_external_id: string | null; email: string | null; linkedin: string | null; external_contact_id: string | null; body: string | null; at: string }
export interface WebhookRequest { headers: Record<string, string | undefined>; query: Record<string, string | undefined>; body: unknown }

export interface Connector {
  name: string;
  channels: Channel[];
  capabilities: Capabilities;
  /** True for the demo's stand-in tool. Screens label it. */
  simulated?: boolean;
  /** The sending accounts this tool holds, with their health. Absent: the tool does not show them, and the screen says the desk cannot vouch for them. */
  listSenders?(): Promise<SenderInfo[]>;
  /** Puts these accounts on a sequence. Absent: a person attaches the ones the desk names. */
  assignSenders?(sequenceId: string, senders: SenderInfo[]): Promise<void>;
  /** Sets the sending settings instead of inheriting whatever the campaign had. */
  applySettings?(sequenceId: string, s: SendSettings): Promise<void>;
  readSettings?(sequenceId: string): Promise<SendSettings | null>;
  /** The tool's own guidance on the lowest health it should send from. */
  healthFloor?: number;
  listTemplates(): Promise<{ id: string; name: string }[]>;
  ensureContact(p: PersonForTool): Promise<string>;
  createSequence(name: string, templateId: string, senders: string[]): Promise<string>;
  addContacts(sequenceId: string, people: AddContact[]): Promise<AddResult[]>;
  removeContact(sequenceId: string, externalId: string): Promise<void>;
  pauseContact(sequenceId: string, externalId: string): Promise<void>;
  resumeContact(sequenceId: string, externalId: string): Promise<void>;
  pauseSequence(sequenceId: string): Promise<void>;
  sequenceState(sequenceId: string): Promise<SequenceState>;
  /** Everything since `since`, on these sequences. May return an event twice: the desk removes duplicates by provider id. */
  events(since: string, sequenceIds: string[]): Promise<ToolEvent[]>;
  /** The events in a webhook call, or null when the call is not from this tool. */
  verifyWebhook(req: WebhookRequest): ToolEvent[] | null;
}

export type Fetch = typeof fetch;
export class ToolError extends Error {
  tool: string; status: number;
  constructor(tool: string, status: number, detail: string) { super(`${tool} answered ${status}: ${detail}`); this.tool = tool; this.status = status; }
}

export function client(tool: string, f: Fetch, base: string, auth: { headers?: Record<string, string>; query?: Record<string, string> }) {
  return async function call<T = any>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries({ ...auth.query, ...opts.query })) if (v !== undefined) u.searchParams.set(k, String(v));
    const r = await f(u.toString(), { method, headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...auth.headers }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new ToolError(tool, r.status, text.slice(0, 200));
    return (text ? JSON.parse(text) : {}) as T;
  };
}

export const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
/** Constant-time enough for a shared secret that is compared once per call. */
export const sameSecret = (a: string | undefined, b: string) => {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
