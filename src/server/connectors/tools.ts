/* One connector per tool. Paths and payloads follow each tool's public docs; `docs/LIFECYCLE.md` lists what still needs a real account to confirm. */

import type { SenderInfo } from "../../shared/sending.ts";
import { chunks, client, sameSecret, type AddContact, type AddResult, type Connector, type Fetch, type PersonForTool, type SequenceState, type ToolEvent, type WebhookRequest } from "./types.ts";

/** Instantly gives no link to one conversation in what the desk stores, so a reply opens its shared inbox, the Unibox, where the rep finds the thread. */
const INSTANTLY_INBOX = "https://app.instantly.ai/app/unibox";

interface Opts { apiKey: string; webhookSecret: string; fetch?: Fetch }
const need = (p: PersonForTool) => p.email?.toLowerCase() ?? null;
const daysSince = (t: unknown) => (typeof t === "string" && !Number.isNaN(Date.parse(t)) ? Math.floor((Date.now() - Date.parse(t)) / 86_400_000) : null);

/* ------------------------------------------------------------- Instantly */

const toInstantly = (t: string) => t.replaceAll("{{first_name}}", "{{firstName}}").replaceAll("{{last_name}}", "{{lastName}}").replaceAll("{{company}}", "{{companyName}}");
const fromInstantly = (t: string) => t.replaceAll("{{firstName}}", "{{first_name}}").replaceAll("{{lastName}}", "{{last_name}}").replaceAll("{{companyName}}", "{{company}}");

const INSTANTLY_STATE: Record<number, SequenceState> = { 0: "draft", 1: "active", 2: "paused", 3: "archived", [-1]: "paused", [-2]: "paused" };

function instantlyEvent(w: any): ToolEvent | null {
  const signal = ({ reply_received: "reply", email_bounced: "bounce", lead_unsubscribed: "unsubscribe", email_sent: "send" } as const)[w?.event_type as string];
  if (!signal || !w.lead_email) return null;
  const id = String(w.email_id ?? w.id ?? `${w.event_type}:${w.lead_email}:${w.timestamp}`);
  return { provider_message_id: `${signal}:${id}`, signal, channel: "email", sequence_external_id: w.campaign_id ?? w.campaign ?? null, email: String(w.lead_email).toLowerCase(), linkedin: null, external_contact_id: null, body: w.reply_text ?? w.reply_text_snippet ?? null, at: w.timestamp ?? new Date().toISOString(), thread_url: INSTANTLY_INBOX, sender: w.email_account ?? null, step: typeof w.step === "number" ? w.step : null, hard: w.bounce_type ? w.bounce_type === "hard" : undefined };
}

