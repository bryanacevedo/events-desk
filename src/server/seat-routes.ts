/* Seats over HTTP: the catalog of events, seat requests, and the demo decision route. Slack decides
   them in a live setup (slack.ts). The requester is always the person acting. */

import type { Hono } from "hono";
import type { Db } from "./db.ts";
import { RuleError } from "./events.ts";
import { isLead } from "./money.ts";
import { approvalHeadroom } from "./budget.ts";
import { addCatalogEntry, decideSeat, Forbidden, Invalid, parseCatalogEntry, parseSeatRequest, requestSeat } from "./seats.ts";
import { postSeatRequest, type SlackConfig } from "./slack.ts";

export const CATALOG_SQL = `
  WITH live AS (SELECT DISTINCT ON (catalog_id) id, catalog_id, stage FROM events WHERE catalog_id IS NOT NULL AND stage <> 'declined' AND parent_event_id IS NULL ORDER BY catalog_id, created_at DESC)
  SELECT c.id, c.name, c.venue, c.city, c.country, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, c.website, c.brand_color, c.seat_price_cents, c.price_is_estimate,
         c.source, c.confidence, c.source_url, c.size, l.id AS event_id, l.stage,
         (SELECT count(*)::int FROM seat_requests r WHERE r.event_id = l.id AND r.status = 'approved') AS going,
         (SELECT count(*)::int FROM seat_requests r WHERE r.event_id = l.id AND r.status = 'pending') AS waiting
  FROM catalog_events c LEFT JOIN live l ON l.catalog_id = c.id ORDER BY c.starts_on, c.name`;

export const REQUESTS_SQL = `
  SELECT r.id, r.event_id, e.name, e.venue, e.starts_on::text AS starts_on, e.stage, e.seat_price_cents, c.website, c.brand_color,
         coalesce(c.price_is_estimate, false) AS price_is_estimate, (r.suggestion IS NOT NULL AND r.catalog_id IS NULL) AS is_new,
         r.requester, r.team, r.role, r.goal, r.why_event, r.why_you, r.expected_meetings, r.known_accounts, r.travel_cents, r.decide_by::text AS decide_by,
         (SELECT p.amount_cents FROM ticket_purchases p WHERE p.seat_request_id = r.id) AS ticket_cents,
         r.status, r.decided_by, r.decline_reason, r.created_at,
         (SELECT count(*)::int FROM seat_requests x WHERE x.event_id = r.event_id AND x.status = 'approved') AS approved_on_event
  FROM seat_requests r JOIN events e ON e.id = r.event_id LEFT JOIN catalog_events c ON c.id = r.catalog_id
  WHERE e.parent_event_id IS NULL
  ORDER BY e.starts_on, e.name, r.created_at`;

export function mountSeatRoutes(app: Hono<any>, db: Db, cfg: { demo: boolean; slack?: SlackConfig }) {
  app.get("/api/catalog", async (c) => c.json({ catalog: await db.query(CATALOG_SQL) }));
  // Add event, from the Events tab. GTM Engineering and the seat approvers only; the server decides, not the screen.
  app.post("/api/catalog", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    try { return c.json(await addCatalogEntry(db, c.get("actor"), parseCatalogEntry(body)), 201); }
    catch (e) {
      if (e instanceof Forbidden) return Response.json({ error: e.message }, { status: 403 });
      if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
  });
  app.get("/api/seat-requests", async (c) => {
    const room = await approvalHeadroom(db);
    const lead = isLead(c.get("actor"));
    // Budget headroom is leadership's; a rep sees ticket prices and the travel on their own requests, nobody else's.
    const requests = (await db.query<{ id: string; requester?: string; travel_cents?: number | null }>(REQUESTS_SQL)).map((r) => lead
      ? { ...r, budget: room.get(r.id) ?? null }
      : { ...r, travel_cents: r.requester === c.get("actor") ? r.travel_cents ?? null : null, budget: null });
    return c.json({ requests });
  });

  app.post("/api/seat-requests", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const actor: string = c.get("actor");
    try {
      const made = await requestSeat(db, actor, parseSeatRequest(actor, body), { approvers: cfg.slack?.approvers });
      if (cfg.slack) await postSeatRequest(db, cfg.slack, made.id);
      return c.json(made, 201);
    } catch (e) {
      if (e instanceof Forbidden) return Response.json({ error: e.message }, { status: 403 });
      if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
  });

  // The Slack-style panel. This route does not exist outside demo mode; a live setup decides in Slack.
  if (cfg.demo) {
    app.post("/api/seat-requests/:id/decision", async (c) => {
      const b = await c.req.json<{ decision?: string; reason?: string }>().catch(() => ({}) as { decision?: string; reason?: string });
      if (b.decision !== "approve" && b.decision !== "decline") return Response.json({ error: "Choose approve or decline." }, { status: 400 });
      try { return c.json(await decideSeat(db, { requestId: c.req.param("id"), actor: c.get("actor"), decision: b.decision, reason: b.reason, userMap: cfg.slack?.userMap })); }
      catch (e) { if (e instanceof RuleError) return Response.json({ error: e.message }, { status: 409 }); throw e; }
    });
  }
}
