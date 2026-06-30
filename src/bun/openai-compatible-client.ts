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
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<unknown> {
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
      // The model ignored the JSON format instruction and returned prose. Salvage it rather than
      // forcing a full retry, but DO NOT silently cap it at a tiny length (that produced the
      // mid-sentence cut). Hand the full prose to the caller as a single paragraph; the caller's
      // sanitizer splits long prose into scannable blocks. Log it so a chronically-failing JSON
      // path (which would mean the schema/visual instructions never apply) is visible.
      if (prose.length > 10) {
        console.warn(`[ai] Model returned prose instead of JSON; salvaging ${prose.length} chars as paragraph. Parse error: ${(error as Error).message}`);
        return {
          message: prose.slice(0, 6000),
          blocks: [{ type: "paragraph", body: prose.slice(0, 6000) }],
          stateUpdate: { criticWarning: "Model returned prose instead of structured JSON; salvaged as paragraph." },
        };
      }
      throw new Error(`AI returned invalid JSON: ${(error as Error).message}. Response excerpt: ${prose.slice(0, 500)}`);
    }
  }

  async chatText(params: {
    model?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  }) {
    return this.chat(params);
  }

  private async chat(
    params: {
      model?: string;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
    },
    responseFormat?: { type: "json_object" }
  ) {
    const model = params.model || this.settings.model;
    if (!this.settings.apiKey) throw new Error("Ollama API key is not configured");
    if (!model) throw new Error("Model is not selected");

    // Bound every request so a stalled provider fails fast instead of hanging the turn forever.
    let response: Response;
    try {
      response = await fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(params.timeoutMs ?? 120000),
        body: JSON.stringify({
          model,
          messages: params.messages,
          temperature: params.temperature ?? 0.7,
          // Output token budget. NOTE: this is TOKENS, not characters — and Korean is token-dense
          // (~2-3 tokens per syllable), while the response also carries the full JSON envelope
          // (blocks, choices, stateUpdate, sourceRefs). So 2048 tokens only buys ~600-900 Korean
          // characters of actual teaching before the turn truncates mid-sentence. Keep this high.
          max_tokens: params.maxTokens ?? 8192,
          response_format: responseFormat,
        }),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`AI provider request timed out after ${Math.round((params.timeoutMs ?? 120000) / 1000)}s for model ${model}`);
      }
      throw new Error(`AI provider request failed: ${(error as Error)?.message || String(error)}`);
    }

    if (!response.ok) {
      throw new Error(`AI provider HTTP ${response.status}: ${(await response.text()).replace(/\s+/g, " ").slice(0, 700)}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || "";
    if (!content.trim()) throw new Error(`AI provider returned an empty message for model ${model}`);
    return content;
  }
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
