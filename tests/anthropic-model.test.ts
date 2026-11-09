import { describe, expect, it, vi } from "vitest";

// The SDK is replaced, so nothing here can reach the network.
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    static RateLimitError = class extends Error {};
    beta = { messages: { create: async () => ({ model: "served-by-fallback", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }) } };
  }
  return { default: Anthropic };
});

describe("the adapter reports the model that answered", () => {
  it("returns response.model, not the requested model", async () => {
    const { anthropicLlm } = await import("../src/server/anthropic.ts");
    const llm = anthropicLlm("requested-model");
    expect(llm.model).toBe("requested-model");
    expect((await llm.complete("company_tier", "x")).model).toBe("served-by-fallback");
  });
});
