/* The assessment's questions and the checks on an answer (docs/EVENT-PLAN.md 4.4 and 8). Pure rules shared by the server and the screens.
   A model may propose an answer; code keeps it only when its quoted sentence is in the page the model was sent. A person confirms every answer. */

export const QUESTION_IDS = ["directory_present", "directory_tickets", "directory_fields", "can_hide", "download", "sponsor_adds", "terms"] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

export const SOURCE_KINDS = ["faq", "registration_terms", "app_store_listing", "prospectus", "organizer_email", "event_page", "other"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_WORDS: Record<SourceKind | "first_hand" | "last_year", string> = {
  faq: "FAQ", registration_terms: "Registration terms", app_store_listing: "App store listing", prospectus: "Sponsor prospectus", organizer_email: "Organizer email", event_page: "Event page", other: "Other", first_hand: "First hand", last_year: "Last year",
};

export interface Question {
  id: QuestionId;
  /** What the screen asks. */
  label: string;
  /** `choice`: one of `values`. `list`: a comma list drawn from `values`. `text`: free text up to `max` characters. */
  type: "choice" | "list" | "text";
  values: readonly string[];
  /** The words for each value on the screen. */
  words: Record<string, string>;
  max: number;
}

export const QUESTIONS: readonly Question[] = [
  { id: "directory_present", label: "Is there an attendee directory?", type: "choice", values: ["yes", "no", "unknown"], words: { yes: "Yes", no: "No", unknown: "Not known" }, max: 0 },
  { id: "directory_tickets", label: "Which tickets see it?", type: "text", values: [], words: {}, max: 300 },
  { id: "directory_fields", label: "What does it show about a person?", type: "list", values: ["name", "title", "company", "photo", "email", "linkedin", "country", "other"], words: { name: "Name", title: "Title", company: "Company", photo: "Photo", email: "Email", linkedin: "LinkedIn", country: "Country", other: "Other" }, max: 0 },
  { id: "can_hide", label: "Can an attendee hide?", type: "choice", values: ["yes", "no", "opt_in", "unknown"], words: { yes: "Yes", no: "No", opt_in: "Only by opting in", unknown: "Not known" }, max: 0 },
  { id: "download", label: "Can the list be downloaded?", type: "choice", values: ["web_app", "app", "emailed", "browse_only", "none", "unknown"], words: { web_app: "Download from the web app", app: "Download from the app", emailed: "Emailed by the organizer", browse_only: "Browse only", none: "No list", unknown: "Not known" }, max: 0 },
  { id: "sponsor_adds", label: "What does a sponsor get beyond that?", type: "list", values: ["lead_retrieval", "opt_in_list", "meeting_program", "in_app_search", "none"], words: { lead_retrieval: "Lead retrieval", opt_in_list: "Opt-in list", meeting_program: "Meeting program", in_app_search: "In-app search", none: "Nothing more" }, max: 0 },
  { id: "terms", label: "What do the terms say about using the list?", type: "text", values: [], words: {}, max: 300 },
];
export const questionOf = (id: string): Question | undefined => QUESTIONS.find((q) => q.id === id);

/** Free text and lists also take "unknown" when a person answers by hand: a person can say they do not know, and the page need not. A model never proposes it. */
export function answerError(question: string, answer: unknown, by: "model" | "person"): string | null {
  const q = questionOf(question);
  if (!q) return "That is not one of the assessment's questions.";
  if (typeof answer !== "string" || !answer.trim()) return "Give an answer.";
  const a = answer.trim();
  if (q.type === "choice") return q.values.includes(a) ? null : `The answer to "${q.label}" is one of: ${q.values.join(", ")}.`;
  if (q.type === "list") {
    if (by === "person" && a === "unknown") return null;
    const parts = a.split(",").map((s) => s.trim());
    return parts.length && parts.every((p) => q.values.includes(p)) && new Set(parts).size === parts.length ? null : `The answer to "${q.label}" is a comma list from: ${q.values.join(", ")}.`;
  }
  return a.length <= q.max ? null : `Keep the answer under ${q.max} characters.`;
}

/* ------------------------------------------------------------------ the conference, across years */

/** Lower case, years removed, every run of other characters one dash, no dash at either end. "Money20/20 USA 2026" gives money20-20-usa. */
export const conferenceKey = (name: string): string =>
  name.toLowerCase().replace(/\b\d{4}\b/g, " ").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

/* ------------------------------------------------------------------ the quote check */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: "..." };
/** HTML entities decoded: the named ones above and every numeric form. An entity it does not know is left as it was. */
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Both sides of the quote check read the same way: entities decoded, Unicode NFKC, curly quotes straight, every run of whitespace (a non-breaking space included) one space, trimmed. */
export const normalizeText = (s: string) =>
  decodeEntities(s).normalize("NFKC").replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"').replace(/\s+/g, " ").trim();

export const QUOTE_MIN = 12, QUOTE_MAX = 400, PAGE_MAX = 40_000;

/** The page as the model is sent it: the data markers neutralised the way websiteRead does, then cut to length. The quote check runs against exactly this. */
export const pageSent = (body: string) => body.replaceAll("PAGE>>>", "PAGE> >>").replaceAll("<<<PAGE", "<< <PAGE").slice(0, PAGE_MAX);

/** The quote as it stands in the page, normalised, or null when it is not there (case sensitive). `sent` is the text that went between the markers. */
export function quoteIn(sent: string, quote: unknown): string | null {
  if (typeof quote !== "string") return null;
  const q = normalizeText(quote);
  return q && normalizeText(sent).includes(q) ? q : null;
}

export interface Proposal { question: QuestionId; answer: string; detail: string; quote: string }
export type DropReason = "shape" | "question" | "answer" | "quote_short" | "quote_long" | "quote_missing";

/** One proposed answer against the page that was sent. Kept as a proposal with the matching quote, or dropped with the reason. */
export function validProposal(p: unknown, sent: string): { ok: true; value: Proposal } | { ok: false; why: DropReason } {
  if (!p || typeof p !== "object") return { ok: false, why: "shape" };
  const o = p as Record<string, unknown>;
  if (typeof o.question !== "string" || !questionOf(o.question)) return { ok: false, why: "question" };
  if (answerError(o.question, o.answer, "model")) return { ok: false, why: "answer" };
  if (typeof o.quote !== "string") return { ok: false, why: "shape" };
  const raw = normalizeText(o.quote);
  if (raw.length < QUOTE_MIN) return { ok: false, why: "quote_short" };
  if (raw.length > QUOTE_MAX) return { ok: false, why: "quote_long" };
  const found = quoteIn(sent, o.quote);
  if (!found) return { ok: false, why: "quote_missing" };
  return { ok: true, value: { question: o.question as QuestionId, answer: (o.answer as string).trim(), detail: typeof o.detail === "string" ? o.detail.trim().slice(0, 300) : "", quote: found } };
}
