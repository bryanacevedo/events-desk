/* What the after-delivery work needs from the outside world. */

import type { Connector } from "./connectors/types.ts";
import type { Crm, Llm } from "./providers.ts";
import type { CardMessage } from "./slack-cards.ts";
import type { MailAuth } from "./sending.ts";
import type { SendingRules } from "../shared/sending.ts";

export interface Notifier {
  /** True only when the message was delivered. */
  dm(slackId: string, message: CardMessage): Promise<boolean>;
  /** Posts to the event's thread, starting one when `thread` is null. Returns the thread, or null when nothing was posted. */
  thread(thread: string | null, message: CardMessage): Promise<string | null>;
}

export interface LifecycleDeps {
  crm?: Crm | null;
  connectors: Record<string, Connector>;
  llm: Llm;
  notify?: Notifier;
  userMap?: Record<string, string>;
  now?: () => Date;
  holidays?: string[];
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
