/* The real model, behind the same interface as the mock. Used only when
   ANTHROPIC_API_KEY and LIVE_SPEND=1 are both set. `--demo` never reaches it.
   A refused or truncated reply returns as empty text, which the pipeline treats
   as an invalid answer: one retry, then the item fails with a reason. The SDK's
   own retries are off, because the cost card could not see them. */

import Anthropic from "@anthropic-ai/sdk";
import { VendorError, type Llm } from "./providers.ts";
import { PARTS } from "./perspective-check.ts";
import { QUESTION_IDS } from "../shared/assessment.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Output room per step. Hidden thinking is counted inside max_tokens, so a step that thinks and then writes needs room for both: at 2048 the Summary's
    three paragraphs can be cut off after the thinking, and a cut-off reply is returned empty (below), which reads as invalid JSON. */
export const MAX_TOKENS: Record<string, number> = { icp_compile: 8000, perspective: 8000, assessment_propose: 4000, cfp_read: 3000, scan_read: 2000, directory_read: 4000 };
const DEFAULT_MAX_TOKENS = 2048;

/** Steps whose reply must be exactly this JSON, so the API holds the model to it (structured output) instead of the prompt asking nicely. */
export const SCHEMAS: Record<string, { type: "json_schema"; schema: Record<string, unknown> }> = {
  perspective: { type: "json_schema", schema: { type: "object", properties: Object.fromEntries(PARTS.map((p) => [p, { type: "string" }])), required: [...PARTS], additionalProperties: false } },
  // The answers of the assessment step. The question and the quote are checked in code (src/shared/assessment.ts); the schema holds the shape.
  assessment_propose: { type: "json_schema", schema: { type: "object", properties: { answers: { type: "array", items: { type: "object", properties: { question: { type: "string", enum: [...QUESTION_IDS] }, answer: { type: "string" }, detail: { type: "string" }, quote: { type: "string" } }, required: ["question", "answer", "detail", "quote"], additionalProperties: false } } }, required: ["answers"], additionalProperties: false } },
};

/** Every template is its instructions (and, for the tiering steps, the whole ICP), then a line that starts the data (see DATA_START), then the facts about one
    company. Everything before that line is the same for every company in a run, so it is sent as its own block marked as the cache
    breakpoint, and the per-company part comes after it. A prefix under the model's minimum (512 tokens on Opus 5.5) is not cached
    and bills as normal. A prompt with no such line is sent whole, unmarked. */
/** The line where a template's per-request part begins: INPUT, the seat requests of the perspective, or the first data marker of the reply and debrief steps. */
const DATA_START = /\n(?:INPUT|SEAT REQUESTS|<<<[A-Z]+)\n/;

export function cacheableContent(prompt: string) {
  const at = prompt.search(DATA_START);
  if (at < 0) return prompt;
  return [
    { type: "text" as const, text: prompt.slice(0, at + 1), cache_control: { type: "ephemeral" as const } },
    { type: "text" as const, text: prompt.slice(at + 1) },
  ];
}

export function anthropicLlm(model = process.env.EVENTS_DESK_MODEL || DEFAULT_MODEL): Llm {
  // A key not scoped to one workspace has to name the workspace on every request.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic({ maxRetries: 0, ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}) });
  const shape = (response: { stop_reason: string | null; content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number }; model: string }) => {
    const text = response.stop_reason === "refusal" || response.stop_reason === "max_tokens" ? "" : response.content.flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("");
    return { text, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, model: response.model, stop_reason: response.stop_reason ?? undefined };
  };
  return {
    model,
    async read(step, prompt, image) {
      const response = await client.beta.messages.create({
        model, max_tokens: MAX_TOKENS[step] ?? DEFAULT_MAX_TOKENS, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "low" },
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } }, { type: "text", text: prompt }] }],
      }).catch((e: unknown) => { throw e instanceof Anthropic.RateLimitError ? new VendorError(0) : e; });
      return shape(response as never);
    },
    async complete(step, prompt) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: MAX_TOKENS[step] ?? DEFAULT_MAX_TOKENS,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", ...(SCHEMAS[step] ? { format: SCHEMAS[step] } : {}) },
        messages: [{ role: "user", content: cacheableContent(prompt) }],
      }).catch((e: unknown) => { throw e instanceof Anthropic.RateLimitError ? new VendorError(0) : e; });
      const text = response.stop_reason === "refusal" || response.stop_reason === "max_tokens"
        ? ""
        : response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, input_tokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0), cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0, cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0, output_tokens: response.usage.output_tokens, model: response.model, stop_reason: response.stop_reason ?? undefined, thinking_tokens: response.usage.output_tokens_details?.thinking_tokens };
    },
  };
}
