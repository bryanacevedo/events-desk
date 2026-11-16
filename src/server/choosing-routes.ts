/* Before the list, and choosing events over HTTP (docs/CHOOSING.md). Every /api/choosing and /api/target-accounts read is for planners, leadership and GTM
   (the middleware in app.ts refuses a rep with the standing money sentence). The tracker is counts only and goes through forRep anyway. */

import type { Context, Hono } from "hono";
import type { Db } from "./db.ts";
import { RuleError } from "./events.ts";
import { goalTracker } from "./goal-tracker.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { canPlan, forRep } from "./money.ts";
import { addPage, addSeriesLink, Invalid, NotFound, rejectMatch, removePage, restoreMatch } from "./overlap.ts";
import { Forbidden } from "./seats.ts";

export const CHOOSING_WRITER_REFUSAL = "Pages, matches and series links are written by planners, leadership and GTM Engineering.";
type Cfg = { demo: boolean; lifecycle?: LifecycleDeps };

export function mountChoosing(app: Hono<any>, db: Db, cfg: Cfg) {
  const body = async (c: Context): Promise<Record<string, any>> => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, any>;
  const refuse = (msg: string, status: 400 | 403 | 404) => Response.json({ error: msg }, { status });
  const run = async <T>(fn: () => Promise<T>, status: 200 | 201 = 200) => {
    try { return Response.json(await fn(), { status }); }
    catch (e) {
      if (e instanceof Invalid) return refuse(e.message, 400);
      if (e instanceof Forbidden) return refuse(e.message, 403);
      if (e instanceof NotFound) return refuse(e.message, 404);
      if (e instanceof RuleError) return Response.json({ error: e.message }, { status: 409 });
      throw e;
    }
  };
  const actorOf = (c: Context): string => c.get("actor");
  const writer = (c: Context) => canPlan(actorOf(c));

  app.get("/api/target-accounts", async (c) => {
    if (!writer(c)) return refuse("Target accounts are read by planners, leadership and GTM Engineering.", 403);
    const accounts = await db.query<{ id: string; name: string; domain: string | null; country: string | null; owner: string | null; open_deal: string | null; deal_stage: string | null; source: string; created_at: string }>(
      "SELECT id, name, domain, country, owner, open_deal, deal_stage, source, created_at::text AS created_at FROM target_accounts ORDER BY lower(name), id");
    const by_source: Record<string, number> = {};
    for (const a of accounts) by_source[a.source] = (by_source[a.source] ?? 0) + 1;
    return c.json({ accounts, total: accounts.length, by_source });
  });

  app.post("/api/choosing/:catalogId/pages", async (c) => {
    if (!writer(c)) return refuse(CHOOSING_WRITER_REFUSAL, 403);
    const b = await body(c);
    return run(() => addPage(db, actorOf(c), c.req.param("catalogId"), { kind: String(b.kind ?? ""), input: String(b.input ?? ""), filename: typeof b.filename === "string" ? b.filename : null, text: typeof b.text === "string" ? b.text : (undefined as never) }), 201);
  });
  app.delete("/api/choosing/pages/:id", async (c) => {
    if (!writer(c)) return refuse(CHOOSING_WRITER_REFUSAL, 403);
    return run(() => removePage(db, actorOf(c), c.req.param("id")));
  });
  app.post("/api/choosing/matches/:id/reject", async (c) => {
    if (!writer(c)) return refuse(CHOOSING_WRITER_REFUSAL, 403);
    const b = await body(c);
    return run(() => rejectMatch(db, actorOf(c), c.req.param("id"), b.reason));
  });
  app.post("/api/choosing/matches/:id/restore", async (c) => {
    if (!writer(c)) return refuse(CHOOSING_WRITER_REFUSAL, 403);
    return run(() => restoreMatch(db, actorOf(c), c.req.param("id")));
  });
  app.post("/api/choosing/series-links", async (c) => {
    if (!writer(c)) return refuse(CHOOSING_WRITER_REFUSAL, 403);
    const b = await body(c);
    return run(() => addSeriesLink(db, actorOf(c), b), 201);
  });

  // Counts only, for anyone who can read the event.
  app.get("/api/events/:id/goal-tracker", async (c) => {
    try { return c.json(forRep(await goalTracker(db, cfg.lifecycle, c.req.param("id")))); }
    catch (e) { if (e instanceof RuleError) return refuse(e.message, 404); throw e; }
  });
}
