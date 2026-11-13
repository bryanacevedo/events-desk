/* The contract of docs/EVENT-PLAN.md section 3, frozen before any plan code. The list stage machine in src/shared/domain.ts must keep
   every value and every move. NEXT is not exported and stays that way, so this test reads it through moveError over every pair. */

import { describe, expect, it } from "vitest";
import { DEFAULT_FLOW, DROP_REASONS, FLOWS, moveError, STAGES, stageLabel, validateRequest, waitingOn, type Stage } from "../src/shared/domain.ts";

// A frozen copy of the edges the desk had on 2026-11-13. A change to domain.ts that adds or removes an edge fails here and asks for a decision.
const FROZEN_STAGES = ["requested", "approved", "mapped", "quoted", "tiering", "enriching", "flagging", "delivered", "declined", "paused", "researching", "ready_for_review", "finding_people"];
const FROZEN_EDGES: Record<string, string[]> = {
  requested: ["approved", "declined"],
  approved: ["mapped", "declined"],
  mapped: ["quoted", "declined"],
  quoted: ["tiering", "researching", "mapped", "declined"],
  tiering: ["enriching", "paused"],
  enriching: ["flagging", "paused"],
  flagging: ["delivered", "paused"],
  delivered: [],
  declined: [],
  paused: ["tiering", "enriching", "flagging", "researching", "ready_for_review", "finding_people"],
  researching: ["ready_for_review", "paused"],
  ready_for_review: ["finding_people", "declined", "paused"],
  finding_people: ["flagging", "paused"],
};

describe("the list stage machine is frozen", () => {
  it("has the same thirteen stages, in order", () => {
    expect([...STAGES]).toEqual(FROZEN_STAGES);
  });

  it("allows exactly the frozen moves, and gives the frozen sentences for the rest", () => {
    for (const from of STAGES) for (const to of STAGES) {
      // A paused event resumes only where it paused; check each possible paused_from.
      const froms: (Stage | null)[] = from === "paused" ? FROZEN_EDGES.paused as Stage[] : [null];
      for (const paused_from of froms) {
        const got = moveError({ stage: from, paused_from }, to, "a reason");
        const edge = FROZEN_EDGES[from].includes(to);
        if (!edge) expect(got, `${from} to ${to}`).toBe(`An event cannot go from ${from} to ${to}.`);
        else if (from === "paused" && to !== paused_from) expect(got, `${from} to ${to}`).toBe(`This event paused during ${paused_from}, so it can only resume there.`);
        else expect(got, `${from} to ${to}`).toBeNull();
      }
    }
  });

  it("demands a reason on every way to declined", () => {
    for (const from of STAGES) if (FROZEN_EDGES[from].includes("declined")) {
      expect(moveError({ stage: from, paused_from: null }, "declined", "")).toBe("Say why before declining.");
      expect(moveError({ stage: from, paused_from: null }, "declined", "   ")).toBe("Say why before declining.");
      expect(moveError({ stage: from, paused_from: null }, "declined", undefined)).toBe("Say why before declining.");
      expect(moveError({ stage: from, paused_from: null }, "declined", "No budget")).toBeNull();
    }
  });

  it("keeps the words, the flows, the request rules and the drop reasons", () => {
    expect([...FLOWS]).toEqual(["single_card", "two_card"]);
    expect(DEFAULT_FLOW).toBe("two_card");
    expect(waitingOn({ stage: "requested" })).toBe("Approver: seats");
    expect(waitingOn({ stage: "approved" })).toBe("Requester: attendee list");
    expect(waitingOn({ stage: "delivered" })).toBe("Nobody");
    expect(stageLabel("ready_for_review")).toBe("Ready for review");
    expect(validateRequest({ name: "x", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 0 })).toBeNull();
    expect(validateRequest({ name: "", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 0 })).toBe("Name the event.");
    expect(DROP_REASONS.length).toBe(21);
    expect(DROP_REASONS).toContain("opted_out");
  });
});
