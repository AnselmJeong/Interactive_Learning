import type { RPCSchema } from "electrobun/bun";
import type {
  ImageLookupResult,
  HighlightResult,
  LookupResult,
  LookupSourceMeta,
  MaterialAnnotation,
  MaterialAnnotationKind,
  MaterialArtifacts,
  MaterialStatus,
  NoteResult,
  QualityStatus,
  SourceType,
} from "./artifact-types";
import type { AiProviderId, AiProviderStatus, AppSettings, ProviderModel, PublicAiProviderUpdate } from "./settings-types";
import type { SessionSnapshot, SessionSummary, TutorContext, TutorPrefetchStatus, TutorTurnOutput } from "./tutor-types";

export type ProjectSummary = {
  id: string;
  title: string;
  description: string | null;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  archivedAt: number | null;
};

export type SourceSummary = {
  id: string;
  projectId: string;
  title: string;
  sourceType: SourceType;
  originalFileName: string;
  qualityStatus: QualityStatus;
  createdAt: number;
  updatedAt: number;
};

export type PreparedSourceImportItem = {
  id: string;
  title: string;
  fileName: string;
  relativePath: string;
  kind: string | null;
  charCount: number;
  preview: string;
  selected: boolean;
};

export type PreparedSourceImport = {
  id: string;
  projectId: string;
  sourceName: string;
  sourcePath: string;
  itemCount: number;
  items: PreparedSourceImportItem[];
};

export type MaterialSummary = {
  id: string;
  projectId: string;
  title: string;
  materialType: string;
  status: MaterialStatus;
  sourceIds: string[];
  generationError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type IngestionProgress = {
  projectId: string;
  sourceId?: string;
  stage: "copying" | "extracting" | "indexing" | "complete" | "failed";
  message: string;
  progress: number;
};

export type GenerationProgress = {
  projectId: string;
  materialId?: string;
  stage: "concepts" | "course" | "visuals" | "persist" | "complete" | "failed";
  message: string;
  progress: number;
};

export type ProjectArchiveExport = {
  zipPath: string;
  fileName: string;
  sessionCount: number;
};

export type AiProviderConnectionInput = {
  settings?: AppSettings;
  apiKeys?: Partial<Record<AiProviderId, string>>;
  provider?: AiProviderId;
  modelPurpose?: "learning" | "vision";
};

export type BuddyMessageMood = "idle" | "thinking" | "ready" | "progress" | "complete" | "quiet";

export type BuddyMessageInput = {
  trigger: "click" | "state";
  mood: BuddyMessageMood;
  progressPercent: number;
  currentModuleTitle?: string | null;
  tutorThinking: boolean;
  prefetchStatus: "idle" | "generating" | "ready" | "failed";
  previousMessage?: string | null;
};

export type AppRPC = {
  bun: RPCSchema<{
    requests: {
      "projects.create": { params: { title: string; description?: string }; response: ProjectSummary };
      "projects.list": { params: {}; response: ProjectSummary[] };
      "projects.open": { params: { projectId: string }; response: ProjectSummary };
      "projects.archive": { params: { projectId: string }; response: boolean };
      "projects.exportArchive": { params: { projectId: string; destinationFolder?: string }; response: ProjectArchiveExport };
      "projects.openFolder": { params: { projectId?: string }; response: boolean };
      "app.openExternal": { params: { url: string }; response: boolean };
      "sources.importPaths": { params: { projectId: string; paths: string[] }; response: SourceSummary[] };
      "sources.prepareImport": { params: { projectId: string; paths: string[] }; response: PreparedSourceImport };
      "sources.commitPreparedImport": { params: { projectId: string; importId: string; selectedItemIds: string[] }; response: SourceSummary[] };
      "sources.cancelPreparedImport": { params: { projectId: string; importId: string }; response: boolean };
      "sources.openDialog": { params: { projectId: string }; response: string[] };
      "sources.chooseAndImport": { params: { projectId: string }; response: SourceSummary[] };
      "sources.list": { params: { projectId: string }; response: SourceSummary[] };
      "materials.generate": { params: { projectId: string; sourceIds: string[] }; response: MaterialSummary };
      "materials.list": { params: { projectId: string }; response: MaterialSummary[] };
      "materials.getArtifacts": { params: { materialId: string }; response: MaterialArtifacts };
      "figures.getAsset": { params: { materialId: string; figureId: string }; response: { figureId: string; mimeType: string; dataUrl: string } };
      "figures.explain": { params: { materialId: string; figureId: string; userPrompt?: string; contextChunkIds?: string[] }; response: { figureId: string; explanation: string; model: string; visionCapable: true } };
      "annotations.define": { params: { materialId: string; chunkId: string; selectedText: string }; response: LookupResult };
      "annotations.lookup": { params: { materialId: string; chunkId: string; selectedText: string }; response: LookupResult };
      "annotations.findImages": { params: { materialId: string; chunkId: string; selectedText: string }; response: ImageLookupResult };
      "annotations.save": {
        params: {
          materialId: string;
          chunkId: string;
          anchorMessageId?: string | null;
          kind: MaterialAnnotationKind;
          selectedText: string;
          result: LookupResult | ImageLookupResult | NoteResult | HighlightResult;
          sourceMeta: LookupSourceMeta[];
        };
        response: MaterialAnnotation;
      };
      "annotations.updateNote": { params: { annotationId: string; note: string }; response: MaterialAnnotation };
      "annotations.delete": { params: { annotationId: string }; response: boolean };
      "sessions.list": { params: { materialId: string }; response: SessionSummary[] };
      "sessions.start": { params: { materialId: string; mode: "new" | "continue"; sessionId?: string }; response: { session: SessionSnapshot; context: TutorContext; firstTurn?: TutorTurnOutput } };
      "sessions.load": { params: { sessionId: string }; response: { session: SessionSnapshot; context: TutorContext } };
      "sessions.advance": { params: { sessionId: string; mode: "chunk" | "paragraph" | "module" }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "sessions.returnToProgress": { params: { sessionId: string }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "sessions.prefetchStatus": { params: { sessionId: string }; response: TutorPrefetchStatus };
      "sessions.selectModule": { params: { sessionId: string; moduleId: string }; response: { session: SessionSnapshot; context: TutorContext } };
      "sessions.openModule": { params: { sessionId: string; moduleId: string }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "tutor.sendTurn": { params: { sessionId: string; userText: string }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "settings.getPublic": { params: {}; response: AppSettings };
      "settings.updatePublic": { params: Partial<AppSettings>; response: AppSettings };
      "settings.chooseProjectRootFolder": { params: {}; response: AppSettings };
      "settings.chooseDownloadFolder": { params: {}; response: AppSettings };
      "aiProvider.status": { params: {}; response: AiProviderStatus };
      "aiProvider.updateSettings": { params: PublicAiProviderUpdate; response: AiProviderStatus };
      "aiProvider.listModels": { params: AiProviderConnectionInput; response: ProviderModel[] };
      "aiProvider.testConnection": { params: AiProviderConnectionInput; response: AiProviderStatus };
      "buddy.generateMessage": { params: BuddyMessageInput; response: { text: string } };
    };
    messages: {
      "app.log": { level: "info" | "warn" | "error"; message: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      "sources.ingestionProgress": IngestionProgress;
      "materials.generationProgress": GenerationProgress;
      "tutor.turnStarted": { sessionId: string };
      "tutor.turnCompleted": { sessionId: string; output: TutorTurnOutput };
      "tutor.turnError": { sessionId: string; error: string };
      "tutor.prefetchStatus": TutorPrefetchStatus;
      "app.openAbout": {};
    };
  }>;
};
