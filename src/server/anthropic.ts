/* The real model, behind the same interface as the mock. Used only when
   ANTHROPIC_API_KEY and LIVE_SPEND=1 are both set. `--demo` never reaches it.
   A refused or truncated reply returns as empty text, which the pipeline treats
   as an invalid answer: one retry, then the item fails with a reason. The SDK's
   own retries are off, because the cost card could not see them. */

import Anthropic from "@anthropic-ai/sdk";
import { VendorError, type Llm } from "./providers.ts";
import { PARTS } from "./perspective-check.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Output room per step. Hidden thinking is counted inside max_tokens, so a step that thinks and then writes needs room for both: at 2048 the Summary's
    three paragraphs can be cut off after the thinking, and a cut-off reply is returned empty (below), which reads as invalid JSON. */
const MAX_TOKENS: Record<string, number> = { icp_compile: 8000, perspective: 8000 };
const DEFAULT_MAX_TOKENS = 2048;

/** Steps whose reply must be exactly this JSON, so the API holds the model to it (structured output) instead of the prompt asking nicely. */
const SCHEMAS: Record<string, { type: "json_schema"; schema: Record<string, unknown> }> = {
  perspective: { type: "json_schema", schema: { type: "object", properties: Object.fromEntries(PARTS.map((p) => [p, { type: "string" }])), required: [...PARTS], additionalProperties: false } },
};

export function anthropicLlm(model = process.env.EVENTS_DESK_MODEL || DEFAULT_MODEL): Llm {
  // A key not scoped to one workspace has to name the workspace on every request.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic({ maxRetries: 0, ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}) });
  return {
    model,
    async complete(step, prompt) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: MAX_TOKENS[step] ?? DEFAULT_MAX_TOKENS,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", ...(SCHEMAS[step] ? { format: SCHEMAS[step] } : {}) },
        messages: [{ role: "user", content: prompt }],
      }).catch((e: unknown) => { throw e instanceof Anthropic.RateLimitError ? new VendorError(0) : e; });
      const text = response.stop_reason === "refusal" || response.stop_reason === "max_tokens"
        ? ""
        : response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, model: response.model, stop_reason: response.stop_reason ?? undefined, thinking_tokens: response.usage.output_tokens_details?.thinking_tokens };
    },
  };
}
