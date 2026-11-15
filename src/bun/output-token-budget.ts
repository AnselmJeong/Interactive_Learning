// Output token budget shared by every HTTP LLM client.
//
// Call sites state how long a reply *should* be, but a hard cap that is too tight does not make
// the model shorter: it cuts the reply mid-sentence and the client throws
// "finish_reason=length". Korean text is token-dense (roughly 1-2 tokens per syllable) and
// reasoning models (DeepSeek V4, Qwen, etc. via Ollama) spend output tokens on thinking before the
// visible answer, so a few thousand tokens is far too little. The transport layer therefore never
// sends less than MIN_OUTPUT_TOKENS: ~20,000+ Korean characters of visible text plus room for
// reasoning. Length is controlled by prompts and post-processing, not by truncation.

/** Floor applied to every request, whatever the call site asks for. */
export const MIN_OUTPUT_TOKENS = 32_768;
/** Used when a call site does not specify a budget. */
export const DEFAULT_OUTPUT_TOKENS = 32_768;
/** Ceiling for the automatic retry after finish_reason=length. */
export const MAX_OUTPUT_TOKENS = 131_072;
/** Budget to fall back to if a provider rejects a large max_tokens value outright. */
export const CONSERVATIVE_OUTPUT_TOKENS = 8_192;

export function resolveOutputTokens(requested?: number) {
  const value = requested && Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_OUTPUT_TOKENS;
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, value));
}

/** Next budget to try after the model hit the limit, or null when already at the ceiling. */
export function expandedOutputTokens(current: number) {
  if (current >= MAX_OUTPUT_TOKENS) return null;
  return Math.min(MAX_OUTPUT_TOKENS, current * 2);
}

export class OutputTokenLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputTokenLimitError";
  }
}

/** True when a provider's 4xx reply says the requested output budget is above what the model allows. */
export function isOutputBudgetRejection(error: unknown) {
  const status = (error as { status?: number })?.status;
  if (status !== 400 && status !== 413 && status !== 422) return false;
  const message = ((error as Error)?.message || String(error)).toLowerCase();
  return /max_tokens|max_completion_tokens|maxoutputtokens|max_output_tokens|num_predict|output tokens/.test(message);
}
