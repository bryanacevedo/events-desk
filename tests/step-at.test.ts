import { describe, expect, it } from "vitest";
import { STEPS, stepAt } from "../src/app/waiting";

const at = (stage: Parameters<typeof stepAt>[0]["stage"], open = 0) => STEPS[stepAt({ stage, paused_from: null }, open)];

describe("the step an event is on", () => {
  it("stays on research while its cases are open", () => {
    expect(at("ready_for_review", 15)).toBe("Research companies");
  });
  it("moves on once no case is open", () => {
    expect(at("ready_for_review", 0)).toBe("Verify and find contacts");
  });
  it("ignores open cases once contacts are being found", () => {
    expect(at("finding_people", 3)).toBe("Verify and find contacts");
  });
  it("counts every step done at delivered, whatever is left to review", () => {
    expect(stepAt({ stage: "delivered", paused_from: null }, 38)).toBe(5);
  });
});
