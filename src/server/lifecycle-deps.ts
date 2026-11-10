/* What the after-delivery work needs from the outside world. */

import type { Connector } from "./connectors/types.ts";
import type { Crm, Llm } from "./providers.ts";
import type { CardMessage } from "./slack-cards.ts";
import type { MailAuth } from "./sending.ts";
import type { SendingRules } from "../shared/sending.ts";

/** The event's own Slack channel. `channel` is null until the first post opens it. */
export interface EventRoom { event_id: string; name: string; channel: string | null }

/** Slack, as the desk uses it: in the open. Nothing goes by direct message, so the team sees every reply, owner card and reminder. */
export interface Notifier {
  /** Posts to the event's channel, opening it the first time and inviting whoever is @-mentioned (Slack does not notify someone outside the channel). Returns the channel, or null when nothing was posted. */
  post(room: EventRoom, message: CardMessage, mention?: string[]): Promise<string | null>;
  /** Posts to the desk's ops channel: problems that belong to no one event. True only when it was delivered. */
  ops(message: CardMessage): Promise<boolean>;
  /** Adds people to a channel. True when they are in it, including when they already were. */
  invite?(channel: string, users: string[]): Promise<boolean>;
  /** Sets the channel's topic line. */
  topic?(channel: string, text: string): Promise<boolean>;
  /** Archives the channel. True when it is archived, including when it already was. */
  archive?(channel: string): Promise<boolean>;
}

export interface LifecycleDeps {
  crm?: Crm | null;
  connectors: Record<string, Connector>;
  llm: Llm;
  notify?: Notifier;
  userMap?: Record<string, string>;
  /** The desk's own address, for links in Slack (APP_URL). Without it, Slack text carries no link. */
  appUrl?: string;
  now?: () => Date;
  holidays?: string[];
  /** The demo only: past conferences stay in their follow-up window. Never set for real sending. */
  demoCalendar?: boolean;
  /** The sequence launch checks poll this often, and the screen states it. */
  pollMinutes?: number;
  sendingRules?: Partial<SendingRules>;
  mailAuth?: MailAuth;
  /** True when a placement test tool is in use: a domain with no recent passing test is not used. */
  placementRequired?: boolean;
  /** Where tools send their webhooks: the desk's public address plus /hooks/sequencer/<tool>. Absent, the desk polls. */
  webhookBase?: string;
  /** On a real tool, the first this many people in each sequence go out, and the rest wait for a person to look and release them. */
  firstCohort?: number;
  /** The company's own mail domains. Cold outreach never goes out from these. */
  primaryDomains?: string[];
}

export const nowOf = (d: LifecycleDeps) => d.now?.() ?? new Date();
export const DESK = "Events Desk";
