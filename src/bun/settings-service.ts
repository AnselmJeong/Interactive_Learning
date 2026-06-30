import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "./paths";
import { readJsonFile, writeJsonFile } from "./json-file";
import type { AppSettings } from "../shared/settings-types";

const SETTINGS_PATH = dataPath("settings.json");
const DEFAULT_DOWNLOAD_FOLDER = process.env.HOME ? join(process.env.HOME, "Downloads") : dataPath("exports");

export const defaultSettings: AppSettings = {
  theme: "system",
  selectedModel: "",
  ollamaBaseUrl: "https://ollama.com/v1",
  projectRootFolder: dataPath("projects"),
  defaultDownloadFolder: DEFAULT_DOWNLOAD_FOLDER,
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
    if (!next.defaultDownloadFolder.trim()) next.defaultDownloadFolder = defaultSettings.defaultDownloadFolder;
    await mkdir(next.projectRootFolder, { recursive: true });
    await mkdir(next.defaultDownloadFolder, { recursive: true });
    await writeJsonFile(SETTINGS_PATH, next);
    return next;
  }
}
