/* A hard limit on real spend, applied to every real provider at once. When a run is
   live it may process at most REAL_RUN_MAX_ROWS source rows (default 4, because the
   Apollo account has 75 credits). A larger event is refused before the first paid
   call. Raising the limit needs an explicit env value; nothing else lifts it. */

import type { Db } from "./db.ts";

export const DEFAULT_REAL_RUN_MAX_ROWS = 4;

export class SpendGuardError extends Error {}

type Env = Record<string, string | undefined>;

export function realRunMaxRows(env: Env = process.env): number {
  const raw = env.REAL_RUN_MAX_ROWS?.trim();
  if (!raw) return DEFAULT_REAL_RUN_MAX_ROWS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new SpendGuardError(`REAL_RUN_MAX_ROWS must be a whole number of 1 or more, not "${raw}".`);
  return n;
}

/** Throws when `rows` source rows exceed the limit. Pure, so it is tested without a database. */
export function checkRealRun(rows: number, env: Env = process.env, what = "This event") {
  const max = realRunMaxRows(env);
  if (rows > max) {
    throw new SpendGuardError(
      `${what} has ${rows} source rows and a live run may process at most ${max} (REAL_RUN_MAX_ROWS). Refusing to start before any paid call. ` +
      `Upload an attendee list of ${max} rows or fewer, or set REAL_RUN_MAX_ROWS=${rows} explicitly if you mean to spend on all of them.`,
    );
  }
}

export async function assertRealRunAllowed(db: Db, eventId: string, env: Env = process.env) {
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM source_rows WHERE event_id = $1", [eventId]);
  checkRealRun(n, env, `Event ${eventId}`);
}
