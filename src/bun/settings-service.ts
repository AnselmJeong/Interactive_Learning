import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "./paths";
import { readJsonFile, writeJsonFile } from "./json-file";
import type { AiProviderId, AppSettings } from "../shared/settings-types";

const SETTINGS_PATH = dataPath("settings.json");
const DEFAULT_DOWNLOAD_FOLDER = process.env.HOME ? join(process.env.HOME, "Downloads") : dataPath("exports");
const DEFAULT_PROVIDERS: AppSettings["providers"] = {
  ollama: { baseUrl: "https://ollama.com/v1", selectedModel: "" },
  openai: { baseUrl: "https://api.openai.com/v1", selectedModel: "" },
  anthropic: { baseUrl: "https://api.anthropic.com", selectedModel: "" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", selectedModel: "" },
};

const AI_PROVIDERS: AiProviderId[] = ["ollama", "openai", "anthropic", "gemini"];

export const defaultSettings: AppSettings = {
  theme: "system",
  aiProvider: "ollama",
  selectedModel: "",
  ollamaBaseUrl: "https://ollama.com/v1",
  providers: DEFAULT_PROVIDERS,
  projectRootFolder: dataPath("projects"),
  defaultDownloadFolder: DEFAULT_DOWNLOAD_FOLDER,
  tutorLanguage: "ko",
  autoAdvanceOnMastery: true,
  showSourceInspector: true,
  answerReadySound: true,
};

export class SettingsService {
  async get() {
    const saved = await readJsonFile<Partial<AppSettings>>(SETTINGS_PATH, {});
    return normalizeSettings(saved);
  }

  async update(patch: Partial<AppSettings>) {
    const current = await this.get();
    const next = normalizeSettings({ ...current, ...patch });
    if (!next.ollamaBaseUrl.trim()) next.ollamaBaseUrl = defaultSettings.ollamaBaseUrl;
    for (const provider of AI_PROVIDERS) {
      if (!next.providers[provider].baseUrl.trim()) {
        next.providers[provider].baseUrl = defaultSettings.providers[provider].baseUrl;
      }
    }
    if (typeof patch.selectedModel === "string") {
      next.providers[next.aiProvider].selectedModel = patch.selectedModel;
    }
    next.selectedModel = next.providers[next.aiProvider].selectedModel;
    next.ollamaBaseUrl = next.providers.ollama.baseUrl;
    if (!next.projectRootFolder.trim()) next.projectRootFolder = defaultSettings.projectRootFolder;
    if (!next.defaultDownloadFolder.trim()) next.defaultDownloadFolder = defaultSettings.defaultDownloadFolder;
    await mkdir(next.projectRootFolder, { recursive: true });
    await mkdir(next.defaultDownloadFolder, { recursive: true });
    await writeJsonFile(SETTINGS_PATH, next);
    return next;
  }
}

function normalizeSettings(saved: Partial<AppSettings>): AppSettings {
  const provider = AI_PROVIDERS.includes(saved.aiProvider as AiProviderId) ? (saved.aiProvider as AiProviderId) : "ollama";
  const savedProviders = saved.providers || {};
  const providers = AI_PROVIDERS.reduce((acc, id) => {
    acc[id] = {
      ...DEFAULT_PROVIDERS[id],
      ...(savedProviders as Partial<AppSettings["providers"]>)[id],
    };
    return acc;
  }, {} as AppSettings["providers"]);

  providers.ollama.baseUrl = DEFAULT_PROVIDERS.ollama.baseUrl;
  if (saved.selectedModel && !providers[provider].selectedModel) providers[provider].selectedModel = saved.selectedModel;

  return {
    ...defaultSettings,
    ...saved,
    aiProvider: provider,
    providers,
    ollamaBaseUrl: providers.ollama.baseUrl,
    selectedModel: providers[provider].selectedModel,
  };
}
