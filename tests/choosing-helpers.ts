/* Shared set-up for the choosing tests: the demo on the world with its past results, and small made-up past events with written scorecards. */

import type { Db } from "../src/server/db.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { mockLlm } from "../src/server/providers.ts";
import { seed } from "../src/server/seed.ts";
import { DREAMFORCE, M2020, seedPastResults } from "../src/server/seed-plan.ts";
import { simDeps } from "../src/server/sim-vendors.ts";
import { freshDb } from "./helpers.ts";

export const TODAY = "2026-11-24";
export const lifecycle = { connectors: {}, llm: mockLlm, now: () => new Date(`${TODAY}T12:00:00Z`) } as never;
export const clockOnly = { now: () => new Date(`${TODAY}T12:00:00Z`) };

/** The demo on the world, with the two past events' lists built and their results seeded (what node.ts does in the background). */
export async function demoWithResults(): Promise<Db> {
  const db = await freshDb();
  await seed(db, { real: true, today: TODAY, world: true });
  for (const id of [M2020, DREAMFORCE]) await processEvent(db, id, simDeps());
  await seedPastResults(db, lifecycle);
  return db;
}

export interface PastSpec { n: number; name?: string; size?: string | null; country?: string; goal?: number | null; held: number; cost_cents?: number; year?: number }

/** A past conference with a written 30-day scorecard, made directly: only the fields the choosing code reads. */
export async function addPast(db: Db, s: PastSpec) {
  const year = s.year ?? 2025, id = `evt_past_${s.n}`, cat = `cat_past_${s.n}`, name = s.name ?? `Past Conference ${s.n} ${year}`;
  const start = `${year}-0${1 + (s.n % 8)}-10`, end = `${year}-0${1 + (s.n % 8)}-12`;
  await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, seat_price_cents, size) VALUES ($1, $2, '', 'X', $3, $4, $5, 100000, $6)", [cat, name, s.country ?? "United States", start, end, s.size === undefined ? "flagship" : s.size]);
  await db.query("INSERT INTO events (id, name, starts_on, ends_on, seat_count, seat_price_cents, requested_by, stage, motion, catalog_id, country, goal_meetings_held) VALUES ($1, $2, $3, $4, 1, 1, 'Maya Ortiz', 'delivered', 'scored', $5, $6, $7)", [id, name, start, end, cat, s.country ?? "United States", s.goal === undefined ? 10 : s.goal]);
  const cost = s.cost_cents ?? 1_000_000;
  const score = s.held >= 5 && cost > 0 ? { held_per_thousand: Math.round((s.held / (cost / 100_000)) * 100) / 100, pipeline_per_dollar: null } : null;
  const metrics = { funnel: {}, logged_outside: 0, held_all: s.held, cost: { tickets_cents: 0, travel_cents: 0, ai_cents: 0, other_cents: cost, dollars_cents: cost, credits_by_step: {} }, cost_per_held_cents: null, influence: { available: false, opportunities: 0, pipeline_cents: 0, sourced: { n: 0, cents: 0 }, influenced: { n: 0, cents: 0 }, won: { n: 0, cents: 0 }, stale: 0 }, control: { available: false }, roi: { pipeline_per_dollar: null, won_per_dollar: null, cost_missing: [] }, score, past: { held_per_thousand: null, pipeline_per_dollar: null } };
  await db.query("INSERT INTO scorecards (id, event_id, window_days, metrics) VALUES ($1, $2, 30, $3::jsonb)", [`sc_past_${s.n}`, id, JSON.stringify(metrics)]);
  return id;
}

/** Fourteen past conferences where flagship events met their goal 5 of 6 times and regional events 1 of 8: a pattern that passes. */
export async function addPassingTable(db: Db) {
  for (let i = 0; i < 6; i++) await addPast(db, { n: i, size: "flagship", goal: 10, held: i < 5 ? 12 : 4 });
  for (let i = 6; i < 14; i++) await addPast(db, { n: i, size: "regional", goal: 10, held: i === 6 ? 12 : 4 });
}
