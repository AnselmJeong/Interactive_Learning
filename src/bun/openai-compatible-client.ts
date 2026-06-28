import type { ProviderModel } from "../shared/settings-types";

type ClientSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export class OpenAICompatibleClient {
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
    if (!this.settings.apiKey) throw new Error("Ollama API key is not configured");
    const response = await fetch(this.url("/models"), { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`Model list failed: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as { data?: Array<{ id: string; created?: number }> };
    return (data.data || []).map((model) => ({ id: model.id, created: model.created }));
  }

  async chatJson(params: {
    model?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
  }): Promise<unknown> {
    const text = await this.chat(params, { type: "json_object" });
    return parseJsonFromText(text);
  }

  async chatText(params: {
    model?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
  }) {
    return this.chat(params);
  }

  private async chat(
    params: {
      model?: string;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      temperature?: number;
    },
    responseFormat?: { type: "json_object" }
  ) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw new Error("Ollama API key is not configured");
    if (!model) throw new Error("Model is not selected");

    const response = await fetch(this.url("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages: params.messages,
        temperature: params.temperature ?? 0.7,
        response_format: responseFormat,
      }),
    });

    if (!response.ok) {
      throw new Error(`Chat completion failed: ${response.status} ${(await response.text()).slice(0, 700)}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || "";
  }
}

export function parseJsonFromText(text: string) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Model did not return valid JSON");
  }
}
