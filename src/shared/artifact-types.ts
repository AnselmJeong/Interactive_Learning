export type SourceType = "markdown" | "pdf" | "text";
export type QualityStatus = "good" | "warning" | "poor";
export type MaterialStatus = "draft" | "generating" | "ready" | "failed";

export type SourceManifest = {
  id: string;
  projectId: string;
  title: string;
  updatedAt?: string;
  sourceType: SourceType;
  originalPath?: string;
  importedAt: string;
  extractionMethod: string;
  language: string;
  quality: {
    status: QualityStatus;
    warnings: string[];
  };
};

export type SourceChunk = {
  id: string;
  headingPath: string[];
  pageRange?: [number, number];
  locator: string;
  kind: "body" | "quote" | "caption" | "table" | "note";
  text: string;
  confidence: number;
};

export type SourceFigure = {
  id: string;
  sourceId: string;
  title: string;
  assetPath: string;
  assetUrl: string;
  mimeType: string;
  caption: string | null;
  captionStatus: string;
  width: number | null;
  height: number | null;
  locator: string;
  pageRange?: [number, number];
  sourceChunkIds: string[];
};

export type LookupSourceMeta = {
  id?: string;
  title: string;
  url?: string;
  provider?: string;
  retrievedAt?: string;
  snippet?: string;
};

export type LookupResult = {
  kind: "define" | "lookup" | "question";
  title: string;
  body: string;
  query: string;
  question?: string;
  provider: "ai" | "wikipedia";
  model?: string;
  url?: string;
  sourceTitle?: string;
  retrievedAt: string;
  sourceMeta: LookupSourceMeta[];
};

export type QuestionThreadMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  model?: string;
  sources?: LookupSourceMeta[];
};

export type QuestionThreadResult = {
  kind: "question_thread";
  version: 1;
  title: string;
  messages: QuestionThreadMessage[];
  provider: "ai";
  model?: string;
  sourceTitle?: string;
  retrievedAt: string;
  updatedAt: number;
  sourceMeta: LookupSourceMeta[];
};

export type ImageLookupItem = {
  title: string;
  thumbnailUrl: string;
  imageUrl?: string;
  pageUrl?: string;
  sourceTitle?: string;
  provider: "brave" | "direct" | "wikipedia";
  width?: number;
  height?: number;
  caption?: string;
};

export type ImageLookupResult = {
  kind: "image";
  title: string;
  query: string;
  body?: string;
  warning?: string;
  provider: "brave" | "direct" | "wikipedia";
  images: ImageLookupItem[];
  retrievedAt: string;
  sourceMeta: LookupSourceMeta[];
};

export type NoteResult = {
  kind: "note";
  note: string;
};

export type HighlightResult = {
  kind: "highlight";
  style?: "yellow" | "green" | "blue" | "pink" | "red-underline";
};

export type MaterialAnnotationKind = "define" | "lookup" | "question" | "image" | "note" | "highlight";
export type MaterialAnnotationSurface = "chat" | "source";

export type TextSelectionAnchor = {
  version: 1;
  surface: MaterialAnnotationSurface;
  scope: "source-chunk" | "chat-message" | "tutor-block";
  chunkId: string;
  messageId?: string | null;
  blockId?: string | null;
  selectedText: string;
  normalizedText: string;
  occurrence: number;
  startOffset: number;
  endOffset: number;
  prefix: string;
  suffix: string;
  scopeTextLength: number;
};

export type MaterialAnnotation = {
  id: string;
  projectId: string;
  materialId: string;
  sourceId: string | null;
  chunkId: string;
  surface: MaterialAnnotationSurface;
  scope?: "material" | "session";
  sessionId?: string | null;
  anchorMessageId?: string | null;
  anchorBlockId?: string | null;
  textAnchor?: TextSelectionAnchor | null;
  kind: MaterialAnnotationKind;
  selectedText: string;
  normalizedText: string;
  result: LookupResult | QuestionThreadResult | ImageLookupResult | NoteResult | HighlightResult;
  sourceMeta: LookupSourceMeta[];
  createdAt: number;
  updatedAt: number;
  syncWarning?: string;
};

export type Concept = {
  id: string;
  name: string;
  definition: string;
  whyItMatters: string;
  prerequisites: string[];
  misconceptions: string[];
  sourceChunkIds: string[];
  visualCandidate?: {
    type: string;
    id: string;
  };
};

