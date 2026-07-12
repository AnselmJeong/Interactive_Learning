import Electrobun, { BrowserView, Utils } from "electrobun/bun";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ProjectService } from "./project-service";
import { ProjectTransferService } from "./project-transfer-service";
import { SessionExportService } from "./session-export-service";
import { SettingsService } from "./settings-service";
import { AiProviderSettingsService } from "./ai-provider-settings";
import { createAiProviderClient } from "./ai-provider-client";
import { SourceService } from "./source-service";
import { CourseArtifactService } from "./course-artifact-service";
import { AnnotationService } from "./annotation-service";
import { TutorService } from "./tutor-service";
import { createMainWindow } from "./app-window";
import { installApplicationMenu } from "./app-menu";
import type { AiProviderConnectionInput, AppRPC, BuddyMessageInput } from "../shared/rpc-types";
import type { AiProviderKeyState } from "../shared/settings-types";
import { modelSupportsVision } from "../shared/vision-models";
import { openFilesystemPath } from "./platform-utils";
import { configureAppDataBase, configureDatabaseBase, stableDatabaseBase } from "./paths";
import { normalizeSelectedPaths } from "./file-dialog-selection";
import { buildBuddyPromptMessages, cleanBuddyMessage } from "./buddy-message";
import { searchOllamaWeb } from "./ollama-web-search-service";
import { searchBraveImages } from "./brave-image-search-service";
import { createFigureAssetServer } from "./figure-asset-server";

configureAppDataBase(Utils.paths.userData);
configureDatabaseBase(stableDatabaseBase(Utils.paths.userData));

const projects = new ProjectService();
const projectTransfers = new ProjectTransferService();
const sessionExports = new SessionExportService();
const settings = new SettingsService();
const secrets = new AiProviderSettingsService();
const sources = new SourceService();
const materials = new CourseArtifactService(materialOverviewRuntime);
const figureAssetServer = createFigureAssetServer(async (materialId, figureId) => {
  const artifacts = await materials.getArtifacts(materialId);
  const figure = artifacts.figures.find((item) => item.id === figureId);
  return figure ? { path: figure.assetPath, mimeType: figure.mimeType || "image/png" } : null;
});
const annotations = new AnnotationService(materials, providerClient, async (query) => {
  const ollamaKey = await secrets.getApiKey("ollama");
  return searchOllamaWeb(query, ollamaKey.value);
}, async (query) => {
  const braveKey = await secrets.getBraveSearchApiKey();
  if (!braveKey.value) {
    return {
      images: [],
      warning: "Brave Search API key가 없어 Wikipedia 이미지 검색으로 전환했습니다.",
    };
  }
  return { images: await searchBraveImages(query, braveKey.value) };
});
const tutor = new TutorService(
  (status) => sendToView("tutor.prefetchStatus", status),
  undefined,
  (status) => sendToView("materials.messageSetProgress", status)
);
const MAX_FIGURE_VISION_IMAGE_BYTES = 6_000_000;

