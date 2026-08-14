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
  NoteImageUpload,
  NoteResult,
  QuestionThreadResult,
  QualityStatus,
  DocumentType,
  SourceType,
  TextSelectionAnchor,
} from "./artifact-types";
import type { AiProviderId, AiProviderStatus, AppSettings, ProviderModel, PublicAiProviderUpdate } from "./settings-types";
import type { LearningMessageSetSummary, SessionSnapshot, SessionSummary, TutorContext, TutorMessage, TutorPrefetchStatus, TutorTurnOutput } from "./tutor-types";
import type { LearningLevel } from "./learning-levels";
import type { PreparedLearningIrResult } from "./learning-ir-types";
import type { ProjectTransferExport, ProjectTransferImportResult, ProjectTransferPreview, SessionReadableExport } from "./project-transfer-types";
import type { DocumentTransferExport, DocumentTransferImportPreview, DocumentTransferImportResult, DocumentTransferPreview } from "./document-transfer-types";

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
  documentId?: string | null;
  title: string;
  sourceType: SourceType;
  documentType: DocumentType;
  originalFileName: string;
  qualityStatus: QualityStatus;
  learningStatus: "not_started" | "in_progress" | "completed";
  createdAt: number;
  updatedAt: number;
};

export type LearningProgressSummary = {
  status: "not_started" | "in_progress" | "completed";
  coveredChunks: number;
  totalChunks: number;
  percent: number;
  currentSourceId: string | null;
  activeSessionId: string | null;
};

export type PreparationProgressSummary = {
  completedMessages: number;
  totalMessages: number;
  percent: number;
};

export type DocumentSummary = {
  id: string;
  projectId: string;
  documentType: DocumentType;
  title: string;
  subtitle: string | null;
  description: string | null;
  authors: string[];
  publisher: string | null;
  publishedDate: string | null;
  isbn10: string | null;
  isbn13: string | null;
  journal: string | null;
  doi: string | null;
  language: string | null;
  coverUrl: string | null;
  metadataStatus: "pending" | "found" | "not_found" | "manual" | "failed";
  sourceCount: number;
  learning: LearningProgressSummary;
  preparation: PreparationProgressSummary;
  annotationCount: number;
  lastStudiedAt: number | null;
  originalFileName: string;
  createdAt: number;
  updatedAt: number;
};

export type BookMetadataSearchInput = {
  title?: string;
  isbn?: string;
};

export type BookMetadataCandidate = {
  title: string;
  subtitle: string | null;
  description: string | null;
  authors: string[];
  publisher: string | null;
  publishedDate: string | null;
  isbn10: string | null;
  isbn13: string | null;
  language: string | null;
  coverUrl: string | null;
  providerVolumeId: string;
};

export type SourceProgressSnapshot = {
  sourceId: string;
  documentId: string;
  title: string;
  ordinal: number;
  status: LearningProgressSummary["status"];
  coveredChunks: number;
  totalChunks: number;
  percent: number;
  currentChunkId: string | null;
  activeSessionId: string | null;
};

export type DocumentProgressSnapshot = {
  documentId: string;
  title: string;
  documentType: DocumentType;
  status: LearningProgressSummary["status"];
  coveredChunks: number;
  totalChunks: number;
  percent: number;
  currentSourceId: string | null;
  activeSessionId: string | null;
  sources: SourceProgressSnapshot[];
};

export type LearningActivityDay = {
  /** Local calendar day in YYYY-MM-DD form. Each count is distinct material passages first opened that day. */
  date: string;
  viewedChunks: number;
};

