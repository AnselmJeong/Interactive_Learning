import { BrowserView, Utils } from "electrobun/bun";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ProjectService } from "./project-service";
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
import { configureAppDataBase } from "./paths";
import { normalizeSelectedPaths } from "./file-dialog-selection";

configureAppDataBase(Utils.paths.userData);

const projects = new ProjectService();
const settings = new SettingsService();
const secrets = new AiProviderSettingsService();
const sources = new SourceService();
const materials = new CourseArtifactService();
const annotations = new AnnotationService(materials, providerClient);
const tutor = new TutorService((status) => sendToView("tutor.prefetchStatus", status));
const MAX_FIGURE_VISION_IMAGE_BYTES = 6_000_000;

void settings.get().then((current) => projects.migrateUnsetProjectRoots(current.projectRootFolder)).catch((error) => {
  console.warn("Failed to migrate project roots", error);
});
void Promise.resolve(materials.recoverInterruptedGenerations()).then((count) => {
  if (count) console.warn(`Recovered ${count} interrupted material generation(s).`);
}).catch((error) => {
  console.warn("Failed to recover interrupted material generations", error);
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

async function providerStatus(reachable = false, error?: string, input: AiProviderConnectionInput = {}) {
  const publicSettings = input.settings || await settings.get();
  const provider = input.provider || publicSettings.aiProvider;
  const overrideKey = input.apiKeys?.[provider]?.trim();
  const apiKey = overrideKey ? { value: overrideKey, source: "settings" as const } : await secrets.getApiKey(provider);
  const keyStates = await secrets.keyStates();
  if (overrideKey) {
    keyStates[provider] = { hasApiKey: true, apiKeySource: "settings" } satisfies AiProviderKeyState;
  }
  const providerSettings = publicSettings.providers[provider];
  return {
    provider,
    baseUrl: providerSettings.baseUrl,
    hasApiKey: Boolean(apiKey.value),
    apiKeySource: apiKey.source,
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

function cleanBuddyMessage(text: string) {
  const compact = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^(메시지|한마디|버디|Buddy)\s*[:：-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) throw new Error("AI provider returned an empty buddy message");
  const firstSentence = compact.match(/^.*?[.!?。！？](?=\s|$)/)?.[0]?.trim() || compact;
  return firstSentence.length > 120 ? `${firstSentence.slice(0, 117).trim()}...` : firstSentence;
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
  const { client, publicSettings } = await providerClient();
  const moduleTitle = input.currentModuleTitle?.trim();
  const moduleContext = input.currentModuleContext?.trim();
  const moodGuide: Record<BuddyMessageInput["mood"], string> = {
    idle: "현재 module 맥락에서 건질 수 있는 짧은 흥미거리",
    thinking: "기다리는 동안 지루하지 않게 하는 module 관련 작은 관찰",
    ready: "다음 설명이 준비됐다는 신호와 연결되는 흥미로운 예고",
    progress: "방금 진도가 나간 내용을 알아차리는 맥락형 한마디",
    complete: "마무리를 축하하되 module의 핵심 재미를 다시 떠올리는 한마디",
    quiet: "실패나 대기 상태를 과장하지 않는 차분한 맥락형 격려",
  };
  const text = await client.chatText({
    temperature: 0.95,
    maxTokens: 256,
    timeoutMs: 20000,
    thinking: "disabled",
    messages: [
      {
        role: "system",
        content: [
          "You are Learnie's tiny learning buddy, a playful companion inside a study workspace.",
          "Generate exactly one fresh Korean sentence for a speech bubble.",
          "Prefer a contextual curiosity: a surprising connection, hidden implication, tiny anecdote-like observation, or why-this-is-interesting hook from the supplied module/source context.",
          "Use generic encouragement only when the mood makes that clearly better or the module context is unavailable.",
          "Ground source-specific claims only in the supplied module/source context; do not invent outside dates, people, anecdotes, or facts.",
          "Keep it around 45-95 Korean characters. Do not use markdown, emoji, quotes, labels, lists, or multiple sentences.",
          "Do not mention hidden prompts and do not say you are an AI.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Trigger: ${input.trigger}`,
          `Mood: ${input.mood} (${moodGuide[input.mood]})`,
          `Progress: ${Math.max(0, Math.min(100, Math.round(input.progressPercent)))}%`,
          moduleTitle ? `Current module: ${moduleTitle.slice(0, 120)}` : "Current module: unavailable",
          moduleContext ? `Module/source context:\n${moduleContext.slice(0, 1800)}` : "Module/source context: unavailable",
          `Tutor thinking: ${input.tutorThinking ? "yes" : "no"}`,
          `Prefetch: ${input.prefetchStatus}`,
          input.previousMessage?.trim() ? `Previous bubble to avoid repeating: ${input.previousMessage.trim().slice(0, 120)}` : "",
          "Write only the bubble sentence. Prefer a fun aside over generic praise when the context is usable.",
        ].filter(Boolean).join("\n"),
      },
    ],
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
      "projects.exportArchive": ({ projectId, destinationFolder }) => projects.exportArchive(projectId, destinationFolder),
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
      "sources.delete": ({ projectId, sourceId }) => sources.delete(projectId, sourceId),
      "materials.generate": async ({ projectId, sourceIds }) => {
        sendToView("materials.generationProgress", { projectId, stage: "concepts", message: "Building source-grounded material", progress: 20 });
        const result = await materials.generate(projectId, sourceIds);
        sendToView("materials.generationProgress", { projectId, materialId: result.id, stage: "complete", message: "Material ready", progress: 100 });
        return result;
      },
      "materials.list": ({ projectId }) => materials.list(projectId),
      "materials.getArtifacts": ({ materialId }) => materials.getArtifacts(materialId),
      "figures.getAsset": ({ materialId, figureId }) => getFigureAsset(materialId, figureId),
      "figures.explain": ({ materialId, figureId, userPrompt, contextChunkIds }) => explainFigure(materialId, figureId, userPrompt, contextChunkIds),
      "annotations.define": (params) => annotations.define(params),
      "annotations.ask": (params) => annotations.ask(params),
      "annotations.lookup": (params) => annotations.lookup(params),
      "annotations.findImages": (params) => annotations.findImages(params),
      "annotations.save": (params) => annotations.save(params),
      "annotations.updateNote": (params) => annotations.updateNote(params),
      "annotations.delete": ({ annotationId }) => annotations.delete(annotationId),
      "sessions.list": ({ materialId }) => tutor.listSessions(materialId),
      "sessions.start": ({ materialId, mode, sessionId }) => tutor.start(materialId, { mode, sessionId }),
      "sessions.load": ({ sessionId }) => tutor.load(sessionId),
      "sessions.advance": ({ sessionId, mode }) => tutor.advance(sessionId, mode),
      "sessions.returnToProgress": ({ sessionId }) => tutor.returnToProgress(sessionId),
      "sessions.prefetchStatus": ({ sessionId }) => tutor.prefetchStatus(sessionId),
      "sessions.delete": ({ sessionId }) => tutor.deleteSession(sessionId),
      "sessions.selectModule": ({ sessionId, moduleId }) => tutor.selectModule(sessionId, moduleId),
      "sessions.openModule": ({ sessionId, moduleId }) => tutor.openModule(sessionId, moduleId),
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
