/* The RSVP state machine for a hosted event's guest (docs/HOSTED.md section 5 and 21.5). Pure: no database, no clock. Every writer asks `transition` before it moves a guest. */

export const GUEST_STATUSES = ["listed", "invited", "registered", "waitlist", "declined", "attended", "no_show"] as const;
export type GuestStatus = (typeof GUEST_STATUSES)[number];
export const isGuestStatus = (v: unknown): v is GuestStatus => typeof v === "string" && (GUEST_STATUSES as readonly string[]).includes(v);

export const STATUS_WORDS: Record<GuestStatus, string> = {
  listed: "Listed", invited: "Invited", registered: "Registered", waitlist: "Waitlist", declined: "Declined", attended: "Attended", no_show: "No-show",
};

/** Who is making the move. The guest answers on the public link; the host (or a planner, a lead, the guest's owner) writes on the desk; the system promotes and closes. */
export type Mover = "guest" | "host" | "system";
export interface MoveContext {
  by: Mover;
  /** Registered guests already fill the capacity. A guest's yes then lands on the waitlist. */
  atCapacity?: boolean;
  /** The event's first day has begun in its own zone. */
  dayBegan?: boolean;
  /** Attendance was closed for the event. */
  closed?: boolean;
  /** The move is a check-in being undone. */
  undo?: boolean;
  /** Reason given for a move to declined by the host. */
  reason?: string;
}

const OPEN: GuestStatus[] = ["listed", "invited", "registered", "waitlist"];
const ANY_BEFORE_DOOR: GuestStatus[] = ["listed", "invited", "registered", "waitlist", "declined", "no_show"];

/** The same sentence for every refusal of one kind, so a screen and a test can rely on it. */
export const REFUSAL = {
  passed: "The date has passed.",
  full: "The list is full.",
  room: "There is room, so this answer registers.",
  closed: "Attendance is closed.",
  illegal: (from: GuestStatus, to: GuestStatus) => `A guest cannot go from ${STATUS_WORDS[from].toLowerCase()} to ${STATUS_WORDS[to].toLowerCase()}.`,
  reason: "Say why they are not coming.",
} as const;

/** Returns the one-sentence refusal, or null when the move is allowed. */
export function transition(from: GuestStatus, to: GuestStatus, ctx: MoveContext): string | null {
  const { by } = ctx;
  const bad = () => REFUSAL.illegal(from, to);
  // A repeated yes edits the dietary text; a nudge repeats an invitation.
  if (from === to) {
    if ((from === "registered" || from === "waitlist") && by === "guest") return ctx.dayBegan ? REFUSAL.passed : null;
    if (from === "invited" && by === "host") return null;
    return bad();
  }
  switch (to) {
    case "invited": return from === "listed" && by === "host" ? null : bad();
    case "registered":
    case "waitlist": {
      if (by === "guest") {
        if (from !== "listed" && from !== "invited" && from !== "declined") return bad();
        if (ctx.dayBegan) return REFUSAL.passed;
        if (to === "registered" && ctx.atCapacity) return REFUSAL.full;
        if (to === "waitlist" && !ctx.atCapacity) return REFUSAL.room;
        return null;
      }
      // Promotion and the host's move take someone off the waitlist; an import may set either.
      if (from === "waitlist" && to === "registered" && (by === "system" || by === "host")) return null;
      if (by === "system" && (from === "listed" || from === "invited" || from === "declined")) return null;
      return bad();
    }
    case "declined": {
      if (!OPEN.includes(from)) return bad();
      if (by === "host" && !String(ctx.reason ?? "").trim()) return REFUSAL.reason;
      return by === "system" ? bad() : null;
    }
    case "attended": {
      if (by === "guest") return bad();
      if (from === "no_show" || OPEN.includes(from) || from === "declined") return null;
      return bad();
    }
    case "no_show": return from === "registered" && by !== "guest" ? (ctx.dayBegan ? null : "Attendance closes on the event's day or after it.") : bad();
    case "listed": return ctx.undo && from === "attended" ? null : bad();
    default: return bad();
  }
}

/** Undoing a check-in restores the status the guest had. Refused once attendance is closed. */
export function undoTransition(prior: GuestStatus | null, ctx: { closed?: boolean }): string | null {
  if (ctx.closed) return REFUSAL.closed;
  if (!prior) return "A walk-in is removed from the list, not put back.";
  return null;
}

/** An import never moves a guest backwards: listed < invited < waitlist < registered < attended. Declined and no-show are never overwritten except by attended. */
const ORDER: GuestStatus[] = ["listed", "invited", "waitlist", "registered", "attended"];
export function importMove(from: GuestStatus, to: GuestStatus): boolean {
  if (from === to) return false;
  if (to === "attended") return true;
  if (from === "declined" || from === "no_show" || from === "attended") return false;
  if (to === "declined") return false;
  return ORDER.indexOf(to) > ORDER.indexOf(from);
}

/** Only a registered guest holds a place. A waitlisted guest does not, and neither does anyone who has attended or been marked no-show (the door does not enforce capacity). */
export const HOLDS_A_PLACE: GuestStatus[] = ["registered"];
