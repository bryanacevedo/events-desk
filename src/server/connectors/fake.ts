/* A scripted stand-in for each tool: it answers the same HTTP each connector sends, keeps state, and behaves the awkward way the real tool is documented to. The contract suite runs on these, and the demo's sequencer is the real connector talking to one. */

import { apollo, gong, heyreach, instantly, smartlead } from "./tools.ts";
import type { Connector, Fetch, ToolEvent } from "./types.ts";

export interface FakeSeq { id: string; name: string; status: string; people: Map<string, { id: string; email?: string; paused: boolean; stopped?: boolean }> }
export interface FakeTool { senders: any[]; name: string; connector: Connector; seqs: Map<string, FakeSeq>; launch(id: string): void; pause(id: string): void; reply(seq: string, who: string, body: string | null): { webhook: unknown; request: { headers: Record<string, string>; query: Record<string, string>; body: unknown } }; refuse: Set<string>; down: boolean; calls: string[]; webhookSecret: string; newSeq(id?: string): string }

let n = 0;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const SECRET = "fake-secret";

function base(name: string, active: string, draft: string, paused: string) {
  const t = {
    name, senders: [] as any[], assigned: new Map<string, unknown>(), seqs: new Map<string, FakeSeq>(), refuse: new Set<string>(), down: false, calls: [] as string[], webhookSecret: SECRET,
    newSeq(id = `${++n}`) { t.seqs.set(id, { id, name: id, status: draft, people: new Map() }); return id; },
    launch(id: string) { t.seqs.get(id)!.status = active; },
    pause(id: string) { t.seqs.get(id)!.status = paused; },
  };
  return t;
}
const wrap = (t: { down: boolean; calls: string[] }, h: (m: string, p: string, q: URLSearchParams, b: any) => Response | Promise<Response>): Fetch =>
  (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    t.calls.push(`${init.method ?? "GET"} ${u.pathname}`);
    if (t.down) return new Response("down", { status: 503 });
    return h(init.method ?? "GET", u.pathname, u.searchParams, init.body ? JSON.parse(init.body) : undefined);
  }) as Fetch;

export function fakeInstantly(): FakeTool {
  const t = base("instantly", "1", "0", "2") as any;
  const f = wrap(t, (m, p, q, b) => {
    let x: RegExpMatchArray | null;
    if (m === "GET" && p.endsWith("/accounts")) return json({ items: t.senders });
    if (m === "PATCH" && (x = p.match(/\/campaigns\/([^/]+)$/))) { if (b.email_list) t.assigned.set(x[1], b.email_list); else (t.settings ??= new Map()).set(x[1], b); return json({}); }
    if (m === "GET" && p.endsWith("/campaigns")) return json({ items: [...t.seqs.values()].map((s: any) => ({ id: s.id, name: s.name })) });
    if ((x = p.match(/\/campaigns\/([^/]+)\/duplicate$/))) { const id = t.newSeq(); t.seqs.get(id).name = b.name; return json({ id }); }
    if ((x = p.match(/\/campaigns\/([^/]+)\/pause$/))) { t.pause(x[1]); return json({}); }
    if (m === "GET" && (x = p.match(/\/campaigns\/([^/]+)$/))) return json({ status: Number(t.seqs.get(x[1]).status), ...(t.settings?.get(x[1]) ?? {}) });
    if (p.endsWith("/leads/add")) {
      const s = t.seqs.get(b.campaign_id), created: unknown[] = [];
      for (const l of b.leads) { const e = l.email.toLowerCase(); if (t.refuse.has(e) || s.people.has(e)) continue; const id = `lead_${++n}`; s.people.set(e, { id, email: e, paused: false }); created.push({ id, email: e }); }
      return json({ created_leads: created });
    }
    if (p.endsWith("/leads/list")) { const hit = t.seqs.get(b.campaign)?.people.get(b.search); return json({ items: hit ? [{ id: hit.id }] : [] }); }
    if (m === "DELETE" && (x = p.match(/\/leads\/([^/]+)$/))) { for (const s of t.seqs.values() as any) for (const [k, v] of s.people) if ((v as any).id === x[1]) s.people.delete(k); return json({}); }
    if (p.endsWith("/emails")) return json({ items: (t.mail ?? []).filter((e: any) => e.campaign === q.get("campaign_id")) });
    return new Response("no route", { status: 404 });
  });
  t.connector = instantly({ apiKey: "k", webhookSecret: SECRET, fetch: f });
  t.reply = (seq: string, who: string, body: string | null) => {
    const id = `em_${++n}`, at = new Date().toISOString();
    (t.mail ??= []).push({ id, campaign: seq, lead: who, body: { text: body }, timestamp_email: at });
    const w = { event_type: "reply_received", lead_email: who, campaign_id: seq, email_id: id, reply_text: body, timestamp: at };
    return { webhook: w, request: { headers: { "x-desk-secret": SECRET }, query: {}, body: w } };
  };
  return t;
}

