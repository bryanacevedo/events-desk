/* What a model call really costs, from the tokens the API reports. Anthropic first-party prices per million tokens, as of 2026-10-06.
   An unlisted model returns null instead of a guess. Prompt caching and fast mode are not used by this project, so they are not priced here. */

const PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/** Dollars for one call or a total of calls on one model. */
export function modelCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PER_MILLION[model];
  return p ? (inputTokens * p.input + outputTokens * p.output) / 1_000_000 : null;
}
