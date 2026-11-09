/* Every Slack card the after-delivery work sends. One idea per card: a headline, a line or two with air around it, and one clear thing to do. Detail lives on the event's page, one click away. */

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

export const launchCard = (s: { event: string; sequence: string; passed: number; removed: number }): CardMessage => ({
  text: `${s.sequence} is live.`,
  blocks: [say(`*${esc(s.sequence)} is live*`), small(`${s.passed} passed the launch check  ·  ${s.removed} came out`)],
});

export const scoreCard = (s: { event: string; held: number; line: string; url?: string }): CardMessage => ({
  text: `${s.event} is scored: ${s.line}`,
  blocks: [header(`${s.event}, scored`), say(`*${s.held}* held ${s.held === 1 ? "meeting" : "meetings"}\n${esc(s.line)}`), ...(s.url ? [{ type: "actions", elements: [link("See the scorecard", s.url)] }] : [])],
});