export function instantly(o: Opts): Connector {
  const api = client("instantly", o.fetch ?? fetch, "https://api.instantly.ai/api/v2", { headers: { authorization: `Bearer ${o.apiKey}` } });
  const leadId = async (campaign: string, email: string) => {
    const j = await api("POST", "/leads/list", { body: { campaign, search: email, limit: 1 } });
    return (j.items ?? [])[0]?.id as string | undefined;
  };
  return {
    name: "instantly", channels: ["email"],
    // Instantly documents no way to pause one lead in a campaign, so a pause is a removal and a resume is adding them back.
    capabilities: { reports: ["send", "reply", "bounce", "unsubscribe"], createsSequences: true, pause: "remove-only", events: "both", replyBodies: true, needsCrmRecord: false, observesLaunch: true, addsWhileDraft: true, reportsStops: true, appliesSettings: true },
    healthFloor: 90,
    async listSenders() {
      const j = await api("GET", "/accounts", { query: { limit: 100 } });
      return (j.items ?? []).map((a: any): SenderInfo => ({ warmup_on: a.warmup_status === undefined ? null : a.warmup_status === 1, name: [a.first_name, a.last_name].filter(Boolean).join(" ") || null, id: a.email, address: a.email, domain: String(a.email).split("@")[1], channel: "email", active: a.status === 1, daily_limit: a.daily_limit ?? null, health: a.stat_warmup_score ?? a.warmup_score ?? null, warm_days: a.warmup_status === 0 ? 0 : daysSince(a.timestamp_warmup_start), bounce_rate: null, spam_rate: null }));
    },
    async assignSenders(id, senders) { await api("PATCH", `/campaigns/${id}`, { body: { email_list: senders.map((s) => s.address) } }); },
    async registerWebhooks(id, url) {
      const have = await api("GET", "/webhooks", { query: { limit: 100 } });
      if ((have.items ?? []).some((w: any) => w.target_hook_url === url && w.campaign === id)) return;
      await api("POST", "/webhooks", { body: { target_hook_url: url, campaign: id, event_type: "all_events", headers: { "x-desk-secret": o.webhookSecret } } });
    },
    async pushCopy(id, steps) { await api("PATCH", `/campaigns/${id}`, { body: { sequences: [{ steps: steps.map((s, i) => ({ type: "email", delay: i ? s.day - steps[i - 1].day : 0, variants: [{ subject: toInstantly(s.subject ?? ""), body: toInstantly(s.body) }] })) }] } }); },
    async readCopy(id) {
      const j = await api("GET", `/campaigns/${id}`), st = j.sequences?.[0]?.steps;
      if (!st) return null;
      let day = 0;
      return st.map((s: any, i: number) => { if (i) day += s.delay; const v = s.variants[0]; return { day, subject: fromInstantly(v.subject) || undefined, body: fromInstantly(v.body) }; });
    },
    async applySettings(id, x) {
      await api("PATCH", `/campaigns/${id}`, { body: { campaign_schedule: { schedules: [{ name: "Desk", timing: { from: x.from, to: x.to }, days: Object.fromEntries(x.days.map((d) => [d, true])), timezone: x.timezone }] }, stop_on_reply: x.stop_on_reply, open_tracking: x.track_opens, link_tracking: x.track_links, daily_limit: x.daily_limit } });
    },
    async readSettings(id) {
      const j = await api("GET", `/campaigns/${id}`), sc = j.campaign_schedule?.schedules?.[0];
      if (!sc) return null;
      return { timezone: sc.timezone, from: sc.timing.from, to: sc.timing.to, days: Object.keys(sc.days).filter((d) => sc.days[d]).map(Number).sort(), stop_on_reply: Boolean(j.stop_on_reply), track_opens: Boolean(j.open_tracking), track_links: Boolean(j.link_tracking), daily_limit: j.daily_limit };
    },
    async listTemplates() { const j = await api("GET", "/campaigns", { query: { limit: 100 } }); return (j.items ?? []).map((c: any) => ({ id: c.id, name: c.name })); },
    // A lead exists only inside a campaign, so the address is the id until one is added.
    async ensureContact(p) { const e = need(p); if (!e) throw new Error("Instantly needs an email address."); return e; },
    async createSequence(name, templateId) { const j = await api("POST", `/campaigns/${templateId}/duplicate`, { body: { name } }); return j.id; },
    async addContacts(sequenceId, people: AddContact[]) {
      const out: AddResult[] = [];
      for (const batch of chunks(people, 1000)) {
        const j = await api("POST", "/leads/add", { body: { campaign_id: sequenceId, skip_if_in_campaign: true, leads: batch.map((p) => ({ email: p.email, first_name: p.first_name, last_name: p.last_name, company_name: p.company, personalization: p.title ?? undefined })) } });
        const created = new Map<string, string>((j.created_leads ?? []).map((l: any) => [String(l.email).toLowerCase(), l.id]));
        for (const p of batch) {
          const email = p.email!.toLowerCase();
          // Already in the campaign: asked for by the replay of a crash, and still one person.
          const id = created.get(email) ?? await leadId(sequenceId, email);
          out.push(id ? { ref: p.ref, ok: true, external_id: id } : { ref: p.ref, ok: false, reason: "not_accepted", retry_after_minutes: 60 });
        }
      }
      return out;
    },
    async removeContact(_s, externalId) { await api("DELETE", `/leads/${externalId}`); },
    async pauseSequence(id) { await api("POST", `/campaigns/${id}/pause`); },
    async sequenceState(id) { const j = await api("GET", `/campaigns/${id}`); return INSTANTLY_STATE[j.status as number] ?? "paused"; },
    async events(since, sequenceIds) {
      const out: ToolEvent[] = [];
      for (const campaign_id of sequenceIds) {
        const j = await api("GET", "/emails", { query: { campaign_id, email_type: "received", min_timestamp_created: since, limit: 100 } });
        if (!Array.isArray(j.items)) throw new Error("Instantly's answer had no list in it.");
        for (const m of j.items) out.push({ provider_message_id: `reply:${m.id}`, signal: "reply", channel: "email", sequence_external_id: campaign_id, email: String(m.lead ?? m.from_address_email).toLowerCase(), linkedin: null, external_contact_id: null, body: m.body?.text ?? m.content_preview ?? null, at: m.timestamp_email ?? m.timestamp_created, thread_url: INSTANTLY_INBOX });
      }
      return out;
    },
    verifyWebhook(req: WebhookRequest) {
      if (!sameSecret(req.headers["x-desk-secret"], o.webhookSecret)) return null;
      const e = instantlyEvent(req.body);
      return e ? [e] : [];
    },
  };
}

