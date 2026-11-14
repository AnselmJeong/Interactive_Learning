export const DEEP_READING_VERSION = "deep-reading-v1";

/** An exact text match is a location check, never a proof of entailment. */
export type PassageEvidence = {
  chunkId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
};

export type ExplanationStatus = "source" | "interpretation" | "analogy" | "background" | "uncertain";
export type ExplanationGrounding = {
  status: ExplanationStatus;
  evidence: PassageEvidence[];
};

export type PassagePlan = {
  chunkId: string;
  status: "analyzed" | "fallback";
  limitation: string | null;
  analyzedCharacters: number;
  role: string;
  difficulty: string;
  steps: Array<{ purpose: string; instruction: string; status: ExplanationStatus; evidence: PassageEvidence[] }>;
  connections: Array<{
    targetChunkId: string;
    kind: "definition" | "premise" | "contrast" | "limitation" | "continuation";
    explanation: string;
    evidence: PassageEvidence[];
  }>;
  explorations: string[];
  teachingTurns: number;
};

export type DeepReadingPlan = {
  version: typeof DEEP_READING_VERSION;
  sourceFingerprint: string;
  contentHash: string;
  model: string;
  generatedAt: string;
  passages: PassagePlan[];
};
