/* Review fixes from the standalone day: a page never refuses while the planners are still loading, a decision button is not offered where its route does not exist,
   and the desk says where decisions are taken (/api/health.decisions). */

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { createApp } from "../src/server/app.ts";
import { CHOOSING_FAILED, DecisionLine, NOT_AVAILABLE, decisionsOf, plannerAccess } from "../src/app/access.tsx";
import type { Needs } from "../src/app/waiting.ts";
import { freshDb } from "./helpers.ts";

const needs = (planners: string[]) => ({ items: [], approvals: [], approvers: [], planners, events: [], requests: [], catalog: [] }) as Needs;

describe("a page waits for the planners instead of refusing", () => {
  it("says loading while the planners are not known, for someone who is not leadership or GTM", () => {
    expect(plannerAccess(null, "Camille Laurent", false)).toBe("loading");
  });
  it("lets a planner in once they are known, and refuses someone who is not one", () => {
    expect(plannerAccess(needs(["Camille Laurent"]), "Camille Laurent", false)).toBe("yes");
    expect(plannerAccess(needs(["Camille Laurent"]), "Maya Ortiz", false)).toBe("no");
  });
  it("never makes leadership or GTM wait", () => {
    expect(plannerAccess(null, "Dan", true)).toBe("yes");
  });
});

describe("where decisions are taken", () => {
  it("reads the health answer, and falls back to nowhere for a server that does not say", () => {
    expect(decisionsOf({ demo: true })).toBe("panel");
    expect(decisionsOf({ demo: false, decisions: "slack" })).toBe("slack");
    expect(decisionsOf({ demo: false })).toBe("none");
    expect(decisionsOf(null)).toBe("none");
  });
  it("draws no decision line in the panel, and an honest one elsewhere", () => {
    expect(renderToStaticMarkup(createElement(DecisionLine, { decisions: "panel" }))).toBe("");
    expect(renderToStaticMarkup(createElement(DecisionLine, { decisions: "slack" }))).toContain("Decided in Slack.");
    const none = renderToStaticMarkup(createElement(DecisionLine, { decisions: "none" }));
    expect(none).toContain("need Slack connected");
    expect(none).not.toContain("Decided in Slack.");
  });
  it("says a part is not available on a desk that does not run it", () => {
    expect(NOT_AVAILABLE("The scanner")).toBe("The scanner is not available on this desk.");
    expect(CHOOSING_FAILED).not.toMatch(/is for/);
  });
});

describe("/api/health.decisions", () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });
  const read = async (cfg: Parameters<typeof createApp>[1]) => (await createApp(db, cfg).request("/api/health")).json();
  it("is panel in the demo, slack with Slack, and panel with neither (decision 104: a desk with no Slack decides in the app)", async () => {
    expect((await read({ demo: true })).decisions).toBe("panel");
    expect((await read({ demo: false, slack: { signingSecret: "s", botToken: "t", channel: "C", approvers: ["U1"] } as never })).decisions).toBe("slack");
    expect((await read({ demo: false })).decisions).toBe("panel");
  });
});
