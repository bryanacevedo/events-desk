/* The numbers the after-delivery rules run on, in one place. Each is explained in docs/LIFECYCLE.md; change it here and there together. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Holds: how long a company or a person is left alone. LIFECYCLE §6. */
export const LIVE_THREAD_HOLD_DAYS = 14;
export const MEETING_HOLD_DAYS = 30;
export const AFTER_OUTCOME_HOLD_DAYS = 14;

/** A no carries to the next event, for a while. LIFECYCLE §7. */
export const NOT_NOW_COOL_OFF_DAYS = 90;
export const NOT_INTERESTED_COOL_OFF_DAYS = 180;

/** Someone waiting to be added this long is checked again before going in. */
export const REGATE_AFTER_MINUTES = 15;

/** A sequence pauses itself when bounces pass this rate, once it has sent enough to judge. LIFECYCLE §5a. */
export const BOUNCE_PAUSE_RATE = 0.03;
export const BOUNCE_MIN_SENDS = 50;

/** The post-event wave (LIFECYCLE §5b): the press works until this many days after the last day; its sequences end this many days after; a template's steps span at most this many days. */
export const POST_START_LATEST_DAYS = 10;
export const POST_WAVE_END_DAYS = 24;
export const POST_TEMPLATE_MAX_DAYS = 10;
/** An event's Slack channel is archived this many days after the event's last day (Bryan, 2026-11-10). Slack keeps its history. */
export const ROOM_ARCHIVE_DAYS = 90;

/** CRM deal stages late enough that the owner should hear before anyone is sequenced. */
export const DEFAULT_LATE_STAGES = ["proposal", "negotiation", "contract", "closing", "verbal"];
