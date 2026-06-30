import type { RPCSchema } from "electrobun/bun";
import type { MaterialArtifacts, MaterialStatus, QualityStatus, SourceType } from "./artifact-types";
import type { AiProviderStatus, AppSettings, ProviderModel, PublicAiProviderUpdate } from "./settings-types";
import type { SessionSnapshot, SessionSummary, TutorContext, TutorTurnOutput } from "./tutor-types";

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

export type AppRPC = {
  bun: RPCSchema<{
    requests: {
      "projects.create": { params: { title: string; description?: string }; response: ProjectSummary };
      "projects.list": { params: {}; response: ProjectSummary[] };
      "projects.open": { params: { projectId: string }; response: ProjectSummary };
      "projects.archive": { params: { projectId: string }; response: boolean };
      "projects.exportArchive": { params: { projectId: string; destinationFolder?: string }; response: ProjectArchiveExport };
      "projects.openFolder": { params: { projectId?: string }; response: boolean };
      "sources.importPaths": { params: { projectId: string; paths: string[] }; response: SourceSummary[] };
      "sources.openDialog": { params: { projectId: string }; response: string[] };
      "sources.chooseAndImport": { params: { projectId: string }; response: SourceSummary[] };
      "sources.list": { params: { projectId: string }; response: SourceSummary[] };
      "materials.generate": { params: { projectId: string; sourceIds: string[] }; response: MaterialSummary };
      "materials.list": { params: { projectId: string }; response: MaterialSummary[] };
      "materials.getArtifacts": { params: { materialId: string }; response: MaterialArtifacts };
      "sessions.list": { params: { materialId: string }; response: SessionSummary[] };
      "sessions.start": { params: { materialId: string; mode: "new" | "continue"; sessionId?: string }; response: { session: SessionSnapshot; context: TutorContext; firstTurn?: TutorTurnOutput } };
      "sessions.load": { params: { sessionId: string }; response: { session: SessionSnapshot; context: TutorContext } };
      "tutor.sendTurn": { params: { sessionId: string; userText: string }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "settings.getPublic": { params: {}; response: AppSettings };
      "settings.updatePublic": { params: Partial<AppSettings>; response: AppSettings };
      "settings.chooseProjectRootFolder": { params: {}; response: AppSettings };
      "settings.chooseDownloadFolder": { params: {}; response: AppSettings };
      "aiProvider.status": { params: {}; response: AiProviderStatus };
      "aiProvider.updateSettings": { params: PublicAiProviderUpdate; response: AiProviderStatus };
      "aiProvider.listModels": { params: {}; response: ProviderModel[] };
      "aiProvider.testConnection": { params: {}; response: AiProviderStatus };
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
    };
  }>;
};
