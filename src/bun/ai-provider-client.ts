import type { AiProviderId, AppSettings, ProviderModel } from "../shared/settings-types";
import { modelSupportsVision } from "../shared/vision-models";
import { type AiChatClient, type ChatMessage, type ChatParams, OpenAICompatibleClient, parseJsonFromText } from "./openai-compatible-client";
import { providerConfigurationError, providerHttpError, providerNetworkError, providerTimeoutError } from "./provider-error";

type ProviderClientSettings = {
  provider: AiProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
};

const PROVIDER_LABELS: Record<AiProviderId, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
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

  if (provider === "anthropic") return new AnthropicClient(clientSettings);
  if (provider === "gemini") return new GeminiClient(clientSettings);
  return new OpenAICompatibleClient({
    baseUrl: clientSettings.baseUrl,
    apiKey,
    model: clientSettings.model,
    providerName: PROVIDER_LABELS[provider],
  });
}

class AnthropicClient implements AiChatClient {
  constructor(private readonly settings: ProviderClientSettings) {}

  private url(path: string) {
    return `${this.settings.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers() {
    return {
      "x-api-key": this.settings.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    if (!this.settings.apiKey) throw providerConfigurationError("Claude", undefined, "Claude API key is not configured");
    const response = await fetch(this.url("/v1/models"), { headers: this.headers() });
    if (!response.ok) throw await providerHttpError(response, "Claude", undefined, "Model list failed");
    const data = (await response.json()) as { data?: Array<{ id: string; created_at?: string }> };
    return (data.data || []).map((model) => ({ id: model.id, supportsVision: modelSupportsVision("anthropic", model.id) }));
  }

  async chatJson(params: ChatParams): Promise<unknown> {
    return parseJsonFromText(await this.chat(params));
  }

  async chatText(params: ChatParams): Promise<string> {
    return this.chat(params);
  }

  async describeImage(params: {
    image: { mimeType: string; dataBase64: string };
    prompt: string;
    system?: string;
    model?: string;
    timeoutMs?: number;
  }) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw providerConfigurationError("Claude", model, "Claude API key is not configured");
    if (!model) throw providerConfigurationError("Claude", model, "Model is not selected");

    let response: Response;
    try {
      response = await fetch(this.url("/v1/messages"), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(params.timeoutMs ?? 120000),
        body: JSON.stringify({
          model,
          system: params.system || undefined,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: params.image.mimeType,
                    data: params.image.dataBase64,
                  },
                },
                { type: "text", text: params.prompt },
              ],
            },
          ],
          temperature: 0.4,
          max_tokens: 2048,
        }),
      });
    } catch (error) {
      throw normalizeProviderError(error, "Claude", model, params.timeoutMs);
    }
    if (!response.ok) throw await providerHttpError(response, "Claude", model);
    const data = (await response.json()) as { stop_reason?: string | null; content?: Array<{ type?: string; text?: string }> };
    assertAnthropicFinished("Claude", model, data.stop_reason);
    const content = (data.content || []).filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n").trim();
    if (!content) throw new Error(`AI provider returned an empty image explanation for model ${model}`);
    return content;
  }

  private async chat(params: ChatParams) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw providerConfigurationError("Claude", model, "Claude API key is not configured");
    if (!model) throw providerConfigurationError("Claude", model, "Model is not selected");

    const system = params.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages = coalesceAnthropicMessages(params.messages.filter((message) => message.role !== "system"));
    let response: Response;
    try {
      response = await fetch(this.url("/v1/messages"), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(params.timeoutMs ?? 120000),
        body: JSON.stringify({
          model,
          system: system || undefined,
          messages,
          temperature: params.temperature ?? 0.7,
          max_tokens: params.maxTokens ?? 8192,
        }),
      });
    } catch (error) {
      throw normalizeProviderError(error, "Claude", model, params.timeoutMs);
    }
    if (!response.ok) throw await providerHttpError(response, "Claude", model);
    const data = (await response.json()) as { stop_reason?: string | null; content?: Array<{ type?: string; text?: string }> };
    assertAnthropicFinished("Claude", model, data.stop_reason);
    const content = (data.content || []).filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n").trim();
    if (!content) throw new Error(`AI provider returned an empty message for model ${model}`);
    return content;
  }
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
            maxOutputTokens: 2048,
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
            maxOutputTokens: params.maxTokens ?? 8192,
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

function coalesceAnthropicMessages(messages: ChatMessage[]) {
  const result: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const last = result[result.length - 1];
    if (last?.role === role) {
      last.content = `${last.content}\n\n${message.content}`;
    } else {
      result.push({ role, content: message.content });
    }
  }
  return result.length ? result : [{ role: "user" as const, content: "" }];
}

function normalizeProviderError(error: unknown, provider: string, model: string, timeoutMs?: number) {
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return providerTimeoutError(provider, model, timeoutMs ?? 120000);
  }
  return providerNetworkError(error, provider, model);
}

function assertAnthropicFinished(provider: string, model: string, reason: string | null | undefined) {
  if (!reason || reason === "end_turn" || reason === "stop_sequence") return;
  if (reason === "max_tokens") {
    throw new Error(`${provider} ${model} stopped before finishing because it hit the output token limit (stop_reason=max_tokens)`);
  }
  throw new Error(`${provider} ${model} stopped before finishing (stop_reason=${reason})`);
}

function assertGeminiFinished(provider: string, model: string, reason: string | undefined) {
  if (!reason || reason === "STOP") return;
  if (reason === "MAX_TOKENS") {
    throw new Error(`${provider} ${model} stopped before finishing because it hit the output token limit (finishReason=MAX_TOKENS)`);
  }
  throw new Error(`${provider} ${model} stopped before finishing (finishReason=${reason})`);
}
