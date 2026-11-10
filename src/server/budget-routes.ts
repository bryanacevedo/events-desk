/* Budget and Usage over HTTP. Reads are open; changing the budget and recording a ticket are for approvers. */

import type { Hono } from "hono";
import type { Db } from "./db.ts";
import { budgetView, NotApprover, recordTicket, setBudget } from "./budget.ts";
import { RuleError } from "./events.ts";
import { usageView } from "./usage.ts";

const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
const refuse = (e: unknown) => {
  if (e instanceof NotApprover) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof RuleError) return Response.json({ error: e.message }, { status: 409 });
  throw e;
};

export function mountBudgetRoutes(app: Hono<any>, db: Db, cfg: { demo: boolean; slack?: { approvers: string[] } }) {
  app.get("/api/budget", async (c) => c.json(await budgetView(db, { year: num(c.req.query("year")) ?? new Date().getFullYear(), q: c.req.query("q"), page: num(c.req.query("page")), size: num(c.req.query("size")), quarter: num(c.req.query("quarter")), team: c.req.query("team") || undefined, region: c.req.query("region") || undefined, show: c.req.query("show"), sort: c.req.query("sort") })));
  app.get("/api/usage", async (c) => c.json(await usageView(db, { year: num(c.req.query("year")), month: num(c.req.query("month")), q: c.req.query("q"), page: num(c.req.query("page")), size: num(c.req.query("size")), when: c.req.query("when"), near: c.req.query("near") === "1", sort: c.req.query("sort"), simulated: cfg.demo })));

  app.put("/api/budget/:year", async (c) => {
    const b = await c.req.json<{ quarters?: unknown }>().catch(() => ({}) as { quarters?: unknown });
    const quarters = Array.isArray(b.quarters) ? b.quarters.map(Number) : [];
    try { await setBudget(db, c.get("actor"), Number(c.req.param("year")), quarters); return c.json({ ok: true }); } catch (e) { return refuse(e); }
  });
  app.put("/api/seat-requests/:id/ticket", async (c) => {
    const b = await c.req.json<{ amount_dollars?: unknown }>().catch(() => ({}) as { amount_dollars?: unknown });
    try { return c.json(await recordTicket(db, c.get("actor"), c.req.param("id"), Number(b.amount_dollars))); } catch (e) { return refuse(e); }
  });
}
