import type { AiProviderId, AppSettings, ProviderModel } from "../shared/settings-types";
import { modelSupportsVision } from "../shared/vision-models";
import { type AiChatClient, type ChatParams, OpenAICompatibleClient, parseJsonFromText } from "./openai-compatible-client";
import { providerConfigurationError, providerHttpError, providerNetworkError, providerTimeoutError } from "./provider-error";
import { ClaudeSubscriptionClient, CodexSubscriptionClient } from "./subscription-cli-client";
import {
  CONSERVATIVE_OUTPUT_TOKENS,
  OutputTokenLimitError,
  expandedOutputTokens,
  isOutputBudgetRejection,
  resolveOutputTokens,
} from "./output-token-budget";

// Gemini's largest models cap output at 65,536 tokens; asking for more is rejected.
const GEMINI_MAX_OUTPUT_TOKENS = 65_536;

type ProviderClientSettings = {
  provider: AiProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
};

const PROVIDER_LABELS: Record<AiProviderId, string> = {
  ollama: "Ollama",
  openai: "Codex",
  anthropic: "Claude",
  gemini: "Gemini",
};

export function createAiProviderClient(settings: AppSettings, apiKey: string, provider: AiProviderId = settings.aiProvider): AiChatClient {
  const providerSettings = settings.providers[provider];
  const clientSettings = {
    provider,
    baseUrl: providerSettings.baseUrl,
    apiKey,
    model: providerSettings.selectedModel,
  };

  // OpenAI and Claude run through the user's Codex / Claude Code subscription login, not an API key.
  if (provider === "anthropic") return new ClaudeSubscriptionClient(clientSettings.model);
  if (provider === "openai") return new CodexSubscriptionClient(clientSettings.model);
  if (provider === "gemini") return new GeminiClient(clientSettings);
  return new OpenAICompatibleClient({
    baseUrl: clientSettings.baseUrl,
    apiKey,
    model: clientSettings.model,
    providerName: PROVIDER_LABELS[provider],
  });
}

class GeminiClient implements AiChatClient {
  constructor(private readonly settings: ProviderClientSettings) {}

  private url(path: string) {
    return `${this.settings.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers() {
    return {
      "x-goog-api-key": this.settings.apiKey,
      "content-type": "application/json",
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    if (!this.settings.apiKey) throw providerConfigurationError("Gemini", undefined, "Gemini API key is not configured");
    const response = await fetch(this.url("/models"), { headers: this.headers() });
    if (!response.ok) throw await providerHttpError(response, "Gemini", undefined, "Model list failed");
    const data = (await response.json()) as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (data.models || [])
      .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes("generateContent"))
      .map((model) => {
        const id = (model.name || "").replace(/^models\//, "");
        return { id, supportsVision: modelSupportsVision("gemini", id) };
      })
      .filter((model) => model.id);
  }

  async chatJson(params: ChatParams): Promise<unknown> {
    return parseJsonFromText(await this.chat(params, true));
  }

  async chatText(params: ChatParams): Promise<string> {
    return this.chat(params, false);
  }

  async describeImage(params: {
    image: { mimeType: string; dataBase64: string };
    prompt: string;
    system?: string;
    model?: string;
    timeoutMs?: number;
  }) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw providerConfigurationError("Gemini", model, "Gemini API key is not configured");
    if (!model) throw providerConfigurationError("Gemini", model, "Model is not selected");

    let response: Response;
    try {
      const modelPath = model.startsWith("models/") ? model : `models/${model}`;
      response = await fetch(this.url(`/${modelPath}:generateContent`), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(params.timeoutMs ?? 120000),
        body: JSON.stringify({
          systemInstruction: params.system ? { parts: [{ text: params.system }] } : undefined,
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: params.image.mimeType, data: params.image.dataBase64 } },
                { text: params.prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: resolveOutputTokens(),
          },
        }),
      });
    } catch (error) {
      throw normalizeProviderError(error, "Gemini", model, params.timeoutMs);
    }
    if (!response.ok) throw await providerHttpError(response, "Gemini", model);
    const data = (await response.json()) as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }> };
    const candidate = data.candidates?.[0];
    assertGeminiFinished("Gemini", model, candidate?.finishReason);
    const content = candidate?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
    if (!content) throw new Error(`AI provider returned an empty image explanation for model ${model}`);
    return content;
  }

  private async chat(params: ChatParams, jsonMode: boolean) {
    let maxTokens = Math.min(GEMINI_MAX_OUTPUT_TOKENS, resolveOutputTokens(params.maxTokens));
    let budgetRejected = false;
    for (;;) {
      try {
        return await this.chatOnce(params, jsonMode, maxTokens);
      } catch (error) {
        if (error instanceof OutputTokenLimitError) {
          const next = expandedOutputTokens(maxTokens);
          if (next && !budgetRejected && maxTokens < GEMINI_MAX_OUTPUT_TOKENS) {
            maxTokens = Math.min(GEMINI_MAX_OUTPUT_TOKENS, next);
            continue;
          }
        } else if (!budgetRejected && maxTokens > CONSERVATIVE_OUTPUT_TOKENS && isOutputBudgetRejection(error)) {
          budgetRejected = true;
          maxTokens = CONSERVATIVE_OUTPUT_TOKENS;
          continue;
        }
        throw error;
      }
    }
  }

  private async chatOnce(params: ChatParams, jsonMode: boolean, maxTokens: number) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw providerConfigurationError("Gemini", model, "Gemini API key is not configured");
    if (!model) throw providerConfigurationError("Gemini", model, "Model is not selected");
    const system = params.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const contents = params.messages.filter((message) => message.role !== "system").map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

    let response: Response;
    try {
      const modelPath = model.startsWith("models/") ? model : `models/${model}`;
      response = await fetch(this.url(`/${modelPath}:generateContent`), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(params.timeoutMs ?? 120000),
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents,
          generationConfig: {
            temperature: params.temperature ?? 0.7,
            maxOutputTokens: maxTokens,
            responseMimeType: jsonMode ? "application/json" : undefined,
          },
        }),
      });
    } catch (error) {
      throw normalizeProviderError(error, "Gemini", model, params.timeoutMs);
    }
    if (!response.ok) throw await providerHttpError(response, "Gemini", model);
    const data = (await response.json()) as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }> };
    const candidate = data.candidates?.[0];
    assertGeminiFinished("Gemini", model, candidate?.finishReason);
    const content = candidate?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
    if (!content) throw new Error(`AI provider returned an empty message for model ${model}`);
    return content;
  }
}

function normalizeProviderError(error: unknown, provider: string, model: string, timeoutMs?: number) {
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return providerTimeoutError(provider, model, timeoutMs ?? 120000);
  }
  return providerNetworkError(error, provider, model);
}

function assertGeminiFinished(provider: string, model: string, reason: string | undefined) {
  if (!reason || reason === "STOP") return;
  if (reason === "MAX_TOKENS") {
    throw new OutputTokenLimitError(`${provider} ${model} stopped before finishing because it hit the output token limit (finishReason=MAX_TOKENS)`);
  }
  throw new Error(`${provider} ${model} stopped before finishing (finishReason=${reason})`);
}
