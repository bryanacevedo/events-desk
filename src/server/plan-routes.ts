/* The plan over HTTP (docs/EVENT-PLAN.md section 7), Session 1: making a plan, asking for approval, approving, involvements, who goes, budget lines and the result.
   Every read answers a rep through forRep (planView does it). The server decides who may write, not the screen. */

import type { Context, Hono } from "hono";
import type { Db } from "./db.ts";
import { RuleError } from "./events.ts";
import { canPlan, isLead, MONEY_REFUSAL } from "./money.ts";
import { eventBudget, removeBudgetLine, setBudgetLine, type BudgetLineInput } from "./budget-lines.ts";
import { Forbidden, Invalid } from "./seats.ts";
import { addDeliverable, addPromise, saveSponsorship, SponsorshipInvalid, updateDeliverable, updatePromise, type DeliverableInput, type PackageInput, type PromiseInput } from "./sponsorship.ts";
import {
  addInvolvement, addPerson, approvePlan, askToGoOn, closeResult, createPlan, declinePlan, dropInvolvement, planView, PlanInvalid, removePerson, submitPlan,
  todayOf, updateInvolvement, updatePerson, updatePlan, type InvolvementInput, type PersonInput, type PlanInput,
} from "./plan.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { postPlanCard, type SlackConfig } from "./slack.ts";
import {
  addSource, assessmentView, AssessmentInvalid, confirmAssessment, draftOrganizerRequest, markRequestCopied, patchOrganizerRequest, proposeAnswers, rejectAnswer, reuseLastYear, setAnswer,
  type AnswerInput, type PageFetcher, type RequestPatch, type SourceInput,
} from "./assessment.ts";
import { mockLlm, type Llm } from "./providers.ts";

export const PLANNER_REFUSAL = "Plans are written by the field marketer, leadership and GTM Engineering.";
type Cfg = { demo: boolean; slack?: SlackConfig; lifecycle?: LifecycleDeps; llm?: Llm; /** Reads one public page for the assessment. Tests give a stand-in; the demo never fetches. */ fetchPage?: PageFetcher };
type Body = Record<string, any>;

