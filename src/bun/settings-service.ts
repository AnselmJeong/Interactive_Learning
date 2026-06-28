import { mkdir } from "node:fs/promises";
import { dataPath } from "./paths";
import { readJsonFile, writeJsonFile } from "./json-file";
import type { AppSettings } from "../shared/settings-types";

const SETTINGS_PATH = dataPath("settings.json");

export const defaultSettings: AppSettings = {
  theme: "system",
  selectedModel: "",
  ollamaBaseUrl: "https://ollama.com/v1",
  projectRootFolder: dataPath("projects"),
  tutorLanguage: "ko",
  autoAdvanceOnMastery: true,
  showSourceInspector: true,
};

export class SettingsService {
  async get() {
    const saved = await readJsonFile<Partial<AppSettings>>(SETTINGS_PATH, {});
    return { ...defaultSettings, ...saved };
  }

  async update(patch: Partial<AppSettings>) {
    const current = await this.get();
    const next = { ...current, ...patch };
    if (!next.ollamaBaseUrl.trim()) next.ollamaBaseUrl = defaultSettings.ollamaBaseUrl;
    if (!next.projectRootFolder.trim()) next.projectRootFolder = defaultSettings.projectRootFolder;
    await mkdir(next.projectRootFolder, { recursive: true });
    await writeJsonFile(SETTINGS_PATH, next);
    return next;
  }
}
