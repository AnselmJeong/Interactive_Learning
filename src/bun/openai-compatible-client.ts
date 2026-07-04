import type { ProviderModel } from "../shared/settings-types";
import { modelSupportsVision } from "../shared/vision-models";
import { providerConfigurationError, providerHttpError, providerNetworkError, providerTimeoutError } from "./provider-error";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatParams = {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  thinking?: "enabled" | "disabled";
};

export type ImagePart = { mimeType: string; dataBase64: string };

export interface AiChatClient {
  listModels(): Promise<ProviderModel[]>;
  chatJson(params: ChatParams): Promise<unknown>;
  chatText(params: ChatParams): Promise<string>;
  describeImage?(params: {
    image: ImagePart;
    prompt: string;
    system?: string;
    model?: string;
    timeoutMs?: number;
  }): Promise<string>;
}

type ClientSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName?: string;
};

export class OpenAICompatibleClient implements AiChatClient {
  constructor(private readonly settings: ClientSettings) {}

  private url(path: string) {
    return `${this.settings.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers() {
    return {
      authorization: `Bearer ${this.settings.apiKey}`,
      "content-type": "application/json",
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    if (!this.settings.apiKey) throw providerConfigurationError(this.providerName(), undefined, `${this.providerName()} API key is not configured`);
    const response = await fetch(this.url("/models"), { headers: this.headers() });
    if (!response.ok) {
      throw await providerHttpError(response, this.providerName(), undefined, "Model list failed");
    }
    const data = (await response.json()) as { data?: Array<{ id: string; created?: number }> };
    return (data.data || []).map((model) => ({
      id: model.id,
      created: model.created,
      supportsVision: modelSupportsVision(this.providerId(), model.id),
    }));
  }

  async chatJson(params: ChatParams): Promise<unknown> {
    const text = await this.chat(params, { type: "json_object" });
    try {
      return parseJsonFromText(text);
    } catch (error) {
      const prose = text.replace(/\s+/g, " ").trim();
      // If the text looks like an ATTEMPTED-but-truncated JSON object (it began as JSON and got
      // cut off mid-generation), do NOT salvage it as prose — that dumps raw braces and flattens
      // a compare_table into pipe text. Throw instead so the caller retries / falls back to a
      // clean structured turn rather than rendering the mangled fragment.
      const looksLikeTruncatedJson = prose.startsWith("{") && (prose.includes('"blocks"') || prose.includes('"message"'));
      if (looksLikeTruncatedJson) {
        throw new Error(`AI returned truncated JSON (likely hit the output token limit): ${(error as Error).message}`);
      }
      // For structured tutor turns, prose is a format failure. Do not silently salvage it here:
      // the caller owns retries and the explicit text-repair fallback. Salvaging at this layer
      // bypasses the stricter JSON retry and flattens rich blocks into a paragraph.
      if (prose.length > 10) {
        throw new Error(`AI returned prose instead of JSON: ${(error as Error).message}. Response excerpt: ${prose.slice(0, 500)}`);
      }
      throw new Error(`AI returned invalid JSON: ${(error as Error).message}. Response excerpt: ${prose.slice(0, 500)}`);
    }
  }

  async chatText(params: ChatParams) {
    return this.chat(params);
  }

  async describeImage(params: {
    image: ImagePart;
    prompt: string;
    system?: string;
    model?: string;
    timeoutMs?: number;
  }) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw providerConfigurationError(this.providerName(), model, `${this.providerName()} API key is not configured`);
    if (!model) throw providerConfigurationError(this.providerName(), model, "Model is not selected");

    const messages: Array<Record<string, unknown>> = [];
    if (params.system) messages.push({ role: "system", content: params.system });
    messages.push({
      role: "user",
      content: [
        { type: "text", text: params.prompt },
        {
          type: "image_url",
          image_url: {
            url: `data:${params.image.mimeType};base64,${params.image.dataBase64}`,
            detail: "auto",
          },
        },
      ],
    });

    let response: Response;
    try {
      response = await fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(params.timeoutMs ?? 120000),
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.4,
          max_tokens: 2048,
        }),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw providerTimeoutError(this.providerName(), model, params.timeoutMs ?? 120000);
      }
      throw providerNetworkError(error, this.providerName(), model);
    }

    if (!response.ok) {
      throw await providerHttpError(response, this.providerName(), model);
    }

    const data = (await response.json()) as { choices?: Array<{ finish_reason?: string | null; message?: { content?: string | Array<{ text?: string }> } }> };
    const choice = data.choices?.[0];
    assertOpenAIChoiceFinished(this.providerName(), model, choice);
    const raw = choice?.message?.content;
    const content = typeof raw === "string" ? raw : (raw || []).map((part) => part.text || "").join("\n");
    if (!content.trim()) throw new Error(`AI provider returned an empty image explanation for model ${model}`);
    return content.trim();
  }

  private async chat(
    params: ChatParams,
    responseFormat?: { type: "json_object" }
  ) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw providerConfigurationError(this.providerName(), model, `${this.providerName()} API key is not configured`);
    if (!model) throw providerConfigurationError(this.providerName(), model, "Model is not selected");

    const body: Record<string, unknown> = {
      model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      // Output token budget. NOTE: this is TOKENS, not characters — and Korean is token-dense
      // (~2-3 tokens per syllable), while the response also carries the full JSON envelope
      // (blocks, choices, stateUpdate, sourceRefs). So 2048 tokens only buys ~600-900 Korean
      // characters of actual teaching before the turn truncates mid-sentence. Keep this high.
      max_tokens: params.maxTokens ?? 8192,
      response_format: responseFormat,
    };
    if (params.thinking && this.supportsThinkingToggle(model)) {
      body.thinking = { type: params.thinking };
    }

    // Bound every request so a stalled provider fails fast instead of hanging the turn forever.
    let response: Response;
    try {
      response = await fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(params.timeoutMs ?? 120000),
        body: JSON.stringify(body),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw providerTimeoutError(this.providerName(), model, params.timeoutMs ?? 120000);
      }
      throw providerNetworkError(error, this.providerName(), model);
    }

    if (!response.ok) {
      throw await providerHttpError(response, this.providerName(), model);
    }

    const data = (await response.json()) as { choices?: Array<{ finish_reason?: string | null; message?: { content?: string } }> };
    const choice = data.choices?.[0];
    assertOpenAIChoiceFinished(this.providerName(), model, choice);
    const content = choice?.message?.content || "";
    if (!content.trim()) throw new Error(`AI provider returned an empty message for model ${model}`);
    return content;
  }

  private providerName() {
    return this.settings.providerName || "AI provider";
  }

  private providerId() {
    const name = this.providerName().toLowerCase();
    if (name.includes("openai")) return "openai";
    if (name.includes("ollama")) return "ollama";
    return "openai";
  }

  private supportsThinkingToggle(model: string) {
    const name = this.providerName().toLowerCase();
    const baseUrl = this.settings.baseUrl.toLowerCase();
    const modelId = model.toLowerCase();
    return name.includes("deepseek") || baseUrl.includes("deepseek") || modelId.startsWith("deepseek-v4-");
  }
}

function assertOpenAIChoiceFinished(
  provider: string,
  model: string,
  choice: { finish_reason?: string | null } | undefined
) {
  const reason = choice?.finish_reason;
  if (!reason || reason === "stop") return;
  if (reason === "length") {
    throw new Error(`${provider} ${model} stopped before finishing because it hit the output token limit (finish_reason=length)`);
  }
  if (reason === "content_filter") {
    throw new Error(`${provider} ${model} stopped because the provider content filter interrupted the response (finish_reason=content_filter)`);
  }
  throw new Error(`${provider} ${model} stopped before finishing (finish_reason=${reason})`);
}

export function parseJsonFromText(text: string) {
  const trimmed = text.trim();
  // Strip a fenced block if the model wrapped the JSON in markdown code fences.
  // Allow prose before/after the fence — the model sometimes adds commentary.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Try to extract the first balanced JSON object, counting braces and
    // respecting string literals so } inside strings doesn't confuse us.
    const extracted = extractFirstJsonObject(candidate);
    if (extracted) return JSON.parse(extracted);
    throw new Error("Model did not return valid JSON");
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
