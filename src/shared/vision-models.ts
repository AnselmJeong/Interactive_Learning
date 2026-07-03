import type { AiProviderId } from "./settings-types";

const TEXT_ONLY_PATTERNS = [/embedding/i, /imagen/i, /tts/i, /audio/i];

const VISION_PATTERNS: Partial<Record<AiProviderId, RegExp[]>> = {
  gemini: [/^gemini-/i],
  openai: [/gpt-4o/i, /gpt-4\.1/i, /gpt-5/i, /\bo3\b/i, /\bo4\b/i, /vision/i],
  ollama: [
    /vision/i,
    /\bvl\b/i,
    /llava/i,
    /bakllava/i,
    /minicpm-v/i,
    /qwen.*vl/i,
    /^qwen3\.5(?::|$)/i,
    /^gemma4(?::|$)/i,
    /^gemma3(?::|$)/i,
    /^kimi-k2\.7-code(?::|$)/i,
    /^minimax-m3(?::|$)/i,
    /moondream/i,
  ],
  anthropic: [/claude-3/i, /claude-sonnet/i, /claude-opus/i, /claude-haiku/i],
};

export function modelSupportsVision(provider: AiProviderId, modelId: string) {
  const normalized = modelId.replace(/^models\//, "").trim();
  if (!normalized || TEXT_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return (VISION_PATTERNS[provider] || []).some((pattern) => pattern.test(normalized));
}
