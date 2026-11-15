/* Per-person view choices (decision 81). The Overview comes in three layouts; each person keeps the one they pick, and anyone with no pick gets b. */

import type { Db } from "./db.ts";

export const OVERVIEW_VIEWS = ["a", "b", "c"] as const;
export type OverviewView = (typeof OVERVIEW_VIEWS)[number];
export const DEFAULT_OVERVIEW_VIEW: OverviewView = "b";
export const isOverviewView = (v: unknown): v is OverviewView => typeof v === "string" && (OVERVIEW_VIEWS as readonly string[]).includes(v);

export async function overviewView(db: Db, person: string): Promise<OverviewView> {
  if (!person.trim()) return DEFAULT_OVERVIEW_VIEW;
  const [r] = await db.query<{ choice: string }>("SELECT choice FROM person_view_prefs WHERE person = $1 AND screen = 'overview'", [person]);
  return r && isOverviewView(r.choice) ? r.choice : DEFAULT_OVERVIEW_VIEW;
}

export async function setOverviewView(db: Db, person: string, view: OverviewView): Promise<void> {
  await db.query(
    `INSERT INTO person_view_prefs (person, screen, choice) VALUES ($1, 'overview', $2)
     ON CONFLICT (person, screen) DO UPDATE SET choice = EXCLUDED.choice, updated_at = now()`, [person, view]);
}
