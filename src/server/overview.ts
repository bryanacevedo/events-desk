/* Read-only numbers for the Overview: the lists delivered lately, with people by priority and
   the Sheet link when one exists. Everything else on the Overview comes from routes that already exist. */

import type { Db } from "./db.ts";

export interface DeliveredLately {
  id: string; name: string; venue: string; starts_on: string; delivered_at: string; sheet_url: string | null;
  a: number; b: number; c: number; website: string | null;
}

export async function overview(db: Db): Promise<{ delivered: DeliveredLately[] }> {
  const delivered = await db.query<DeliveredLately>(
    `SELECT e.id, e.name, e.venue, e.starts_on::text AS starts_on, e.stage_changed_at AS delivered_at, e.sheet_url,
            (SELECT k.website FROM catalog_events k WHERE k.id = e.catalog_id) AS website,
            (SELECT count(*)::int FROM contacts c WHERE c.event_id = e.id AND c.dropped_at IS NULL AND c.priority = 'A') AS a,
            (SELECT count(*)::int FROM contacts c WHERE c.event_id = e.id AND c.dropped_at IS NULL AND c.priority = 'B') AS b,
            (SELECT count(*)::int FROM contacts c WHERE c.event_id = e.id AND c.dropped_at IS NULL AND c.priority = 'C') AS c
     FROM events e WHERE e.stage = 'delivered' AND e.parent_event_id IS NULL ORDER BY e.stage_changed_at DESC, e.starts_on DESC LIMIT 8`,
  );
  return { delivered };
}
