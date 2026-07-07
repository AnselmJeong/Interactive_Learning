import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "./paths";
import { readJsonFile, writeJsonFile } from "./json-file";
import { SOURCE_IMPORT_MIN_CHARS_OPTIONS, type AiProviderId, type AppSettings, type ChatSubmitShortcut, type SourceImportMinChars } from "../shared/settings-types";
import { modelSupportsVision } from "../shared/vision-models";

const DEFAULT_PROVIDERS: AppSettings["providers"] = {
  ollama: { baseUrl: "http://localhost:11434/v1", selectedModel: "", selectedVisionModel: "" },
  openai: { baseUrl: "https://api.openai.com/v1", selectedModel: "", selectedVisionModel: "" },
  anthropic: { baseUrl: "https://api.anthropic.com", selectedModel: "", selectedVisionModel: "" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", selectedModel: "", selectedVisionModel: "" },
};

const AI_PROVIDERS: AiProviderId[] = ["ollama", "openai", "anthropic", "gemini"];
const CHAT_SUBMIT_SHORTCUTS: ChatSubmitShortcut[] = ["enter", "cmd-enter"];
const THEME_MODES: AppSettings["theme"][] = ["light", "dark", "system"];
const SOURCE_IMPORT_MIN_CHARS = SOURCE_IMPORT_MIN_CHARS_OPTIONS as readonly number[];

export type SettingsPatch = Omit<Partial<AppSettings>, "providers"> & {
  providers?: Partial<AppSettings["providers"]>;
};

export const defaultSettings: AppSettings = {
  theme: "system",
  aiProvider: "ollama",
  visionProvider: "ollama",
  selectedModel: "",
  ollamaBaseUrl: DEFAULT_PROVIDERS.ollama.baseUrl,
  providers: DEFAULT_PROVIDERS,
  projectRootFolder: "",
  defaultDownloadFolder: "",
  tutorLanguage: "ko",
  chatSubmitShortcut: "cmd-enter",
  autoAdvanceOnMastery: true,
  tutorPrefetchEnabled: true,
  showSourceInspector: true,
  answerReadySound: true,
  learningBuddyEnabled: true,
  sourceImportMinChars: 1000,
};

function settingsPath() {
  return dataPath("settings.json");
}

function defaultDownloadFolder() {
  return process.env.HOME ? join(process.env.HOME, "Downloads") : dataPath("exports");
}

function runtimeDefaultSettings(): AppSettings {
  return {
    ...defaultSettings,
    providers: cloneProviders(defaultSettings.providers),
    projectRootFolder: dataPath("projects"),
    defaultDownloadFolder: defaultDownloadFolder(),
  };
}

function cloneProviders(providers: AppSettings["providers"]): AppSettings["providers"] {
  return AI_PROVIDERS.reduce((acc, id) => {
    acc[id] = { ...providers[id] };
    return acc;
  }, {} as AppSettings["providers"]);
}

export class SettingsService {
  async get() {
    const saved = await readJsonFile<Partial<AppSettings>>(settingsPath(), {});
    return normalizeSettings(saved);
  }

  async update(patch: SettingsPatch) {
    const current = await this.get();
    const defaults = runtimeDefaultSettings();
    const next = normalizeSettings(mergeSettingsPatch(current, patch));
    if (!next.ollamaBaseUrl.trim()) next.ollamaBaseUrl = defaults.ollamaBaseUrl;
    for (const provider of AI_PROVIDERS) {
      if (!next.providers[provider].baseUrl.trim()) {
        next.providers[provider].baseUrl = defaults.providers[provider].baseUrl;
      }
    }
    if (typeof patch.selectedModel === "string") {
      next.providers[next.aiProvider].selectedModel = patch.selectedModel;
    }
    next.selectedModel = next.providers[next.aiProvider].selectedModel;
    next.ollamaBaseUrl = next.providers.ollama.baseUrl;
    if (!next.projectRootFolder.trim()) next.projectRootFolder = defaults.projectRootFolder;
    if (!next.defaultDownloadFolder.trim()) next.defaultDownloadFolder = defaults.defaultDownloadFolder;
    await mkdir(next.projectRootFolder, { recursive: true });
    await mkdir(next.defaultDownloadFolder, { recursive: true });
    await writeJsonFile(settingsPath(), next);
    return next;
  }
}

export function mergeSettingsPatch(current: AppSettings, patch: SettingsPatch): Partial<AppSettings> {
  return {
    ...current,
    ...patch,
    providers: patch.providers
      ? AI_PROVIDERS.reduce((acc, id) => {
          acc[id] = {
            ...current.providers[id],
            ...patch.providers?.[id],
          };
          return acc;
        }, {} as AppSettings["providers"])
      : current.providers,
  };
}

export function normalizeSettings(saved: Partial<AppSettings>, defaults = runtimeDefaultSettings()): AppSettings {
  const provider = AI_PROVIDERS.includes(saved.aiProvider as AiProviderId) ? (saved.aiProvider as AiProviderId) : "ollama";
  const visionProvider = AI_PROVIDERS.includes(saved.visionProvider as AiProviderId) ? (saved.visionProvider as AiProviderId) : provider;
  const theme = THEME_MODES.includes(saved.theme as AppSettings["theme"]) ? (saved.theme as AppSettings["theme"]) : defaults.theme;
  const chatSubmitShortcut = CHAT_SUBMIT_SHORTCUTS.includes(saved.chatSubmitShortcut as ChatSubmitShortcut)
    ? (saved.chatSubmitShortcut as ChatSubmitShortcut)
    : defaults.chatSubmitShortcut;
  const sourceImportMinChars = SOURCE_IMPORT_MIN_CHARS.includes(Number(saved.sourceImportMinChars))
    ? (Number(saved.sourceImportMinChars) as SourceImportMinChars)
    : defaults.sourceImportMinChars;
  const savedProviders = saved.providers || {};
  const providers = AI_PROVIDERS.reduce((acc, id) => {
    acc[id] = {
      ...defaults.providers[id],
      ...(savedProviders as Partial<AppSettings["providers"]>)[id],
    };
    return acc;
  }, {} as AppSettings["providers"]);
  const savedOllamaBaseUrl = typeof saved.ollamaBaseUrl === "string" ? saved.ollamaBaseUrl.trim() : "";
  const savedOllamaProvider = (savedProviders as Partial<AppSettings["providers"]>).ollama;
  if (savedOllamaBaseUrl && !savedOllamaProvider?.baseUrl) {
    providers.ollama.baseUrl = savedOllamaBaseUrl;
  }

  if (saved.selectedModel && !providers[provider].selectedModel) providers[provider].selectedModel = saved.selectedModel;
  const legacyVisionModel = providers[visionProvider].selectedModel;
  if (!providers[visionProvider].selectedVisionModel && modelSupportsVision(visionProvider, legacyVisionModel)) {
    providers[visionProvider].selectedVisionModel = legacyVisionModel;
  }

  return {
    ...defaults,
    ...saved,
    theme,
    aiProvider: provider,
    visionProvider,
    providers,
    ollamaBaseUrl: providers.ollama.baseUrl,
    selectedModel: providers[provider].selectedModel,
    chatSubmitShortcut,
    sourceImportMinChars,
  };
}
