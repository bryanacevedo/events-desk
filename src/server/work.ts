/* Small writes the pipeline and the review cases share: queueing a job, and the two ways a company or a
   contact stops, each with one reason from the design's list. */

import type { Db } from "./db.ts";
import { newId } from "./events.ts";

export const enqueue = (q: Db["query"], eventId: string, kind: string, payload: object) =>
  q("INSERT INTO jobs (id, event_id, kind, payload) VALUES ($1, $2, $3, $4::jsonb)", [newId("job"), eventId, kind, JSON.stringify(payload)]);

export function dropAtCompany(q: Db["query"], eventId: string, companyId: string, reason: string) {
  return Promise.all([
    q("UPDATE contacts SET drop_reason = $3, dropped_at = now() WHERE event_id = $1 AND company_id = $2 AND dropped_at IS NULL", [eventId, companyId, reason]),
    q("UPDATE source_rows SET drop_reason = $3, dropped_at = now() WHERE event_id = $1 AND company_id = $2 AND kind = 'company_only' AND dropped_at IS NULL", [eventId, companyId, reason]),
  ]);
}
export const dropContact = (db: Db, id: string, reason: string) => db.query("UPDATE contacts SET drop_reason = $2, dropped_at = now() WHERE id = $1 AND dropped_at IS NULL", [id, reason]);
