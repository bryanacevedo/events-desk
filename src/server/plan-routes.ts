/* The plan over HTTP (docs/EVENT-PLAN.md section 7), Session 1: making a plan, asking for approval, approving, involvements, who goes, budget lines and the result.
   Every read answers a rep through forRep (planView does it). The server decides who may write, not the screen. */

import type { Context, Hono } from "hono";
import type { Db } from "./db.ts";
import { RuleError } from "./events.ts";
import { canPlan, isLead, MONEY_REFUSAL } from "./money.ts";
import { eventBudget, removeBudgetLine, setBudgetLine, type BudgetLineInput } from "./budget-lines.ts";
import { Forbidden, Invalid } from "./seats.ts";
import {
  addInvolvement, addPerson, approvePlan, askToGoOn, closeResult, createPlan, declinePlan, dropInvolvement, planView, PlanInvalid, removePerson, submitPlan,
  todayOf, updateInvolvement, updatePerson, updatePlan, type InvolvementInput, type PersonInput, type PlanInput,
} from "./plan.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import type { SlackConfig } from "./slack.ts";

export const PLANNER_REFUSAL = "Plans are written by the field marketer, leadership and GTM Engineering.";
type Cfg = { demo: boolean; slack?: SlackConfig; lifecycle?: LifecycleDeps };
type Body = Record<string, any>;

export function mountPlanRoutes(app: Hono<any>, db: Db, cfg: Cfg) {
  const body = async (c: Context): Promise<Body> => ((await c.req.json().catch(() => ({}))) ?? {}) as Body;
  const refuse = (msg: string, status: 400 | 403 | 404) => Response.json({ error: msg }, { status });
  // RuleError becomes a 409 in the app's own handler. A bad body is a 400 with one sentence, and a refusal is a 403.
  const run = async <T>(fn: () => Promise<T>, status: 200 | 201 = 200) => {
    try { return Response.json(await fn(), { status }); }
    catch (e) {
      if (e instanceof PlanInvalid || e instanceof Invalid) return refuse(e.message, 400);
      if (e instanceof Forbidden) return refuse(e.message, 403);
      throw e;
    }
  };
  const actorOf = (c: Context): string => c.get("actor");
  const planner = (c: Context) => canPlan(actorOf(c));
  const userMap = cfg.slack?.userMap;
  const id = (c: Context) => c.req.param("id") as string;

  app.post("/api/plans", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as PlanInput;
    return run(() => createPlan(db, actorOf(c), b, { approvers: cfg.slack?.approvers }), 201);
  });
  app.get("/api/events/:id/plan", async (c) => {
    try { return c.json(await planView(db, cfg.lifecycle, id(c), actorOf(c))); }
    catch (e) { if (e instanceof RuleError) return refuse(e.message, 404); throw e; }
  });
  app.patch("/api/events/:id/plan", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = await body(c);
    return run(() => updatePlan(db, actorOf(c), id(c), b));
  });
  app.post("/api/events/:id/plan/submit", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    return run(() => submitPlan(db, actorOf(c), id(c), { today: todayOf(cfg.lifecycle) }));
  });
  // The panel decision exists in demo mode only. A live setup decides on the plan card in Slack, as it does for seats.
  if (cfg.demo) {
    app.post("/api/events/:id/plan/decision", async (c) => {
      const b = await body(c);
      if (b.decision !== "approve" && b.decision !== "decline") return refuse("Choose approve or decline.", 400);
      const d = { eventId: id(c), actor: actorOf(c), userMap, today: todayOf(cfg.lifecycle) };
      return run<object>(() => (b.decision === "approve" ? approvePlan(db, d) : declinePlan(db, { ...d, reason: String(b.reason ?? "") })));
    });
  }
  app.post("/api/events/:id/plan/close", async (c) => {
    if (!isLead(actorOf(c))) return refuse("Closing a result is for leadership and GTM Engineering.", 403);
    return run(() => closeResult(db, actorOf(c), id(c), todayOf(cfg.lifecycle)));
  });

  app.post("/api/events/:id/involvements", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as InvolvementInput;
    return run(() => addInvolvement(db, actorOf(c), id(c), b), 201);
  });
  app.patch("/api/events/:id/involvements/:iid", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as Partial<InvolvementInput>;
    return run(() => updateInvolvement(db, actorOf(c), id(c), c.req.param("iid") as string, b));
  });
  // Deleting an involvement is a drop, and a drop has a reason.
  app.delete("/api/events/:id/involvements/:iid", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = await body(c);
    return run(() => dropInvolvement(db, actorOf(c), id(c), c.req.param("iid") as string, String(b.reason ?? "")));
  });

  app.post("/api/events/:id/people", async (c) => {
    const b = (await body(c)) as PersonInput;
    const actor = actorOf(c);
    if (!planner(c)) {
      // A rep posts only themselves: "ask to go".
      if (b.person !== undefined && b.person !== actor) return refuse("You can ask to go for yourself. A planner adds the rest of the team.", 403);
      return run(() => askToGoOn(db, actor, id(c), { team: b.team, role_title: b.role_title }), 201);
    }
    return run(() => addPerson(db, actor, id(c), b, { userMap }), 201);
  });
  app.patch("/api/events/:id/people/:pid", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as PersonInput;
    return run(() => updatePerson(db, actorOf(c), id(c), c.req.param("pid") as string, b, { userMap }));
  });
  app.delete("/api/events/:id/people/:pid", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = await body(c);
    return run(() => removePerson(db, actorOf(c), id(c), c.req.param("pid") as string, String(b.reason ?? "")));
  });

  // Budget lines are plan money: leadership and planners. A rep is refused.
  app.get("/api/events/:id/budget-lines", async (c) => (planner(c) ? c.json(await eventBudget(db, id(c))) : refuse(MONEY_REFUSAL, 403)));
  app.post("/api/events/:id/budget-lines", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as BudgetLineInput;
    return run(() => setBudgetLine(db, actorOf(c), id(c), { ...b, id: undefined }), 201);
  });
  app.put("/api/events/:id/budget-lines/:lid", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as BudgetLineInput;
    return run(() => setBudgetLine(db, actorOf(c), id(c), { ...b, id: c.req.param("lid") as string }));
  });
  app.delete("/api/events/:id/budget-lines/:lid", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    return run(() => removeBudgetLine(db, actorOf(c), id(c), c.req.param("lid") as string));
  });
}