void settings.get().then((current) => projects.migrateUnsetProjectRoots(current.projectRootFolder)).catch((error) => {
  console.warn("Failed to migrate project roots", error);
});
void Promise.resolve(materials.recoverInterruptedGenerations()).then((count) => {
  if (count) console.warn(`Recovered ${count} interrupted material generation(s).`);
}).catch((error) => {
  console.warn("Failed to recover interrupted material generations", error);
});
void tutor.recoverInterruptedMessageSets().then((count) => {
  if (count) console.warn(`Resumed ${count} interrupted prepared message set(s).`);
}).catch((error) => {
  console.warn("Failed to recover interrupted prepared message sets", error);
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

async function chooseSourcePaths() {
  const appSettings = await settings.get();
  const startingFolder = existsSync(appSettings.projectRootFolder) ? appSettings.projectRootFolder : Utils.paths.home;
  const selected = await Utils.openFileDialog({
    startingFolder,
    allowedFileTypes: "pdf,epub,md,txt",
    canChooseFiles: true,
    canChooseDirectory: true,
    allowsMultipleSelection: true,
  });
  return normalizeSelectedPaths(selected);
}

async function chooseProjectTransferPath() {
  const current = await settings.get();
  const selected = await Utils.openFileDialog({
    startingFolder: existsSync(current.defaultDownloadFolder) ? current.defaultDownloadFolder : Utils.paths.home,
    allowedFileTypes: "zip",
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
  });
  return firstSelectedPath(selected);
}

async function providerClient(input: AiProviderConnectionInput = {}) {
  const publicSettings = input.settings || await settings.get();
  const provider = input.provider || publicSettings.aiProvider;
  const overrideKey = input.apiKeys?.[provider]?.trim();
  const apiKey = overrideKey ? { value: overrideKey, source: "settings" as const } : await secrets.getApiKey(provider);
  return {
    publicSettings,
    provider,
    apiKey,
    client: createAiProviderClient(publicSettings, apiKey.value, provider),
  };
}

async function materialOverviewRuntime() {
  const runtime = await providerClient();
  const model = runtime.publicSettings.providers[runtime.provider].selectedModel;
  if (!model) throw new Error("학습 모델을 먼저 선택해야 자료 전체 요약을 만들 수 있습니다");
  return { client: runtime.client, model };
}

async function providerStatus(reachable = false, error?: string, input: AiProviderConnectionInput = {}) {
  const publicSettings = input.settings || await settings.get();
  const provider = input.provider || publicSettings.aiProvider;
  const overrideKey = input.apiKeys?.[provider]?.trim();
  const apiKey = overrideKey ? { value: overrideKey, source: "settings" as const } : await secrets.getApiKey(provider);
  const keyStates = await secrets.keyStates();
  const braveSearchKeyState = await secrets.braveSearchKeyState();
  if (overrideKey) {
    keyStates[provider] = { hasApiKey: true, apiKeySource: "settings" } satisfies AiProviderKeyState;
  }
  const providerSettings = publicSettings.providers[provider];
  return {
    provider,
    baseUrl: providerSettings.baseUrl,
    hasApiKey: Boolean(apiKey.value),
    apiKeySource: apiKey.source,
    braveSearchKeyState,
    keyStates,
    selectedModel: input.modelPurpose === "vision" ? providerSettings.selectedVisionModel : providerSettings.selectedModel,
    reachable,
    error,
  };
}

function uniqueValues(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function languageInstruction(tutorLanguage: string) {
  if (tutorLanguage === "ko") {
    return [
      "Reply in Korean.",
      "Keep proper nouns and visible English source terms when they matter, but explain their meaning in Korean.",
      "Do not open with English stock phrases such as 'Based on the visible text'.",
    ].join(" ");
  }
  return "Reply in English.";
}

async function testSelectedLearningModel(client: Awaited<ReturnType<typeof providerClient>>["client"], model: string) {
  await client.chatText({
    model,
    messages: [
      { role: "system", content: "Reply with exactly: OK" },
      { role: "user", content: "Connection test." },
    ],
    temperature: 0,
    maxTokens: 8,
    timeoutMs: 15000,
    thinking: "disabled",
  });
}

async function generateBuddyMessage(input: BuddyMessageInput) {
  const { client } = await providerClient();
  const text = await client.chatText({
    temperature: 1,
    maxTokens: 256,
    timeoutMs: 20000,
    thinking: "disabled",
    messages: buildBuddyPromptMessages(input),
  });
  return { text: cleanBuddyMessage(text) };
}

async function explainFigure(materialId: string, figureId: string, userPrompt?: string, contextChunkIds: string[] = []) {
  const artifacts = await materials.getArtifacts(materialId);
  const figure = artifacts.figures.find((item) => item.id === figureId);
  if (!figure) throw new Error("Figure not found");
  if (!existsSync(figure.assetPath)) throw new Error("FIGURE_ASSET_MISSING: The source image file is missing.");

  const publicSettings = await settings.get();
  const visionProvider = publicSettings.visionProvider;
  const apiKey = await secrets.getApiKey(visionProvider);
  const client = createAiProviderClient(publicSettings, apiKey.value, visionProvider);
  const model = publicSettings.providers[visionProvider].selectedVisionModel;
  if (!model || !apiKey.value) throw new Error("AI provider is not configured");
  if (!client.describeImage) {
    throw new Error("VISION_MODEL_REQUIRED: 이 그림 설명에는 vision-capable model이 필요합니다. Settings에서 Figure vision model을 선택하세요.");
  }

  const chunksById = new Map(artifacts.sourceChunks.map((chunk) => [chunk.id, chunk]));
  const validContextChunkIds = uniqueValues(contextChunkIds).filter((id) => chunksById.has(id));
  const primaryChunkIds = uniqueValues([...validContextChunkIds, ...figure.sourceChunkIds]).filter((id) => chunksById.has(id));
  const contextModule = artifacts.coursePlan.modules.find((module) => primaryChunkIds.some((id) => module.sourceChunkIds.includes(id)));
  const contextChunkIdsForPrompt = uniqueValues([
    ...primaryChunkIds,
    ...(contextModule?.sourceChunkIds || []),
  ]).filter((id) => chunksById.has(id)).slice(0, 6);
  const contextChunks = contextChunkIdsForPrompt
    .map((id) => {
      const chunk = chunksById.get(id)!;
      const meta = artifacts.sourceIndex[id];
      const labels = [
        validContextChunkIds.includes(id) ? "current chunk" : "",
        figure.sourceChunkIds.includes(id) ? "figure-linked chunk" : "",
      ].filter(Boolean).join(", ");
      return [
        `Chunk: ${meta?.title || chunk.headingPath.join(" > ") || id}${labels ? ` (${labels})` : ""}`,
        `Locator: ${meta?.locator || chunk.locator}`,
        chunk.text.replace(/\s+/g, " ").trim().slice(0, 900),
      ].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  const prompt = [
    languageInstruction(publicSettings.tutorLanguage),
    "Explain this source figure for a learner. Ground the explanation in the visible image, the caption, the current source chunk, and the current module context. Do not interpret the figure as a detached image. If the image content is uncertain, say so plainly.",
    figure.caption ? `Caption: ${figure.caption}` : "Caption: unavailable.",
    figure.locator ? `Locator: ${figure.locator}` : "",
    contextModule ? `Current module:\nTitle: ${contextModule.title}\nLearning goal: ${contextModule.learningGoal}` : "",
    contextChunks ? `Current chunk/module source context:\n${contextChunks.slice(0, 3600)}` : "",
    userPrompt?.trim() ? `Learner request: ${userPrompt.trim()}` : "",
  ].filter(Boolean).join("\n\n");
  const bytes = await readFile(figure.assetPath);
  if (bytes.length > MAX_FIGURE_VISION_IMAGE_BYTES) {
    throw new Error("FIGURE_ASSET_TOO_LARGE: 이 그림은 vision 요청으로 보내기에는 너무 큽니다.");
  }
  const explanation = await client.describeImage({
    image: { mimeType: figure.mimeType, dataBase64: bytes.toString("base64") },
    prompt,
    system: `You are Learnie, a source-grounded tutor. ${languageInstruction(publicSettings.tutorLanguage)} Explain figures clearly and avoid inventing details not visible in the image or supported by the caption/context.`,
    model,
    timeoutMs: 120000,
  });
  return { figureId, explanation, model, visionCapable: true as const };
}

async function getFigureAsset(materialId: string, figureId: string) {
  const artifacts = await materials.getArtifacts(materialId);
  const figure = artifacts.figures.find((item) => item.id === figureId);
  if (!figure) throw new Error("Figure not found");
  if (!existsSync(figure.assetPath)) throw new Error("FIGURE_ASSET_MISSING: The source image file is missing.");

  const bytes = await readFile(figure.assetPath);
  const mimeType = figure.mimeType || "image/png";
  return {
    figureId,
    mimeType,
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
  };
}

async function openPath(path: string) {
  return openFilesystemPath(path, "folder");
}

async function openExternalUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs can be opened externally");
  }
  await Utils.openExternal(url.toString());
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
      "projects.delete": ({ projectId }) => projects.delete(projectId),
      "projects.exportTransfer": ({ projectId, destinationFolder }) => projectTransfers.exportTransfer(projectId, destinationFolder),
      "projects.chooseTransferFile": () => chooseProjectTransferPath(),
      "projects.prepareTransferImport": ({ path }) => projectTransfers.prepareImport(path),
      "projects.commitTransferImport": ({ importId, mode }) => projectTransfers.commitImport(importId, mode),
      "projects.cancelTransferImport": ({ importId }) => projectTransfers.cancelImport(importId),
      "projects.openFolder": ({ projectId }) => openPath(projects.folder(projectId)),
      "app.openExternal": ({ url }) => openExternalUrl(url),
      "sources.openDialog": () => chooseSourcePaths(),
      "sources.chooseAndImport": async ({ projectId }) => {
        const paths = await chooseSourcePaths();
        if (!paths.length) return sources.list(projectId);
        sendToView("sources.ingestionProgress", { projectId, stage: "extracting", message: "Importing sources", progress: 20 });
        await sources.importPaths(projectId, paths);
        sendToView("sources.ingestionProgress", { projectId, stage: "complete", message: "Sources imported", progress: 100 });
        return sources.list(projectId);
      },
      "sources.prepareImport": async ({ projectId, paths }) => {
        sendToView("sources.ingestionProgress", { projectId, stage: "extracting", message: "Preparing source preview", progress: 20 });
        const result = await sources.prepareImport(projectId, paths);
        sendToView("sources.ingestionProgress", { projectId, stage: "indexing", message: "Source preview ready", progress: 80 });
        return result;
      },
      "sources.commitPreparedImport": async ({ projectId, importId, selectedItemIds }) => {
        sendToView("sources.ingestionProgress", { projectId, stage: "copying", message: "Importing selected sources", progress: 60 });
        const result = await sources.commitPreparedImport(projectId, importId, selectedItemIds);
        sendToView("sources.ingestionProgress", { projectId, stage: "complete", message: "Sources imported", progress: 100 });
        return result;
      },
      "sources.cancelPreparedImport": ({ projectId, importId }) => sources.cancelPreparedImport(projectId, importId),
      "sources.importPaths": async ({ projectId, paths }) => {
        sendToView("sources.ingestionProgress", { projectId, stage: "extracting", message: "Importing sources", progress: 20 });
        const result = await sources.importPaths(projectId, paths);
        sendToView("sources.ingestionProgress", { projectId, stage: "complete", message: "Sources imported", progress: 100 });
        return result;
      },
      "sources.list": ({ projectId }) => sources.list(projectId),
      "sources.rename": ({ projectId, sourceId, title }) => sources.rename(projectId, sourceId, title),
      "sources.delete": ({ projectId, sourceId }) => sources.delete(projectId, sourceId),
      "materials.generate": async ({ projectId, sourceIds }) => {
        sendToView("materials.generationProgress", { projectId, stage: "concepts", message: "Building source-grounded material", progress: 20 });
        const result = await materials.generate(projectId, sourceIds);
        sendToView("materials.generationProgress", { projectId, materialId: result.id, stage: "complete", message: "Material ready", progress: 100 });
        return result;
      },
      "materials.list": ({ projectId }) => materials.list(projectId),
      "materials.getArtifacts": ({ materialId }) => materials.getArtifacts(materialId),
      "materials.prepareMessages": ({ materialId, forceNewVersion }) => tutor.prepareMessages(materialId, Boolean(forceNewVersion)),
      "materials.messageSetStatus": ({ materialId }) => tutor.messageSetStatus(materialId),
      "materials.resumeMessageSetGeneration": ({ messageSetId }) => tutor.resumeMessageSetGeneration(messageSetId),
      "materials.pauseMessageSetGeneration": ({ messageSetId }) => tutor.pauseMessageSetGeneration(messageSetId),
      "figures.getAsset": ({ materialId, figureId }) => getFigureAsset(materialId, figureId),
      "figures.getAssetUrl": ({ materialId, figureId }) => ({ figureId, url: figureAssetServer.urlFor(materialId, figureId) }),
      "figures.explain": ({ materialId, figureId, userPrompt, contextChunkIds }) => explainFigure(materialId, figureId, userPrompt, contextChunkIds),
      "annotations.define": (params) => annotations.define(params),
      "annotations.ask": (params) => annotations.ask(params),
      "annotations.askTurn": (params) => annotations.askTurn(params),
      "annotations.lookup": (params) => annotations.lookup(params),
      "annotations.findImages": (params) => annotations.findImages(params),
      "annotations.save": (params) => annotations.save(params),
      "annotations.updateNote": (params) => annotations.updateNote(params),
      "annotations.updateQuestionThread": (params) => annotations.updateQuestionThread(params),
      "annotations.delete": ({ annotationId }) => annotations.delete(annotationId),
      "sessions.list": ({ materialId }) => tutor.listSessions(materialId),
      "sessions.start": ({ materialId, mode, sessionId }) => tutor.start(materialId, { mode, sessionId }),
      "sessions.load": ({ sessionId }) => tutor.load(sessionId),
      "sessions.advance": ({ sessionId, mode }) => tutor.advance(sessionId, mode),
      "sessions.continue": ({ sessionId }) => tutor.continueSession(sessionId),
      "sessions.returnToProgress": ({ sessionId }) => tutor.returnToProgress(sessionId),
      "sessions.prefetchStatus": ({ sessionId }) => tutor.prefetchStatus(sessionId),
      "sessions.delete": ({ sessionId }) => tutor.deleteSession(sessionId),
      "sessions.exportReadable": ({ sessionId, destinationFolder }) => sessionExports.exportReadable(sessionId, destinationFolder),
      "sessions.selectModule": ({ sessionId, moduleId }) => tutor.selectModule(sessionId, moduleId),
      "sessions.openModule": ({ sessionId, moduleId }) => tutor.openModule(sessionId, moduleId),
      "sessions.resumeModule": ({ sessionId, moduleId }) => tutor.resumeModule(sessionId, moduleId),
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
        void tutor.recoverInterruptedMessageSets().catch(() => undefined);
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
      "settings.chooseDownloadFolder": async () => {
        const current = await settings.get();
        const chosen = await Utils.openFileDialog({
          startingFolder: existsSync(current.defaultDownloadFolder) ? current.defaultDownloadFolder : Utils.paths.home,
          allowedFileTypes: "*",
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });
        const folder = firstSelectedPath(chosen);
        if (!folder) return current;
        return settings.update({ defaultDownloadFolder: folder });
      },
      "aiProvider.status": () => providerStatus(),
      "aiProvider.updateSettings": async (patch) => {
        await secrets.update(patch);
        void tutor.recoverInterruptedMessageSets().catch(() => undefined);
        return providerStatus();
      },
      "aiProvider.listModels": async (input) => {
        const { client } = await providerClient(input);
        return client.listModels();
      },
      "aiProvider.testConnection": async (input) => {
        try {
          const { client, publicSettings } = await providerClient(input);
          const provider = input.provider || publicSettings.aiProvider;
          const models = await client.listModels();
          const selectedModel = input.modelPurpose === "vision"
            ? publicSettings.providers[provider].selectedVisionModel
            : publicSettings.providers[provider].selectedModel;
          const savedStillExists = !selectedModel || models.some((model) => model.id === selectedModel);
          if (!savedStillExists) {
            return providerStatus(true, "Saved model is unavailable. Choose a model manually.", input);
          }
          if (input.modelPurpose === "vision" && selectedModel && !modelSupportsVision(provider, selectedModel)) {
            return providerStatus(true, "Selected model is not in the known image-input list; figure explanation will still try it.", input);
          }
          if (input.modelPurpose !== "vision" && selectedModel) {
            await testSelectedLearningModel(client, selectedModel);
          }
          return providerStatus(true, undefined, input);
        } catch (error) {
          return providerStatus(false, (error as Error).message, input);
        }
      },
      "buddy.generateMessage": (input) => generateBuddyMessage(input),
    },
    messages: {
      "app.log": ({ level, message }) => {
        console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${level}] ${message}`);
      },
    },
  },
});

const mainWindow = createMainWindow(rpc as never);
installApplicationMenu(() => sendToView("app.openAbout", {}));
Electrobun.events.on("before-quit", () => {
  tutor.markGeneratingMessageSetsInterrupted();
});
