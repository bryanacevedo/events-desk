/* Read routes the event page needs at volume. A list of 1,650 rows is never sent whole: the people and
   the companies of an event are searched, filtered and paged here, so the screen asks for 50 at a time. */

import { accountOf } from "./rep-day.ts";
import type { Hono } from "hono";
import type { Db } from "./db.ts";

const PAGE = 50, MAX = 200;
const int = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };
const like = (q: string | undefined) => { const s = (q ?? "").trim().slice(0, 80); return s ? `%${s.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : ""; };
// tier=unknown asks for companies with no tier yet; 0 means any tier.
const tierOf = (v: string | undefined) => (v === "unknown" ? -1 : [1, 2, 3].includes(Number(v)) ? Number(v) : 0);

export interface PersonRow {
  id: string; full_name: string | null; title: string | null; email: string | null; priority: "A" | "B" | "C" | null; title_tier: 1 | 2 | 3 | null;
  drop_reason: string | null; source: "attendee" | "prospect"; linkedin: string | null; employer: string | null;
  company: string | null; company_id: string | null; company_tier: 1 | 2 | 3 | null; flags: string[];
  /** How many events this person has been on, from the shared record. 0 when they have none. */
  seen_at: number; last_verified_at: string | null;
  /** Where this person is in outreach: their latest enrollment, latest reply and latest meeting. Null where there is none. */
  outreach: { state: string; cause: string | null; channel: string } | null; reply_code: string | null; meeting: string | null;
}
export interface CompanyRow {
  id: string; name: string; tier: 1 | 2 | 3 | null; tier_fact: string | null; industry: string | null; employees: string | null; country: string | null;
  list_status: string | null; identity_state: string; in_research: boolean; primary_domain: string | null; people: number; rows_total: number;
}

export function mountEventViews(app: Hono<{ Variables: { actor: string } }>, db: Db) {
  app.get("/api/events/:id/people", async (c) => {
    const id = c.req.param("id");
    const q = like(c.req.query("q")), priority = ["A", "B", "C"].includes(c.req.query("priority") ?? "") ? c.req.query("priority")! : "";
    const tier = tierOf(c.req.query("tier")), status = ["all", "dropped"].includes(c.req.query("status") ?? "") ? c.req.query("status")! : "kept";
    const source = ["attendee", "prospect"].includes(c.req.query("source") ?? "") ? c.req.query("source")! : "";
    const limit = Math.min(MAX, int(c.req.query("limit"), PAGE) || PAGE), offset = int(c.req.query("offset"), 0);
    const rows = await db.query<PersonRow & { total: number }>(
      `SELECT c.id, c.full_name, c.title, c.email, c.priority, c.title_tier, c.drop_reason, c.source, c.linkedin, c.employer,
              co.name AS company, co.id AS company_id, co.tier AS company_tier,
              coalesce((SELECT array_agg(f.flag ORDER BY f.flag) FROM review_flags f WHERE f.contact_id = c.id), '{}') AS flags,
              (SELECT count(DISTINCT coalesce(ev.parent_event_id, ev.id))::int FROM contacts x JOIN events ev ON ev.id = x.event_id WHERE x.person_id = c.person_id) AS seen_at,
              (SELECT p.last_verified_at FROM people p WHERE p.id = c.person_id) AS last_verified_at,
              (SELECT json_build_object('state', n.state, 'cause', n.cause, 'channel', n.channel) FROM enrollments n WHERE n.contact_id = c.id ORDER BY n.changed_at DESC LIMIT 1) AS outreach,
              (SELECT m.code FROM inbound_messages m WHERE m.contact_id = c.id AND m.signal = 'reply' ORDER BY m.received_at DESC LIMIT 1) AS reply_code,
              (SELECT mt.status FROM meetings mt WHERE mt.contact_id = c.id ORDER BY mt.scheduled_at DESC LIMIT 1) AS meeting,
              count(*) OVER()::int AS total
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       WHERE c.event_id = $1
         AND ($2::text = '' OR c.full_name ILIKE $2 OR c.title ILIKE $2 OR co.name ILIKE $2 OR c.email ILIKE $2)
         AND ($3::text = '' OR c.priority = $3)
         AND ($4::int = 0 OR ($4 = -1 AND co.tier IS NULL) OR co.tier = $4)
         AND ($5::text = 'all' OR ($5 = 'kept' AND c.dropped_at IS NULL) OR ($5 = 'dropped' AND c.dropped_at IS NOT NULL))
         AND ($8::text = '' OR c.source = $8)
       ORDER BY c.dropped_at IS NOT NULL, c.priority NULLS LAST, co.tier NULLS LAST, co.name NULLS LAST, c.full_name, c.id
       LIMIT $6 OFFSET $7`, [id, q, priority, tier, status, limit, offset, source]);
    const total = rows[0]?.total ?? 0;
    return c.json({ total, offset, limit, rows: rows.map(({ total: _t, ...r }) => r) });
  });

  // One company, opened from the list: what the desk knows of it and everyone from it on this event.
  app.get("/api/events/:id/companies/:cid", async (c) => {
    const a = await accountOf(db, c.req.param("id"), { companyId: c.req.param("cid") }, 100);
    if (!a) return c.json({ error: "That company is not on this event." }, 404);
    const [x] = await db.query<{ tier_fact: string | null; country: string | null; list_status: string | null }>("SELECT tier_fact, firmo->>'country' AS country, list_status FROM companies WHERE id = $1", [a.company_id]);
    return c.json({ ...a, ...x });
  });

  app.get("/api/events/:id/companies", async (c) => {
    const id = c.req.param("id");
    const q = like(c.req.query("q")), tier = tierOf(c.req.query("tier"));
    const limit = Math.min(MAX, int(c.req.query("limit"), PAGE) || PAGE), offset = int(c.req.query("offset"), 0);
    // "people" puts the companies with the most people kept first: the top of the list at a glance.
    const order = c.req.query("sort") === "people" ? "people DESC, co.tier NULLS LAST, co.name" : "co.tier NULLS LAST, people DESC, co.name";
    const rows = await db.query<CompanyRow & { total: number }>(
      `SELECT x.*, count(*) OVER()::int AS total FROM (
         SELECT co.id, co.name, co.tier, co.tier_fact, co.firmo->>'industry' AS industry, co.firmo->>'employees' AS employees, co.firmo->>'country' AS country,
                co.list_status, co.identity_state, co.in_research, co.primary_domain,
                (SELECT count(*)::int FROM contacts k WHERE k.company_id = co.id AND k.dropped_at IS NULL) AS people,
                (SELECT count(*)::int FROM contacts k WHERE k.company_id = co.id) AS rows_total
         FROM companies co
         WHERE co.event_id = $1 AND ($2::text = '' OR co.name ILIKE $2)
           AND ($3::int = 0 OR ($3 = -1 AND co.tier IS NULL) OR co.tier = $3)
       ) x
       ORDER BY ${order.replace(/co\./g, "x.")} LIMIT $4 OFFSET $5`, [id, q, tier, limit, offset]);
    const total = rows[0]?.total ?? 0;
    return c.json({ total, offset, limit, rows: rows.map(({ total: _t, ...r }) => r) });
  });
}
