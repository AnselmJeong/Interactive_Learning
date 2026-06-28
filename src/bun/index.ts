import { BrowserView, Utils } from "electrobun/bun";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { ProjectService } from "./project-service";
import { SettingsService } from "./settings-service";
import { AiProviderSettingsService } from "./ai-provider-settings";
import { OpenAICompatibleClient } from "./openai-compatible-client";
import { SourceService } from "./source-service";
import { CourseArtifactService } from "./course-artifact-service";
import { TutorService } from "./tutor-service";
import { createMainWindow } from "./app-window";
import { installApplicationMenu } from "./app-menu";
import type { AppRPC } from "../shared/rpc-types";

const projects = new ProjectService();
const settings = new SettingsService();
const secrets = new AiProviderSettingsService();
const sources = new SourceService();
const materials = new CourseArtifactService();
const tutor = new TutorService();

installApplicationMenu();
void settings.get().then((current) => projects.migrateUnsetProjectRoots(current.projectRootFolder)).catch((error) => {
  console.warn("Failed to migrate project roots", error);
});

function sendToView(message: string, payload: unknown) {
  const viewRpc = mainWindow?.webview.rpc as { proxy?: { send?: (message: string, payload: unknown) => void } } | undefined;
  viewRpc?.proxy?.send?.(message, payload);
}

function firstSelectedPath(selection: unknown) {
  if (typeof selection === "string") return selection;
  if (Array.isArray(selection)) return typeof selection[0] === "string" ? selection[0] : "";
  return "";
}

function normalizeSelectedPaths(selection: unknown) {
  const values = Array.isArray(selection) ? selection : typeof selection === "string" ? selection.split(",") : [];
  return values.map((path) => String(path).trim()).filter((path) => path && existsSync(path));
}

async function chooseSourcePaths() {
  const appSettings = await settings.get();
  const startingFolder = existsSync(appSettings.projectRootFolder) ? appSettings.projectRootFolder : Utils.paths.home;
  const selected = await Utils.openFileDialog({
    startingFolder,
    allowedFileTypes: "*",
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: true,
  });
  return normalizeSelectedPaths(selected);
}

async function providerClient() {
  const publicSettings = await settings.get();
  const apiKey = await secrets.getApiKey();
  return {
    publicSettings,
    apiKey,
    client: new OpenAICompatibleClient({
      baseUrl: publicSettings.ollamaBaseUrl,
      apiKey: apiKey.value,
      model: publicSettings.selectedModel,
    }),
  };
}

async function providerStatus(reachable = false, error?: string) {
  const publicSettings = await settings.get();
  const apiKey = await secrets.getApiKey();
  return {
    baseUrl: publicSettings.ollamaBaseUrl,
    hasApiKey: Boolean(apiKey.value),
    apiKeySource: apiKey.source,
    selectedModel: publicSettings.selectedModel,
    reachable,
    error,
  };
}

function openPath(path: string) {
  const child = spawn("open", [path], { stdio: "ignore", detached: true });
  child.unref();
  return true;
}

const rpc = BrowserView.defineRPC<AppRPC>({
  maxRequestTime: Infinity,
  handlers: {
    requests: {
      "projects.create": (params) => projects.create(params),
      "projects.list": () => projects.list(),
      "projects.open": ({ projectId }) => projects.open(projectId),
      "projects.archive": ({ projectId }) => projects.archive(projectId),
      "projects.openFolder": ({ projectId }) => openPath(projects.folder(projectId)),
      "sources.openDialog": () => chooseSourcePaths(),
      "sources.chooseAndImport": async ({ projectId }) => {
        const paths = await chooseSourcePaths();
        if (!paths.length) return sources.list(projectId);
        sendToView("sources.ingestionProgress", { projectId, stage: "extracting", message: "Importing sources", progress: 20 });
        await sources.importPaths(projectId, paths);
        sendToView("sources.ingestionProgress", { projectId, stage: "complete", message: "Sources imported", progress: 100 });
        return sources.list(projectId);
      },
      "sources.importPaths": async ({ projectId, paths }) => {
        sendToView("sources.ingestionProgress", { projectId, stage: "extracting", message: "Importing sources", progress: 20 });
        const result = await sources.importPaths(projectId, paths);
        sendToView("sources.ingestionProgress", { projectId, stage: "complete", message: "Sources imported", progress: 100 });
        return result;
      },
      "sources.list": ({ projectId }) => sources.list(projectId),
      "materials.generate": async ({ projectId, sourceIds }) => {
        sendToView("materials.generationProgress", { projectId, stage: "concepts", message: "Building source-grounded material", progress: 20 });
        const result = await materials.generate(projectId, sourceIds);
        sendToView("materials.generationProgress", { projectId, materialId: result.id, stage: "complete", message: "Material ready", progress: 100 });
        return result;
      },
      "materials.list": ({ projectId }) => materials.list(projectId),
      "materials.getArtifacts": ({ materialId }) => materials.getArtifacts(materialId),
      "sessions.list": ({ materialId }) => tutor.listSessions(materialId),
      "sessions.start": ({ materialId, mode, sessionId }) => tutor.start(materialId, { mode, sessionId }),
      "sessions.load": ({ sessionId }) => tutor.load(sessionId),
      "tutor.sendTurn": async ({ sessionId, userText }) => {
        sendToView("tutor.turnStarted", { sessionId });
        try {
          const result = await tutor.sendTurn(sessionId, userText);
          sendToView("tutor.turnCompleted", { sessionId, output: result.output });
          return result;
        } catch (error) {
          sendToView("tutor.turnError", { sessionId, error: (error as Error).message });
          throw error;
        }
      },
      "settings.getPublic": () => settings.get(),
      "settings.updatePublic": async (patch) => {
        const next = await settings.update(patch);
        if (typeof patch.projectRootFolder === "string") {
          await projects.migrateUnsetProjectRoots(next.projectRootFolder);
        }
        return next;
      },
      "settings.chooseProjectRootFolder": async () => {
        const current = await settings.get();
        const chosen = await Utils.openFileDialog({
          startingFolder: existsSync(current.projectRootFolder) ? current.projectRootFolder : Utils.paths.home,
          allowedFileTypes: "*",
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });
        const folder = firstSelectedPath(chosen);
        if (!folder) return current;
        const next = await settings.update({ projectRootFolder: folder });
        await projects.migrateUnsetProjectRoots(next.projectRootFolder);
        return next;
      },
      "aiProvider.status": () => providerStatus(),
      "aiProvider.updateSettings": async (patch) => {
        await secrets.update(patch);
        return providerStatus();
      },
      "aiProvider.listModels": async () => {
        const { client } = await providerClient();
        return client.listModels();
      },
      "aiProvider.testConnection": async () => {
        try {
          const { client, publicSettings } = await providerClient();
          const models = await client.listModels();
          const savedStillExists = !publicSettings.selectedModel || models.some((model) => model.id === publicSettings.selectedModel);
          if (!savedStillExists) {
            return providerStatus(true, "Saved model is unavailable. Choose a model manually.");
          }
          return providerStatus(true);
        } catch (error) {
          return providerStatus(false, (error as Error).message);
        }
      },
    },
    messages: {
      "app.log": ({ level, message }) => {
        console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${level}] ${message}`);
      },
    },
  },
});

const mainWindow = createMainWindow(rpc as never);