export function fakeHeyreach(): FakeTool {
  const t = base("heyreach", "IN_PROGRESS", "DRAFT", "PAUSED") as any;
  const f = wrap(t, (m, p, q, b) => {
    if (p.endsWith("/li_account/GetAll")) return json({ items: t.senders });
    if (p.endsWith("/campaign/GetAll")) return json({ items: [...t.seqs.values()].map((s: any) => ({ id: s.id, name: s.name })) });
    if (p.endsWith("/campaign/GetById")) return json({ status: t.seqs.get(q.get("campaignId")).status });
    if (p.endsWith("/campaign/Pause")) { t.pause(q.get("campaignId")); return json({}); }
    if (p.endsWith("/campaign/AddLeadsToCampaignV2")) {
      const s = t.seqs.get(String(b.campaignId));
      // The real tool's trap: adding to a paused campaign starts it again.
      if (s.status === "PAUSED") s.status = "IN_PROGRESS";
      for (const x of b.accountLeadPairs) if (!s.people.has(x.lead.profileUrl)) s.people.set(x.lead.profileUrl, { id: x.lead.profileUrl, paused: false });
      return json({ added: b.accountLeadPairs.length });
    }
    if (p.endsWith("/campaign/StopLeadInCampaign")) { t.seqs.get(String(b.campaignId)).people.delete(b.leadUrl); return json({}); }
    if (p.endsWith("/inbox/GetConversationsV2")) return json({ items: (t.mail ?? []).filter((c: any) => b.filters.campaignIds.includes(Number(c.campaignId))) });
    return new Response("no route", { status: 404 });
  });
  t.connector = heyreach({ apiKey: "k", webhookSecret: SECRET, fetch: f });
  t.reply = (seq: string, who: string, body: string | null) => {
    const id = `c_${++n}`, at = new Date().toISOString();
    (t.mail ??= []).push({ id, campaignId: seq, lastMessageSender: "CORRESPONDENT", lastMessageAt: at, lastMessageText: body, correspondentProfile: { profileUrl: who } });
    const w = { event_type: "MESSAGE_REPLY_RECEIVED", conversation_id: id, timestamp: at, campaign: { id: seq }, lead: { profile_url: who }, recent_messages: [{ message: body }] };
    return { webhook: w, request: { headers: {}, query: { secret: SECRET }, body: w } };
  };
  return t;
}

export function fakeSmartlead(): FakeTool {
  const t = base("smartlead", "ACTIVE", "DRAFTED", "PAUSED") as any;
  const leads = new Map<string, string>();
  const f = wrap(t, (m, p, q, b) => {
    let x: RegExpMatchArray | null;
    if (m === "GET" && p.endsWith("/email-accounts/")) return json(t.senders);
    if ((x = p.match(/\/email-accounts\/([^/]+)\/warmup-stats$/))) return json(t.senders.find((a: any) => String(a.id) === x![1])?.stats ?? {});
    if (m === "POST" && (x = p.match(/\/campaigns\/([^/]+)\/email-accounts$/))) { t.assigned.set(x[1], b.email_account_ids); return json({}); }
    if (p.endsWith("/campaigns/create")) { const id = t.newSeq(); t.seqs.get(id).name = b.name; return json({ id }); }
    if (m === "GET" && p.endsWith("/campaigns")) return json([...t.seqs.values()].map((s: any) => ({ id: s.id, name: s.name })));
    if ((x = p.match(/\/campaigns\/([^/]+)\/sequences$/))) return json(m === "GET" ? [{ seq_number: 1 }] : { ok: true });
    if ((x = p.match(/\/campaigns\/([^/]+)\/status$/))) { t.seqs.get(x[1]).status = b.status; return json({}); }
    if ((x = p.match(/\/campaigns\/([^/]+)\/schedule$/))) { const c = ((t.cfg ??= new Map()).get(x[1]) ?? {}); c.scheduler_cron_value = { tz: b.timezone, days: b.days_of_the_week, startHour: b.start_hour, endHour: b.end_hour }; c.max_leads_per_day = b.max_new_leads_per_day; t.cfg.set(x[1], c); return json({}); }
    if ((x = p.match(/\/campaigns\/([^/]+)\/settings$/))) { const c = ((t.cfg ??= new Map()).get(x[1]) ?? {}); c.track_settings = b.track_settings; c.stop_lead_settings = b.stop_lead_settings; t.cfg.set(x[1], c); return json({}); }
    if ((x = p.match(/\/campaigns\/([^/]+)\/leads$/))) {
      if (b.lead_list.length > 100) return new Response("too many", { status: 400 });
      const s = t.seqs.get(x[1]);
      for (const l of b.lead_list) { const e = l.email.toLowerCase(); if (t.refuse.has(e)) continue; const id = leads.get(e) ?? `${++n}`; leads.set(e, id); if (!s.people.has(id)) s.people.set(id, { id, email: e, paused: false }); }
      return json({ upload_count: b.lead_list.length });
    }
    if (p.endsWith("/leads/")) { const id = leads.get(q.get("email")!.toLowerCase()); return json(id ? { id } : {}); }
    if ((x = p.match(/\/campaigns\/([^/]+)\/leads\/([^/]+)\/(pause|resume)$/))) { t.seqs.get(x[1]).people.get(x[2]).paused = x[3] === "pause"; return json({}); }
    if (m === "DELETE" && (x = p.match(/\/campaigns\/([^/]+)\/leads\/([^/]+)$/))) { t.seqs.get(x[1]).people.delete(x[2]); return json({}); }
    if (m === "GET" && (x = p.match(/\/campaigns\/([^/]+)\/statistics$/))) return json({ data: (t.mail ?? []).filter((r: any) => r.campaign === x![1]) });
    if (m === "GET" && (x = p.match(/\/campaigns\/([^/]+)$/))) return json({ status: t.seqs.get(x[1]).status, ...(t.cfg?.get(x[1]) ?? {}) });
    return new Response("no route", { status: 404 });
  });
  t.connector = smartlead({ apiKey: "k", webhookSecret: SECRET, fetch: f });
  t.reply = (seq: string, who: string, body: string | null) => {
    const stats_id = `st_${++n}`, at = new Date().toISOString();
    (t.mail ??= []).push({ campaign: seq, stats_id, lead_email: who, reply_time: at, reply_text: body });
    const w = { secret_key: SECRET, event_type: "EMAIL_REPLY", stats_id, to_email: who, campaign_id: seq, reply_message: { text: body }, time_replied: at };
    return { webhook: w, request: { headers: {}, query: {}, body: w } };
  };
  return t;
}

