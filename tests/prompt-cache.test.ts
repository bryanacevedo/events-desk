import { describe, expect, it, vi } from "vitest";

// The SDK is replaced, so nothing here can reach the network. The request it receives is kept for the assertions.
const seen: any[] = [];
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    static RateLimitError = class extends Error {};
    beta = { messages: { create: async (req: unknown) => { seen.push(req); return { model: "m", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 700, cache_read_input_tokens: 0 } }; } } };
  }
  return { default: Anthropic };
});

describe("prompt caching (bl_117)", () => {
  it("marks the stable part, and puts the per-company part after the marker", async () => {
    const { anthropicLlm } = await import("../src/server/anthropic.ts");
    const { fill } = await import("../src/server/prompts.ts");
    const prompt = fill("company_tier", { icp: "ICP-TEXT-SHARED", segments: "a, b", company_types: "c, d", input: "Employees: 450 unique-per-company" });
    const out = await anthropicLlm("m").complete("company_tier", prompt);
    const content = seen.at(-1).messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(content[0].text).toContain("ICP-TEXT-SHARED");
    expect(content[0].text).not.toContain("unique-per-company");
    expect(content[1].cache_control).toBeUndefined();
    expect(content[1].text).toContain("unique-per-company");
    expect(content[0].text + content[1].text).toBe(prompt); // nothing lost or reordered
    expect(out.cache_creation_input_tokens).toBe(700);
    expect(out.input_tokens).toBe(710);
  });

  it("every real template has an INPUT line, so every step gets a marker", async () => {
    const { TEMPLATES } = await import("../src/server/prompts.ts");
    const { cacheableContent } = await import("../src/server/anthropic.ts");
    for (const [step, t] of Object.entries(TEMPLATES)) {
      const c = cacheableContent(t as string);
      expect(Array.isArray(c), step).toBe(true);
    }
  });

  it("sends a prompt with no INPUT line whole and unmarked", async () => {
    const { cacheableContent } = await import("../src/server/anthropic.ts");
    expect(cacheableContent("just text")).toBe("just text");
  });
});
