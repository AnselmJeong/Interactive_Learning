import { dataPath } from "./paths";
import { readJsonFile, writeJsonFile } from "./json-file";

type AiProviderSecretSettings = {
  ollamaApiKey?: string;
};

const SECRET_PATH = dataPath("ai-provider-settings.json");

export class AiProviderSettingsService {
  async getApiKey() {
    const fromEnv = process.env.OLLAMA_API_KEY || process.env.OPENAI_API_KEY;
    if (fromEnv) return { value: fromEnv, source: "env" as const };
    const saved = await readJsonFile<AiProviderSecretSettings>(SECRET_PATH, {});
    return saved.ollamaApiKey ? { value: saved.ollamaApiKey, source: "settings" as const } : { value: "", source: null };
  }

  async hasSavedKey() {
    const saved = await readJsonFile<AiProviderSecretSettings>(SECRET_PATH, {});
    return Boolean(saved.ollamaApiKey);
  }

  async update(input: { ollamaApiKey?: string; clearApiKey?: boolean }) {
    const current = await readJsonFile<AiProviderSecretSettings>(SECRET_PATH, {});
    const next = { ...current };
    if (input.clearApiKey) {
      delete next.ollamaApiKey;
    } else if (typeof input.ollamaApiKey === "string" && input.ollamaApiKey.trim()) {
      next.ollamaApiKey = input.ollamaApiKey.trim();
    }
    await writeJsonFile(SECRET_PATH, next);
  }
}