/* -------------------------------------------------------------- HeyReach */

const HEYREACH_STATE: Record<string, SequenceState> = { DRAFT: "draft", STARTING: "active", IN_PROGRESS: "active", ACTIVE: "active", PAUSED: "paused", FINISHED: "archived", CANCELED: "archived", FAILED: "paused" };

/** HeyReach's webhook event types for what a campaign did, and the signal each becomes. UNCONFIRMED: these names come from third-party
    integration docs (Make, Zapier, OutboundSync), not HeyReach's own reference, which listed only some. A correction is one line here. */
export const HEYREACH_EVENTS: Record<string, "invite" | "accepted" | "send"> = { CONNECTION_REQUEST_SENT: "invite", CONNECTION_REQUEST_ACCEPTED: "accepted", MESSAGE_SENT: "send" };

export function heyreach(o: Opts): Connector {
  const api = client("heyreach", o.fetch ?? fetch, "https://api.heyreach.io/api/public", { headers: { "X-API-KEY": o.apiKey } });
  const state = async (id: string) => HEYREACH_STATE[(await api("GET", "/campaign/GetById", { query: { campaignId: id } })).status as string] ?? "paused";
  return {
    name: "heyreach", channels: ["linkedin"],
    capabilities: { reports: ["invite", "accepted", "send", "reply"], createsSequences: false, pause: "remove-only", events: "both", replyBodies: true, needsCrmRecord: false, observesLaunch: true, addsWhileDraft: false, reportsStops: true, appliesSettings: false },
    // Which accounts run a campaign is set by a person in HeyReach, so there is no assignSenders. The desk names the ones to attach.
    async registerWebhooks(id, url) {
      const target = `${url}?secret=${encodeURIComponent(o.webhookSecret)}`;
      const have = await api("POST", "/webhooks/GetAllWebhooks", { body: { offset: 0, limit: 100 } });
      // HeyReach takes one event type per webhook: one each, so a campaign that already has the reply webhook still gets the others.
      for (const eventType of ["MESSAGE_REPLY_RECEIVED", ...Object.keys(HEYREACH_EVENTS)]) {
        if ((have.items ?? []).some((w: any) => w.webhookUrl === target && (w.campaignIds ?? []).includes(Number(id)) && String(w.eventType ?? "").toUpperCase() === eventType)) continue;
        await api("POST", "/webhooks/CreateWebhook", { body: { webhookName: `Events Desk ${id} ${eventType.toLowerCase()}`, webhookUrl: target, eventType, campaignIds: [Number(id)] } });
      }
    },
    async listSenders() {
      const j = await api("POST", "/li_account/GetAll", { body: { offset: 0, limit: 100 } });
      return (j.items ?? []).map((a: any): SenderInfo => ({ /* firstName and lastName: field names from HeyReach's docs, not yet seen on a real account. */ name: [a.firstName, a.lastName].filter(Boolean).join(" ") || null, id: String(a.id), address: a.emailAddress ?? a.profileUrl ?? String(a.id), domain: "linkedin.com", channel: "linkedin", active: a.isActive !== false && a.authIsValid !== false, daily_limit: null, health: a.authIsValid === false ? 0 : 100, warm_days: null, bounce_rate: null, spam_rate: null }));
    },
    async listTemplates() { const j = await api("POST", "/campaign/GetAll", { body: { offset: 0, limit: 100 } }); return (j.items ?? []).map((c: any) => ({ id: String(c.id), name: c.name })); },
    async ensureContact(p) { if (!p.linkedin) throw new Error("HeyReach needs a LinkedIn profile."); return p.linkedin; },
    async createSequence() { throw new Error("HeyReach campaigns are made by a person."); },
    async addContacts(sequenceId, people) {
      // Adding leads to a paused HeyReach campaign starts it again, so nothing is ever added unless it is already running.
      const s = await state(sequenceId);
      if (s !== "active") return people.map((p) => ({ ref: p.ref, ok: false, reason: "campaign_not_running", retry_after_minutes: 15 }));
      for (const batch of chunks(people, 100)) await api("POST", "/campaign/AddLeadsToCampaignV2", { body: { campaignId: Number(sequenceId), accountLeadPairs: batch.map((p) => ({ lead: { firstName: p.first_name, lastName: p.last_name, profileUrl: p.linkedin, companyName: p.company, position: p.title ?? undefined } })) } });
      return people.map((p) => ({ ref: p.ref, ok: true, external_id: p.linkedin! }));
    },
    async removeContact(sequenceId, externalId) { await api("POST", "/campaign/StopLeadInCampaign", { body: { campaignId: Number(sequenceId), leadUrl: externalId } }); },
    async pauseSequence(id) { await api("POST", "/campaign/Pause", { query: { campaignId: id } }); },
    sequenceState: state,
    async events(since, sequenceIds) {
      const j = await api("POST", "/inbox/GetConversationsV2", { body: { filters: { campaignIds: sequenceIds.map(Number) }, offset: 0, limit: 100 } });
      if (!Array.isArray(j.items)) throw new Error("HeyReach's answer had no list in it.");
      const out: ToolEvent[] = [];
      for (const c of j.items ?? []) {
        const m = c.lastMessage ?? c;
        const at = c.lastMessageAt ?? m.createdAt;
        if (c.lastMessageSender !== "CORRESPONDENT" || !at || at < since) continue;
        out.push({ provider_message_id: `reply:${c.id}:${at}`, signal: "reply", channel: "linkedin", sequence_external_id: c.campaignId ? String(c.campaignId) : null, email: null, linkedin: c.correspondentProfile?.profileUrl ?? null, external_contact_id: c.correspondentProfile?.profileUrl ?? null, body: c.lastMessageText ?? null, at });
      }
      return out;
    },
    // HeyReach signs nothing, so the desk puts a secret in the webhook's address.
    verifyWebhook(req) {
      if (!sameSecret(req.query.secret, o.webhookSecret)) return null;
      const b = req.body as any;
      // What the campaign did: a connection request sent, one accepted, a message sent. No step comes with them.
      const did = HEYREACH_EVENTS[String(b?.event_type ?? "").toUpperCase()];
      if (did) {
        if (!b?.lead?.profile_url) return [];
        const at = b.timestamp ?? new Date().toISOString();
        return [{ provider_message_id: `${String(b.event_type).toLowerCase()}:${b.campaign?.id ?? ""}:${b.lead.profile_url}:${at}`, signal: did, channel: "linkedin", sequence_external_id: b.campaign?.id ? String(b.campaign.id) : null, email: null, linkedin: b.lead.profile_url, external_contact_id: b.lead.profile_url, body: null, at, step: null, sender: null }];
      }
      // HeyReach sends the event in lower case, and fires only on a lead's first reply: later replies come in through the poll.
      if (!["message_reply_received", "every_message_reply_received"].includes(String(b?.event_type ?? "").toLowerCase()) || !b?.lead?.profile_url) return [];
      // The thread holds our messages and theirs. Only what they sent is the reply.
      const theirs = (Array.isArray(b.recent_messages) ? b.recent_messages : []).filter((m: any) => m?.is_reply === true);
      const last = theirs.at(-1);
      const at = last?.timestamp ?? b.timestamp ?? new Date().toISOString();
      return [{ provider_message_id: `reply:${b.conversation_id}:${last?.timestamp ?? theirs.length}`, signal: "reply", channel: "linkedin", sequence_external_id: b.campaign?.id ? String(b.campaign.id) : null, email: b.lead.custom_email ? String(b.lead.custom_email).toLowerCase() : null, linkedin: b.lead.profile_url, external_contact_id: b.lead.profile_url, body: last?.message ?? null, at, thread_url: b.campaign?.id && b.conversation_id ? `https://app.heyreach.io/app/inbox/${b.campaign.id}/${b.conversation_id}` : "https://app.heyreach.io/app/inbox" }];
    },
  };
}

