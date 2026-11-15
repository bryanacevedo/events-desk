/* The definitions Events Desk owns, published read-only as numbered versions with a hash (docs/SHARED-WORLD.md section 6), in the shape of CRM Desk's
   `/api/v1/definitions`. Today there is one: `campaign_member_statuses`. A new version is appended when the body in code differs from the latest stored one. */

import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

export const DESK = "events_desk";
export interface StatusRow { key: string; label: string; meaning: string; applies: ("event" | "webinar")[]; responded: boolean }

/** In funnel order. `meaning` is what CRM Desk calls it; the three with no meaning there yet are `targeted`, `waitlist` and `declined` (part 3). */
export const MEMBER_STATUSES: StatusRow[] = [
  { key: "targeted", label: "Targeted", meaning: "targeted", applies: ["event", "webinar"], responded: false },
  { key: "invited", label: "Invited", meaning: "sent", applies: ["event", "webinar"], responded: false },
  { key: "registered", label: "Registered", meaning: "registered", applies: ["event", "webinar"], responded: false },
  { key: "waitlist", label: "Waitlist", meaning: "waitlist", applies: ["event", "webinar"], responded: false },
  { key: "declined", label: "Declined", meaning: "declined", applies: ["event", "webinar"], responded: false },
  { key: "attended", label: "Attended", meaning: "attended", applies: ["event", "webinar"], responded: true },
  { key: "met", label: "Met", meaning: "met", applies: ["event"], responded: true },
  { key: "watched_later", label: "Watched later", meaning: "responded", applies: ["webinar"], responded: true },
  { key: "no_show", label: "No show", meaning: "no_show", applies: ["event", "webinar"], responded: false },
];
export const BODIES: Record<string, () => unknown> = { campaign_member_statuses: () => ({ statuses: MEMBER_STATUSES.map((s) => ({ ...s, applies: [...s.applies].sort() })) }) };

/** JSON with sorted keys, no spaces, non-ASCII kept: CRM Desk's algorithm, so one hash means one body on both sides. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
export const hashOf = (body: unknown) => "sha256:" + createHash("sha256").update(canonical(body), "utf8").digest("hex");

interface Version { name: string; owner_desk: string; version: number; hash: string; published_at: string; changed_by: string; body: unknown }

/** Appends a version for each definition whose body changed, then returns the latest of each. */
export async function publishAll(db: Db, changedBy = "system"): Promise<Version[]> {
  const out: Version[] = [];
  for (const [name, make] of Object.entries(BODIES)) {
    const body = make(), hash = hashOf(body);
    await db.tx(async (q) => {
      await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`definitions:${name}`]);
      const [last] = await q<{ version: number; hash: string }>("SELECT version, hash FROM definition_versions WHERE name = $1 ORDER BY version DESC LIMIT 1", [name]);
      if (!last || last.hash !== hash) await q("INSERT INTO definition_versions (name, version, hash, body, changed_by) VALUES ($1, $2, $3, $4::jsonb, $5)", [name, (last?.version ?? 0) + 1, hash, JSON.stringify(body), changedBy]);
    });
    const [v] = await db.query<Version>("SELECT name, 'events_desk' AS owner_desk, version, hash, (to_json(published_at) #>> '{}') AS published_at, changed_by, body FROM definition_versions WHERE name = $1 ORDER BY version DESC LIMIT 1", [name]);
    out.push(v);
  }
  return out;
}

export async function listDefinitions(db: Db) {
  const defs = await publishAll(db);
  return { desk: DESK, schema_version: 1, as_of: new Date().toISOString(), definitions: defs,
    index: defs.map((d) => ({ name: d.name, owner_desk: d.owner_desk, version: d.version, hash: d.hash, read_at: null, link: `/api/definitions/${d.name}` })) };
}
export async function readDefinition(db: Db, name: string, version?: number): Promise<Version | null> {
  if (!(name in BODIES)) return null;
  await publishAll(db);
  const [v] = await db.query<Version>(`SELECT name, 'events_desk' AS owner_desk, version, hash, (to_json(published_at) #>> '{}') AS published_at, changed_by, body FROM definition_versions WHERE name = $1 ${version ? "AND version = $2" : ""} ORDER BY version DESC LIMIT 1`, version ? [name, version] : [name]);
  return v ?? null;
}
export async function definitionVersions(db: Db, name: string) {
  if (!(name in BODIES)) return null;
  await publishAll(db);
  return { name, versions: await db.query("SELECT version, hash, (to_json(published_at) #>> '{}') AS published_at, changed_by FROM definition_versions WHERE name = $1 ORDER BY version DESC", [name]) };
}