export function mountPlanRoutes(app: Hono<any>, db: Db, cfg: Cfg) {
  const body = async (c: Context): Promise<Body> => ((await c.req.json().catch(() => ({}))) ?? {}) as Body;
  const refuse = (msg: string, status: 400 | 403 | 404) => Response.json({ error: msg }, { status });
  // RuleError becomes a 409 in the app's own handler. A bad body is a 400 with one sentence, and a refusal is a 403.
  const run = async <T>(fn: () => Promise<T>, status: 200 | 201 = 200) => {
    try { return Response.json(await fn(), { status }); }
    catch (e) {
      if (e instanceof PlanInvalid || e instanceof Invalid || e instanceof SponsorshipInvalid || e instanceof AssessmentInvalid) return refuse(e.message, 400);
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
    // Live mode (Slack configured, not the demo) posts the plan card to the approvers' channel, and the decision is taken there.
    return run(async () => {
      const r = await submitPlan(db, actorOf(c), id(c), { today: todayOf(cfg.lifecycle) });
      if (cfg.slack && !cfg.demo && !r.auto_approved) await postPlanCard(db, cfg.slack, id(c));
      return r;
    });
  });
  // The panel decision (decision 104): the demo has it, and so does a desk with no Slack, so a plan is never stuck for want of a chat tool. It runs the same approvePlan and declinePlan
  // the Slack plan card calls (approvers only, never the person who wrote the plan). With Slack connected the card is the one path and this route does not exist.
  if (cfg.demo || !cfg.slack) {
    app.post("/api/events/:id/plan/decision", async (c) => {
      const b = await body(c);
      if (b.decision !== "approve" && b.decision !== "decline") return refuse("Choose approve or decline.", 400);
      const d = { eventId: id(c), actor: actorOf(c), userMap, today: todayOf(cfg.lifecycle) };
      return run<object>(() => (b.decision === "approve" ? approvePlan(db, d) : declinePlan(db, { ...d, reason: String(b.reason ?? "") })));
    });
  }
  app.post("/api/events/:id/plan/close", async (c) => {
    // Decision 4: the planner who wrote the plan can close plan against actual, with or without the sending stage.
    if (!isLead(actorOf(c)) && !planner(c)) return refuse("Closing a result is for planners, leadership and GTM Engineering.", 403);
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

  // Sponsorship: the package writes its budget line in the same transaction. A rep gets none of it as money (planView answers through forRep).
  app.put("/api/events/:id/sponsorships/:iid", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as PackageInput;
    return run(() => saveSponsorship(db, actorOf(c), id(c), c.req.param("iid") as string, b));
  });
  app.post("/api/events/:id/deliverables", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as DeliverableInput;
    return run(() => addDeliverable(db, actorOf(c), id(c), b), 201);
  });
  // A planner changes anything; the person a deliverable is assigned to may mark their own done. The function decides, and refuses with a 403.
  app.patch("/api/events/:id/deliverables/:did", async (c) => {
    const b = (await body(c)) as DeliverableInput;
    return run(() => updateDeliverable(db, actorOf(c), id(c), c.req.param("did") as string, b, { planner: planner(c) }));
  });
  app.post("/api/events/:id/promises", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as PromiseInput;
    return run(() => addPromise(db, actorOf(c), id(c), b), 201);
  });
  app.patch("/api/events/:id/promises/:pid", async (c) => {
    if (!planner(c)) return refuse(PLANNER_REFUSAL, 403);
    const b = (await body(c)) as PromiseInput;
    return run(() => updatePromise(db, actorOf(c), id(c), c.req.param("pid") as string, b));
  });

  /* The assessment and the request to the organizer. Nothing here holds money, so a rep reads and writes all of it. There is no route that sends mail: the person copies the email
     and sends it from their own mailbox, and the desk keeps who copied it and the dates they say. */
  app.get("/api/events/:id/assessment", async (c) => {
    try { return c.json(await assessmentView(db, id(c))); }
    catch (e) { if (e instanceof RuleError) return refuse(e.message, 404); throw e; }
  });
  app.post("/api/events/:id/assessment/sources", async (c) => {
    const b = (await body(c)) as SourceInput;
    // The demo never fetches a page: a visitor's link would make this server read the open web.
    return run(() => addSource(db, actorOf(c), id(c), b, { fetchPage: cfg.demo && !cfg.fetchPage ? null : cfg.fetchPage }), 201);
  });
  app.post("/api/events/:id/assessment/propose", async (c) => {
    const b = await body(c);
    if (typeof b.source_id !== "string" || !b.source_id) return refuse("Say which source to read.", 400);
    return run(() => proposeAnswers(db, cfg.llm ?? mockLlm, id(c), actorOf(c), b.source_id));
  });
  app.put("/api/events/:id/assessment/answers/:question", async (c) => {
    const b = (await body(c)) as AnswerInput;
    return run(() => setAnswer(db, actorOf(c), id(c), c.req.param("question") as string, b));
  });
  app.delete("/api/events/:id/assessment/answers/:question", async (c) => run(() => rejectAnswer(db, actorOf(c), id(c), c.req.param("question") as string)));
  app.post("/api/events/:id/assessment/confirm", async (c) => run(() => confirmAssessment(db, actorOf(c), id(c))));
  app.post("/api/events/:id/assessment/reuse", async (c) => run(() => reuseLastYear(db, actorOf(c), id(c))));
  app.post("/api/events/:id/organizer-request", async (c) => {
    const b = (await body(c)) as { template?: string; organizer_name?: string };
    return run(() => draftOrganizerRequest(db, actorOf(c), id(c), b, { planner: planner(c) }), 201);
  });
  app.post("/api/events/:id/organizer-request/:rid/copied", async (c) => run(() => markRequestCopied(db, actorOf(c), id(c), c.req.param("rid") as string)));
  app.patch("/api/events/:id/organizer-request/:rid", async (c) => {
    const b = (await body(c)) as RequestPatch;
    return run(() => patchOrganizerRequest(db, actorOf(c), id(c), c.req.param("rid") as string, b));
  });
}
