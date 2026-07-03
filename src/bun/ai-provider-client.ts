import type { AiProviderId, AppSettings, ProviderModel } from "../shared/settings-types";
import { type AiChatClient, type ChatMessage, type ChatParams, OpenAICompatibleClient, parseJsonFromText } from "./openai-compatible-client";

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

export function createAiProviderClient(settings: AppSettings, apiKey: string): AiChatClient {
  const providerSettings = settings.providers[settings.aiProvider];
  const clientSettings = {
    provider: settings.aiProvider,
    baseUrl: providerSettings.baseUrl,
    apiKey,
    model: providerSettings.selectedModel,
  };

  if (settings.aiProvider === "anthropic") return new AnthropicClient(clientSettings);
  if (settings.aiProvider === "gemini") return new GeminiClient(clientSettings);
  return new OpenAICompatibleClient({
    baseUrl: clientSettings.baseUrl,
    apiKey,
    model: clientSettings.model,
    providerName: PROVIDER_LABELS[settings.aiProvider],
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
    if (!this.settings.apiKey) throw new Error("Claude API key is not configured");
    const response = await fetch(this.url("/v1/models"), { headers: this.headers() });
    if (!response.ok) throw new Error(`Model list failed: ${response.status} ${(await response.text()).replace(/\s+/g, " ").slice(0, 700)}`);
    const data = (await response.json()) as { data?: Array<{ id: string; created_at?: string }> };
    return (data.data || []).map((model) => ({ id: model.id }));
  }

  async chatJson(params: ChatParams): Promise<unknown> {
    return parseJsonFromText(await this.chat(params));
  }

  async chatText(params: ChatParams): Promise<string> {
    return this.chat(params);
  }

  private async chat(params: ChatParams) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw new Error("Claude API key is not configured");
    if (!model) throw new Error("Model is not selected");

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
    if (!response.ok) throw new Error(`AI provider HTTP ${response.status}: ${(await response.text()).replace(/\s+/g, " ").slice(0, 700)}`);
    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
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
    if (!this.settings.apiKey) throw new Error("Gemini API key is not configured");
    const response = await fetch(this.url("/models"), { headers: this.headers() });
    if (!response.ok) throw new Error(`Model list failed: ${response.status} ${(await response.text()).replace(/\s+/g, " ").slice(0, 700)}`);
    const data = (await response.json()) as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (data.models || [])
      .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes("generateContent"))
      .map((model) => ({ id: (model.name || "").replace(/^models\//, "") }))
      .filter((model) => model.id);
  }

  async chatJson(params: ChatParams): Promise<unknown> {
    return parseJsonFromText(await this.chat(params, true));
  }

  async chatText(params: ChatParams): Promise<string> {
    return this.chat(params, false);
  }

  private async chat(params: ChatParams, jsonMode: boolean) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw new Error("Gemini API key is not configured");
    if (!model) throw new Error("Model is not selected");
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
    if (!response.ok) throw new Error(`AI provider HTTP ${response.status}: ${(await response.text()).replace(/\s+/g, " ").slice(0, 700)}`);
    const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
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
    return new Error(`AI provider request timed out after ${Math.round((timeoutMs ?? 120000) / 1000)}s for ${provider} model ${model}`);
  }
  return new Error(`AI provider request failed: ${(error as Error)?.message || String(error)}`);
}
