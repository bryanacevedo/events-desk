/* The email asking an organizer for the attendee list (docs/EVENT-PLAN.md 8). Two fixed texts and a function that fills them. No model writes anything here,
   and the desk never sends it: a person copies it and sends it from their own mailbox. */

export const ORGANIZER_TEMPLATES = ["ask_for_list", "follow_up"] as const;
export type OrganizerTemplate = (typeof ORGANIZER_TEMPLATES)[number];

export interface OrganizerEmailInput {
  /** The event's name. */
  event: string;
  /** Who it goes to. Empty reads as no name. */
  organizer?: string;
  /** Who is sending it: the person's name. */
  sender: string;
  /** The sender's company. */
  company: string;
  /** What the team holds, in words: "12 conference passes". */
  ticket: string;
  /** The follow-up quotes the first email's date, YYYY-MM-DD. */
  first_sent_on?: string | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDay = (ymd: string) => { const [, m, d] = ymd.slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };

export function renderOrganizerEmail(template: OrganizerTemplate, i: OrganizerEmailInput): { subject: string; body: string } {
  const hello = i.organizer?.trim() ? `Hello ${i.organizer.trim()},` : "Hello,";
  const sign = `${i.sender.trim()}\n${i.company.trim()}`;
  if (template === "follow_up") {
    const when = i.first_sent_on ? `my note of ${longDay(i.first_sent_on)}` : "my earlier note";
    return {
      subject: `Following up: attendee list for ${i.event}`,
      body: `${hello}

I am following up on ${when} about the attendee list for ${i.event}. We hold ${i.ticket}.

Could you tell me whether the list is shared with ticket holders or with sponsors, in what form, and on what date we can expect it? If it is not shared, a one-line answer helps us plan around it.

Thank you,
${sign}`,
    };
  }
  return {
    subject: `Attendee list for ${i.event}`,
    body: `${hello}

${i.company.trim()} is taking part in ${i.event}. We hold ${i.ticket}.

Is the attendee list shared with ticket holders or with sponsors? If it is, could you tell me in what form (a download, an export, or an email) and on what date we can expect it?

Thank you,
${sign}`,
  };
}
