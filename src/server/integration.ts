/* Which other desks this install runs beside (docs/HOSTED.md 8). `INTEGRATED_WITH` is a comma list. This is a stub until the setting exists (step 6): the transactional sender
   runs whatever it names and does not depend on the sequencer, so the answer never changes whether a reminder goes. */

export const integratedWith = (env: Record<string, string | undefined> = process.env): string[] =>
  (env.INTEGRATED_WITH ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