/* ------------------------------------------------------------- Smartlead */

const SMARTLEAD_STATE: Record<string, SequenceState> = { DRAFTED: "draft", ACTIVE: "active", PAUSED: "paused", STOPPED: "archived", COMPLETED: "archived", ARCHIVED: "archived" };

function smartleadEvent(b: any): ToolEvent | null {
  const signal = ({ EMAIL_REPLY: "reply", EMAIL_BOUNCE: "bounce", LEAD_UNSUBSCRIBED: "unsubscribe", EMAIL_SENT: "send" } as const)[b?.event_type as string];
  const email = b?.to_email ?? b?.sl_email_lead_email ?? b?.lead_email;
  if (!signal || !email) return null;
  return { provider_message_id: `${signal}:${b.stats_id ?? b.message_id ?? `${email}:${b.time_replied ?? b.event_timestamp}`}`, signal, channel: "email", sequence_external_id: b.campaign_id ? String(b.campaign_id) : null, email: String(email).toLowerCase(), linkedin: null, external_contact_id: b.sl_email_lead_id ? String(b.sl_email_lead_id) : null, body: b.reply_message?.text ?? b.reply_body ?? null, at: b.time_replied ?? b.event_timestamp ?? new Date().toISOString(), thread_url: "https://app.smartlead.ai/app/master-inbox" };
}

