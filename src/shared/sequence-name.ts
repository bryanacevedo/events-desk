/* One name for a sequence, the same in the desk and in the sequencer's own campaign list, so a team can find, sort and filter it there.

   Desk | <start YYYY-MM> <event> | <Before | Follow-up> | <Email | LinkedIn> | <audience> | <region> | <desk id>

   - "Desk" first: every campaign the desk made can be filtered in the tool in one search.
   - The month the event starts, then its name: the tool's name sort puts campaigns in event order.
   - Every part is always there and always in this order and case; nothing is left out because it is the default.
   - The last six characters of the desk's own id end it. The desk finds its campaign again by this name after a crash, so it is unique.
   - ASCII separators only (" | "): some tools mangle other characters in a campaign name. At most 120 characters; the event name gives way first. */

export const AUDIENCE_WORDS: Record<string, string> = { A: "Priority A", B: "Priority B", C: "Priority C", scanned: "Scanned at booth", reached: "Reached before", not_reached: "Not reached before" };
export const REGION_WORDS: Record<string, string> = { americas: "Americas", emea: "EMEA", apac: "APAC", event: "Event region" };
const MAX = 120;

export function sequenceName(o: { event: string; startsOn: string; phase: "pre" | "post"; channel: "email" | "linkedin"; audience: string; region: string; id: string }): string {
  const tail = [o.phase === "pre" ? "Before" : "Follow-up", o.channel === "linkedin" ? "LinkedIn" : "Email", AUDIENCE_WORDS[o.audience] ?? o.audience.replace(/_/g, " "), REGION_WORDS[o.region] ?? o.region, o.id.slice(-6)].join(" | ");
  const head = `Desk | ${o.startsOn.slice(0, 7)} `;
  const room = MAX - head.length - tail.length - 3;
  const event = o.event.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim();
  return `${head}${event.length > room ? `${event.slice(0, Math.max(8, room - 1)).trimEnd()}.` : event} | ${tail}`;
}
