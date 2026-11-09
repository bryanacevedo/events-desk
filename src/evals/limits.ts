/* Caps real model use in `make evals-live`. The full list is about 320 calls, so a
   run without an explicit EVALS_MAX_ITEMS makes at most DEFAULT_EVALS_MAX_ITEMS. */

export const DEFAULT_EVALS_MAX_ITEMS = 8;

type Env = Record<string, string | undefined>;

export function evalsMaxItems(env: Env = process.env): { limit: number; explicit: boolean } {
  const raw = env.EVALS_MAX_ITEMS?.trim();
  if (!raw) return { limit: DEFAULT_EVALS_MAX_ITEMS, explicit: false };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`EVALS_MAX_ITEMS must be a whole number of 1 or more, not "${raw}".`);
  return { limit: n, explicit: true };
}

/** How many items of each step to run, in order, never more than the limit in total.
    `full` is true only when every item runs, the one case that may overwrite a recording. */
export function planEvalRun(sizes: Record<string, number>, env: Env = process.env) {
  const { limit, explicit } = evalsMaxItems(env);
  let left = limit;
  const take: Record<string, number> = {};
  for (const [step, n] of Object.entries(sizes)) { take[step] = Math.min(n, left); left -= take[step]; }
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  const run = Object.values(take).reduce((a, b) => a + b, 0);
  return { limit, explicit, take, total, run, full: run === total };
}