export function smartlead(o: Opts): Connector {
  const api = client("smartlead", o.fetch ?? fetch, "https://server.smartlead.ai/api/v1", { query: { api_key: o.apiKey } });
  return {
    name: "smartlead", channels: ["email"],
    capabilities: { reports: ["send", "reply", "bounce", "unsubscribe"], createsSequences: true, pause: "contact", events: "both", replyBodies: true, needsCrmRecord: false, observesLaunch: true, addsWhileDraft: true, reportsStops: true, appliesSettings: true },
    // Smartlead's own guidance is to add accounts with reputation above 80%; the desk's rule is stricter by default.
    healthFloor: 80,
    async listSenders() {
      const j = await api("GET", "/email-accounts/", { query: { offset: 0, limit: 100 } });
      const out: SenderInfo[] = [];
      for (const a of Array.isArray(j) ? j : []) {
        const w = await api("GET", `/email-accounts/${a.id}/warmup-stats`);
        const sent = Number(w.sent_count ?? w.total_sent ?? 0), spam = Number(w.spam_count ?? 0);
        const rep = parseFloat(String(w.warmup_reputation ?? a.warmup_details?.warmup_reputation ?? ""));
        out.push({ id: String(a.id), address: a.from_email, domain: String(a.from_email).split("@")[1], channel: "email", active: a.is_smtp_success !== false && a.is_imap_success !== false, daily_limit: a.message_per_day ?? a.max_email_per_day ?? null, health: Number.isNaN(rep) ? null : rep, warm_days: daysSince(a.warmup_details?.warmup_created_at), bounce_rate: null, spam_rate: sent ? spam / sent : null });
      }
      return out;
    },
    async assignSenders(id, senders) { await api("POST", `/campaigns/${id}/email-accounts`, { body: { email_account_ids: senders.map((s) => Number(s.id)) } }); },
    async registerWebhooks(id, url) {
      const have = await api("GET", `/campaigns/${id}/webhooks`);
      if ((Array.isArray(have) ? have : []).some((w: any) => w.webhook_url === url)) return;
      await api("POST", `/campaigns/${id}/webhooks`, { body: { id: null, name: "Events Desk", webhook_url: url, event_types: ["EMAIL_REPLY", "EMAIL_BOUNCE", "LEAD_UNSUBSCRIBED", "EMAIL_SENT"], categories: [] } });
    },
    async pushCopy(id, steps) { await api("POST", `/campaigns/${id}/sequences`, { body: { sequences: steps.map((s, i) => ({ seq_number: i + 1, seq_delay_details: { delay_in_days: i ? s.day - steps[i - 1].day : 0 }, subject: s.subject ?? "", email_body: s.body })) } }); },
    async readCopy(id) {
      const j = await api("GET", `/campaigns/${id}/sequences`);
      if (!Array.isArray(j) || !j.length || j[0].email_body === undefined) return null;
      let day = 0;
      return j.map((s: any, i: number) => { if (i) day += s.seq_delay_details?.delay_in_days ?? 0; return { day, subject: s.subject || undefined, body: s.email_body }; });
    },
    async applySettings(id, x) {
      await api("POST", `/campaigns/${id}/schedule`, { body: { timezone: x.timezone, days_of_the_week: x.days, start_hour: x.from, end_hour: x.to, max_new_leads_per_day: x.daily_limit } });
      await api("POST", `/campaigns/${id}/settings`, { body: { track_settings: [...(x.track_opens ? [] : ["DONT_TRACK_EMAIL_OPEN"]), ...(x.track_links ? [] : ["DONT_TRACK_LINK_CLICK"])], stop_lead_settings: x.stop_on_reply ? "REPLY_TO_AN_EMAIL" : "CLICK_ON_A_LINK" } });
    },
    async readSettings(id) {
      const j = await api("GET", `/campaigns/${id}`), sc = j.scheduler_cron_value;
      if (!sc) return null;
      return { timezone: sc.tz, from: sc.startHour, to: sc.endHour, days: [...sc.days].sort(), stop_on_reply: j.stop_lead_settings === "REPLY_TO_AN_EMAIL", track_opens: !(j.track_settings ?? []).includes("DONT_TRACK_EMAIL_OPEN"), track_links: !(j.track_settings ?? []).includes("DONT_TRACK_LINK_CLICK"), daily_limit: j.max_leads_per_day };
    },
    async listTemplates() { const j = await api("GET", "/campaigns"); return (Array.isArray(j) ? j : []).map((c: any) => ({ id: String(c.id), name: c.name })); },
    async ensureContact(p) { const e = need(p); if (!e) throw new Error("Smartlead needs an email address."); return e; },
    async createSequence(name, templateId) {
      const j = await api("POST", "/campaigns/create", { body: { name } });
      const from = await api("GET", `/campaigns/${templateId}/sequences`);
      await api("POST", `/campaigns/${j.id}/sequences`, { body: { sequences: from } });
      return String(j.id);
    },
    async addContacts(sequenceId, people) {
      const out: AddResult[] = [];
      for (const batch of chunks(people, 100)) {
        await api("POST", `/campaigns/${sequenceId}/leads`, { body: { lead_list: batch.map((p) => ({ email: p.email, first_name: p.first_name, last_name: p.last_name, company_name: p.company })), settings: { ignore_duplicate_leads_in_other_campaign: false } } });
        for (const p of batch) {
          const j = await api("GET", "/leads/", { query: { email: p.email! } });
          out.push(j?.id ? { ref: p.ref, ok: true, external_id: String(j.id) } : { ref: p.ref, ok: false, reason: "not_accepted", retry_after_minutes: 60 });
        }
      }
      return out;
    },
    async removeContact(s, id) { await api("DELETE", `/campaigns/${s}/leads/${id}`); },
    async pauseContact(s, id) { await api("POST", `/campaigns/${s}/leads/${id}/pause`); },
    async resumeContact(s, id) { await api("POST", `/campaigns/${s}/leads/${id}/resume`, { body: { resume_lead_with_delay_days: 0 } }); },
    async pauseSequence(id) { await api("POST", `/campaigns/${id}/status`, { body: { status: "PAUSED" } }); },
    async sequenceState(id) { const j = await api("GET", `/campaigns/${id}`); return SMARTLEAD_STATE[j.status as string] ?? "paused"; },
    async events(since, sequenceIds) {
      const out: ToolEvent[] = [];
      for (const id of sequenceIds) {
        const j = await api("GET", `/campaigns/${id}/statistics`, { query: { email_status: "replied", offset: 0, limit: 100 } });
        if (!Array.isArray(j.data)) throw new Error("Smartlead's answer had no list in it.");
        for (const r of j.data ?? []) {
          if (!r.reply_time || r.reply_time < since) continue;
          out.push({ provider_message_id: `reply:${r.stats_id}`, signal: "reply", channel: "email", sequence_external_id: id, email: String(r.lead_email).toLowerCase(), linkedin: null, external_contact_id: null, body: r.reply_text ?? null, at: r.reply_time });
        }
      }
      return out;
    },
    verifyWebhook(req) {
      const b = req.body as any;
      if (!sameSecret(b?.secret_key, o.webhookSecret)) return null;
      const e = smartleadEvent(b);
      return e ? [e] : [];
    },
  };
}

