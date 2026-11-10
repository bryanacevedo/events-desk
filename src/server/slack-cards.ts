/* Every Slack card the after-delivery work sends. One idea per card: a headline, a line or two with air around it, and one clear thing to do. Detail lives on the event's page, one click away. */
import { gateWords } from "../shared/gate-words.ts";

export interface CardMessage { text: string; blocks: unknown[] }

/** Anything from a person or a tool is plain text here: it cannot mention anyone or make a link. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const quote = (s: string) => esc(clip(s.replace(/\s+/g, " ").trim(), 320));

const header = (t: string) => ({ type: "header", text: { type: "plain_text", text: clip(t, 150) } });
const say = (t: string) => ({ type: "section", text: { type: "mrkdwn", text: t } });
const small = (t: string) => ({ type: "context", elements: [{ type: "mrkdwn", text: t }] });
const button = (text: string, action_id: string, value: string, style?: "primary" | "danger") => ({ type: "button", text: { type: "plain_text", text }, action_id, value, ...(style ? { style } : {}) });
const link = (text: string, url: string) => ({ type: "button", text: { type: "plain_text", text }, url, action_id: `link_${text.toLowerCase().replace(/\W+/g, "_")}` });

export const ACCOUNTS_PER_CARD = 12;

export interface OwnerAccount { decision_id: string; company: string; people: number; deal: string | null }

/** The default is include, so the only thing an owner ever has to press is Mine. */
export function ownerCard(eventName: string, accounts: OwnerAccount[], by: string, url?: string): CardMessage {
  const n = accounts.length;
  return {
    text: `${n} of your accounts ${n === 1 ? "is" : "are"} on the ${eventName} list. Keep any by ${by}.`,
    blocks: [
      header(`${eventName}: your accounts`),
      say(`We plan to reach out to ${n === 1 ? "this account" : `these ${n} accounts`} after the event.\nPress *Mine* on anything you want to handle yourself.`),
      { type: "divider" },
      ...accounts.slice(0, ACCOUNTS_PER_CARD).map((a) => ({
        ...say(`*${esc(a.company)}*\n${a.people} ${a.people === 1 ? "person" : "people"}${a.deal ? `  ·  ${esc(a.deal)}` : ""}`),
        accessory: button("Mine", "owner_mine", a.decision_id),
      })),
      { type: "divider" },
      { type: "actions", elements: [button(n === 1 ? "Include it" : "Include all", "owner_include_all", accounts.slice(0, ACCOUNTS_PER_CARD).map((a) => a.decision_id).join(","), "primary"), ...(url ? [link("Open event", url)] : [])] },
      small(`Nothing from you by *${esc(by)}* means include.`),
    ],
  };
}

export function ownerWarningCard(eventName: string, count: number, by: string): CardMessage {
  return { text: `Last call on ${count} ${eventName} accounts.`, blocks: [say(`*Last call on ${count} ${esc(eventName)} ${count === 1 ? "account" : "accounts"}.*\nAnything you have not marked Mine goes into sequences on ${esc(by)}.`)] };
}

const REPLY_WORDS: Record<string, string> = { interested: "is interested", meeting_request: "wants to meet", referral: "pointed us to someone else" };

export function replyCard(r: { event: string; person: string; company: string; code: string; body: string | null; contact_id: string; channel: string; url?: string }): CardMessage {
  const line = `*${esc(r.person)}* at *${esc(r.company)}* ${REPLY_WORDS[r.code] ?? "replied"}`;
  return {
    text: `${r.person} at ${r.company} ${REPLY_WORDS[r.code] ?? "replied"}`,
    blocks: [
      say(line),
      ...(r.body ? [say(`>${quote(r.body)}`)] : []),
      { type: "actions", elements: [button("Mark booked", "meeting_booked", r.contact_id, "primary"), ...(r.url ? [link("Open event", r.url)] : [])] },
      small(`Paused and waiting for a rep  ·  ${r.channel === "linkedin" ? "LinkedIn" : "Email"}`),
    ],
  };
}

export const doubtCard = (r: { person: string; company: string; body: string | null; url?: string }): CardMessage => ({
  text: `A reply from ${r.person} needs a person to read it.`,
  blocks: [
    say(`*A reply needs your eyes*\n${esc(r.person)} at ${esc(r.company)}`),
    ...(r.body ? [say(`>${quote(r.body)}`)] : []),
    ...(r.url ? [{ type: "actions", elements: [link("Decide", r.url)] }] : []),
    small("They stay paused until someone decides."),
  ],
});

export const meetingReminderCard = (m: { person: string; company: string; when: string; meeting_id: string }): CardMessage => ({
  text: `How did the meeting with ${m.person} go?`,
  blocks: [
    say(`*How did it go with ${esc(m.person)}?*\n${esc(m.company)}  ·  ${esc(m.when)}`),
    { type: "actions", elements: [button("Held", "meeting_held", m.meeting_id, "primary"), button("No show", "meeting_no_show", m.meeting_id), button("Cancelled", "meeting_cancelled", m.meeting_id)] },
  ],
});

export const debriefCard = (d: { event: string; meetings: number; debrief_id: string }): CardMessage => ({
  text: `What did you learn at ${d.event}?`,
  blocks: [
    header(`How was ${d.event}?`),
    say(`You held ${d.meetings} ${d.meetings === 1 ? "meeting" : "meetings"}. A few lines is plenty: who mattered, what they said, what you would do differently.`),
    { type: "actions", elements: [button("Write it", "debrief_open", d.debrief_id, "primary")] },
  ],
});

