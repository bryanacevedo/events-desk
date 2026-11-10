/* After delivery, the steps an event goes through, shared by the event header and the Overview cards so the two never disagree. */

import type { EventRow } from "../shared/domain";
import { addDays } from "../shared/motion";
import { POST_START_LATEST_DAYS, POST_WAVE_END_DAYS } from "../shared/policy";

/** The demo runs on conferences that already happened and keeps them in their follow-up window, as the server does (`demoCalendar`). Set once by the app. */
let demoCalendar = false;
export const setDemoCalendar = (on: boolean) => { demoCalendar = on; };
const windowOpen = (last: string, today: string) => demoCalendar || today <= addDays(last, POST_START_LATEST_DAYS);

/** After delivery the steps that built the list fold into one, and the same bar carries on. One timeline for the whole life of the event. */
export const AFTER: [string, string, string][] = [["none", "List ready", "Ready for outreach"], ["owners", "Owners", "With account owners"], ["sequencing", "Sequences", "Being set up"], ["in_market", "In market", "Live"], ["follow_up", "Follow-up", "Following up"], ["closing", "Closing", ""], ["scored", "Scored", ""]];

/** Where a delivered event is. In market is the outreach before it; Follow-up is from the day after its last day until the wave ends (LIFECYCLE §5b). */
export function afterStep(e: EventRow): { key: string; caption?: string } {
  const m = e.motion ?? "none", last = e.last_day, today = new Date().toISOString().slice(0, 10);
  // After the event, with no follow-up started: sequences that are still being set up are the follow-up waiting for its press.
  if (last && m === "sequencing" && today > last && !e.post_started_at) return { key: "follow_up", caption: windowOpen(last, today) ? "Ready to start" : "Not started" };
  if (!last || !["in_market", "closing"].includes(m) || today <= last) return { key: m };
  if (e.post_started_at) return today < addDays(last, POST_WAVE_END_DAYS) ? { key: "follow_up" } : { key: m === "in_market" ? "follow_up" : m };
  if (m === "in_market") return { key: "follow_up", caption: windowOpen(last, today) ? "Ready to start" : "Not started" };
  return { key: m };
}


const STEP_WORDS: Record<string, string> = { none: "Outreach list ready", owners: "With account owners", sequencing: "Setting up sequences", in_market: "In market", follow_up: "Following up", closing: "Closing", scored: "Scored" };

/** A delivered event in a few words, the same on every screen. `waiting` is true when it is a person's move. */
export function deliveredWords(e: EventRow): { words: string; waiting: boolean } {
  const s = afterStep(e);
  if (s.key === "follow_up" && !e.post_started_at) return { words: s.caption === "Not started" ? "Follow-up not started" : "Follow-up ready", waiting: s.caption !== "Not started" };
  // A list that was never taken to outreach, on an event now over, is not still ready: it went unused.
  if (s.key === "none" && e.last_day && new Date().toISOString().slice(0, 10) > e.last_day) return { words: "No outreach", waiting: false };
  return { words: STEP_WORDS[s.key] ?? STEP_WORDS.none, waiting: false };
}
