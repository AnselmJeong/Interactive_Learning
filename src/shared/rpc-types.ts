import type { RPCSchema } from "electrobun/bun";
import type {
  ImageLookupResult,
  HighlightResult,
  LookupResult,
  LookupSourceMeta,
  MaterialAnnotation,
  MaterialAnnotationKind,
  MaterialAnnotationSurface,
  MaterialArtifacts,
  MaterialStatus,
  NoteResult,
  QuestionThreadResult,
  QualityStatus,
  SourceType,
  TextSelectionAnchor,
} from "./artifact-types";
import type { AiProviderId, AiProviderStatus, AppSettings, ProviderModel, PublicAiProviderUpdate } from "./settings-types";
import type { LearningMessageSetSummary, SessionSnapshot, SessionSummary, TutorContext, TutorPrefetchStatus, TutorTurnOutput } from "./tutor-types";
import type { LearningLevel } from "./learning-levels";

export type ProjectSummary = {
  id: string;
  title: string;
  description: string | null;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  archivedAt: number | null;
  learningLevel: LearningLevel;
};

export type SourceSummary = {
  id: string;
  projectId: string;
  title: string;
  sourceType: SourceType;
  originalFileName: string;
  qualityStatus: QualityStatus;
  learningStatus: "not_started" | "in_progress" | "completed";
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
  currentModuleContext?: string | null;
  tutorThinking: boolean;
  prefetchStatus: "idle" | "generating" | "ready" | "failed";
  previousMessage?: string | null;
};

export type AppRPC = {
  bun: RPCSchema<{
    requests: {
      "projects.create": { params: { title: string; description?: string; learningLevel?: LearningLevel }; response: ProjectSummary };
      "projects.list": { params: {}; response: ProjectSummary[] };
      "projects.open": { params: { projectId: string }; response: ProjectSummary };
      "projects.archive": { params: { projectId: string }; response: boolean };
      "projects.delete": { params: { projectId: string }; response: boolean };
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
      "sources.rename": { params: { projectId: string; sourceId: string; title: string }; response: SourceSummary };
      "sources.delete": { params: { projectId: string; sourceId: string }; response: boolean };
      "materials.generate": { params: { projectId: string; sourceIds: string[] }; response: MaterialSummary };
      "materials.list": { params: { projectId: string }; response: MaterialSummary[] };
      "materials.getArtifacts": { params: { materialId: string }; response: MaterialArtifacts };
      "materials.prepareMessages": { params: { materialId: string; forceNewVersion?: boolean }; response: LearningMessageSetSummary };
      "materials.messageSetStatus": { params: { materialId: string }; response: LearningMessageSetSummary[] };
      "materials.resumeMessageSetGeneration": { params: { messageSetId: string }; response: LearningMessageSetSummary };
      "materials.pauseMessageSetGeneration": { params: { messageSetId: string }; response: LearningMessageSetSummary };
      "figures.getAsset": { params: { materialId: string; figureId: string }; response: { figureId: string; mimeType: string; dataUrl: string } };
      "figures.explain": { params: { materialId: string; figureId: string; userPrompt?: string; contextChunkIds?: string[] }; response: { figureId: string; explanation: string; model: string; visionCapable: true } };
      "annotations.define": { params: { materialId: string; chunkId: string; selectedText: string }; response: LookupResult };
      "annotations.ask": { params: { materialId: string; chunkId: string; selectedText: string; question: string; useWebSearch?: boolean }; response: LookupResult };
      "annotations.askTurn": {
        params: {
          materialId: string;
          chunkId: string;
          selectedText: string;
          userText: string;
          useWebSearch?: boolean;
          draftThread?: QuestionThreadResult;
        };
        response: { thread: QuestionThreadResult };
      };
      "annotations.lookup": { params: { materialId: string; chunkId: string; selectedText: string }; response: LookupResult };
      "annotations.findImages": { params: { materialId: string; chunkId: string; selectedText: string }; response: ImageLookupResult };
      "annotations.save": {
        params: {
          materialId: string;
          chunkId: string;
          surface?: MaterialAnnotationSurface;
          anchorMessageId?: string | null;
          anchorBlockId?: string | null;
          textAnchor?: TextSelectionAnchor | null;
          kind: MaterialAnnotationKind;
          selectedText: string;
          result: LookupResult | QuestionThreadResult | ImageLookupResult | NoteResult | HighlightResult;
          sourceMeta: LookupSourceMeta[];
        };
        response: MaterialAnnotation;
      };
      "annotations.updateNote": { params: { annotationId: string; note: string }; response: MaterialAnnotation };
      "annotations.updateQuestionThread": { params: { annotationId: string; thread: QuestionThreadResult }; response: MaterialAnnotation };
      "annotations.delete": { params: { annotationId: string }; response: { deleted: boolean; syncWarning?: string } };
      "sessions.list": { params: { materialId: string }; response: SessionSummary[] };
      "sessions.start": { params: { materialId: string; mode: "new" | "continue"; sessionId?: string }; response: { session: SessionSnapshot; context: TutorContext; messageSet: LearningMessageSetSummary; firstTurn?: TutorTurnOutput } };
      "sessions.load": { params: { sessionId: string }; response: { session: SessionSnapshot; context: TutorContext } };
      "sessions.advance": { params: { sessionId: string; mode: "chunk" | "paragraph" | "module" }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "sessions.continue": { params: { sessionId: string }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "sessions.returnToProgress": { params: { sessionId: string }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "sessions.prefetchStatus": { params: { sessionId: string }; response: TutorPrefetchStatus };
      "sessions.delete": { params: { sessionId: string }; response: boolean };
      "sessions.selectModule": { params: { sessionId: string; moduleId: string }; response: { session: SessionSnapshot; context: TutorContext } };
      "sessions.openModule": { params: { sessionId: string; moduleId: string }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "sessions.resumeModule": { params: { sessionId: string; moduleId: string }; response: { session: SessionSnapshot; context: TutorContext; output?: TutorTurnOutput } };
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
      "materials.messageSetProgress": LearningMessageSetSummary;
      "app.openAbout": {};
    };
  }>;
};