export const overdueCard = (r: { person: string; company: string }): CardMessage => ({
  text: `Nobody has answered ${r.person} at ${r.company}.`,
  blocks: [say(`*Nobody has answered ${esc(r.person)}*\n${esc(r.company)} replied and is still waiting for a rep.`)],
});

/** Something the desk did on its own, or could not do, that a person should know today. Sent once a day per problem. */
export const alertCard = (a: { text: string }): CardMessage => ({
  text: `Events Desk: ${a.text}`,
  blocks: [say(`*Events Desk needs a look*\n${esc(a.text)}`), small("Raised once a day while it lasts")],
});

export const digestCard = (d: { event: string; sent: number; replied: number; booked: number; waiting: number }): CardMessage => ({
  text: `${d.event} today: ${d.replied} replied, ${d.booked} booked.`,
  blocks: [header(d.event), { type: "section", fields: [{ type: "mrkdwn", text: `*Reached*\n${d.sent}` }, { type: "mrkdwn", text: `*Replied*\n${d.replied}` }, { type: "mrkdwn", text: `*Booked*\n${d.booked}` }, { type: "mrkdwn", text: `*Waiting on a rep*\n${d.waiting}` }] }],
});

export const launchCard = (s: { event: string; sequence: string; passed: number; removed: number }): CardMessage => ({
  text: `${s.sequence} is live.`,
  blocks: [say(`*${esc(s.sequence)} is live*`), small(`${s.passed} passed the launch check  ·  ${s.removed} came out`)],
});

export const scoreCard = (s: { event: string; held: number; line: string; url?: string }): CardMessage => ({
  text: `${s.event} is scored: ${s.line}`,
  blocks: [header(`${s.event}, scored`), say(`*${s.held}* held ${s.held === 1 ? "meeting" : "meetings"}\n${esc(s.line)}`), ...(s.url ? [{ type: "actions", elements: [link("See the scorecard", s.url)] }] : [])],
});

/* ------------------------------------------------------------ after the event */

const POST_WORDS: Record<string, string> = { scanned: "Scanned at the booth", reached: "Reached before, no reply", not_reached: "Not reached before" };
const WITH_REP: Record<string, string> = { met: "met a rep or had a meeting", hot: "hot scans", replied: "replied before the event" };
const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const channelWords = (c: string) => (c === "email" ? "by email" : "on LinkedIn");

/** The day after the event: who goes into the follow-up, by what happened there, after every check. One button. */
export function postEventCard(w: { event: string; event_id: string; counts: { channel: string; group: string; people: number; passing: number }[]; held: Record<string, number>; ready: number; last_press: string }): CardMessage {
  const ready = w.ready;
  const groups = ["scanned", "reached", "not_reached"].map((g) => {
    const rows = w.counts.filter((c) => c.group === g && c.passing > 0);
    return rows.length ? { type: "mrkdwn", text: `*${POST_WORDS[g]}*\n${rows.map((r) => `${r.passing} ${channelWords(r.channel)}`).join("\n")}` } : null;
  }).filter(Boolean);
  const withRep = Object.keys(WITH_REP).map((g) => [g, w.counts.filter((c) => c.group === g).reduce((n, c) => Math.max(n, c.people), 0)] as const).filter(([, n]) => n > 0).map(([g, n]) => `${n} ${WITH_REP[g]}`);
  const held = Object.entries(w.held).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${n} ${gateWords(r)}`);
  return {
    text: `${w.event} is over. ${ready} people are ready for the follow-up.`,
    blocks: [
      header(`Follow up on ${w.event}`),
      say(ready ? `*${ready} people are ready for the follow-up*, each group with its own message.` : "*Nobody is ready for the follow-up yet.* The reasons are below."),
      ...(groups.length ? [{ type: "section", fields: groups }] : []),
      ...(withRep.length ? [small(`With a rep, not sequenced  ·  ${withRep.join("  ·  ")}`)] : []),
      ...(held.length ? [small(`Held back by the checks  ·  ${held.join("  ·  ")}`)] : []),
      ...(ready ? [{ type: "actions", elements: [button("Start the follow-up", "post_event_start", w.event_id, "primary")] }] : []),
      small(`The button works until ${day(w.last_press)}. Nothing starts until someone presses it.`),
    ],
  };
}

export const postEventReminderCard = (w: { event: string; event_id: string; last_press: string }): CardMessage => ({
  text: `The follow-up for ${w.event} has not started.`,
  blocks: [say(`*The follow-up for ${esc(w.event)} has not started*\nThe sooner after the event, the better it lands.`), { type: "actions", elements: [button("Start the follow-up", "post_event_start", w.event_id, "primary")] }, small(`Works until ${day(w.last_press)}`)],
});

/** A hot conversation at the booth goes to the rep who had it, the same day. It never waits for a sequence. */
export const hotCaptureCard = (h: { person: string; company: string | null; note: string }): CardMessage => ({
  text: `Hot from the booth: ${h.person}${h.company ? ` at ${h.company}` : ""}. Follow up today.`,
  blocks: [say(`*Hot from the booth: ${esc(h.person)}*${h.company ? `\n${esc(h.company)}` : ""}`), ...(h.note.trim() ? [small(`“${quote(h.note)}”`)] : []), small("Follow up today. A task is in the CRM. This person stays out of every sequence.")],
});