/* ---------------------------------------------------------------- Apollo */

export function apollo(o: Opts): Connector {
  const api = client("apollo", o.fetch ?? fetch, "https://api.apollo.io/api/v1", { headers: { "x-api-key": o.apiKey } });
  return {
    name: "apollo", channels: ["email"],
    // A contact can be stopped but not started again through the API, so a pause is a removal. Reply text is not reliably available, so the desk works from status.
    capabilities: { reports: ["reply", "bounce"], createsSequences: false, pause: "remove-only", events: "poll", replyBodies: false, needsCrmRecord: false, observesLaunch: true, addsWhileDraft: true, reportsStops: true, appliesSettings: false },
    async listTemplates() { const j = await api("POST", "/emailer_campaigns/search", { body: { per_page: 100 } }); return (j.emailer_campaigns ?? []).map((c: any) => ({ id: c.id, name: c.name })); },
    async ensureContact(p) {
      const j = await api("POST", "/contacts", { body: { first_name: p.first_name, last_name: p.last_name, email: p.email, organization_name: p.company, title: p.title ?? undefined, run_dedupe: true } });
      return j.contact.id;
    },
    async createSequence() { throw new Error("Apollo sequences are made by a person."); },
    async addContacts(sequenceId, people) {
      const out: AddResult[] = [];
      for (const batch of chunks(people, 100)) {
        const j = await api("POST", `/emailer_campaigns/${sequenceId}/add_contact_ids`, { body: { contact_ids: batch.map((p) => p.external_id), emailer_campaign_id: sequenceId, sequence_no_email: false, sequence_active_in_other_campaigns: false } });
        const skipped = new Set(Object.values(j.skipped_contact_ids ?? {}).flat().map(String).concat(Object.keys(j.skipped_contact_ids ?? {})));
        for (const p of batch) out.push(skipped.has(p.external_id) ? { ref: p.ref, ok: false, reason: "tool_refused", retry_after_minutes: 240 } : { ref: p.ref, ok: true, external_id: p.external_id });
      }
      return out;
    },
    async removeContact(s, id) { await api("POST", "/emailer_campaigns/remove_or_stop_contact_ids", { body: { emailer_campaign_ids: [s], contact_ids: [id], mode: "remove" } }); },
    async pauseSequence(id) { await api("POST", `/emailer_campaigns/${id}/deactivate`, { body: {} }); },
    async sequenceState(id) {
      const c = (await api("GET", `/emailer_campaigns/${id}`)).emailer_campaign;
      if (c.archived) return "archived";
      return c.active ? "active" : c.last_used_at ? "paused" : "draft";
    },
    async events(since, sequenceIds) {
      const out: ToolEvent[] = [];
      for (const id of sequenceIds) {
        const j = await api("POST", "/emailer_messages/search", { body: { emailer_campaign_ids: [id], per_page: 100 } });
        if (!Array.isArray(j.emailer_messages)) throw new Error("Apollo's answer had no list in it.");
        // The server-side filters are reported unreliable, so each message's own flags are read here.
        for (const m of j.emailer_messages ?? []) {
          const at = m.replied_at ?? m.bounced_at;
          if (!at || at < since) continue;
          out.push({ provider_message_id: `${m.bounced_at ? "bounce" : "reply"}:${m.id}`, signal: m.bounced_at ? "bounce" : "reply", channel: "email", sequence_external_id: id, email: m.to_email ? String(m.to_email).toLowerCase() : null, linkedin: null, external_contact_id: m.contact_id ?? null, body: null, at });
        }
      }
      return out;
    },
    verifyWebhook() { return null; },
  };
}