export function fakeApollo(): FakeTool {
  const t = base("apollo", "active", "draft", "paused") as any;
  const contacts = new Map<string, string>();
  const f = wrap(t, (m, p, _q, b) => {
    let x: RegExpMatchArray | null;
    if (p.endsWith("/emailer_campaigns/search")) return json({ emailer_campaigns: [...t.seqs.values()].map((s: any) => ({ id: s.id, name: s.name })) });
    if (p.endsWith("/contacts")) { const e = String(b.email).toLowerCase(); const id = contacts.get(e) ?? `ct_${++n}`; contacts.set(e, id); return json({ contact: { id } }); }
    if ((x = p.match(/\/emailer_campaigns\/([^/]+)\/add_contact_ids$/))) {
      const s = t.seqs.get(x[1]), skipped: string[] = [];
      for (const id of b.contact_ids) { if (t.refuse.has(id)) skipped.push(id); else if (!s.people.has(id)) s.people.set(id, { id, paused: false }); }
      return json({ skipped_contact_ids: skipped.length ? { contacts_refused: skipped } : {} });
    }
    if (p.endsWith("/remove_or_stop_contact_ids")) { for (const c of b.emailer_campaign_ids) for (const id of b.contact_ids) t.seqs.get(c).people.delete(id); return json({}); }
    if ((x = p.match(/\/emailer_campaigns\/([^/]+)\/deactivate$/))) { t.pause(x[1]); return json({}); }
    if (m === "GET" && (x = p.match(/\/emailer_campaigns\/([^/]+)$/))) { const st = t.seqs.get(x[1]).status; return json({ emailer_campaign: { active: st === "active", archived: false, last_used_at: st === "paused" ? "2026-01-01" : null } }); }
    if (p.endsWith("/emailer_messages/search")) return json({ emailer_messages: (t.mail ?? []).filter((e: any) => e.seq === b.emailer_campaign_ids[0]) });
    return new Response("no route", { status: 404 });
  });
  t.connector = apollo({ apiKey: "k", webhookSecret: SECRET, fetch: f });
  t.reply = (seq: string, who: string) => { (t.mail ??= []).push({ id: `m_${++n}`, seq, to_email: who, replied_at: new Date().toISOString() }); return { webhook: null, request: { headers: {}, query: {}, body: null } }; };
  return t;
}

export function fakeGong(): FakeTool {
  const t = base("gong", "active", "active", "active") as any;
  const f = wrap(t, (m, p, _q, b) => {
    if (m === "GET" && p.endsWith("/flows")) return json({ flows: [...t.seqs.values()].map((s: any) => ({ id: s.id, name: s.name })) });
    if (p.endsWith("/flows/prospects/assign")) {
      const s = t.seqs.get(b.flowId), bad: unknown[] = [];
      for (const id of b.crmProspectsIds) { if (t.refuse.has(id)) bad.push({ crmProspectId: id }); else if (!s.people.has(id)) s.people.set(id, { id, paused: false }); }
      return json({ errors: bad });
    }
    if (p.endsWith("/flows/prospects/unassign-flows-by-crm-prospect-id")) { for (const fl of b.flowIds) t.seqs.get(fl).people.delete(b.crmProspectId); return json({}); }
    return new Response("no route", { status: 404 });
  });
  t.connector = gong({ apiKey: "k", accessKey: "a", webhookSecret: SECRET, flowOwnerEmail: "owner@desk.example", fetch: f });
  t.reply = () => ({ webhook: null, request: { headers: {}, query: {}, body: null } });
  return t;
}

export const FAKES = { instantly: fakeInstantly, heyreach: fakeHeyreach, smartlead: fakeSmartlead, apollo: fakeApollo, gong: fakeGong };
export type { ToolEvent };
