import type { SourceChunk, SourceFigure, VisualSpec } from "./artifact-types";

export type TutorPhase = "orient" | "discuss" | "explain" | "clarify" | "synthesize" | "complete";

// What the learner is actually doing this turn. Drives whether we teach in place,
// take a detour to answer them, or move the lesson forward.
export type TutorIntent =
  | "start" // module is being opened (no user message yet)
  | "answer" // responding to a reflective prompt, staying on the current thread
  | "question" // asking a question about the current topic
  | "off_topic" // asking something tangential or beyond the current module
  | "deeper" // wants more detail, an example, or a simpler restatement
  | "meta_complaint" // protests that the tutor ignored them / dodged the question
  | "satisfied"; // signals understanding or explicitly wants to move on

// How the tutor is treating this turn.
export type TutorTurnMode =
  | "teach" // normal in-place teaching on the current module
  | "digress" // answering the learner's own question; do NOT advance
  | "synthesize"; // learner is ready; wrap up and move forward

export type TutorConversationMode = "on_track" | "detour" | "returning";

export type SourceRef = {
  chunkId: string;
  title: string;
  locator: string;
  text: string;
  figures?: SourceFigure[];
};

export type TutorContentBlock =
  | { type: "hook"; body: string }
  | { type: "guided_reading"; body: string; sourceRef?: string }
  | { type: "paragraph"; body: string }
  | { type: "bullets"; title?: string; items: string[] }
  | { type: "flow"; title?: string; steps: string[] }
  | { type: "compare_table"; title?: string; columns: string[]; rows: Array<Record<string, string>> }
  | { type: "source_quote"; quote: string; sourceRef: string; attribution?: string; showToLearner?: boolean }
  | { type: "reflection"; body: string; aiView?: string }
  | { type: "misconception"; title?: string; body: string; repair: string }
  | { type: "bridge"; body: string };

export type TutorStateUpdate = {
  nextPhase: TutorPhase;
  readyToContinue: boolean;
  nextSuggestedStep: "continue" | "stay" | "review";
  detectedConfusion: string | null;
  criticWarning?: string | null;
  checkpointPassed?: boolean;
  advanceModule?: boolean;
  detectedMisconception?: string | null;
  userIntent?: TutorIntent;
  turnMode?: TutorTurnMode;
  conversationMode?: TutorConversationMode;
};

export type TutorTurnOutput = {
  message: string;
  blocks?: TutorContentBlock[];
  diagram: string | null;
  visualPlacement?: "inline" | "side_panel" | null;
  choices: string[];
  progress: number;
  moduleId: string;
  sourceRefs: string[];
  stateUpdate: TutorStateUpdate;
};

export type TutorMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  blocks?: TutorContentBlock[];
  moduleId?: string;
  sourceRefs: string[];
  choices: string[];
  visualId?: string | null;
  stateUpdate?: TutorTurnOutput["stateUpdate"];
  createdAt: number;
  ordinal: number;
};

export type SessionSummary = {
  id: string;
  projectId: string;
  materialId: string;
  title: string;
  status: "active" | "completed" | "archived";
  currentModuleId: string | null;
  currentModuleTitle: string | null;
  completedModuleCount: number;
  totalModuleCount: number;
  messageCount: number;
  model: string;
  createdAt: number;
  updatedAt: number;
};

export type SessionSnapshot = {
  id: string;
  projectId: string;
  materialId: string;
  title: string;
  status: "active" | "completed" | "archived";
  currentModuleId: string | null;
  completedModuleIds: string[];
  // Source-chunk progress. The learner advances one semantic source chunk at a time, so a small
  // source that is a single module of many chunks still has fine-grained progression.
  currentChunkId: string | null;
  coveredChunkIds: string[];
  model: string;
  messages: TutorMessage[];
  createdAt: number;
  updatedAt: number;
};

export type TutorContext = {
  session: SessionSnapshot;
  currentObjective: string;
  sourceRefs: SourceRef[];
  visual: VisualSpec | null;
  moduleOutline: Array<{ id: string; title: string; status: "not_started" | "in_progress" | "completed" | "needs_review" }>;
  chunks: SourceChunk[];
  figures?: SourceFigure[];
};