/* ------------------------------------------------------------------ Gong */

export function gong(o: Opts & { accessKey: string; flowOwnerEmail: string }): Connector {
  const api = client("gong", o.fetch ?? fetch, "https://api.gong.io/v2", { headers: { authorization: `Basic ${btoa(`${o.accessKey}:${o.apiKey}`)}` } });
  return {
    name: "gong", channels: ["email"],
    capabilities: { reports: [], createsSequences: false, pause: "remove-only", events: "poll", replyBodies: false, needsCrmRecord: true, observesLaunch: false, addsWhileDraft: true, reportsStops: false, appliesSettings: false },
    async listTemplates() { const j = await api("GET", "/flows"); return (j.flows ?? []).map((f: any) => ({ id: f.id, name: f.name })); },
    async ensureContact(p) { if (!p.crm_id) throw new Error("Gong assigns by CRM record."); return p.crm_id; },
    async createSequence() { throw new Error("Gong flows are made by a person."); },
    async addContacts(sequenceId, people) {
      const out: AddResult[] = [];
      for (const batch of chunks(people, 100)) {
        const j = await api("POST", "/flows/prospects/assign", { body: { crmProspectsIds: batch.map((p) => p.external_id), flowId: sequenceId, flowInstanceOwnerEmail: o.flowOwnerEmail } });
        const bad = new Set((j.errors ?? j.failedProspects ?? []).map((e: any) => String(e.crmProspectId ?? e)));
        for (const p of batch) out.push(bad.has(p.external_id) ? { ref: p.ref, ok: false, reason: "tool_refused", retry_after_minutes: 240 } : { ref: p.ref, ok: true, external_id: p.external_id });
      }
      return out;
    },
    async removeContact(s, id) { await api("POST", "/flows/prospects/unassign-flows-by-crm-prospect-id", { body: { crmProspectId: id, flowIds: [s] } }); },
    async pauseSequence() { throw new Error("Gong flows cannot be paused through its API."); },
    async sequenceState() { return "active"; },
    async events() { return []; },
    verifyWebhook() { return null; },
  };
}
