import type { VisualSpec } from "./artifact-types";

export const LEARNING_IR_SCHEMA_VERSION = 1 as const;
export const MATERIAL_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const LEARNING_IR_COMPILER_VERSION = "learning-ir-v1";
export const LEARNING_IR_PROMPT_VERSION = "learning-ir-extract-v1";
export const PREPARED_LEARNING_IR_SCHEMA_VERSION = 1 as const;
export const PREPARED_LEARNING_IR_COMPILER_VERSION = "prepared-learning-ir-v5";
export const PREPARED_LEARNING_IR_PROMPT_VERSION = "prepared-learning-ir-extract-v5";

export type LearningDocumentType = "book" | "article" | "mixed" | "unknown";

export type LearningSectionKind =
  | "expository_conceptual"
  | "historical_narrative"
  | "argument_reconstruction"
  | "comparative"
  | "procedural_technical"
  | "causal_mechanism"
  | "quantitative";

export type VisualGrammarKind =
  | "argument_map"
  | "relationship_graph"
  | "tree"
  | "cycle"
  | "flow"
  | "formula"
  | "contrast"
  | "layers"
  | "timeline"
  | "axis"
  | "matrix"
  | "annotated_table";

export type ArtifactQualityStatus = "good" | "warning" | "degraded";

export type ArtifactIssueCode =
  | "invalid_schema"
  | "missing_chunk_ref"
  | "orphan_node"
  | "duplicate_concept"
  | "invalid_edge"
  | "prerequisite_cycle"
  | "unsupported_visual"
  | "ungrounded_claim"
  | "oversize"
  | "unsafe_content";

export type ArtifactQualityIssue = {
  code: ArtifactIssueCode;
  stage: "fragment" | "ir" | "brief" | "visual" | "persist" | "prepared_learning_ir";
  itemId?: string;
  message: string;
};

export type ArtifactQualitySummary = {
  status: ArtifactQualityStatus;
  issues: ArtifactQualityIssue[];
  acceptedItemCount: number;
  rejectedItemCount: number;
};

export type LearningSectionIr = {
  id: string;
  moduleId: string;
  title: string;
  kind: LearningSectionKind;
  sourceChunkIds: string[];
  conceptIds: string[];
  claimIds: string[];
  relationIds: string[];
  visualCandidateKinds: VisualGrammarKind[];
};

export type LearningConcept = {
  id: string;
  label: string;
  originalLabel?: string;
  definition: string;
  whyItMatters: string;
  sourceChunkIds: string[];
};

export type LearningClaimRole =
  | "thesis"
  | "premise"
  | "evidence"
  | "counterclaim"
  | "conclusion"
  | "definition"
  | "event"
  | "mechanism"
  | "step";

export type LearningClaim = {
  id: string;
  role: LearningClaimRole;
  statement: string;
  sourceChunkIds: string[];
};

export type LearningRelationType =
  | "supports"
  | "challenges"
  | "causes"
  | "enables"
  | "contrasts_with"
  | "part_of"
  | "precedes"
  | "prerequisite_for"
  | "explains";

export type LearningRelation = {
  id: string;
  fromId: string;
  toId: string;
  type: LearningRelationType;
  label?: string;
  sourceChunkIds: string[];
};

export type SourceSemanticIr = {
  schemaVersion: typeof LEARNING_IR_SCHEMA_VERSION;
  materialId: string;
  documentType: LearningDocumentType;
  sourceFingerprint: string;
  contentHash: string;
  generatedAt: string;
  generator: {
    model: string;
    compilerVersion: string;
    promptVersion: string;
  };
  sections: LearningSectionIr[];
  concepts: LearningConcept[];
  claims: LearningClaim[];
  relations: LearningRelation[];
  quality: ArtifactQualitySummary;
};

export type PreparedLearningPedagogicalRole =
  | "introduce"
  | "explain"
  | "connect"
  | "contrast"
  | "apply"
  | "review";

export type PreparedLearningConcept = {
  id: string;
  label: string;
  definition: string;
  learningSignificance: string;
  firstIntroducedMessageId: string;
  reinforcedMessageIds: string[];
  sourceChunkIds: string[];
};

export type PreparedLearningRelation = {
  id: string;
  fromConceptId: string;
  toConceptId: string;
  type: LearningRelationType;
  explanation: string;
  messageIds: string[];
  sourceChunkIds: string[];
};

export type PreparedLearningStep = {
  messageId: string;
  routeIndex: number;
  moduleId: string;
  role: PreparedLearningPedagogicalRole;
  summary: string;
  conceptIds: string[];
  relationIds: string[];
  sourceChunkIds: string[];
  visualId: string | null;
};

/**
 * The learner-facing Learning IR. Unlike the source analysis above, this is
 * compiled only after every prepared tutor message has been committed.
 */
export type PreparedLearningIr = {
  schemaVersion: typeof PREPARED_LEARNING_IR_SCHEMA_VERSION;
  materialId: string;
  messageSetId: string;
  messageSetFingerprint: string;
  generatedAt: string;
  generator: {
    model: string;
    compilerVersion: string;
    promptVersion: string;
  };
  concepts: PreparedLearningConcept[];
  relations: PreparedLearningRelation[];
  steps: PreparedLearningStep[];
  quality: ArtifactQualitySummary;
};

// Public meaning of Learning IR: the graph of what the completed lesson
// actually teaches. SourceSemanticIr is an internal source-analysis artifact.
export type LearningIr = PreparedLearningIr;

export type PreparedLearningIrResult = {
  status: "not_ready" | "generating" | "ready" | "unavailable";
  ir: PreparedLearningIr | null;
  error: string | null;
};

export type SourceBrief = {
  schemaVersion: 1;
  materialId: string;
  scope: "single_source" | "multi_source";
  documentType: LearningDocumentType;
  guidingQuestion: string;
  summary: string;
  centralIdea: string | null;
  conceptIds: string[];
  structureVisualId: string | null;
  misconceptions: Array<{
    statement: string;
    repair: string;
    sourceChunkIds: string[];
  }>;
  anchors: Array<{
    sourceChunkId: string;
    label: string;
    excerpt: string;
  }>;
  reviewPrompt: {
    prompt: string;
    kind: "recall" | "connect" | "apply";
  };
  sourceFingerprint: string;
  generatedAt: string;
  generatorVersion: string;
  quality: ArtifactQualitySummary;
};

export type GroundedVisualPlacement = "before_explanation" | "after_explanation" | "review";

export type GroundedVisualSpec = VisualSpec & {
  schemaVersion: 1;
  sectionId: string;
  sourceChunkIds: string[];
  nodeIds: string[];
  placement: GroundedVisualPlacement;
  contentHash: string;
};

export type CriticReportV2 = {
  schemaVersion: 2;
  materialId: string;
  generatedAt: string;
  quality: ArtifactQualitySummary;
  stageTimingsMs: Partial<Record<"extract" | "validate" | "brief" | "visuals" | "persist", number>>;
};

export type MaterialArtifactFile = {
  path: string;
  sha256: string;
  required: boolean;
};