export type VisualSpec =
  | { id: string; type: "flow"; title: string; items: string[] }
  | { id: string; type: "formula"; title: string; formula: string }
  | { id: string; type: "contrast"; title: string; left: { label: string; body: string }; right: { label: string; body: string } }
  | { id: string; type: "layers"; title: string; items: string[] }
  | { id: string; type: "grid"; title: string; items: Array<{ label: string; value: string }> }
  | { id: string; type: "timeline"; title: string; events: Array<{ label: string; body: string; marker?: string }> }
  | {
      id: string;
      type: "axis";
      title: string;
      left: { label: string; caption: string };
      right: { label: string; caption: string };
      markers: Array<{ label: string; position: number }>;
    }
  | {
      id: string;
      type: "matrix";
      title: string;
      rows: string[];
      columns: string[];
      cells: Array<{ row: string; column: string; value: string }>;
    }
  | {
      id: string;
      type: "annotated_table";
      title: string;
      columns: string[];
      rows: Array<{ cells: string[]; note?: string }>;
    }
  | {
      id: string;
      type: "geometry";
      title: string;
      shapes: Array<{ kind: string; label: string; items?: string[] }>;
      caption: string;
    };

export type InteractionMove = "prediction" | "compare" | "classify" | "rank" | "rephrase" | "personal_connection";

export type LectureModulePlan = {
  moduleId: string;
  intrigue: {
    tension: string;
    stakes: string;
    surpriseLine: string;
  };
  guidedReading: {
    sourceSpark: string;
    plainParaphrase: string;
    contextBefore: string;
    contextAfter: string;
  };
  bestAnalogy: string | null;
  interactionMove: InteractionMove;
  likelyConfusion: string;
  teacherRepair: string;
  teachingMoves: Array<{ type: "guided_reflection" | "contrast" | "rephrase"; prompt: string }>;
  visualOpportunities: Array<{ kind: "table" | "diagram" | "timeline" | "map"; id: string; placement: "after_hook" | "after_guided_reading" | "after_first_explanation" }>;
};

export type LecturePlan = {
  materialId: string;
  generatedAt: string;
  modules: LectureModulePlan[];
};

export type PresentationBlockType =
  | "hook"
  | "guided_reading"
  | "paragraph"
  | "bullets"
  | "compare_table"
  | "source_quote"
  | "reflection"
  | "misconception"
  | "bridge"
  | "diagram";

export type PresentationModulePlan = {
  moduleId: string;
  defaultTurnShape: PresentationBlockType[];
  recapShape: PresentationBlockType[];
  avoid: string[];
};

export type PresentationPlan = {
  materialId: string;
  modules: PresentationModulePlan[];
};

export type CriticReport = {
  materialId: string;
  generatedAt: string;
  modules: Array<{
    moduleId: string;
    scores: {
      variety: number;
      grounding: number;
      visualFit: number;
      guidedReading: number;
      interaction: number;
      density: number;
      progression: number;
      nonExam: number;
    };
    warnings: string[];
  }>;
};

export type CourseModule = {
  id: string;
  title: string;
  learningGoal: string;
  conceptIds: string[];
  sourceChunkIds: string[];
  visualIds: string[];
  hookIntent: string;
  checkpointRubric: string;
  masterySignals: string[];
  misconceptionSignals: string[];
  remediationStrategy: string;
  mode?: "guided_lecture" | "comprehension_test";
  understandingSignals?: string[];
  confusionSignals?: string[];
  teacherRepairStrategy?: string;
};

export type CoursePlan = {
  id: string;
  title: string;
  subtitle: string;
  audience: string;
  estimatedTimeMinutes: number;
  modules: CourseModule[];
};

export type MaterialOverview = {
  paragraph: string;
  sourceChunkIds: string[];
  generatedAt: string;
  generatorVersion: string;
};

export type MaterialManifest = {
  id: string;
  projectId: string;
  title: string;
  sourceIds: string[];
  sourceChunkIds: string[];
  generatedAt: string;
  generatorModel: string;
  status: MaterialStatus;
};

export type MaterialArtifacts = {
  manifest: MaterialManifest;
  overview: MaterialOverview;
  conceptMap: Concept[];
  coursePlan: CoursePlan;
  lecturePlan?: LecturePlan;
  presentationPlan?: PresentationPlan;
  criticReport?: CriticReport;
  visuals: VisualSpec[];
  sourceChunks: SourceChunk[];
  sourceIndex: Record<string, { sourceId: string; title: string; locator: string }>;
  figures: SourceFigure[];
  figureIndex: Record<string, { sourceId: string; title: string; locator: string; sourceChunkIds: string[] }>;
  annotations: MaterialAnnotation[];
};
