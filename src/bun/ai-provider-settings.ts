import { dataPath } from "./paths";
import { readJsonFile, writeJsonFile } from "./json-file";
import type { AiProviderId, AiProviderKeyState } from "../shared/settings-types";

type AiProviderSecretSettings = {
  ollamaApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  braveSearchApiKey?: string;
};

const PROVIDER_KEY_FIELDS: Record<AiProviderId, keyof AiProviderSecretSettings> = {
  ollama: "ollamaApiKey",
  openai: "openaiApiKey",
  anthropic: "anthropicApiKey",
  gemini: "geminiApiKey",
};
const PROVIDER_ENV_KEYS: Record<AiProviderId, string[]> = {
  ollama: ["OLLAMA_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};
const AI_PROVIDERS: AiProviderId[] = ["ollama", "openai", "anthropic", "gemini"];

function secretPath() {
  return dataPath("ai-provider-settings.json");
}

export class AiProviderSettingsService {
  async getBraveSearchApiKey() {
    const fromEnv = firstEnvValue(["BRAVE_SEARCH_API_KEY"]);
    if (fromEnv) return { value: fromEnv, source: "env" as const };
    const saved = await readJsonFile<AiProviderSecretSettings>(secretPath(), {});
    return saved.braveSearchApiKey
      ? { value: saved.braveSearchApiKey, source: "settings" as const }
      : { value: "", source: null };
  }

  async braveSearchKeyState(): Promise<AiProviderKeyState> {
    const key = await this.getBraveSearchApiKey();
    return { hasApiKey: Boolean(key.value), apiKeySource: key.source };
  }

  async getApiKey(provider: AiProviderId) {
    const fromEnv = firstEnvValue(PROVIDER_ENV_KEYS[provider]);
    if (fromEnv) return { value: fromEnv, source: "env" as const };
    const saved = await readJsonFile<AiProviderSecretSettings>(secretPath(), {});
    const savedKey = saved[PROVIDER_KEY_FIELDS[provider]];
    return savedKey ? { value: savedKey, source: "settings" as const } : { value: "", source: null };
  }

  async keyStates(): Promise<Record<AiProviderId, AiProviderKeyState>> {
    const saved = await readJsonFile<AiProviderSecretSettings>(secretPath(), {});
    const states = {} as Record<AiProviderId, AiProviderKeyState>;
    for (const provider of AI_PROVIDERS) {
      const fromEnv = firstEnvValue(PROVIDER_ENV_KEYS[provider]);
      const savedKey = saved[PROVIDER_KEY_FIELDS[provider]];
      states[provider] = {
        hasApiKey: Boolean(fromEnv || savedKey),
        apiKeySource: fromEnv ? "env" : savedKey ? "settings" : null,
      };
    }
    return states;
  }

  async update(input: {
    provider?: AiProviderId;
    ollamaApiKey?: string;
    apiKeys?: Partial<Record<AiProviderId, string>>;
    braveSearchApiKey?: string;
    clearApiKey?: boolean;
    clearApiKeyFor?: AiProviderId;
    clearBraveSearchApiKey?: boolean;
  }) {
    const current = await readJsonFile<AiProviderSecretSettings>(secretPath(), {});
    const next = { ...current };

    if (input.clearApiKeyFor) {
      delete next[PROVIDER_KEY_FIELDS[input.clearApiKeyFor]];
    } else if (input.clearApiKey) {
      delete next[PROVIDER_KEY_FIELDS[input.provider || "ollama"]];
    }
    if (input.clearBraveSearchApiKey) delete next.braveSearchApiKey;

    if (typeof input.ollamaApiKey === "string" && input.ollamaApiKey.trim()) {
      next.ollamaApiKey = input.ollamaApiKey.trim();
    }
    for (const provider of AI_PROVIDERS) {
      const value = input.apiKeys?.[provider];
      if (typeof value === "string" && value.trim()) {
        next[PROVIDER_KEY_FIELDS[provider]] = value.trim();
      }
    }
    if (typeof input.braveSearchApiKey === "string" && input.braveSearchApiKey.trim()) {
      next.braveSearchApiKey = input.braveSearchApiKey.trim();
    }
    await writeJsonFile(secretPath(), next);
  }
}

function firstEnvValue(names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}