export type ProjectProgressSnapshot = {
  projectId: string;
  status: LearningProgressSummary["status"];
  coveredChunks: number;
  totalChunks: number;
  percent: number;
  currentDocumentId: string | null;
  currentSourceId: string | null;
  activeSessionId: string | null;
  documents: DocumentProgressSnapshot[];
  activityDays: LearningActivityDay[];
  orphanCoveredChunkCount: number;
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

export type SourceRemovalImpact = {
  projectId: string;
  documentId: string;
  sourceId: string;
  sourceTitle: string;
  exclusiveMaterials: number;
  sharedMaterials: number;
  sessions: number;
  messages: number;
  preparedMessages: number;
  annotations: number;
  impactToken: string;
};

export type DocumentRemovalImpact = {
  projectId: string;
  documentId: string;
  documentTitle: string;
  documentType: DocumentType;
  sources: number;
  exclusiveMaterials: number;
  sharedMaterials: number;
  sessions: number;
  messages: number;
  preparedMessages: number;
  annotations: number;
  impactToken: string;
};

export type AnnotationReadableExport = {
  zipPath: string;
  fileName: string;
  projectId: string;
  annotationCount: number;
  assetCount: number;
};

export type PreparedSourceImport = {
  id: string;
  projectId: string;
  sourceName: string;
  sourcePath: string;
  documentType: DocumentType;
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
  stage:
    | "normalize"
    | "extract"
    | "validate"
    | "brief"
    | "visuals"
    | "graph"
    | "persist"
    | "complete"
    | "failed"
    // Legacy senders remain accepted during the v1 to v2 transition.
    | "concepts"
    | "course";
  message: string;
  progress: number;
};

export type MaterialProgressSnapshot = {
  materialId: string;
  currentChunkId: string | null;
  coveredChunkIds: string[];
  activeSessionId: string | null;
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
      "projects.exportTransfer": { params: { projectId: string; destinationFolder?: string }; response: ProjectTransferExport };
      "projects.chooseTransferFile": { params: {}; response: string };
      "projects.prepareTransferImport": { params: { path: string }; response: ProjectTransferPreview };
      "projects.commitTransferImport": { params: { importId: string; mode: "create_new" | "fast_forward" }; response: ProjectTransferImportResult };
      "projects.cancelTransferImport": { params: { importId: string }; response: boolean };
      "projects.openFolder": { params: { projectId?: string }; response: boolean };
      "app.openExternal": { params: { url: string }; response: boolean };
      "sources.importPaths": { params: { projectId: string; paths: string[]; documentType?: DocumentType }; response: SourceSummary[] };
      "sources.prepareImport": { params: { projectId: string; paths: string[]; documentType?: DocumentType }; response: PreparedSourceImport };
      "sources.commitPreparedImport": { params: { projectId: string; importId: string; selectedItemIds: string[] }; response: SourceSummary[] };
      "sources.cancelPreparedImport": { params: { projectId: string; importId: string }; response: boolean };
      "sources.openDialog": { params: { projectId: string }; response: string[] };
      "sources.chooseAndImport": { params: { projectId: string }; response: SourceSummary[] };
      "sources.list": { params: { projectId: string }; response: SourceSummary[] };
      "sources.rename": { params: { projectId: string; sourceId: string; title: string }; response: SourceSummary };
      "sources.delete": { params: { projectId: string; sourceId: string }; response: boolean };
      "documents.list": { params: { projectId: string }; response: DocumentSummary[] };
      "documents.get": { params: { projectId: string; documentId: string }; response: DocumentSummary };
      "documents.listSources": { params: { projectId: string; documentId: string }; response: SourceSummary[] };
      "documents.refreshMetadata": { params: { projectId: string; documentId: string }; response: DocumentSummary };
      "documents.refreshProjectMetadata": { params: { projectId: string }; response: DocumentSummary[] };
      "documents.searchMetadata": { params: { projectId: string; documentId: string; input: BookMetadataSearchInput }; response: BookMetadataCandidate[] };
      "documents.applyMetadata": { params: { projectId: string; documentId: string; metadata: BookMetadataCandidate }; response: DocumentSummary };
      "documents.previewRemoval": { params: { projectId: string; documentId: string }; response: DocumentRemovalImpact };
      "documents.remove": { params: { projectId: string; documentId: string; impactToken: string }; response: { removed: boolean; documentId: string } };
      "documents.previewSourceRemoval": { params: { projectId: string; documentId: string; sourceId: string }; response: SourceRemovalImpact };
      "documents.removeSource": { params: { projectId: string; documentId: string; sourceId: string; impactToken: string }; response: { removed: boolean; documentId: string } };
      "documents.previewTransfer": { params: { projectId: string; documentId: string }; response: DocumentTransferPreview };
      "documents.exportTransfer": { params: { projectId: string; documentId: string; destinationFolder?: string }; response: DocumentTransferExport };
      "documents.exportLegacyTransfers": { params: { projectId: string; destinationFolder?: string }; response: DocumentTransferExport[] };
      "documents.chooseTransferFile": { params: {}; response: string };
      "documents.prepareTransferImport": { params: { path: string; destinationProjectId: string }; response: DocumentTransferImportPreview };
      "documents.commitTransferImport": { params: { importId: string }; response: DocumentTransferImportResult };
      "documents.cancelTransferImport": { params: { importId: string }; response: boolean };
      "progress.getProjectSnapshot": { params: { projectId: string }; response: ProjectProgressSnapshot };
      "progress.getDocumentSnapshot": { params: { projectId: string; documentId: string }; response: DocumentProgressSnapshot };
      "progress.getMaterialSnapshot": { params: { materialId: string }; response: MaterialProgressSnapshot };
      "materials.generate": { params: { projectId: string; sourceIds: string[] }; response: MaterialSummary };
      "materials.list": { params: { projectId: string }; response: MaterialSummary[] };
      "materials.getArtifacts": { params: { materialId: string }; response: MaterialArtifacts };
      "materials.prepareMessages": { params: { materialId: string; forceNewVersion?: boolean }; response: LearningMessageSetSummary };
      "materials.messageSetStatus": { params: { materialId: string }; response: LearningMessageSetSummary[] };
      "materials.getLearningIr": { params: { messageSetId: string }; response: PreparedLearningIrResult };
      "materials.resumeMessageSetGeneration": { params: { messageSetId: string }; response: LearningMessageSetSummary };
      "materials.pauseMessageSetGeneration": { params: { messageSetId: string }; response: LearningMessageSetSummary };
      "figures.getAsset": { params: { materialId: string; figureId: string }; response: { figureId: string; mimeType: string; dataUrl: string } };
      "figures.getAssetUrl": { params: { materialId: string; figureId: string }; response: { figureId: string; url: string } };
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
      "annotations.listProject": { params: { projectId: string }; response: MaterialAnnotation[] };
      "annotations.exportReadable": { params: { projectId: string; annotationIds: string[]; destinationFolder?: string }; response: AnnotationReadableExport };
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
      "annotations.saveNote": {
        params: {
          materialId: string;
          chunkId: string;
          surface?: MaterialAnnotationSurface;
          anchorMessageId?: string | null;
          anchorBlockId?: string | null;
          textAnchor?: TextSelectionAnchor | null;
          selectedText: string;
          note: string;
          images?: NoteImageUpload[];
        };
        response: MaterialAnnotation;
      };
      "annotations.updateNote": {
        params: { annotationId: string; note: string; imagesToAdd?: NoteImageUpload[]; imageIdsToRemove?: string[] };
        response: MaterialAnnotation;
      };
      "annotations.updateQuestionThread": { params: { annotationId: string; thread: QuestionThreadResult }; response: MaterialAnnotation };
      "annotations.delete": { params: { annotationId: string }; response: { deleted: boolean; syncWarning?: string } };
      "sessions.list": { params: { materialId: string }; response: SessionSummary[] };
      "sessions.start": { params: { materialId: string; mode: "new" | "continue"; sessionId?: string }; response: { session: SessionSnapshot; context: TutorContext; messageSet: LearningMessageSetSummary; firstTurn?: TutorTurnOutput } };
      "sessions.load": { params: { sessionId: string }; response: { session: SessionSnapshot; context: TutorContext } };
      "sessions.getMessage": { params: { messageId: string }; response: TutorMessage };
      "sessions.advance": { params: { sessionId: string; mode: "chunk" | "paragraph" | "module" }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "sessions.continue": { params: { sessionId: string }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "sessions.returnToProgress": { params: { sessionId: string }; response: { session: SessionSnapshot; context: TutorContext; output: TutorTurnOutput } };
      "sessions.prefetchStatus": { params: { sessionId: string }; response: TutorPrefetchStatus };
      "sessions.delete": { params: { sessionId: string }; response: boolean };
      "sessions.exportReadable": { params: { sessionId: string; destinationFolder?: string }; response: SessionReadableExport };
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
